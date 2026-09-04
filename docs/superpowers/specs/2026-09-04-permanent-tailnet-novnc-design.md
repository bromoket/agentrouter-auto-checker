# Permanent Tailnet noVNC Design

## Goal

Make the AI Fleet Observatory staging Xvfb desktop permanently reachable from every device allowed by the owner's Tailscale ACLs, so a human can complete AgentRouter access verification in the exact browser session used by the worker.

## Scope

This change covers the staging service `ai-fleet-observatory` on `bkserver`. It versions the Xvfb lifecycle, noVNC companion services, Tailscale Serve route, deployment instructions, and operational checks. It does not expose production, create a second desktop, weaken AgentRouter validation, automate the human verification gesture, or expose VNC outside the tailnet.

## Architecture

The existing Tailscale Serve HTTPS listener gains one path:

- `https://bkserver.tailbbaa91.ts.net/observatory-vnc/`

The existing `/` and `/observatory/` handlers remain unchanged. Tailscale Serve proxies the new path to `http://127.0.0.1:6080`. Websockify serves the distro-provided noVNC static files and proxies WebSockets to x11vnc on `127.0.0.1:5900`. x11vnc attaches to the Observatory staging Xvfb display.

The canonical launch URL is:

```text
https://bkserver.tailbbaa91.ts.net/observatory-vnc/vnc.html?autoconnect=true&resize=scale&path=observatory-vnc/websockify
```

The explicit `path` query keeps the noVNC WebSocket request under the mounted Tailscale Serve prefix.

## Access Boundary

Tailscale identity and ACL enforcement are the only authentication layer. No shared VNC password is added. This avoids distributing a legacy, weak shared secret while keeping transport encrypted and identity-scoped by the tailnet.

The implementation must preserve all of these invariants:

- x11vnc listens only on `127.0.0.1:5900`.
- websockify listens only on `127.0.0.1:6080`.
- Tailscale Funnel is never enabled.
- No LAN, public IPv4, public IPv6, or wildcard listener is created.
- The existing Tailscale Serve root and `/observatory/` routes are preserved.

Any tailnet identity allowed by the current ACL can interact with the authenticated worker desktop. This surface is therefore an administrative control plane, not a read-only dashboard.

## Xvfb Lifecycle

`scripts/start-server.sh` accepts an opt-in `XVFB_DISPLAY` and `XVFB_AUTH_FILE` pair. The staging service sets them to `99` and `/run/ai-fleet-observatory/Xauthority`; specifying only one is a startup error. When neither is set, the wrapper retains its existing automatically selected display and temporary authority file, so production and manual invocations remain unchanged.

A deterministic display and stable authority path let x11vnc reconnect after Observatory restarts without inspecting process IDs or private temporary directories. Xvfb retains `-nolisten tcp`; only its local Unix socket exists.

The x11vnc companion joins Observatory's systemd private temporary namespace so it can reach the X11 Unix socket without removing `PrivateTmp=true` from the main service or exposing that socket in the host's global `/tmp`.

## Companion Services

Two hardened systemd service templates and one lifecycle target are versioned under `deploy/`:

1. `ai-fleet-observatory-vnc.service`
   - Runs as `agentrouter`.
   - Waits for display `:99` and its Xauthority file.
   - Starts x11vnc in shared, persistent, no-password mode.
   - Binds RFB only to loopback port 5900.
   - Disables x11vnc's remote-command and external-command channels.
   - Restarts and retries across Xvfb lifecycle changes.

2. `ai-fleet-observatory-novnc.service`
   - Runs as `agentrouter`.
   - Serves `/usr/share/novnc` through websockify.
   - Binds HTTP/WebSocket traffic only to loopback port 6080.
   - Proxies only to loopback port 5900.
   - Restarts independently.

Both services use systemd hardening consistent with the existing Observatory unit. Failure of either companion must not stop or restart the dashboard, scheduler, Antigravity probes, or AgentRouter worker.

3. `ai-fleet-observatory-novnc.target`
   - Requires the main Observatory service.
   - Uses systemd `Upholds=` to restore either companion while the target is active.
   - Owns companion lifecycle so stopping or disabling the target cleanly stops both services.

The Xeon runs systemd 255, satisfying the `Upholds=` directive's systemd 249 minimum. The target closes the automatic failure-restart path without coupling main-service success to companion health.

## Data and Interaction Flow

1. A tailnet device opens the canonical HTTPS URL.
2. Tailscale authenticates the device/user under the tailnet ACL and terminates HTTPS.
3. Tailscale Serve forwards the mounted path to loopback websockify.
4. noVNC establishes a WebSocket at `/observatory-vnc/websockify`.
5. Websockify forwards RFB traffic to loopback x11vnc.
6. x11vnc reads and writes the exact Xvfb display used by the Observatory worker.
7. A human completes AgentRouter's access-verification slider.
8. The existing worker retries `/api/user/self`, validates the authoritative user identity and numeric fields, and records the real balance.

## Failure Behavior

- If Observatory/Xvfb is down, noVNC may load but cannot connect to RFB; the bridge retries when the display returns.
- If x11vnc exits, systemd restarts it without affecting Observatory.
- If websockify exits, systemd restarts it without affecting Observatory or x11vnc.
- If the Tailscale Serve route is absent, only remote noVNC access fails; both loopback services remain non-public.
- If AgentRouter rejects the human verification, the worker keeps its existing timeout and explicit diagnostic error. No stale, local-storage, or visible-UI money is accepted as authoritative.

## Deployment

The Ubuntu deployment guide must document:

- Installing `x11vnc`, `novnc`, and `websockify` from Ubuntu packages.
- Copying and enabling both versioned systemd units.
- Updating and restarting `ai-fleet-observatory` for the deterministic Xvfb identity.
- Adding `/observatory-vnc/` with `tailscale serve --set-path` rather than replacing Serve configuration.
- Confirming that `/`, `/observatory/`, and `/observatory-vnc/` are all present after the change.
- The canonical browser URL and the administrative-control warning.

## Verification

The change is complete only when all of these checks pass:

1. `sh -n scripts/start-server.sh` succeeds.
2. `systemd-analyze verify` accepts the Observatory, both companion services, and the lifecycle target.
3. The repository's Bun tests and TypeScript checks still pass.
4. `ai-fleet-observatory`, `ai-fleet-observatory-novnc.target`, `ai-fleet-observatory-vnc`, and `ai-fleet-observatory-novnc` are active.
5. Socket inspection shows ports 5900 and 6080 bound only to loopback.
6. Tailscale Serve status contains the unchanged `/` and `/observatory/` handlers plus `/observatory-vnc/`.
7. A tailnet browser opens the canonical URL and controls the worker's actual Xvfb canvas.
8. Restarting Observatory temporarily disconnects noVNC, after which the same URL reconnects without manual server repair.
9. A human completes AgentRouter access verification through noVNC.
10. The resulting account run succeeds and stores money derived from authoritative `/api/user/self` data.

## Cleanup and Rollback

The temporary SSH tunnel and ad-hoc bridge processes used during diagnosis are removed after the permanent services are live. Rollback removes only the `/observatory-vnc/` Serve path and disables the noVNC lifecycle target, which stops both companions without restarting Observatory. A full package rollback may also restore the previous startup wrapper and remove the three Ubuntu packages. Existing Serve handlers and Observatory data remain untouched.
