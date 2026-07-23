---
id: task_67aa
title: M8-D3: installer + systemd — rootless-Podman provisioning (subuid/subgid, linger, kvm group, AF_VSOCK)
type: task
status: open
priority: 1
labels: [distribution,installer]
blocked_by: [task_2f46]
parent: epic_59b1
remote_task_url: null
created_at: 2026-07-19T22:55:58Z
updated_at: 2026-07-23T08:28:41Z
---
Absorb Proposal C's distribution ambition on the rootless substrate (brief §5): the installer
makes rootless-Podman setup feel one-command, without C's nested-sandbox weakness.

- [ ] scripts/install.sh: provision subuid/subgid ranges, loginctl enable-linger, kvm-group
      membership for the service user; replace today's docker-group grant.
- [ ] /dev/kvm access: kvm group primary; if the krun spike showed more is needed (crun #1894),
      setfacl -m u:<svc>:rw /dev/kvm — never world-0666.
- [ ] systemd/magpie.service: RestrictAddressFamilies gains AF_VSOCK; drop docker-daemon
      dependency; keep the gateway unit's separate-uid layout untouched (CTO edit 1).
- [ ] Run the M8-D1 preflight at install time with the fail-loud/acknowledge flow.
- [ ] Update scripts/pack-host.sh + release CI for any new artifacts (preflight probe binary).
- [ ] QUICKSTART.md / INSTALL.md walk-through re-verified on a clean host, both arches.

Done when: a clean Linux host goes from tarball to a running micro-VM-tier (or explicitly
acknowledged weaker-tier) install via the documented path, with no root daemon anywhere.
