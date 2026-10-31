import socket, os, sys, time
uds = sys.argv[1]
if os.path.exists(uds): os.unlink(uds)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(uds); s.listen(1)
print(f"host: listening on {uds}", flush=True)
conn, _ = s.accept()
data = conn.recv(256)
print(f"host: received {data!r}", flush=True)
conn.sendall(b"PONG from host gateway (uid=%d)\n" % os.getuid())
conn.shutdown(socket.SHUT_WR)   # signal EOF cleanly, but only our write side
time.sleep(0.5)                 # let libkrun drain reply to guest before teardown
conn.close(); s.close(); os.unlink(uds)
print("host: done", flush=True)
