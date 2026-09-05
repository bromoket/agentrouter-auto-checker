# Native Chrome CDP Browser Design

## Goal

Replace every AgentRouter Playwright-launched browser with official Google Chrome Stable launched directly under the Observatory Xvfb session. Playwright retains page automation by attaching over loopback Chrome DevTools Protocol (CDP). AgentRouter must either stop presenting Access Verification or accept a real human gesture through permanent noVNC.

## Evidence and Root Cause

The deployed account worker is already headed (`browserHeadless: false`), yet a real noVNC mouse drag is rejected. A live probe measured:

- Chrome for Testing 151 rather than installed Google Chrome Stable.
- `navigator.webdriver === true`.
- SwiftShader WebGL (`0x0000C0DE`).
- Playwright test flags including `--remote-debugging-pipe`, `--no-sandbox`, disabled extensions/sync/component updates/background services, and forced unsafe SwiftShader.
- `DISABLE_WEBAUTHN=true`, which adds feature flags and replaces `navigator.credentials.get/create` in page JavaScript.

A second path, `DefaultAgentRouterReadSessions`, launches Playwright Chromium headless for minute polling. Live logs show both pollers session-dead after failed full checks. Correctness requires cutting over both paths, not only the visible worker.

No implementation may claim an undetectable or “100% real” browser. Success is defined only by measured browser state and the real AgentRouter response.

## Shared Native Chrome Host

Add one Node-compatible host module and CLI under `scripts/`. It owns the Chrome process and is the only code that constructs native Chrome arguments.

The parent sends validated startup configuration containing:

- absolute Chrome executable path;
- absolute user-data directory;
- loopback CDP port;
- bounded startup timeout.

The host:

1. Rejects an occupied CDP endpoint before spawning, so it never attaches to an unknown browser.
2. Spawns Chrome in its own process group as the current unprivileged service user.
3. Passes only:
   - `--user-data-dir=<path>`;
   - `--remote-debugging-address=127.0.0.1`;
   - a fixed, nonzero `--remote-debugging-port=<port>`;
   - `--no-first-run` and `--no-default-browser-check`.
4. Does not pass `--headless`, `--no-sandbox`, `--enable-automation`, `--disable-blink-features=AutomationControlled`, WebGL overrides, user-agent overrides, proxy flags, or Playwright’s default argument set.
5. Polls `http://127.0.0.1:<port>/json/version` until ready or timed out.
6. Requires a Google Chrome product/version response before reporting readiness.
7. Emits a bounded JSON readiness record to its parent and remains alive while stdin remains open.
8. On stop, EOF, signal, startup failure, or parent death, terminates only its owned process group, waits for a grace interval, then force-kills that same group if required.

Chrome remains inside the existing Observatory systemd cgroup and Xvfb private temporary namespace. Its sandbox remains enabled. A sandbox failure is explicit; there is no automatic `--no-sandbox` fallback.

## Full Account Check Browser

The account worker starts one native Chrome host for the current account profile on `127.0.0.1:19222`, then calls:

```js
chromium.connectOverCDP({
  endpointURL: "http://127.0.0.1:19222",
  noDefaults: true,
})
```

It uses the single default persistent context and existing account profile. The coordinator already checks accounts sequentially, so the fixed port cannot overlap between accounts. After every success, error, timeout, or cancellation, the worker disconnects Playwright, closes host stdin, waits for host cleanup, and only then exits or permits the next account.

The default CDP context cannot be closed as a Playwright-created persistent context. Cleanup therefore disconnects the connected `Browser` and delegates Chrome termination to the owned host.

## Minute Polling Browser

`DefaultAgentRouterReadSessions` starts one separate native Chrome host on `127.0.0.1:19223` with a dedicated non-secret runtime profile directory. It attaches through CDP with `noDefaults: true`, then creates isolated contexts from each account’s existing monitor storage state as it does today.

The poller browser is headed under Xvfb. It stays alive until the read-session manager closes, but its account contexts remain isolated and are dropped when storage state changes. It must not share the full-check profile or CDP port.

If the poller host or CDP connection dies, the manager closes stale contexts and may start a fresh owned host. It never attaches to an already occupied endpoint.

## Configuration and Clean Cutover

Add explicit configuration:

- `BROWSER_EXECUTABLE=/usr/bin/google-chrome-stable`
- `BROWSER_WORKER_CDP_PORT=19222`
- `BROWSER_POLLER_CDP_PORT=19223`
- `BROWSER_START_TIMEOUT_MS=30000`
- `BROWSER_POLLER_PROFILE_DIR=/var/lib/ai-fleet-observatory/data/poller-browser-profile`

Validation:

- executable and profile paths are absolute;
- both ports are distinct integers in the unprivileged range;
- host is hard-coded to `127.0.0.1` and is not configurable;
- ports cannot collide with the dashboard, collector, noVNC HTTP, noVNC RFB, or OMP broker ports;
- startup timeout is bounded;
- poller profile remains inside the configured private data directory.

Remove `BROWSER_CHANNEL`, `DISABLE_WEBAUTHN`, and AgentRouter `browserHeadless` behavior from configuration, worker payloads, settings, UI, server examples, and tests. There is no fallback to Chrome for Testing, headless mode, or the WebAuthn mutation. Clean cutover prevents a future setting change from silently restoring the rejected fingerprint.

Other non-AgentRouter browser uses, such as isolated chart and UI test rendering, remain unchanged.

## Process and Protocol Boundaries

The worker and main process each own their host subprocess through an explicit stdin/stdout protocol. Protocol records are size-bounded, schema-validated, and contain no credentials. Browser profile paths are runtime metadata but are not logged verbatim in user-facing errors.

Cleanup never searches by browser name or kills a PID it did not spawn. On Linux the host uses its owned process group. Service shutdown still provides a final cgroup-level boundary.

No browser profile, cookie, OAuth state, API key, token, or runtime database is copied into Git.

## Security Boundary

- CDP binds only to `127.0.0.1:19222` and `127.0.0.1:19223` and is never exposed by Tailscale Serve, noVNC, nginx, LAN, or public interfaces.
- noVNC remains the only tailnet-visible interactive browser surface.
- Chrome runs as `agentrouter` within the current hardened service and Xvfb namespace.
- Chrome sandbox stays enabled.
- No stealth plugin, JavaScript fingerprint forgery, residential proxy, CAPTCHA solver, or synthetic human gesture is added.
- The authoritative user ID and numeric money checks remain unchanged.

## Package and Deployment

Install the current official 64-bit Google Chrome Stable Debian package from Google. Google’s package installs its signed update repository so normal apt maintenance keeps Chrome current. Verify `/usr/bin/google-chrome-stable` and record its version before restarting Observatory.

Deployment order:

1. Install and verify Google Chrome Stable.
2. Deploy code and root-owned environment configuration.
3. Stop any active AgentRouter cycle cleanly.
4. Restart Observatory.
5. Confirm neither CDP port listens while idle.
6. Trigger a full check and inspect process arguments, CDP listeners, measured fingerprint, noVNC, and AgentRouter behavior.
7. After a successful full check, verify the headed minute poller and both account contexts.

## Verification

Completion requires all of the following:

1. Tests cover host command construction, product validation, occupied-port rejection, readiness timeout, graceful cleanup, forced cleanup, parent EOF, protocol bounds, and configuration rejection.
2. Tests cover worker attach/disconnect cleanup and poller restart/context isolation.
3. Removed headless/channel/WebAuthn controls have no remaining AgentRouter callsites or UI fields.
4. `bun run typecheck` passes.
5. `bun test` passes with zero failures.
6. Official Google Chrome Stable launches under the deployed hardened systemd/Xvfb environment with sandbox enabled.
7. Effective Chrome arguments contain none of Playwright’s prior default test flags and no forbidden flags from this design.
8. A live probe reports Google Chrome Stable and `navigator.webdriver === false`. Hardware rendering is not promised on a Xeon without a display GPU, but Chrome must not be forced to SwiftShader by launch arguments.
9. CDP listeners appear only on loopback while their owned browser is active and disappear after cleanup.
10. `acc-1` and `acc-2` full checks run sequentially without profile, page, cookie, or lock crossover.
11. noVNC displays and controls the exact native Chrome instance.
12. AgentRouter either returns authoritative JSON without a challenge or accepts one genuine human slider interaction.
13. The successful run validates account identity and persists balance, consumption, and request count only from authoritative numeric `/api/user/self` fields.
14. Minute polling works for both account storage states without session-dead errors.
15. Antigravity probes, dashboard, Telegram, scheduler, and permanent noVNC remain healthy.

## Failure and Rollback

Startup fails explicitly if Chrome is missing, a CDP port is occupied, the sandbox cannot initialize, the product is not Google Chrome, readiness times out, or CDP attachment fails. Every failure path cleans up the owned host and Chrome process group.

Rollback restores the previous worker/read-session commit, reinstates `BROWSER_CHANNEL=chromium`, `DISABLE_WEBAUTHN=true`, and `automation.browserHeadless=false`, removes the new native-browser keys, and restarts Observatory. Google Chrome may remain installed but unused. Browser profiles and databases are never deleted.
