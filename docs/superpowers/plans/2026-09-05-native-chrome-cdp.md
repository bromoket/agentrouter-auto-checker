# Native Chrome CDP Cutover Implementation Plan

> **For implementation:** Execute tasks in order. Use TDD at each behavior boundary. Preserve AgentRouter authoritative-money and challenge handling unchanged.

**Goal:** Replace every AgentRouter Playwright-launched browser with an owned Google Chrome Stable process reached over loopback CDP, so real manual input is not rejected solely because the browser declares Playwright automation.

**Architecture:** A single Node-compatible `scripts/native-chrome-host.mjs` is the only process that launches Chrome and constructs Chrome arguments. Full account workers and the minute read-session manager each spawn that host, consume one bounded readiness record, connect with Playwright `chromium.connectOverCDP({ endpointURL, noDefaults: true })`, and disconnect before asking the host to terminate its owned Chrome process group. Full checks use each account's persistent profile on port 19222. Minute polling uses one dedicated persistent profile on port 19223 and retains per-account isolated contexts loaded from monitor storage state.

**Runtime:** Bun/TypeScript for Observatory, private Node-compatible runtime for worker/host scripts, Playwright only as the CDP client, official Google Chrome Stable, systemd/Xvfb/noVNC on Ubuntu.

---

## Task 1: Clean configuration and settings cutover

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`
- Modify: `src/settings.ts`
- Modify: `src/settings.test.ts`
- Modify: `src/account-checker.ts`
- Modify: `src/coordinator.ts`
- Modify: `src/coordinator.test.ts`
- Modify: `src/dashboard.test.ts`
- Modify: `src/telegram.test.ts`
- Modify: `src/observatory/delivery.test.ts`
- Modify: `src/web/dashboard.js`
- Modify: `deploy/settings.server.example.json`

**Step 1: Add failing configuration tests**

Extend `src/config.test.ts` to require:

- `BROWSER_EXECUTABLE` defaults to `/usr/bin/google-chrome-stable` on Linux and must be absolute.
- `BROWSER_WORKER_CDP_PORT=19222`, `BROWSER_POLLER_CDP_PORT=19223`, and both ports must be distinct unprivileged integers.
- Neither CDP port may equal dashboard, collector, noVNC HTTP 6080, noVNC RFB 15900, or a configured OMP broker port.
- `BROWSER_START_TIMEOUT_MS=30000` is bounded to a documented safe interval.
- `BROWSER_POLLER_PROFILE_DIR` defaults under `DATA_DIR` and a configured value must remain inside `DATA_DIR` after canonical path resolution.
- `BROWSER_CHANNEL` and `DISABLE_WEBAUTHN` no longer affect `AppConfig`.

Run: `bun test src/config.test.ts`
Expected: FAIL because the native-browser fields and validation do not exist.

**Step 2: Implement the native-browser configuration contract**

Replace `browserChannel` and `disableWebAuthn` in `AppConfig` with:

```ts
browserExecutable: string;
browserWorkerCdpPort: number;
browserPollerCdpPort: number;
browserStartTimeoutMs: number;
browserPollerProfileDir: string;
```

Add focused path/port validation in `loadConfig()`. Keep the CDP host fixed in code as `127.0.0.1`; do not make it configurable. Update test config fixtures across the named tests to the new required shape.

Run: `bun test src/config.test.ts`
Expected: PASS.

**Step 3: Add failing clean-settings tests**

Update `src/settings.test.ts` so saved and loaded automation settings contain no `browserHeadless` property even when an old version-1 file includes one. Assert the production template also omits it.

Run: `bun test src/settings.test.ts`
Expected: FAIL while `AutomationSettings.browserHeadless` remains.

**Step 4: Remove the obsolete setting end to end**

Remove `browserHeadless` from `AutomationSettings`, defaults, validation, coordinator override options, worker payload construction, dashboard settings serialization, template JSON, and affected fixtures. Old version-1 settings files remain readable because unknown keys are ignored; the next save drops the obsolete key. Do not increment the settings file version.

Run: `bun test src/settings.test.ts src/coordinator.test.ts src/dashboard.test.ts`
Expected: PASS.

**Step 5: Type-check the clean interface cutover**

Run: `bun run typecheck`
Expected: PASS with no stale AgentRouter `browserHeadless`, `browserChannel`, or `disableWebAuthn` callsite.

**Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts src/settings.ts src/settings.test.ts src/account-checker.ts src/coordinator.ts src/coordinator.test.ts src/dashboard.test.ts src/telegram.test.ts src/observatory/delivery.test.ts src/web/dashboard.js deploy/settings.server.example.json
git commit -m "refactor: replace AgentRouter browser controls"
```

---

## Task 2: Build the owned native Chrome host

**Files:**
- Create: `scripts/native-chrome-host.mjs`
- Create: `scripts/native-chrome-host.test.mjs`

**Step 1: Add failing protocol and argument tests**

Test the host through exported pure helpers plus a real fake executable subprocess. Cover:

- JSON startup input is one bounded object and rejects unknown/malformed/oversized records.
- executable path and profile path must be absolute; port is loopback-only, nonzero, and unprivileged; timeout is bounded.
- constructed arguments are exactly the five approved switches from the design.
- prohibited switches never appear: `--headless`, `--no-sandbox`, `--enable-automation`, automation-control overrides, WebGL/user-agent/proxy overrides.
- an occupied loopback port is rejected before spawn.
- `/json/version` must identify Google Chrome; Chromium or Chrome for Testing is rejected.
- readiness output is one bounded JSON record containing only protocol version, status, endpoint URL, product, and owned PID.
- EOF and signals terminate only the spawned fake process group; startup failures clean up the same owned group.

Run: `bun test scripts/native-chrome-host.test.mjs`
Expected: FAIL because the host does not exist.

**Step 2: Implement the host CLI**

Implement a Node-compatible ESM CLI with no Bun-only APIs. Use `node:child_process`, `node:net`, bounded line parsing, `fetch`, and explicit timers. On Linux launch Chrome detached into a new process group, retain the exact child PID, terminate `-pid` with `SIGTERM`, wait a bounded grace interval, then `SIGKILL` that same group only if still alive. Never enumerate processes by name. Keep stdin open as the ownership lease; EOF means stop.

Do not log credentials or full profile paths in user-facing failures. Keep detailed internal errors on stderr without dumping environment variables.

Run: `bun test scripts/native-chrome-host.test.mjs`
Expected: PASS.

**Step 3: Prove Node compatibility**

Run: `node --check scripts/native-chrome-host.mjs`
Expected: PASS.

**Step 4: Commit**

```bash
git add scripts/native-chrome-host.mjs scripts/native-chrome-host.test.mjs
git commit -m "feat: add owned native Chrome host"
```

---

## Task 3: Cut the full account worker over to CDP

**Files:**
- Modify: `scripts/agentrouter-worker.mjs`
- Modify: `src/account-checker.ts`
- Create: `scripts/agentrouter-worker-browser.test.mjs`

**Step 1: Add failing worker-browser lifecycle tests**

Extract only the worker's browser-host client boundary into exported functions without importing or executing the worker main loop during tests. Use a fake host script and fake CDP connector to assert:

- payload carries executable, worker port, startup timeout, and account profile; it carries no channel/headless/WebAuthn fields.
- host readiness must arrive before CDP attach.
- attach is exactly `chromium.connectOverCDP({ endpointURL, noDefaults: true })`.
- worker selects the single default persistent context and rejects zero or multiple default contexts.
- success, attach failure, timeout, cancellation, and account-check failure all disconnect Playwright first, close host stdin second, and await host exit last.
- the worker never calls `BrowserContext.close()` on the default CDP context.
- a retry may start a newly owned host only after the prior owned host is fully cleaned up.

Run: `bun test scripts/agentrouter-worker-browser.test.mjs`
Expected: FAIL before the CDP client boundary exists.

**Step 2: Replace Playwright launch with native-host attach**

Change `launchAccountContext()` to:

1. spawn the shared host with the configured Node runtime;
2. send validated startup JSON for the account profile and port 19222;
3. consume the bounded readiness record;
4. attach with `connectOverCDP` and `noDefaults: true`;
5. return a lifecycle owner containing `Browser`, default `BrowserContext`, host process, and cleanup method.

Remove WebAuthn JavaScript mutation and feature-flag injection. Preserve all login, visible Access Verification, authoritative user-ID, numeric-money, monitor-state, screenshot, challenge-broker, and result logic unchanged.

Update final cleanup to disconnect the CDP browser and stop the host rather than closing the default context. Keep the existing one-retry policy only for explicit launch/attach failures, with complete cleanup between attempts.

Run: `bun test scripts/agentrouter-worker-browser.test.mjs scripts/agentrouter-money.test.mjs`
Expected: PASS.

**Step 3: Verify worker syntax and project types**

Run:

```bash
node --check scripts/agentrouter-worker.mjs
bun run typecheck
```

Expected: both PASS.

**Step 4: Commit**

```bash
git add scripts/agentrouter-worker.mjs scripts/agentrouter-worker-browser.test.mjs src/account-checker.ts
git commit -m "feat: attach account checks to native Chrome"
```

---

## Task 4: Cut minute polling over to a persistent native Chrome host

**Files:**
- Modify: `src/agentrouter-session.ts`
- Create: `src/agentrouter-session.test.ts`

**Step 1: Add failing read-session lifecycle tests**

Inject a host factory and CDP connector. Test:

- first poll starts one poller host on the poller profile and port 19223, then attaches with `noDefaults: true`.
- different accounts receive different isolated contexts loaded from their own monitor storage-state files.
- unchanged storage-state mtime reuses the account context; a changed mtime closes and recreates only that account context.
- dropping one account does not close another account context or the shared poller browser.
- a disconnected browser invalidates every stale context and starts one fresh owned host before recreating the requested account context.
- failed attach/startup cleans up the owned host.
- `close()` closes account contexts, disconnects Playwright, closes host stdin, and awaits host exit in that order.
- no path calls `browser.close()` for a CDP-connected browser.

Run: `bun test src/agentrouter-session.test.ts`
Expected: FAIL before the new lifecycle is implemented.

**Step 2: Implement the poller host lifecycle**

Replace the `chromium.launch({ headless: true })` injection with a narrow native-host lifecycle interface. Keep one connected browser per manager and the existing per-account runtime map. Add a single reset path that clears stale runtimes, disconnects the old client, fully stops the old host, and can then start one replacement. Prevent concurrent polls from racing two hosts by serializing browser creation through one in-flight promise.

Continue to create account contexts with `browser.newContext({ storageState })`; do not share full-check profiles, cookies, pages, or contexts.

Run: `bun test src/agentrouter-session.test.ts src/endpoint-poller.test.ts`
Expected: PASS.

**Step 3: Verify types**

Run: `bun run typecheck`
Expected: PASS.

**Step 4: Commit**

```bash
git add src/agentrouter-session.ts src/agentrouter-session.test.ts
git commit -m "feat: attach endpoint polling to native Chrome"
```

---

## Task 5: Update deployment contract and operator documentation

**Files:**
- Modify: `deploy/ai-fleet-observatory.env.example`
- Modify: `deploy/settings.server.example.json`
- Modify: `docs/ubuntu-deployment.md`
- Modify: `README.md` only if it currently documents AgentRouter browser configuration

**Step 1: Update deployment configuration**

Remove `BROWSER_CHANNEL` and `DISABLE_WEBAUTHN`. Add the five native-browser variables with deployed defaults. Document that both CDP listeners are loopback-only and must never be added to Tailscale Serve, nginx, or firewall exposure.

**Step 2: Document installation and rollback**

Add the official Google Chrome Stable `.deb` installation flow, version verification, Xvfb/noVNC relationship, idle listener expectation, process-argument inspection, profile ownership, and exact rollback settings from the approved specification. Do not document `--no-sandbox`, stealth flags, CAPTCHA services, or fingerprint spoofing.

**Step 3: Verify examples remain loadable**

Run:

```bash
bun test src/config.test.ts src/settings.test.ts
bun run typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add deploy/ai-fleet-observatory.env.example deploy/settings.server.example.json docs/ubuntu-deployment.md README.md
git commit -m "docs: document native Chrome deployment"
```

Omit `README.md` from the commit if it required no change.

---

## Task 6: Repository verification and independent review

**Files:** all changed files from Tasks 1-5.

**Step 1: Confirm forbidden AgentRouter launch controls are gone**

Search tracked runtime/config/UI paths for `browserHeadless`, `BROWSER_CHANNEL`, `browserChannel`, `DISABLE_WEBAUTHN`, `disableWebAuthn`, Playwright `launchPersistentContext`, and poller `chromium.launch`. Expected remaining matches: historical design/recon prose or unrelated browser tests only; no AgentRouter runtime/config/UI callsites.

**Step 2: Run exact project checks**

```bash
bun test
bun run typecheck
bun run build
```

Expected: zero failures.

**Step 3: Run an independent fresh-context review**

Review the final diff for:

- process ownership and cleanup on every error/cancel/signal path;
- CDP loopback binding and collision rejection;
- no sandbox weakening or automation spoofing;
- poller concurrency and account isolation;
- no regression to authoritative user-ID/money parsing;
- clean removal of obsolete settings and payload fields.

Fix every confirmed issue, then rerun the focused tests plus all three project checks.

---

## Task 7: Deploy and prove both browser paths on Xeon

**Step 1: Install and record Google Chrome Stable**

Install the official current 64-bit Google Chrome Stable Debian package on `bkserver` and verify `/usr/bin/google-chrome-stable --version`. Do not add unsigned packages or disable Chrome's sandbox.

**Step 2: Deploy code and root-owned environment**

Deploy the reviewed revision. Replace `BROWSER_CHANNEL` and `DISABLE_WEBAUTHN` with the five native-browser variables. Preserve credentials and all unrelated service settings without printing them. Ensure the poller profile directory is owned by `agentrouter` and mode 0700.

**Step 3: Restart safely and verify idle state**

Stop any active cycle, restart `ai-fleet-observatory.service`, and verify Observatory plus permanent noVNC services are active. While idle, ports 19222 and 19223 must not be exposed on non-loopback interfaces; the poller port may be loopback-listening only while endpoint polling is active.

**Step 4: Prove the minute poller path**

Observe the native Google Chrome process, its exact approved arguments, loopback `127.0.0.1:19223`, `/json/version` product, and browser probe values. Required measured evidence includes `navigator.webdriver === false`, no Chrome for Testing product, no SwiftShader-forced launch flag, and separate account contexts. Confirm both accounts poll without `session-dead` after valid monitor states exist.

**Step 5: Prove a full account-check path**

Trigger `acc-1`, inspect loopback `127.0.0.1:19222`, process arguments, product, and noVNC. If AgentRouter presents Access Verification, complete it once through the existing permanent noVNC page. Confirm the real site accepts the interaction or record the exact remaining server response; do not claim undetectability.

Verify `/api/user/self` returns authoritative JSON, the numeric user ID matches the saved identity, and persisted balance/consumption are sourced from authoritative fields. Repeat sequentially for `acc-2` and confirm the worker port is cleaned between accounts.

**Step 6: Final service proof**

Confirm:

- all expected Observatory and noVNC units are active;
- no CDP listener is exposed through Tailscale Serve;
- both account results persist with real authoritative money;
- all ten Antigravity probes remain healthy;
- the deployed revision matches the reviewed commit;
- temporary probes, worktrees, and local tunnel processes are removed without deleting browser profiles or runtime databases.
