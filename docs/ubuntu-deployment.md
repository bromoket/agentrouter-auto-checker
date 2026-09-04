# Ubuntu deployment and operations

The production layout uses a native `systemd` service instead of Docker. Persistent Chromium profiles and
Playwright's browser sandbox are simpler to operate this way, while the dedicated `agentrouter` account and
systemd hardening keep the monitor isolated from the other Xeon workloads.

---

## 1. Production vs. Staging Layout

Production identity (service name, Tailscale endpoint, and persistent account browser sessions) must remain
stable and isolated from testing or staging workloads.

| Property | Production (`agentrouter-monitor`) | Staging / Burn-in (`ai-fleet-observatory`) |
| --- | --- | --- |
| **Systemd Service** | `agentrouter-monitor.service` | `ai-fleet-observatory.service` |
| **Service User** | `agentrouter` (`agentrouter:agentrouter`) | `agentrouter` (`agentrouter:agentrouter`) |
| **Repository Checkout** | `/opt/agentrouter-monitor` (read-only) | `/opt/ai-fleet-observatory` (read-only) |
| **Environment File** | `/etc/agentrouter-monitor/env` (root:root 0600) | `/etc/ai-fleet-observatory/env` (root:root 0600) |
| **Runtime Data Directory** | `/var/lib/agentrouter-monitor/data` | `/var/lib/ai-fleet-observatory/data` |
| **Database Path** | `/var/lib/agentrouter-monitor/data/checks.sqlite` | `/var/lib/ai-fleet-observatory/data/checks.sqlite` and `/var/lib/ai-fleet-observatory/data/observatory.sqlite` |
| **Backups Directory** | `/var/lib/agentrouter-monitor/data/backups` | `/var/lib/ai-fleet-observatory/data/backups` |
| **Playwright Browsers** | `/var/lib/agentrouter-monitor/ms-playwright` | `/var/lib/ai-fleet-observatory/ms-playwright` |
| **Dashboard Binding** | `http://100.127.29.78:8456` (Tailscale) | `http://127.0.0.1:8458` (Tailscale Serve HTTPS) |
| **Telegram Alerts** | Production Bot / Chat ID | Dedicated staging bot or disabled |

Never copy `data/accounts.json`, `data/states`, browser profiles, or SQLite into Git.

---

## 2. Installation and Initial Setup

### Step 1: Create the unprivileged system user
```bash
sudo useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/agentrouter-monitor agentrouter
sudo mkdir -p /var/lib/agentrouter-monitor/data /var/lib/agentrouter-monitor/ms-playwright /var/lib/agentrouter-monitor/cache
sudo chown -R agentrouter:agentrouter /var/lib/agentrouter-monitor
sudo chmod 0700 /var/lib/agentrouter-monitor /var/lib/agentrouter-monitor/data
```

### Step 2: Deploy code checkout
Clone the repository to `/opt/agentrouter-monitor` using a read-only deploy key:
```bash
sudo git clone git@github.com:bromoket/agentrouter-auto-checker.git /opt/agentrouter-monitor
cd /opt/agentrouter-monitor
```

### Step 3: Install runtimes and dependencies
Install Bun (1.3.14+) at `/usr/local/bin/bun` and private Node.js 24 LTS runtime at `/opt/agentrouter-runtime/node`:
```bash
sudo bun install --frozen-lockfile
sudo bunx playwright install-deps chromium
sudo -u agentrouter PLAYWRIGHT_BROWSERS_PATH=/var/lib/agentrouter-monitor/ms-playwright bunx playwright install chromium
```

### Step 4: Configure environment metadata (Root-owned mode `0600`)
The environment configuration file `/etc/agentrouter-monitor/env` must be owned by `root:root` with permissions `0600`.
Systemd reads `EnvironmentFile=` as PID 1 (`root`) before dropping privileges to `User=agentrouter`. Keeping this file
root-owned prevents the unprivileged service user or any child process from tampering with or leaking environment metadata.

```bash
sudo mkdir -p /etc/agentrouter-monitor
sudo cp /opt/agentrouter-monitor/deploy/agentrouter-monitor.env.example /etc/agentrouter-monitor/env
sudo chown root:root /etc/agentrouter-monitor/env
sudo chmod 0600 /etc/agentrouter-monitor/env
```
Edit `/etc/agentrouter-monitor/env` to set production tokens, allowed origins, and Telegram credentials.

### Step 5: Install server settings
Copy the server settings template into the runtime data directory and lock its permissions:
```bash
sudo cp /opt/agentrouter-monitor/deploy/settings.server.example.json /var/lib/agentrouter-monitor/data/settings.json
sudo chown agentrouter:agentrouter /var/lib/agentrouter-monitor/data/settings.json
sudo chmod 0600 /var/lib/agentrouter-monitor/data/settings.json
```
Key production settings in `/var/lib/agentrouter-monitor/data/settings.json`:
- `automation.schedulerEnabled: true` — enables automated hourly checks
- `automation.intervalMinutes: 60` — interval between routine checks
- `automation.browserHeadless: true` — runs headless Chromium under Xvfb
- `automation.runOnStart: false` — prevents immediate check burst on service boot

### Step 6: Install accounts file
Copy the production accounts JSON into `/var/lib/agentrouter-monitor/data/accounts.json` with mode `0600`:
```bash
sudo chown agentrouter:agentrouter /var/lib/agentrouter-monitor/data/accounts.json
sudo chmod 0600 /var/lib/agentrouter-monitor/data/accounts.json
```

### Step 7: Install and start systemd service
```bash
sudo cp /opt/agentrouter-monitor/deploy/agentrouter-monitor.service /etc/systemd/system/agentrouter-monitor.service
sudo systemctl daemon-reload
sudo systemctl enable --now agentrouter-monitor
```

---

## 3. Database Operations: Backup, Restore, and Cutover

### Maintenance Locking and Exclusion Boundary

All mutating database scripts enforce an application-level **maintenance exclusion boundary**:
- Locks are created in every distinct source and destination parent as `.agentrouter-db-maintenance.lock`, after canonicalization, deduplication, and stable-order acquisition. A destructive audit locks the live database parent and backup parent for its full lifecycle.
- Code validates that existing parents are real, same-UID, non-group/world-writable directories. For a missing destination parent it validates the nearest existing ancestor first, creates missing directories as `0700`, revalidates them, and only then creates locks or staging files.
- The filesystem lock coordinates these maintenance scripts. Root or same-UID code that ignores the lock can still violate the exclusion boundary and must not rename sources, targets, sidecars, locks, or staging entries concurrently.
- Lock release verifies the lock inode and surfaces close/unlink failures. After process termination, inspect ownership, the recorded operation state, and active processes before manually removing a stale lock; never delete an unverified live lock.
- All file operations (lstat, realpath, SQLite open, VACUUM, cleanliness checks, and atomic links) are pinned to canonical paths derived from the trusted parent, preventing symlink or path-alias divergence during maintenance operations.

### Path Resolution and Precedence Rules

Database operations strictly separate legacy AgentRouter database maintenance from normalized AI Fleet Observatory database maintenance.

> **CRITICAL SEPARATION RULE**:
> Generic legacy database maintenance commands (`backup:db`, `restore:db`, `audit:db`) operate strictly on legacy AgentRouter `checks.sqlite` (via `DB_PATH`). They **DO NOT** protect, back up, or audit `observatory.sqlite`.
> Normalized Observatory database operations MUST use the dedicated `OBSERVATORY_DB_PATH` configuration and explicit normalized commands (`backup:observatory`, `restore:observatory`, `audit:observatory`, or CLI `--observatory`).

#### 1. Legacy Database Maintenance (`checks.sqlite` / `DB_PATH`)
- **Backup (`scripts/db-backup.mjs` / `bun run backup:db`)**:
  - **Source DB**: `DB_PATH` from environment; otherwise `${DATA_DIR ?? "data"}/checks.sqlite`.
  - **Default Backup Directory**: `${DATA_DIR ?? dirname(DB_PATH)}/backups`.
  - **Target Backup Destination**: Explicit CLI target argument (`argv[2]` / `[target-path]`); otherwise `${defaultBackupDir}/checks-<timestamp>.sqlite`.
- **Restore (`scripts/db-restore.mjs` / `bun run restore:db`)**:
  - **Source Backup DB**: First positional argument or `--source <path>` (required).
  - **Target Destination**: Explicit CLI `--target <path>` or second positional argument; otherwise `${DATA_DIR ?? "data"}/checks-restored-<timestamp>.sqlite`.
  - **Out-of-Place Execution**: The restore script strictly writes to a new, non-existent destination file. It refuses to touch or overwrite any existing database or sidecars (`-wal`, `-shm`, `-journal`).
- **Audit (`scripts/db-audit.mjs` / `bun run audit:db`)**:
  - **Database Path**: `DB_PATH` from environment; otherwise `${DATA_DIR ?? "data"}/checks.sqlite`.
  - **Backup Directory**: `${DATA_DIR ?? dirname(DB_PATH)}/backups`.
  - **Pre-cleanup Backup**: `${backupDirectory}/checks-before-false-zero-cleanup-<timestamp>.sqlite`.

#### 2. Normalized Observatory Database Maintenance (`observatory.sqlite` / `OBSERVATORY_DB_PATH`)
- **Backup (`bun run backup:observatory` / `scripts/db-backup.mjs --observatory`)**:
  - **Source DB**: `OBSERVATORY_DB_PATH` from environment; otherwise `${DATA_DIR ?? "data"}/observatory.sqlite`.
  - **Default Backup Directory**: `${DATA_DIR ?? dirname(OBSERVATORY_DB_PATH)}/backups`.
  - **Target Backup Destination**: Explicit CLI target argument; otherwise `${defaultBackupDir}/observatory-<timestamp>.sqlite`.
- **Restore (`bun run restore:observatory` / `scripts/db-restore.mjs --observatory`)**:
  - **Source Backup DB**: Positional argument or `--source <path>` (required).
  - **Target Destination**: Explicit CLI `--target <path>`; otherwise `${DATA_DIR ?? "data"}/observatory-restored-<timestamp>.sqlite`.
  - **Out-of-Place Execution**: Restores strictly out-of-place to a new non-existent file with integrity and foreign-key validation.
- **Audit (`bun run audit:observatory` / `scripts/db-audit.mjs --observatory`)**:
  - **Database Path**: `OBSERVATORY_DB_PATH` from environment; otherwise `${DATA_DIR ?? "data"}/observatory.sqlite`.
  - **Validations**: Fails closed (exits non-zero) on any `PRAGMA integrity_check` failure, `PRAGMA foreign_key_check` violation, prohibited colocated legacy table, missing migration ledger table, or invalid/drifted 6-entry `observatory_schema_migrations` ledger. Outputs diagnostic JSON on success.

---

### Database Backup

Backups use SQLite `VACUUM INTO` to create an isolated snapshot that includes committed WAL pages. The snapshot is created inside a private `0700` staging directory, captured by inode immediately after creation, hardened to `0600`, checked with both `integrity_check` and `foreign_key_check`, and published with an atomic no-replace hardlink. If failure occurs after publication, the target is retained; inspect it and any reported staging cleanup error, then retry with a fresh target name.

#### Legacy Database Backup:
```bash
cd /opt/agentrouter-monitor

# Automated / default backup (writes to /var/lib/agentrouter-monitor/data/backups/checks-<timestamp>.sqlite):
sudo -u agentrouter env DATA_DIR=/var/lib/agentrouter-monitor/data bun run backup:db

# Backup with custom destination filename:
sudo -u agentrouter env DATA_DIR=/var/lib/agentrouter-monitor/data bun run scripts/db-backup.mjs /var/lib/agentrouter-monitor/data/backups/pre-upgrade-backup.sqlite
```

#### Normalized Observatory Database Backup:
```bash
cd /opt/ai-fleet-observatory

# Default backup (writes to /var/lib/ai-fleet-observatory/data/backups/observatory-<timestamp>.sqlite):
sudo -u agentrouter env OBSERVATORY_DB_PATH=/var/lib/ai-fleet-observatory/data/observatory.sqlite bun run backup:observatory

# Backup with custom destination filename:
sudo -u agentrouter env OBSERVATORY_DB_PATH=/var/lib/ai-fleet-observatory/data/observatory.sqlite bun run scripts/db-backup.mjs --observatory /var/lib/ai-fleet-observatory/data/backups/pre-migration-observatory.sqlite
```

---

### Database Restore and Production Cutover

The restore tool strictly performs **out-of-place** restoration:
- Restores the backup snapshot into an explicit new, non-existent database file (e.g. `/var/lib/agentrouter-monitor/data/checks-restored-<timestamp>.sqlite` or `/var/lib/ai-fleet-observatory/data/observatory-restored-<timestamp>.sqlite`).
- Acquires deduplicated source/destination maintenance locks and requires `target`, `-wal`, `-shm`, and `-journal` to remain absent through the final identity check.
- Uses SQLite `VACUUM INTO` in private `0700` staging, verifies source identity across snapshot phases, validates integrity and foreign keys on the staged inode, hardens it to `0600`, and publishes via atomic hardlink (`fs.link`).
- Post-publication failure contract: the target is intentionally **never unlinked**. Cleanup unlinks only the identity-verified staged inode and removes its empty directory; a cleanup failure is returned alongside the primary failure. Inspect retained artifacts and use a fresh destination for retry.
- The existing production or staging database file remains completely untouched during the restore.

#### Step-by-step Restore & Cutover Procedure (Legacy `checks.sqlite`):

1. **Dry-Run Validation** (optional): the destination parent must already exist and be trusted. Dry-run verifies the source and advisory destination cleanliness without creating directories, locks, or files.
   ```bash
   cd /opt/agentrouter-monitor
   sudo -u agentrouter env DATA_DIR=/var/lib/agentrouter-monitor/data bun run restore:db -- /var/lib/agentrouter-monitor/data/backups/snapshot.sqlite --dry-run
   ```

2. **Restore to a New Database File**:
   ```bash
   cd /opt/agentrouter-monitor
   sudo -u agentrouter env DATA_DIR=/var/lib/agentrouter-monitor/data bun run restore:db -- /var/lib/agentrouter-monitor/data/backups/snapshot.sqlite
   # Output: Successfully restored database to new path: /var/lib/agentrouter-monitor/data/checks-restored-<timestamp>.sqlite
   ```

3. **Cutover Service to Restored Database**:
   Update `DB_PATH` in `/etc/agentrouter-monitor/env` to point to the newly restored file:
   ```bash
   sudo nano /etc/agentrouter-monitor/env
   # Set: DB_PATH=/var/lib/agentrouter-monitor/data/checks-restored-<timestamp>.sqlite

   # Restart the service to apply:
   sudo systemctl restart agentrouter-monitor
   ```

### Destructive Audit Cleanup (Legacy Only)

`bun run audit:db -- --delete-false-zero` acquires the database and backup-directory maintenance locks, enables WAL, and starts `BEGIN IMMEDIATE` before its authoritative candidate query. That SQLite write reservation is held while the hardened backup is created and verified and while `DELETE ... WHERE <full predicate> RETURNING id` runs. Success commits once; every failure rolls back before releasing locks. This blocks normal SQLite writers from entering the backup/delete gap.

*(Note: `--delete-false-zero` is legacy-only; normalized Observatory tables do not use free-text metrics or false-zero state and reject this flag).*

```bash
cd /opt/agentrouter-monitor
sudo -u agentrouter env DATA_DIR=/var/lib/agentrouter-monitor/data bun run audit:db -- --delete-false-zero
```

---

### Reverting / Switching Database Path

Because each database exists in its own distinct SQLite file, switching the active database is done by changing `DB_PATH` (or `OBSERVATORY_DB_PATH`):
1. **History Retention Note**: When you switch `DB_PATH` back to the original database, any new check runs recorded into the restored database remain in that file and do not automatically merge into the original database. Take a backup before switching if you need to retain both runs:
   ```bash
   sudo -u agentrouter env DB_PATH=/var/lib/agentrouter-monitor/data/checks-restored-<timestamp>.sqlite bun run backup:db
   ```
2. **Revert Active DB Path**:
   ```bash
   sudo nano /etc/agentrouter-monitor/env
   # Set: DB_PATH=/var/lib/agentrouter-monitor/data/checks.sqlite
   ```
3. **Restart the service**:
   ```bash
   sudo systemctl restart agentrouter-monitor
   ```

## 4. Health Monitoring and Limitations

Verify service status:
```bash
sudo systemctl status agentrouter-monitor
sudo journalctl -u agentrouter-monitor -f
curl --fail http://100.127.29.78:8456/api/health
```

### Health Check Limitations
The `/api/health` endpoint verifies:
- Process lifecycle, HTTP listener responsiveness, and scheduler state.

**Limitations:**
- `/api/health` does **not** test end-to-end browser automation, GitHub login validity, AgentRouter live API connectivity, or upstream network reachability.
- If upstream AgentRouter encounters CAPTCHA or errors during a check run, `/api/health` will still return `200 OK` as long as the dashboard server process itself is healthy.
- Full automation health must be observed via:
  1. Dashboard UI (`http://100.127.29.78:8456`);
  2. Telegram alert channels;
  3. Systemd journal logs (`journalctl -u agentrouter-monitor -n 100`).

---

## 5. Read-Only Parallel Burn-In / Staging Isolation

AI Fleet Observatory staging uses an independent checkout, systemd identity, environment,
state directory, and database. It MUST NOT reuse production files or credentials.

### Staging installation

```bash
sudo mkdir -p /opt/ai-fleet-observatory /var/lib/ai-fleet-observatory/data /var/lib/ai-fleet-observatory/ms-playwright /var/lib/ai-fleet-observatory/cache /var/lib/ai-fleet-observatory/collector /etc/ai-fleet-observatory
sudo chown -R agentrouter:agentrouter /var/lib/ai-fleet-observatory
sudo chmod 0700 /var/lib/ai-fleet-observatory /var/lib/ai-fleet-observatory/data /var/lib/ai-fleet-observatory/collector
sudo git clone git@github.com:bromoket/agentrouter-auto-checker.git /opt/ai-fleet-observatory
sudo bun install --cwd /opt/ai-fleet-observatory --frozen-lockfile
sudo cp /opt/ai-fleet-observatory/deploy/ai-fleet-observatory.env.example /etc/ai-fleet-observatory/env
sudo chown root:root /etc/ai-fleet-observatory/env
sudo chmod 0600 /etc/ai-fleet-observatory/env
sudo cp /opt/ai-fleet-observatory/deploy/ai-fleet-observatory.service /etc/systemd/system/ai-fleet-observatory.service
sudo systemctl daemon-reload
```

Replace all owner, Observatory HMAC, and broker placeholders with staging credentials before
enabling the service. Set `OBSERVATORY_ENABLED=true` only after broker credentials are set;
leave `OMP_QUOTA_ENABLED=false` unless the separate legacy poller is explicitly intended.
```bash
sudoedit /etc/ai-fleet-observatory/env
sudo systemctl enable --now ai-fleet-observatory
sudo systemctl status ai-fleet-observatory
sudo journalctl -u ai-fleet-observatory -f
```

The dashboard binds only to `127.0.0.1:8458`; never expose it through plaintext
non-loopback HTTP. Mount it at the dedicated `/observatory/` path with Tailscale Serve
TLS. This command MUST preserve the existing `/` handler (currently port 8093):

```bash
sudo tailscale serve --bg --yes --https=443 --set-path=/observatory/ http://127.0.0.1:8458
sudo tailscale serve status --json
```

Open `https://bkserver.tailbbaa91.ts.net/observatory/`. Tailscale Serve strips the
mount prefix before proxying; dashboard assets and API requests are therefore relative
to the mounted path. Confirm the status still lists both `/` and `/observatory/`
handlers before proceeding.

### Permanent staging noVNC access

The noVNC endpoint is an administrative control surface for the authenticated browser used by
the staging worker. Every identity allowed by the tailnet ACL can control that browser. x11vnc
and websockify remain bound to IPv4 loopback; Tailscale Serve provides the only remote route.
Never enable Funnel or bind either companion to a LAN, public, or wildcard address.

Install the Ubuntu packages and versioned units:

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

The lifecycle target uses `Upholds=` to restore either companion while remote access is
enabled and remains active across Observatory restarts. This requires systemd 249 or newer;
the staging Xeon runs systemd 255. Companion failure never propagates back to Observatory,
and disabling the target stops both companions.

Add the noVNC mount without replacing the existing handlers:

```bash
sudo tailscale serve --bg --yes --https=443 \
  --set-path=/observatory-vnc/ http://127.0.0.1:6080
sudo tailscale serve status --json
```

The Serve status MUST contain `/`, `/observatory/`, and `/observatory-vnc/`. Open:

```text
https://bkserver.tailbbaa91.ts.net/observatory-vnc/vnc.html?autoconnect=true&resize=scale&path=observatory-vnc/websockify
```

The explicit `path` query keeps the noVNC WebSocket request under the mounted Serve prefix.
Verify the services and loopback-only listeners:

```bash
sudo ss -ltnp '( sport = :15900 or sport = :6080 )'
systemctl --no-pager --full status \
  ai-fleet-observatory.service \
  ai-fleet-observatory-novnc.target \
  ai-fleet-observatory-vnc.service \
  ai-fleet-observatory-novnc.service
```

Only `127.0.0.1:15900` and `127.0.0.1:6080` are valid. To roll back, remove only this Serve
path and disable only its companions:

```bash
sudo tailscale serve --yes --https=443 --set-path=/observatory-vnc/ off
sudo systemctl disable --now ai-fleet-observatory-novnc.target
sudo tailscale serve status --json
```

After rollback, `/` and `/observatory/` MUST remain present. Do not use `tailscale serve reset`
or `tailscale serve clear`; either command would remove unrelated handlers.

Collector HTTPS ingestion remains disabled until nginx TLS, the registered collector
credentials, and Node IDs are provisioned. Configure the staging-only proxy with
`deploy/ai-fleet-observatory.nginx.conf.example`: bind nginx to
`100.127.29.78:8457`, proxy only to `127.0.0.1:8457`, cap aggregate headers at 8 KiB
and bodies at 262144 bytes, and overwrite (never pass through) `X-AFO-Source-IP`
with `$remote_addr` and `X-AFO-Proxy-Token` from a root-only include. The service-owned
token parent must be mode `0700`, its token file mode `0600`, and the same canonical
32-byte base64url secret must be used by nginx and `COLLECTOR_PROXY_TOKEN_FILE`.

sudo nginx -t
curl --resolve bkserver.tailbbaa91.ts.net:8457:100.127.29.78 \
  -H 'X-AFO-Source-IP: 192.0.2.1' -H 'X-AFO-Proxy-Token: invalid' \
  -sS -o /dev/null -w 'collector proxy status=%{http_code}\n' \
  https://bkserver.tailbbaa91.ts.net:8457/v1/collector/session-batches
```

Only after that smoke check and source identity registration may `COLLECTOR_ENABLED=true`
be set. Do not use Tailscale Serve or Funnel for collector port 8457; dashboard Serve
remains the only Serve route.

Keep staging Observatory and collector ingestion disabled until registration is complete.
Run a complete read-only burn-in before cutover; switch paths only after approval.
Production service, checkout, environment, state, and database remain untouched.

### Staging Observatory Database Maintenance, Pre-Migration Backup, and Rollback

AI Fleet Observatory migrations require a mandatory whole-file pre-migration backup before applying schema changes or upgrading Observatory versions.

#### 1. Mandatory Pre-Migration Backup
Before upgrading the repository checkout or restarting the service with new migrations:
```bash
cd /opt/ai-fleet-observatory
sudo -u agentrouter env OBSERVATORY_DB_PATH=/var/lib/ai-fleet-observatory/data/observatory.sqlite bun run backup:observatory
# Output: /var/lib/ai-fleet-observatory/data/backups/observatory-<timestamp>.sqlite
```

#### 2. Verified Out-of-Place Restore
If a migration issue or schema mismatch occurs, restore out-of-place to a new verified database:
```bash
cd /opt/ai-fleet-observatory
# Dry run validation:
sudo -u agentrouter env DATA_DIR=/var/lib/ai-fleet-observatory/data bun run restore:observatory -- /var/lib/ai-fleet-observatory/data/backups/observatory-<timestamp>.sqlite --dry-run

# Full out-of-place restore:
sudo -u agentrouter env DATA_DIR=/var/lib/ai-fleet-observatory/data bun run restore:observatory -- /var/lib/ai-fleet-observatory/data/backups/observatory-<timestamp>.sqlite
# Output: Successfully restored database to new path: /var/lib/ai-fleet-observatory/data/observatory-restored-<timestamp>.sqlite
```

#### 3. Post-Restore Audit Verification
Verify integrity, foreign keys, and migration ledger before cutover (audit fails closed and exits non-zero if any invariant is violated):
```bash
sudo -u agentrouter env OBSERVATORY_DB_PATH=/var/lib/ai-fleet-observatory/data/observatory-restored-<timestamp>.sqlite bun run audit:observatory
```

#### 4. Service Cutover and Rollback Procedure

**To cut over to the restored database:**
Update `OBSERVATORY_DB_PATH` in `/etc/ai-fleet-observatory/env` to point to the newly restored and audited runtime database file:
```bash
sudo nano /etc/ai-fleet-observatory/env
# Set: OBSERVATORY_DB_PATH=/var/lib/ai-fleet-observatory/data/observatory-restored-<timestamp>.sqlite

# Restart staging service:
sudo systemctl restart ai-fleet-observatory
sudo systemctl status ai-fleet-observatory
```

**Rollback Procedure (Restoring from an Immutable Backup):**
NEVER point `OBSERVATORY_DB_PATH` directly at an immutable backup artifact in `data/backups/`. Running the write-capable service directly on a backup file risks mutating the pre-migration snapshot during startup migrations or normal operations.

Always follow the verified out-of-place restore procedure:
1. Restore the pre-migration backup out-of-place to a new non-existent runtime database:
```bash
cd /opt/ai-fleet-observatory
sudo -u agentrouter env DATA_DIR=/var/lib/ai-fleet-observatory/data bun run restore:observatory -- /var/lib/ai-fleet-observatory/data/backups/observatory-<timestamp>.sqlite
# Output: Successfully restored database to new path: /var/lib/ai-fleet-observatory/data/observatory-restored-<timestamp>.sqlite
```
2. Verify the restored database with the fail-closed Observatory audit:
```bash
sudo -u agentrouter env OBSERVATORY_DB_PATH=/var/lib/ai-fleet-observatory/data/observatory-restored-<timestamp>.sqlite bun run audit:observatory
```
3. Update `OBSERVATORY_DB_PATH` in `/etc/ai-fleet-observatory/env` to point to the restored runtime file:
```bash
sudo nano /etc/ai-fleet-observatory/env
# Set: OBSERVATORY_DB_PATH=/var/lib/ai-fleet-observatory/data/observatory-restored-<timestamp>.sqlite
```
4. Restart the service to apply the restored database:
```bash
sudo systemctl restart ai-fleet-observatory
sudo systemctl status ai-fleet-observatory
```
The original backup in `/var/lib/ai-fleet-observatory/data/backups/` remains immutable, read-only, and untouched.

### Staging Teardown and Production Protection

Remove the staging-only nginx site and token include before restarting production; do not
remove or edit any legacy production unit, environment, state, or database files.

```bash
sudo rm -f /etc/nginx/sites-enabled/ai-fleet-observatory-collector.conf
sudo nginx -t
sudo systemctl reload nginx
```

Stop only the staging service and restart the untouched production service/database:

```bash
sudo systemctl disable --now ai-fleet-observatory
sudo systemctl restart agentrouter-monitor
sudo systemctl status agentrouter-monitor
sudo journalctl -u agentrouter-monitor -n 100
```
