---
title: VM ops
description: Operations guide for managing OpenClaw on remote VMs
---

# VM ops

- Access: `ssh <jump-host>` then `ssh <vm-name>`. Config: `openclaw config set ...`; ensure `gateway.mode=local`.
- Update: `sudo npm i -g openclaw@latest`. Discord: store raw token only.
- Restart: `pkill -9 -f openclaw-gateway || true; nohup openclaw gateway run --bind loopback --port 18789 --force > /tmp/openclaw-gateway.log 2>&1 &`
- Verify: `openclaw channels status --probe`, `ss -ltnp | rg 18789`.
