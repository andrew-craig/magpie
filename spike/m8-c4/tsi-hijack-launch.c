/*
 * spike/m8-c4/tsi-hijack-launch.c -- TEST-ONLY negative-test harness for
 * task_3b48 (M8-C4, "no-network-by-construction").
 *
 * THIS IS NOT THE PRODUCTION LAUNCHER. rust/magpie-microvm-launcher hardcodes
 * TSI OFF unconditionally (see its src/krun.rs's "LAYER 1 PIN" doc comment
 * and resolve_tsi_features()) -- there is no flag, env var, or config value
 * anywhere in that binary, or in packages/orchestrator, that can move the
 * TSI feature bitmask it passes to krun_add_vsock. This file is a wholly
 * separate, throwaway program (mirroring spike/m8-a1/magpie-krun-launch.c's
 * role for the M8-A1 spike) whose ONLY purpose is to deliberately construct
 * the one mis-launch task_3b48's acceptance test requires proof against: a
 * guest booted with TSI hijacking ON. Nothing in the shipped product ever
 * invokes this binary; it exists purely to be run BY HAND (or by
 * run-negative-test.sh in this directory) to prove that
 * docker/reviewer/entrypoint.sh's in-guest Layer-3 assertion (interface/
 * route enumeration + the active egress canary) actually catches this case,
 * since Layers 1/2 cannot -- by definition, this harness bypasses them both.
 *
 * Mirrors rust/magpie-microvm-launcher/src/krun.rs's `boot()` call sequence
 * (create_ctx -> set_vm_config -> set_root -> [virtiofs work/out mounts] ->
 * disable_implicit_vsock -> add_vsock -> [gateway vsock port] -> setuid ->
 * setgid -> set_workdir -> set_exec -> start_enter) so the negative-test
 * guest is configured as close to a real launch as a small throwaway C file
 * reasonably allows. The ONE deliberate deviation: the vsock TSI feature
 * bitmask comes from the MAGPIE_TSI_FEATURES env var (default 0 == TSI off,
 * the "positive control" boot) instead of always being 0. Set it to 1
 * (KRUN_TSI_HIJACK_INET) to reproduce the mis-launch.
 *
 * All configuration is via env vars (spike convention, see
 * spike/m8-a1/magpie-krun-launch.c), not argv, to keep this file small:
 *
 *   MAGPIE_ROOTFS (required)            MAGPIE_EXEC (required)
 *   MAGPIE_UID / MAGPIE_GID (required, non-root)
 *   MAGPIE_VCPUS (default 2)            MAGPIE_RAM_MIB (default 1024)
 *   MAGPIE_WORK_MOUNT_HOST (optional)   MAGPIE_WORK_MOUNT_TAG (default "work")
 *   MAGPIE_OUT_MOUNT_HOST (optional)    MAGPIE_OUT_MOUNT_TAG (default "out")
 *   MAGPIE_VSOCK_PORT / MAGPIE_VSOCK_UDS (both or neither)
 *   MAGPIE_TSI_FEATURES (default 0; 1 = KRUN_TSI_HIJACK_INET, 2 =
 *     KRUN_TSI_HIJACK_UNIX, 3 = both -- see libkrun.h)
 *
 * Remaining argv (argv[1..]) become the guest's exec argv. A fixed allowlist
 * of env vars already set on THIS process's own environment
 * (OPENROUTER_API_KEY, OPENAI_BASE_URL, MAGPIE_REQUIRE_MEMORY_LIMIT, PATH)
 * is forwarded into the guest verbatim if present -- the test driver sets
 * those on this process's env exactly like reviewer.ts does for the real
 * launcher (--env-from-host/--env), so entrypoint.sh sees the same shape of
 * input it would from a real job.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/resource.h>
#include <libkrun.h>

static uint32_t require_env_u32(const char *name)
{
    const char *v = getenv(name);
    if (!v || !*v) {
        fprintf(stderr, "tsi-hijack-launch: %s must be set\n", name);
        exit(2);
    }
    return (uint32_t) strtoul(v, NULL, 10);
}

static const char *require_env_str(const char *name)
{
    const char *v = getenv(name);
    if (!v || !*v) {
        fprintf(stderr, "tsi-hijack-launch: %s must be set\n", name);
        exit(2);
    }
    return v;
}

static uint32_t env_u32_default(const char *name, uint32_t def)
{
    const char *v = getenv(name);
    return (v && *v) ? (uint32_t) strtoul(v, NULL, 10) : def;
}

/* Splits "host[:tag]" into *host/*tag (tag defaults to def_tag). Mutates a
 * strdup'd copy so the caller can pass a getenv() result directly. */
static void split_mount(const char *raw, const char *def_tag, char **host, char **tag)
{
    char *copy = strdup(raw);
    char *colon = strrchr(copy, ':');
    if (colon) {
        *colon = '\0';
        *host = copy;
        *tag = colon + 1;
    } else {
        *host = copy;
        *tag = strdup(def_tag);
    }
}

int main(int argc, char *argv[])
{
    int err;
    uint32_t ctx_id;
    struct rlimit rlim;

    const char *rootfs = require_env_str("MAGPIE_ROOTFS");
    const char *exec_path = require_env_str("MAGPIE_EXEC");
    uint32_t uid = require_env_u32("MAGPIE_UID");
    uint32_t gid = require_env_u32("MAGPIE_GID");
    uint32_t vcpus = env_u32_default("MAGPIE_VCPUS", 2);
    uint32_t ram_mib = env_u32_default("MAGPIE_RAM_MIB", 1024);
    uint32_t tsi_features = env_u32_default("MAGPIE_TSI_FEATURES", 0);

    if (uid == 0 || gid == 0) {
        fprintf(stderr, "tsi-hijack-launch: MAGPIE_UID/MAGPIE_GID must be non-root\n");
        return 2;
    }

    fprintf(stderr,
        "tsi-hijack-launch: booting rootfs=%s exec=%s uid=%u gid=%u vcpus=%u ram_mib=%u "
        "tsi_features=%u (0=OFF; nonzero=TSI HIJACK ON -- the negative-test mis-launch)\n",
        rootfs, exec_path, uid, gid, vcpus, ram_mib, tsi_features);

    ctx_id = krun_create_ctx();
    if ((int32_t) ctx_id < 0) { errno = -(int32_t) ctx_id; perror("krun_create_ctx"); return 1; }

    getrlimit(RLIMIT_NOFILE, &rlim);
    rlim.rlim_cur = rlim.rlim_max;
    setrlimit(RLIMIT_NOFILE, &rlim);

    if ((err = krun_set_vm_config(ctx_id, (uint8_t) vcpus, ram_mib))) {
        errno = -err; perror("krun_set_vm_config"); return 1;
    }
    if ((err = krun_set_root(ctx_id, rootfs))) { errno = -err; perror("krun_set_root"); return 1; }

    {
        const char *work_raw = getenv("MAGPIE_WORK_MOUNT_HOST");
        if (work_raw) {
            char *host, *tag;
            split_mount(work_raw, getenv("MAGPIE_WORK_MOUNT_TAG") ? getenv("MAGPIE_WORK_MOUNT_TAG") : "work", &host, &tag);
            if ((err = krun_add_virtiofs3(ctx_id, tag, host, 0, true))) {
                errno = -err; perror("krun_add_virtiofs3(work, ro)"); return 1;
            }
        }
    }
    {
        const char *out_raw = getenv("MAGPIE_OUT_MOUNT_HOST");
        if (out_raw) {
            char *host, *tag;
            split_mount(out_raw, getenv("MAGPIE_OUT_MOUNT_TAG") ? getenv("MAGPIE_OUT_MOUNT_TAG") : "out", &host, &tag);
            if ((err = krun_add_virtiofs3(ctx_id, tag, host, 0, false))) {
                errno = -err; perror("krun_add_virtiofs3(out, rw)"); return 1;
            }
        }
    }

    /* THE ONE DELIBERATE DEVIATION FROM THE PRODUCTION LAUNCHER: tsi_features
     * comes from MAGPIE_TSI_FEATURES (env), not a hardcoded 0. See module doc
     * comment. */
    if ((err = krun_disable_implicit_vsock(ctx_id))) {
        errno = -err; perror("krun_disable_implicit_vsock"); return 1;
    }
    if ((err = krun_add_vsock(ctx_id, tsi_features))) {
        errno = -err; perror("krun_add_vsock"); return 1;
    }

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

    if ((err = krun_setuid(ctx_id, uid))) { errno = -err; perror("krun_setuid"); return 1; }
    if ((err = krun_setgid(ctx_id, gid))) { errno = -err; perror("krun_setgid"); return 1; }

    if ((err = krun_set_workdir(ctx_id, "/"))) { errno = -err; perror("krun_set_workdir"); return 1; }

    {
        /* Forward a fixed allowlist of this process's own env vars into the
         * guest verbatim -- mirrors reviewer.ts's --env-from-host/--env
         * convention (the test driver sets these on THIS process's env, not
         * on argv, for the same reason the real launcher does). */
        static const char *const forward_names[] = {
            "PATH", "OPENROUTER_API_KEY", "OPENAI_BASE_URL", "MAGPIE_REQUIRE_MEMORY_LIMIT", NULL,
        };
        char *envp[8];
        int n = 0;
        char bufs[8][512];
        for (int i = 0; forward_names[i] && n < 7; i++) {
            const char *v = getenv(forward_names[i]);
            if (v) {
                snprintf(bufs[n], sizeof(bufs[n]), "%s=%s", forward_names[i], v);
                envp[n] = bufs[n];
                n++;
            }
        }
        envp[n] = NULL;

        if ((err = krun_set_exec(ctx_id, exec_path, (const char *const *) &argv[1], (const char *const *) envp))) {
            errno = -err; perror("krun_set_exec"); return 1;
        }
    }

    if ((err = krun_start_enter(ctx_id))) { errno = -err; perror("krun_start_enter"); return 1; }
    return 0; /* not reached on success */
}
