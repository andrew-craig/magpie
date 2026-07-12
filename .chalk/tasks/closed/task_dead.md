---
id: task_dead
title: M7-7: Keep host-native systemd as the documented max-hardening path
type: task
status: closed
priority: 3
labels: [distribution]
blocked_by: [task_d54c]
parent: epic_0162
remote_task_url: null
created_at: 2026-07-12T13:07:35Z
updated_at: 2026-07-12T13:34:18Z
---
Refactor install.sh + the systemd units + setup-network.sh into the documented 'advanced / maximum-hardening' alternative rather than the default. Share the config schema with the compose profile so switching is a deployment choice, not a rewrite. Retain the /opt/magpie prefix + node-path rewriting for this path only.
