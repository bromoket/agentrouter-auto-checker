# AgentRouter Monitor

A Bun + TypeScript service that checks any number of AgentRouter accounts on a configurable schedule:

1. Open the AgentRouter login page.
2. Start the real GitHub OAuth popup flow.
3. Select the configured GitHub username or sign in with its username and password.
4. Read the visible account cards on `/console/` and `/console/topup`, refreshing false `$0.00` values.
5. Save normalized metrics and model usage to SQLite.
6. Capture the AgentRouter dashboard.
7. Open the visible profile menu, click **Quit**, confirm `/login`, and persist the reusable GitHub browser state.

The web UI manages accounts and scheduling, relays GitHub Mobile approvals, shows live stage-by-stage progress, cancels active workers, and presents an all-accounts command center plus detailed interactive charts. It tracks confirmed grant events separately from balance observations and exports sanitized analysis data. It binds only to `127.0.0.1` by default; production can bind to one exact private interface address with an explicit browser-origin allowlist.

## Requirements

- Bun 1.3 or newer
- Node.js 20 or newer for the isolated Playwright worker (Node.js 24 LTS recommended)
- Chromium installed through Playwright

```powershell
bun install
bun run install:browsers
```

## Accounts

Credentials are stored in `data/accounts.json`, which is ignored by Git. Copy `accounts.example.json` to that location, or start the web UI and add accounts there:

```powershell
bun run dashboard
```

The monitor opens <http://127.0.0.1:3100> automatically by default. If the account file does not exist, the UI opens in onboarding mode. The API never returns passwords.

The file accepts any number of enabled accounts:

```json
{
  "version": 1,
  "accounts": [
    {
      "id": "primary",
      "label": "Primary account",
      "githubUsername": "github-username",
      "githubPassword": "github-password",
      "enabled": true,
      "runOrder": 0
    }
  ]
}
```

Account ids must contain lowercase letters, digits, `_`, or `-`. GitHub email addresses are intentionally unsupported.

## Run modes

Run the dashboard and scheduler:

```powershell
bun run start
```

Run one complete check cycle and exit:

```powershell
bun run once
```

Run only the dashboard and use its **Run now** controls:

```powershell
bun run dashboard
```

## GitHub Mobile approval, 2FA, and saved sessions

The worker targets the visible GitHub sign-in form and exact account-picker button; it never clicks a generic or hidden submit button. `DISABLE_WEBAUTHN=true` is the default. In the dedicated automation profile, public-key credential calls are rejected before GitHub page scripts run, preventing native Windows WebAuthn/security-key dialogs while leaving Windows Hello and normal browsers unchanged.

When GitHub Mobile is available for the account, a visible initialization check displays the approval dialog in the local dashboard. GitHub may send a push that only needs approval, or it may also display a two-digit number that the dashboard relays to the phone. The countdown updates independently of network polling, and the worker follows GitHub's post-approval Continue/redirect states. Do not rely on a first-time approval completing in headless Chromium; initialize each dedicated profile visibly.

Every cycle exposes its current account, stage, explanatory message, percentage, and recent event timeline. **Stop** terminates the active browser worker and prevents remaining accounts from running.

AgentRouter currently protects its internal data request with an Aliyun **Access Verification** slider on some sessions. Its deployed dashboard can consequently show only `错误` or render `$0.00` for both balance and consumption. The worker uses AgentRouter's visible pages as the source of truth and refreshes suspicious double-zero money cards up to three times. If an active account still shows both as zero, it refuses to save a false snapshot. Verification state remains in the account's persistent profile; headless mode cannot complete a newly issued interactive verification.

Each account owns an ACL-protected, persistent Chromium profile in `data/browser-profiles/<account-id>/`. This retains GitHub cookies, local storage, IndexedDB, cache, and device trust after logging out of AgentRouter. `data/states/<account-id>.json` remains a restricted GitHub-cookie backup and migration source. The browser process closes after every check, but its profile survives for the next cycle. Set `BROWSER_CHANNEL=chrome` only on machines with Google Chrome installed in a Playwright-recognized location.

## Ubuntu server and verified headless route

Pure headless Chromium was verified end-to-end for both configured accounts after their dedicated profiles had been initialized: OAuth completed, `/console/` and `/console/topup` agreed on the money values, **Quit** logged out, and the profiles remained reusable. Use the non-persisting probe before enabling scheduled headless checks:

```bash
bunx playwright install --with-deps chromium
bun run probe:headless <account-id-or-github-username>
```

The probe exercises a complete real check and logout but does not write its result to production SQLite. On a fresh Ubuntu host, start with headed Chromium under Xvfb (`xvfb-run bun run start`) and use a remote desktop when AgentRouter issues its slider. After every account has a trusted dedicated profile, run the probe; enable **Headless Chromium** only when it succeeds. Do not point Playwright at a normal Chrome profile, and do not run two processes against the same account profile.

### Production deployment

The Xeon deployment uses a dedicated, hardened `systemd` service instead of Docker, binds only to its Tailscale IP on port `8456`, and keeps credentials, SQLite, GitHub state, and Chromium profiles under `/var/lib/agentrouter-monitor`. See [docs/ubuntu-deployment.md](docs/ubuntu-deployment.md) for the layout, installation, health check, logs, upgrades, and headed recovery route.

## Schedule and collection settings

Use **Schedule & settings** in the dashboard to control:

- Whether scheduled cycles are enabled
- Cycle interval and delay between accounts
- Per-account run order
- Run-on-start and automatic dashboard opening
- Visible/headless browser mode and GitHub Mobile approval timeout (visible is the reliable default)
- Screenshot capture and activity lookback window

Settings are stored in `data/settings.json`; credentials remain separate in `data/accounts.json`.

## Data collected

- Visible Console balance, consumption, request count, statistical calls/quota/tokens, RPM, and TPM
- Visible Wallet balance and consumption, used as a second money-value check
- Site user id/name from the completed AgentRouter callback
- Historical normalized snapshots and any previously captured model/usage series
- Confirmed daily sign-in grants parsed and deduplicated from AgentRouter type-4 system logs
- Per-endpoint status and latency
- Login, dashboard, and total duration
- Confirmed logout state and diagnostic screenshot path
- Per-run credit observations with balance/consumption deltas and elapsed time since the prior sample
- Session-reuse status for correlation with credit changes
- Every Console/Wallet money sample, retry timestamp, refresh count, and the route selected as the final money source

Use **Export analysis JSON** for a sanitized per-account dataset containing runs, metrics, usage points, confirmed grant events, credit observations, safe account facts, and endpoint timing. AgentRouter currently describes the `$25` event as a daily sign-in grant. Balance-change classifications remain observations only; a balance increase after a check does not prove that login or logout caused it.

After OAuth, the worker's collection and logout path is UI-driven: `/console/` → `/console/topup` → profile menu → **Quit** → `/login`. It does not directly call AgentRouter data or logout endpoints. `/api/user/token` remains strictly excluded because it resets the account token.

The worker does **not** call `/api/user/token` because that endpoint resets the account token. Token values and browser cookies are never written to SQLite.

## Validation

```powershell
bun run typecheck
bun test
bun run test:ui
bun run test:performance
bun run audit:db
bun audit
```

`test:ui` validates Chromium, Firefox, and WebKit at desktop, tablet, and phone sizes. Install all engines with `bunx playwright install chromium firefox webkit` before running it.

## Security notes

- `data/accounts.json` contains plaintext passwords because this project explicitly uses a credential file. Restrict access to the local Windows user and do not sync or commit it.
- `data/states/` contains authenticated GitHub browser state and must be protected like a secret.
- The dashboard defaults to loopback, rejects wildcard binds, validates the Host and mutation Origin against an explicit allowlist, uses strict security headers, validates all account ids and screenshot paths, and never sends passwords back to the browser.
- Rotate the two passwords if this workspace or conversation transcript is ever shared.

## Roadmap

- Telegram bot notifications for confirmed credit grants, check failures, stalled verification, and service-health events.
