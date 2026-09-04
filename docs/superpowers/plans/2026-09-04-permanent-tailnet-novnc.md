# Permanent Tailnet noVNC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use skill://subagent-driven-development (recommended) or skill://executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently expose the AI Fleet Observatory staging worker's real Xvfb desktop at a tailnet-only HTTPS noVNC URL.

**Architecture:** Staging opts into a deterministic Xvfb display and Xauthority path while production retains the current automatic display behavior. Two independent, hardened systemd companions bind x11vnc and websockify to IPv4 loopback; the existing Tailscale Serve HTTPS listener publishes websockify under `/observatory-vnc/` without changing its other handlers.

**Tech Stack:** POSIX shell, Xvfb/xauth, x11vnc, noVNC/websockify, systemd, Tailscale Serve, Bun 1.3.14, Playwright browser relay.

## Global Constraints

- The change applies only to staging service `ai-fleet-observatory`; production behavior and data remain unchanged.
- x11vnc MUST bind only to `127.0.0.1:5900`.
- websockify MUST bind only to `127.0.0.1:6080`.
- Tailscale Serve MUST preserve `/` and `/observatory/` while adding `/observatory-vnc/`.
- Tailscale Funnel, wildcard listeners, LAN listeners, public listeners, and shared VNC passwords are prohibited.
- noVNC failure MUST NOT stop or restart Observatory.
- Use Bun exclusively for repository tests and type checking.
- Never copy credentials, browser profiles, sessions, or runtime databases into Git.

---

### Task 1: Deterministic Staging Xvfb Contract

**Files:**
- Modify: `scripts/start-server.sh:1-4`
- Modify: `deploy/ai-fleet-observatory.service:4-25`

**Interfaces:**
- Consumes: Optional `XVFB_DISPLAY` and `XVFB_AUTH_FILE` environment variables.
- Produces: Staging display `:99` with authority file `/run/ai-fleet-observatory/Xauthority`; unchanged automatic display selection when neither variable is present.

- [ ] **Step 1: Preserve the default path and validate the opt-in pair**

Replace `scripts/start-server.sh` with:

```sh
#!/bin/sh
set -eu

if [ -n "${XVFB_DISPLAY:-}" ] || [ -n "${XVFB_AUTH_FILE:-}" ]; then
    if [ -z "${XVFB_DISPLAY:-}" ] || [ -z "${XVFB_AUTH_FILE:-}" ]; then
        echo "XVFB_DISPLAY and XVFB_AUTH_FILE must be set together" >&2
        exit 64
    fi

    case "$XVFB_DISPLAY" in
        *[!0-9]*|'')
            echo "XVFB_DISPLAY must be an unsigned display number" >&2
            exit 64
            ;;
    esac

    exec /usr/bin/xvfb-run \
        -n "$XVFB_DISPLAY" \
        -f "$XVFB_AUTH_FILE" \
        -s "-screen 0 1920x1080x24" \
        /usr/local/bin/bun run start
fi

exec /usr/bin/xvfb-run -a -s "-screen 0 1920x1080x24" /usr/local/bin/bun run start
```

- [ ] **Step 2: Configure only staging to use the stable identity**

Replace staging's `ExecStart=` so the fixed values override any same-named entries inherited from its environment file:

```ini
ExecStart=/usr/bin/env XVFB_DISPLAY=99 XVFB_AUTH_FILE=/run/ai-fleet-observatory/Xauthority /opt/ai-fleet-observatory/scripts/start-server.sh
```

Add this directly after `RuntimeDirectory=ai-fleet-observatory`:

```ini
RuntimeDirectoryMode=0700
```

Do not modify `deploy/agentrouter-monitor.service`.

- [ ] **Step 3: Verify shell syntax and the unchanged default branch**

Run:

```bash
sh -n scripts/start-server.sh
```

Expected: exit 0 with no output. The conditional branch added in Step 1 leaves the original final `xvfb-run -a` command unchanged when neither opt-in variable is present.

- [ ] **Step 4: Commit the Xvfb contract**

```bash
git add scripts/start-server.sh deploy/ai-fleet-observatory.service
git commit -m "feat: stabilize staging Xvfb identity"
```

---

### Task 2: Hardened noVNC Companion Units

**Files:**
- Create: `deploy/ai-fleet-observatory-vnc.service`
- Create: `deploy/ai-fleet-observatory-novnc.service`
- Create: `deploy/ai-fleet-observatory-novnc.target`

**Interfaces:**
- Consumes: Display `:99`, `/run/ai-fleet-observatory/Xauthority`, distro noVNC files at `/usr/share/novnc`.
- Produces: RFB at `127.0.0.1:5900`, noVNC HTTP/WebSocket at `127.0.0.1:6080`, and one independently disableable lifecycle target.

- [ ] **Step 1: Add the x11vnc unit**

Create `deploy/ai-fleet-observatory-vnc.service`:

```ini
[Unit]
Description=AI Fleet Observatory staging Xvfb VNC bridge
Documentation=https://github.com/bromoket/agentrouter-auto-checker
After=ai-fleet-observatory.service
Requires=ai-fleet-observatory.service
PartOf=ai-fleet-observatory.service ai-fleet-observatory-novnc.target
JoinsNamespaceOf=ai-fleet-observatory.service

[Service]
Type=simple
User=agentrouter
Group=agentrouter
Environment=HOME=/var/lib/ai-fleet-observatory
Environment=DISPLAY=:99
Environment=XAUTHORITY=/run/ai-fleet-observatory/Xauthority
ExecStart=/usr/bin/x11vnc -display :99 -auth /run/ai-fleet-observatory/Xauthority -listen 127.0.0.1 -rfbport 5900 -forever -shared -nopw -safer -nocmds
Restart=always
RestartSec=2
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
LockPersonality=true
ProtectClock=true
ProtectControlGroups=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectProc=invisible
RestrictAddressFamilies=AF_UNIX AF_INET
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native
TasksMax=128
MemoryMax=256M
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ai-fleet-observatory-vnc
```

- [ ] **Step 2: Add the websockify/noVNC unit**

Create `deploy/ai-fleet-observatory-novnc.service`:

```ini
[Unit]
Description=AI Fleet Observatory staging noVNC gateway
Documentation=https://github.com/bromoket/agentrouter-auto-checker
After=network-online.target ai-fleet-observatory-vnc.service
Wants=network-online.target ai-fleet-observatory-vnc.service
PartOf=ai-fleet-observatory-novnc.target

[Service]
Type=simple
User=agentrouter
Group=agentrouter
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900
Restart=on-failure
RestartSec=2
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
LockPersonality=true
ProtectClock=true
ProtectControlGroups=true
ProtectHostname=true
ProtectKernelLogs=true
ProtectKernelModules=true
ProtectKernelTunables=true
ProtectProc=invisible
RestrictAddressFamilies=AF_UNIX AF_INET
RestrictRealtime=true
RestrictSUIDSGID=true
SystemCallArchitectures=native
TasksMax=128
MemoryMax=256M
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ai-fleet-observatory-novnc
```

- [ ] **Step 3: Add the independently disableable lifecycle target**

Create `deploy/ai-fleet-observatory-novnc.target`:

```ini
[Unit]
Description=AI Fleet Observatory staging noVNC access
Documentation=https://github.com/bromoket/agentrouter-auto-checker
After=ai-fleet-observatory.service
Wants=ai-fleet-observatory.service
Upholds=ai-fleet-observatory-vnc.service ai-fleet-observatory-novnc.service

[Install]
WantedBy=multi-user.target
```

`Upholds=` requires systemd 249 or newer; the Xeon runs systemd 255. The target continuously restores either inactive or failed companion and remains active across main-service restarts because it only `Wants=` Observatory. `PartOf=` stops both companions when the target is stopped, while companion failure never propagates to the target or main service.

- [ ] **Step 4: Verify units on the Ubuntu target**

Copy the four unit files to temporary names on `bkserver`, then run:

```bash
sudo systemd-analyze verify \
  /tmp/ai-fleet-observatory.service \
  /tmp/ai-fleet-observatory-vnc.service \
  /tmp/ai-fleet-observatory-novnc.service \
  /tmp/ai-fleet-observatory-novnc.target
```

Expected: exit 0 with no unit syntax, dependency-cycle, executable, or hardening errors. Delete the temporary files after verification.

- [ ] **Step 5: Commit the companion units**

```bash
git add deploy/ai-fleet-observatory-vnc.service \
  deploy/ai-fleet-observatory-novnc.service \
  deploy/ai-fleet-observatory-novnc.target
git commit -m "feat: add staging noVNC companion services"
```

---

### Task 3: Deployment and Rollback Documentation

**Files:**
- Modify: `docs/ubuntu-deployment.md:263-303`

**Interfaces:**
- Consumes: Unit files and loopback ports from Tasks 1-2.
- Produces: Repeatable install, access, verification, and narrow rollback procedures.

- [ ] **Step 1: Document package and unit installation**

Add a `Permanent staging noVNC access` subsection after the existing staging Tailscale Serve instructions with these commands:

```bash
sudo apt-get update
sudo apt-get install -y x11vnc novnc websockify
sudo cp /opt/ai-fleet-observatory/deploy/ai-fleet-observatory.service /etc/systemd/system/
sudo cp /opt/ai-fleet-observatory/deploy/ai-fleet-observatory-vnc.service /etc/systemd/system/
sudo cp /opt/ai-fleet-observatory/deploy/ai-fleet-observatory-novnc.service /etc/systemd/system/
sudo cp /opt/ai-fleet-observatory/deploy/ai-fleet-observatory-novnc.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ai-fleet-observatory-novnc.target
sudo systemctl restart ai-fleet-observatory.service
sudo systemctl start ai-fleet-observatory-novnc.target
```

State that noVNC controls the authenticated worker desktop and is an administrative surface available to identities allowed by the tailnet ACL.

- [ ] **Step 2: Document additive Tailscale Serve configuration**

Add:

```bash
sudo tailscale serve --bg --yes --https=443 \
  --set-path=/observatory-vnc/ http://127.0.0.1:6080
sudo tailscale serve status --json
```

Require the status to retain `/`, `/observatory/`, and `/observatory-vnc/`. Document this canonical URL:

```text
https://bkserver.tailbbaa91.ts.net/observatory-vnc/vnc.html?autoconnect=true&resize=scale&path=observatory-vnc/websockify
```

- [ ] **Step 3: Document checks and narrow rollback**

Add listener checks:

```bash
sudo ss -ltnp '( sport = :5900 or sport = :6080 )'
systemctl --no-pager --full status \
  ai-fleet-observatory.service \
  ai-fleet-observatory-novnc.target \
  ai-fleet-observatory-vnc.service \
  ai-fleet-observatory-novnc.service
```

Require only `127.0.0.1:5900` and `127.0.0.1:6080`. Add rollback commands that remove only this Serve path and these companions:

```bash
sudo tailscale serve --yes --https=443 --set-path=/observatory-vnc/ off
sudo systemctl disable --now ai-fleet-observatory-novnc.target
```

State that `/` and `/observatory/` must still exist after rollback. Do not recommend `tailscale serve reset` or `tailscale serve clear`, because either would remove unrelated handlers.

- [ ] **Step 4: Commit deployment documentation**

```bash
git add docs/ubuntu-deployment.md
git commit -m "docs: document permanent tailnet noVNC access"
```

---

### Task 4: Repository Verification and Independent Review

**Files:**
- Review: all files changed in Tasks 1-3

**Interfaces:**
- Consumes: Complete implementation tree.
- Produces: Syntax, type, regression, and fresh-context review evidence before deployment.

- [ ] **Step 1: Run targeted configuration checks**

Run:

```bash
sh -n scripts/start-server.sh
git diff --check fbce627..HEAD
```

Expected: both commands exit 0.

- [ ] **Step 2: Run repository checks**

Run:

```bash
bun run typecheck
bun test
```

Expected: TypeScript exits 0 and the full Bun suite has zero failures. The repository has no `build` script, so do not invent or run one.

- [ ] **Step 3: Request one independent review**

Use one routine `reviewer` with fresh context. Scope it to startup isolation, systemd dependency direction, loopback-only exposure, Tailscale route preservation, rollback correctness, and production non-regression. Fix every confirmed issue and rerun Steps 1-2; do not stack reviewers.

---

### Task 5: Deploy and Prove the Real Surface

**Files:**
- Deploy from: `/opt/ai-fleet-observatory`
- Install to: `/etc/systemd/system/ai-fleet-observatory*.service`

**Interfaces:**
- Consumes: Reviewed commits from Tasks 1-4 and Ubuntu packages `x11vnc`, `novnc`, `websockify`.
- Produces: Permanent tailnet URL controlling the active worker display and a successful authoritative AgentRouter account run.

- [ ] **Step 1: Push and fast-forward the Xeon checkout**

```bash
git push origin main
ssh bkserver@bkserver.tailbbaa91.ts.net \
  'sudo -u agentrouter git -C /opt/ai-fleet-observatory pull --ff-only'
```

Expected: Xeon revision equals local `HEAD`; remote worktree is clean.

- [ ] **Step 2: Replace temporary diagnostics with permanent units**

Stop the three OMP-managed diagnostics `xeon-x11vnc`, `xeon-novnc`, and `xeon-novnc-tunnel` before binding permanent ports. Then run on the Xeon:

```bash
sudo apt-get install -y x11vnc novnc websockify
sudo cp /opt/ai-fleet-observatory/deploy/ai-fleet-observatory.service /etc/systemd/system/
sudo cp /opt/ai-fleet-observatory/deploy/ai-fleet-observatory-vnc.service /etc/systemd/system/
sudo cp /opt/ai-fleet-observatory/deploy/ai-fleet-observatory-novnc.service /etc/systemd/system/
sudo cp /opt/ai-fleet-observatory/deploy/ai-fleet-observatory-novnc.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable ai-fleet-observatory-novnc.target
sudo systemctl restart ai-fleet-observatory.service
sudo systemctl start ai-fleet-observatory-novnc.target
```

Expected: the main unit, lifecycle target, and both companion services are active. There are no ad-hoc x11vnc/websockify processes outside the permanent unit cgroups.

- [ ] **Step 3: Add the Serve path without replacing existing handlers**

```bash
sudo tailscale serve --bg --yes --https=443 \
  --set-path=/observatory-vnc/ http://127.0.0.1:6080
sudo tailscale serve status --json
```

Expected: handlers `/`, `/observatory/`, and `/observatory-vnc/` all exist on `bkserver.tailbbaa91.ts.net:443`.

- [ ] **Step 4: Verify process, listener, and failure boundaries**

```bash
systemctl is-active \
  ai-fleet-observatory.service \
  ai-fleet-observatory-novnc.target \
  ai-fleet-observatory-vnc.service \
  ai-fleet-observatory-novnc.service
sudo ss -ltnp '( sport = :5900 or sport = :6080 )'
```

Expected: four `active` lines; only IPv4 loopback listeners for ports 5900 and 6080. Stop each companion separately and confirm the active target restores it while `ai-fleet-observatory.service` stays active.

- [ ] **Step 5: Verify reconnect across an Observatory restart**

Open the canonical URL from a tailnet browser and confirm the actual worker canvas appears. Restart `ai-fleet-observatory.service`; confirm noVNC disconnects temporarily and reconnects after Xvfb returns without changing the URL or repairing server state.

- [ ] **Step 6: Complete the human WAF gesture and trigger a check**

Start a manual AgentRouter check from the dashboard. When the worker displays AgentRouter Access Verification, use noVNC to complete the slider manually. Do not automate or synthesize the gesture.

Expected: the verification page closes, the worker retries `/api/user/self`, and the run finishes instead of timing out with `AgentRouter Access Verification was not completed`.

- [ ] **Step 7: Verify authoritative balance persistence**

Inspect the latest account run and its API-call diagnostics in `/var/lib/ai-fleet-observatory/data/checks.sqlite`. Confirm:

- run status is successful;
- `/api/user/self` is recorded as JSON rather than the verification HTML;
- returned user ID matches the authenticated account;
- persisted balance, consumption, and request count derive from numeric authoritative fields;
- no value came from local-storage zeros or visible dashboard money cards.

- [ ] **Step 8: Final cleanup and state proof**

Close the browser relay tab. Confirm local status contains only pre-existing unrelated user files, the Xeon checkout is clean, all permanent units remain active, the Serve route remains present, and no SSH tunnel or ad-hoc bridge process remains.
