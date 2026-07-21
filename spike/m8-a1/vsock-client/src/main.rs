// M8-A1 spike proof: guest-side AF_VSOCK client in Rust, built as a fully static
// musl binary to bake into the reviewer image. Connects to the host over vsock
// (CID=2) on a port that libkrun bridges to the per-job gateway unix socket
// (krun_add_vsock_port2), sends a line, and echoes the reply. Exit 0 on a
// successful round-trip; non-zero + errno on any failure (never a silent hang).
use std::mem::{size_of, zeroed};

fn main() {
    let port: u32 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(1234);
    unsafe {
        let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0);
        if fd < 0 { eprintln!("socket() failed errno={}", *libc::__errno_location()); std::process::exit(10); }

        let mut addr: libc::sockaddr_vm = zeroed();
        addr.svm_family = libc::AF_VSOCK as libc::sa_family_t;
        addr.svm_port = port;
        addr.svm_cid = libc::VMADDR_CID_HOST; // 2 = host

        let rc = libc::connect(fd, &addr as *const _ as *const libc::sockaddr, size_of::<libc::sockaddr_vm>() as libc::socklen_t);
        if rc != 0 { eprintln!("connect(cid=2,port={port}) failed errno={}", *libc::__errno_location()); std::process::exit(11); }
        println!("vsock connect OK (cid=2 port={port})");

        let msg = b"PING from rust guest\n";
        let w = libc::write(fd, msg.as_ptr() as *const _, msg.len());
        if w < 0 { eprintln!("write failed errno={}", *libc::__errno_location()); std::process::exit(12); }

        let mut buf = [0u8; 256];
        let n = libc::read(fd, buf.as_mut_ptr() as *mut _, buf.len());
        if n <= 0 { eprintln!("read failed/eof n={n} errno={}", *libc::__errno_location()); std::process::exit(13); }
        let reply = String::from_utf8_lossy(&buf[..n as usize]);
        print!("vsock round-trip OK, host replied: {reply}");
        libc::close(fd);
    }
    std::process::exit(0);
}
