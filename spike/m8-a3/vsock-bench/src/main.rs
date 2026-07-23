// M8-A3 spike (task_a163): latency benchmark for the guest -> vsock -> host
// per-job unix-socket path, compared against a plain host<->host unix-socket
// baseline (the transport Magpie uses today).
//
// One static musl aarch64 binary does everything, so both the vsock path and
// the unix baseline exercise byte-for-byte identical client and server code and
// the ONLY variable between them is the transport:
//
//   serve <unix_path>                              host-side echo server (accept
//                                                  loop, echoes each connection
//                                                  until EOF). libkrun connects
//                                                  OUT to this socket for the
//                                                  vsock path (krun_add_vsock_port2
//                                                  listen=false); the native
//                                                  baseline client connects to it
//                                                  directly.
//
//   bench-all <transport> <target> <conn_iters> <stream_msgs> <msg_bytes>
//                                                  runs BOTH sub-benchmarks in one
//                                                  process (needed because a krun
//                                                  guest execs a single binary):
//                                                    1. connection-setup: N times
//                                                       (connect, 1 round-trip,
//                                                       close) -> connect latency +
//                                                       first-round-trip latency.
//                                                    2. streaming: one persistent
//                                                       connection, M ping-pong
//                                                       round-trips -> steady-state
//                                                       per-message latency.
//                                                  transport = vsock <port> | unix <path>
//
// All timings use CLOCK_MONOTONIC (libc::clock_gettime). Summaries
// (count/min/median/p90/max/mean, microseconds) are computed in-process from the
// collected raw samples and printed as machine-parseable RESULT lines. No number
// is ever synthesised: every RESULT is derived from measured clock deltas.

use std::mem::{size_of, zeroed};

fn now_ns() -> i128 {
    unsafe {
        let mut ts: libc::timespec = zeroed();
        if libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) != 0 {
            die("clock_gettime", 20);
        }
        (ts.tv_sec as i128) * 1_000_000_000 + (ts.tv_nsec as i128)
    }
}

fn die(msg: &str, code: i32) -> ! {
    unsafe {
        eprintln!("FATAL {msg}: errno={}", *libc::__errno_location());
    }
    std::process::exit(code);
}

fn connect_unix(path: &str) -> i32 {
    unsafe {
        let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
        if fd < 0 {
            die("socket(AF_UNIX)", 10);
        }
        let mut addr: libc::sockaddr_un = zeroed();
        addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
        let bytes = path.as_bytes();
        if bytes.len() >= addr.sun_path.len() {
            die("unix path too long", 10);
        }
        for (i, b) in bytes.iter().enumerate() {
            addr.sun_path[i] = *b as libc::c_char;
        }
        let rc = libc::connect(
            fd,
            &addr as *const _ as *const libc::sockaddr,
            size_of::<libc::sockaddr_un>() as libc::socklen_t,
        );
        if rc != 0 {
            die("connect(AF_UNIX)", 11);
        }
        fd
    }
}

fn connect_vsock(port: u32) -> i32 {
    unsafe {
        let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM, 0);
        if fd < 0 {
            die("socket(AF_VSOCK)", 10);
        }
        let mut addr: libc::sockaddr_vm = zeroed();
        addr.svm_family = libc::AF_VSOCK as libc::sa_family_t;
        addr.svm_port = port;
        addr.svm_cid = libc::VMADDR_CID_HOST; // 2 = host
        let rc = libc::connect(
            fd,
            &addr as *const _ as *const libc::sockaddr,
            size_of::<libc::sockaddr_vm>() as libc::socklen_t,
        );
        if rc != 0 {
            die("connect(AF_VSOCK cid=2)", 11);
        }
        fd
    }
}

fn connect_transport(transport: &str, target: &str) -> i32 {
    match transport {
        "unix" => connect_unix(target),
        "vsock" => {
            let port: u32 = target.parse().unwrap_or_else(|_| die("bad vsock port", 2));
            connect_vsock(port)
        }
        _ => {
            eprintln!("unknown transport {transport}");
            std::process::exit(2);
        }
    }
}

fn write_all(fd: i32, buf: &[u8]) {
    let mut off = 0usize;
    while off < buf.len() {
        let n = unsafe {
            libc::write(
                fd,
                buf.as_ptr().add(off) as *const libc::c_void,
                buf.len() - off,
            )
        };
        if n <= 0 {
            die("write", 12);
        }
        off += n as usize;
    }
}

fn read_exact(fd: i32, buf: &mut [u8]) {
    let mut off = 0usize;
    while off < buf.len() {
        let n = unsafe {
            libc::read(
                fd,
                buf.as_mut_ptr().add(off) as *mut libc::c_void,
                buf.len() - off,
            )
        };
        if n <= 0 {
            die("read (eof/err)", 13);
        }
        off += n as usize;
    }
}

fn summarize(transport: &str, phase: &str, metric: &str, mut samples: Vec<i128>) {
    if samples.is_empty() {
        println!("RESULT {transport} {phase} {metric} count=0");
        return;
    }
    samples.sort_unstable();
    let n = samples.len();
    let pct = |p: f64| -> f64 {
        // nearest-rank percentile on the sorted sample
        let rank = ((p / 100.0) * (n as f64)).ceil() as usize;
        let idx = rank.saturating_sub(1).min(n - 1);
        samples[idx] as f64 / 1000.0
    };
    let min = samples[0] as f64 / 1000.0;
    let max = samples[n - 1] as f64 / 1000.0;
    let mean = (samples.iter().sum::<i128>() as f64 / n as f64) / 1000.0;
    println!(
        "RESULT {transport} {phase} {metric} count={n} min_us={:.2} median_us={:.2} p90_us={:.2} max_us={:.2} mean_us={:.2}",
        min,
        pct(50.0),
        pct(90.0),
        max,
        mean
    );
}

fn serve(path: &str) -> ! {
    // `unlink` needs a NUL-terminated C string; `path.as_ptr()` on a &str is
    // NOT terminated (UB — reads past the end, could unlink an unrelated path).
    let cpath = std::ffi::CString::new(path).expect("socket path has no interior NUL");
    unsafe {
        let _ = libc::unlink(cpath.as_ptr()); // best-effort
        let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
        if fd < 0 {
            die("server socket", 30);
        }
        let mut addr: libc::sockaddr_un = zeroed();
        addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
        let bytes = path.as_bytes();
        if bytes.len() >= addr.sun_path.len() {
            die("server path too long", 30);
        }
        for (i, b) in bytes.iter().enumerate() {
            addr.sun_path[i] = *b as libc::c_char;
        }
        if libc::bind(
            fd,
            &addr as *const _ as *const libc::sockaddr,
            size_of::<libc::sockaddr_un>() as libc::socklen_t,
        ) != 0
        {
            die("bind", 31);
        }
        if libc::listen(fd, 128) != 0 {
            die("listen", 32);
        }
        println!("SERVE listening {path}");
        // flush stdout so the launcher script can synchronise
        libc::fflush(std::ptr::null_mut());
        loop {
            let conn = libc::accept(fd, std::ptr::null_mut(), std::ptr::null_mut());
            if conn < 0 {
                die("accept", 33);
            }
            // Echo everything until EOF, then close. One connection at a time is
            // sufficient: the client is strictly serial (ping-pong), never
            // concurrent, so no connection is ever left waiting.
            let mut buf = [0u8; 65536];
            loop {
                let n = libc::read(conn, buf.as_mut_ptr() as *mut libc::c_void, buf.len());
                if n <= 0 {
                    break;
                }
                let mut off = 0isize;
                while off < n {
                    let w = libc::write(
                        conn,
                        buf.as_ptr().offset(off) as *const libc::c_void,
                        (n - off) as usize,
                    );
                    if w <= 0 {
                        break;
                    }
                    off += w;
                }
            }
            libc::close(conn);
        }
    }
}

fn bench_all(transport: &str, target: &str, conn_iters: usize, stream_msgs: usize, msg_bytes: usize) {
    let msg = vec![0x41u8; msg_bytes]; // 'A' * msg_bytes
    let mut rbuf = vec![0u8; msg_bytes];

    // ---- Phase 1: connection setup + first round-trip ----
    // Each iteration opens a fresh connection (for vsock this drives a fresh
    // guest vsock connect + libkrun outbound unix connect + server accept),
    // does exactly one ping-pong round-trip, then closes. We separate the
    // connect() cost from the first-round-trip cost.
    let mut connect_ns: Vec<i128> = Vec::with_capacity(conn_iters);
    let mut first_rt_ns: Vec<i128> = Vec::with_capacity(conn_iters);
    for _ in 0..conn_iters {
        let t0 = now_ns();
        let fd = connect_transport(transport, target);
        let t1 = now_ns();
        write_all(fd, &msg);
        read_exact(fd, &mut rbuf);
        let t2 = now_ns();
        unsafe {
            libc::close(fd);
        }
        connect_ns.push(t1 - t0);
        first_rt_ns.push(t2 - t1);
    }
    summarize(transport, "connect", "setup", connect_ns);
    summarize(transport, "connect", "first_roundtrip", first_rt_ns);

    // ---- Phase 2: streaming round-trips on a persistent connection ----
    // One connect, then M serial ping-pong round-trips. Isolates steady-state
    // per-message latency (no per-message reconnect) — the shape the gateway's
    // token streaming actually uses.
    let fd = connect_transport(transport, target);
    // warm-up round-trip (not measured) to page in buffers / prime the path.
    write_all(fd, &msg);
    read_exact(fd, &mut rbuf);
    let mut stream_ns: Vec<i128> = Vec::with_capacity(stream_msgs);
    for _ in 0..stream_msgs {
        let t0 = now_ns();
        write_all(fd, &msg);
        read_exact(fd, &mut rbuf);
        let t1 = now_ns();
        stream_ns.push(t1 - t0);
    }
    unsafe {
        libc::close(fd);
    }
    summarize(transport, "stream", "roundtrip", stream_ns);

    println!(
        "DONE {transport} conn_iters={conn_iters} stream_msgs={stream_msgs} msg_bytes={msg_bytes}"
    );
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!(
            "usage:\n  {0} serve <unix_path>\n  {0} bench-all <vsock <port>|unix <path>> <conn_iters> <stream_msgs> <msg_bytes>",
            args[0]
        );
        std::process::exit(2);
    }
    match args[1].as_str() {
        "serve" => {
            if args.len() != 3 {
                eprintln!("usage: {} serve <unix_path>", args[0]);
                std::process::exit(2);
            }
            serve(&args[2]);
        }
        "bench-all" => {
            // bench-all <transport> <target> <conn_iters> <stream_msgs> <msg_bytes>
            if args.len() != 7 {
                eprintln!(
                    "usage: {} bench-all <transport> <target> <conn_iters> <stream_msgs> <msg_bytes>",
                    args[0]
                );
                std::process::exit(2);
            }
            let transport = &args[2];
            let target = &args[3];
            let conn_iters: usize = args[4].parse().unwrap_or_else(|_| die("bad conn_iters", 2));
            let stream_msgs: usize = args[5].parse().unwrap_or_else(|_| die("bad stream_msgs", 2));
            let msg_bytes: usize = args[6].parse().unwrap_or_else(|_| die("bad msg_bytes", 2));
            bench_all(transport, target, conn_iters, stream_msgs, msg_bytes);
        }
        other => {
            eprintln!("unknown mode {other}");
            std::process::exit(2);
        }
    }
}
