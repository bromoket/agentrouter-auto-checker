# Ubuntu deployment

The production layout uses a native `systemd` service instead of Docker. Persistent Chromium profiles and
Playwright's browser sandbox are simpler to operate this way, while the dedicated `agentrouter` account and
systemd hardening keep the monitor isolated from the other Xeon workloads.

## Layout

- Code: `/opt/agentrouter-monitor` (private GitHub checkout, read-only to the service at runtime)
- Runtime data: `/var/lib/agentrouter-monitor/data` (credentials, SQLite, states, profiles, screenshots)
- Playwright Chromium: `/var/lib/agentrouter-monitor/ms-playwright`
- Configuration: `/etc/agentrouter-monitor/env`
- Service: `agentrouter-monitor.service`
- Dashboard: `http://100.127.29.78:8456` over Tailscale only

Never copy `data/accounts.json`, `data/states`, browser profiles, or SQLite into Git. Move those files directly
to the state directory with mode `0600` and ownership `agentrouter:agentrouter`.

## Install outline

1. Create a locked, unprivileged `agentrouter` system user.
2. Clone the private repository to `/opt/agentrouter-monitor` using a read-only repository deploy key.
3. Install Bun 1.3+ at `/usr/local/bin/bun` and a private Node.js 24 LTS runtime at
   `/opt/agentrouter-runtime/node` so existing server Node workloads are not changed.
4. Run `bun install --frozen-lockfile` in the checkout.
5. Install browser dependencies as root with `bunx playwright install-deps chromium`, then install Chromium as
   the service user with `PLAYWRIGHT_BROWSERS_PATH=/var/lib/agentrouter-monitor/ms-playwright bunx playwright install chromium`.
6. Copy `deploy/agentrouter-monitor.env.example` to `/etc/agentrouter-monitor/env` and set the current Tailscale
   IP, port, and approved browser origins.
7. Copy `deploy/agentrouter-monitor.service` to `/etc/systemd/system`, then run `systemctl daemon-reload` and
   `systemctl enable --now agentrouter-monitor`.

## Operations

```bash
sudo systemctl status agentrouter-monitor
sudo journalctl -u agentrouter-monitor -f
curl --fail http://100.127.29.78:8456/api/health
sudo systemctl restart agentrouter-monitor
```

Before an upgrade or migration, create a consistent SQLite snapshot with `bun run backup:db`. Keep the
credential file, state backups, browser profiles, and database readable only by the service user.

The first Linux run imports the portable Playwright storage state into a fresh Linux Chromium profile. Windows
browser profiles are intentionally not copied because platform-specific Chromium state is not reliably portable.
If GitHub or AgentRouter requires new interactive verification, run a headed recovery session through Xvfb/VNC,
then return the service to headless mode after `bun run probe:headless <account>` succeeds.
