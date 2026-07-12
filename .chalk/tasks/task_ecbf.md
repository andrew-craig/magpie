---
id: task_ecbf
title: M7-4: Config portability — service-DNS addressing; demote host-iptables to opt-in
type: task
status: open
priority: 2
labels: [distribution]
blocked_by: [task_d54c]
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-12T13:07:35Z
---
Replace pinned 172.31.99.1 gateway IP with compose service DNS (gateway:4000) in the default config path. Demote setup-network.sh + pinned 172.31.99.0/24 subnet from the default to the opt-in max-hardening profile. Ensure compose-friendly config defaults work out of the box. One shared config schema across both profiles.
