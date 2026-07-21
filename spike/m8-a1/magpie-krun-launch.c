/*
 * M8-A1 spike — minimal direct-libkrun launcher, to test whether calling the
 * libkrun API ourselves (instead of via crun's krun handler) can produce a
 * PROVABLE no-network guest, i.e. TSI genuinely off, no dummy0.
 *
 * This is a throwaway proof, NOT production code. It exercises the exact calls a
 * real Magpie launcher would make where crun's shim declines to:
 *   krun_disable_implicit_vsock() + krun_add_vsock(ctx, 0)   -> TSI OFF
 * (A real launcher would also add krun_add_vsock_port2() for the gateway channel
 *  and krun_setuid()/setgid() for non-root guest; omitted here to isolate the
 *  networking question.)
 *
 * Usage: magpie-krun-launch <rootfs_dir> <exec> [args...]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/resource.h>
#include <libkrun.h>

int main(int argc, char *argv[])
{
    int err;
    uint32_t ctx_id;
    struct rlimit rlim;

    if (argc < 3) {
        fprintf(stderr, "usage: %s <rootfs_dir> <exec> [args...]\n", argv[0]);
        return 2;
    }

    ctx_id = krun_create_ctx();
    if ((int32_t) ctx_id < 0) { errno = -ctx_id; perror("krun_create_ctx"); return 1; }

    if ((err = krun_set_vm_config(ctx_id, 2, 1024))) { errno = -err; perror("krun_set_vm_config"); return 1; }

    getrlimit(RLIMIT_NOFILE, &rlim);
    rlim.rlim_cur = rlim.rlim_max;
    setrlimit(RLIMIT_NOFILE, &rlim);

    if ((err = krun_set_root(ctx_id, argv[1]))) { errno = -err; perror("krun_set_root"); return 1; }

    /* THE POINT OF THIS EXPERIMENT: turn TSI off explicitly. */
    if ((err = krun_disable_implicit_vsock(ctx_id))) { errno = -err; perror("krun_disable_implicit_vsock"); return 1; }
    if ((err = krun_add_vsock(ctx_id, 0))) { errno = -err; perror("krun_add_vsock(0)"); return 1; }

    /* Optional per-VM gateway channel: guest connects to vsock port -> libkrun
     * bridges to this host UNIX socket (which the host side listens on). This is
     * the krun_add_vsock_port2 HYBRID vsock the brief mandates. Configured via
     * env so the launcher's argv contract stays unchanged. listen=false => guest
     * initiates the connection. */
    {
        const char *uds = getenv("MAGPIE_VSOCK_UDS");
        const char *port_s = getenv("MAGPIE_VSOCK_PORT");
        if (uds && port_s) {
            uint32_t port = (uint32_t) strtoul(port_s, NULL, 10);
            if ((err = krun_add_vsock_port2(ctx_id, port, uds, false))) {
                errno = -err; perror("krun_add_vsock_port2"); return 1;
            }
        }
    }

    if ((err = krun_set_workdir(ctx_id, "/"))) { errno = -err; perror("krun_set_workdir"); return 1; }

    {
        const char *const envp[] = { "PATH=/usr/local/bin:/usr/bin:/bin", NULL };
        if ((err = krun_set_exec(ctx_id, argv[2], (const char *const *) &argv[3], envp))) {
            errno = -err; perror("krun_set_exec"); return 1;
        }
    }

    if ((err = krun_start_enter(ctx_id))) { errno = -err; perror("krun_start_enter"); return 1; }
    return 0; /* not reached */
}
