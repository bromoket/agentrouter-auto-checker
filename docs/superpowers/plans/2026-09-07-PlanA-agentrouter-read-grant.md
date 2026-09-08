# Plan A — AgentRouter Persistent Read + Grant Cadence

> **For agentic workers:** REQUIRED SUB-SKILL: Use skill://subagent-driven-development (recommended) or skill://executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the every-cycle logout that triggers runaway Access-Verification WAF noise, and replace it with a 1-minute persistent-session read loop plus an explicit 12h/24h logout→login grant cycle.

**Architecture:** Keep the existing browser-based read poller (`DefaultAgentRouterReadSessions` + `agentrouter-read-session-worker.mjs`) which already uses a persistent native-Chrome session and never logs out. Enable it by default and extend it to read all current console data. Remove the every-cycle logout from the scheduler-driven full cycle; instead schedule the full logout→login cycle only on a long grant interval, and detect grants as a balance increase.

**Tech Stack:** Bun, TypeScript, Node-compatible worker (.mjs), Playwright as CDP client, native Chrome Stable, SQLite.

## Global Constraints

- Bun is the only supported package manager/runtime (`bun@1.3.14`). Worker/host scripts are Node-compatible `.mjs`.
- Secrets (GitHub cookies, AgentRouter tokens, refresh tokens) never logged or stored in Git; `data/` is Git-ignored.
- Native Chrome launch args stay exactly the 5 approved switches; no `--headless`, `--no-sandbox`, `--enable-automation`, UA/webdriver spoofing.
- Settings file stays version 1; unknown keys ignored so old files remain readable.
- TypeScript `strict`; `bun run typecheck` must pass; worker scripts pass `node --check`.

---

### Task A1: Add grant/read-mode settings

**Files:**
- Modify: `src/settings.ts`
- Test: `src/settings.test.ts`

**Interfaces:**
- Consumes: existing `AutomationSettings` interface.
- Produces: `AutomationSettings` adds `grantIntervalHours: number` and `reusePersistentSession: boolean`; `DEFAULT_AUTOMATION_SETTINGS` and `validateAutomationSettings` updated.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/settings.test.ts
import { DEFAULT_AUTOMATION_SETTINGS, validateAutomationSettings } from "./settings";

describe("grant and persistent-session settings", () => {
  test("defaults enable persistent session reuse and a 12h grant interval", () => {
    expect(DEFAULT_AUTOMATION_SETTINGS.reusePersistentSession).toBe(true);
    expect(DEFAULT_AUTOMATION_SETTINGS.grantIntervalHours).toBe(12);
  });

  test("validates grantIntervalHours bounds", () => {
    const base = { ...DEFAULT_AUTOMATION_SETTINGS };
    expect(validateAutomationSettings({ ...base, grantIntervalHours: 4 }).grantIntervalHours).toBe(4);
    expect(validateAutomationSettings({ ...base, grantIntervalHours: 168 }).grantIntervalHours).toBe(168);
    expect(validateAutomationSettings({ ...base, grantIntervalHours: 1 }).grantIntervalHours).toBe(12);
    expect(validateAutomationSettings({ ...base, grantIntervalHours: 500 }).grantIntervalHours).toBe(12);
  });

  test("reusePersistentSession coerces to boolean with default true", () => {
    const base = { ...DEFAULT_AUTOMATION_SETTINGS };
    expect(validateAutomationSettings({ ...base, reusePersistentSession: false }).reusePersistentSession).toBe(false);
    expect(validateAutomationSettings({ ...base, reusePersistentSession: "no" }).reusePersistentSession).toBe(true);
  });

  test("reader grants old version-1 files without the new keys", () => {
    const old = { ...DEFAULT_AUTOMATION_SETTINGS, grantIntervalHours: undefined as never, reusePersistentSession: undefined as never };
    const parsed = validateAutomationSettings(old);
    expect(parsed.grantIntervalHours).toBe(12);
    expect(parsed.reusePersistentSession).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/settings.test.ts`
Expected: FAIL — `grantIntervalHours`/`reusePersistentSession` don't exist on type.

- [ ] **Step 3: Implement**

```ts
// src/settings.ts — add to AutomationSettings interface
export interface AutomationSettings {
  schedulerEnabled: boolean;
  intervalMinutes: number;          // retained as the full-cycle read cadence baseline
  endpointPollingEnabled: boolean;
  endpointPollIntervalMinutes: number;
  accountDelaySeconds: number;
  runOnStart: boolean;
  openDashboardOnStart: boolean;
  twoFactorTimeoutMinutes: number;
  captureScreenshots: boolean;
  activityLookbackDays: number;
  grantIntervalHours: number;        // NEW
  reusePersistentSession: boolean;   // NEW
}
```

```ts
// DEFAULT_AUTOMATION_SETTINGS
export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  schedulerEnabled: true,
  intervalMinutes: 60,
  endpointPollingEnabled: true,      // CHANGED from false
  endpointPollIntervalMinutes: 1,
  accountDelaySeconds: 5,
  runOnStart: false,
  openDashboardOnStart: true,
  twoFactorTimeoutMinutes: 5,
  captureScreenshots: false,
  activityLookbackDays: 7,
  grantIntervalHours: 12,            // NEW
  reusePersistentSession: true,      // NEW
};
```

```ts
// in validateAutomationSettings() return object — add:
    grantIntervalHours: boundedInteger(
      candidate.grantIntervalHours,
      DEFAULT_AUTOMATION_SETTINGS.grantIntervalHours,
      4,
      168,
    ),
    reusePersistentSession: booleanValue(
      candidate.reusePersistentSession,
      DEFAULT_AUTOMATION_SETTINGS.reusePersistentSession,
    ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/settings.test.ts
git commit -m "feat(settings): add grant interval and persistent-session reuse settings"
```

---

### Task A2: Grant-aware read worker (never logout in read mode)

**Files:**
- Modify: `src/account-checker.ts` — pass grant mode + `reusePersistentSession` to the worker payload.
- Modify: `scripts/agentrouter-worker.mjs` — skip `logoutAndPersist()` when not in grant mode.
- Test: `scripts/agentrouter-worker-browser.test.mjs` (create if absent) — assert mode flag controls logout.

**Interfaces:**
- Consumes: `RunSnapshot.loggedOut`, `sessionReused`.
- Produces: `WorkerPayload.config` gains `grantMode: boolean` and `reusePersistentSession: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// scripts/agentrouter-worker-browser.test.mjs
import { test, expect } from "bun:test";

// The worker must decide logout based on a mode flag, not unconditionally.
test("read-mode worker does not request logout; grant-mode does", () => {
  // Contract check: the payload schema carries grantMode/reusePersistentSession
  // and logout is gated on them. Implemented as a pure helper:
  const { shouldLogout } = await import("./agentrouter-worker-mode.mjs");
  expect(shouldLogout({ grantMode: true, reusePersistentSession: true })).toBe(true);
  expect(shouldLogout({ grantMode: false, reusePersistentSession: true })).toBe(false);
  expect(shouldLogout({ grantMode: false, reusePersistentSession: false })).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/agentrouter-worker-browser.test.mjs`
Expected: FAIL — module `agentrouter-worker-mode.mjs` missing.

- [ ] **Step 3: Add the pure mode helper**

Create `scripts/agentrouter-worker-mode.mjs`:

```js
/**
 * Decide whether an AgentRouter cycle must logout.
 *
 * grantMode   : this is the periodic logout->login grant cycle.
 * reuseSession: persistent-session reuse is enabled (read/full cycles).
 *
 * Logout only happens on the grant cycle (to claim grants) OR when persistent
 * session reuse is disabled (legacy behavior, keep full logout each cycle).
 */
export function shouldLogout({ grantMode, reusePersistentSession }) {
  return grantMode || !reusePersistentSession;
}
```

- [ ] **Step 4: Wire into worker + account-checker**

In `scripts/agentrouter-worker.mjs` `runWorker`, replace the unconditional logout tail:

```js
// Replace: result.loggedOut = await logoutAndPersist(...)
const logoutNeeded = shouldLogout({ grantMode: config.grantMode, reusePersistentSession: config.reusePersistentSession });
if (logoutNeeded) {
  progress("logging-out", "Data captured. Logging out (grant cycle).", 92);
  result.loggedOut = await logoutAndPersist(context, activePage, config, authenticatedUserId, statePath, result.apiCalls);
  if (!result.loggedOut) throw new Error("AgentRouter logout did not complete after data collection.");
} else {
  result.loggedOut = false;
  progress("persisted", "Data captured. Session kept alive for the next read.", 92);
}
```

Add `import { shouldLogout } from "./agentrouter-worker-mode.mjs";` at the top of the worker.

In `src/account-checker.ts`, extend `WorkerPayload.config` and the payload construction:

```ts
  config: {
    baseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    loginTimeoutMs: config.loginTimeoutMs,
    browserExecutable: config.browserExecutable,
    browserWorkerCdpPort: config.browserWorkerCdpPort,
    browserStartTimeoutMs: config.browserStartTimeoutMs,
    screenshotDir: config.screenshotDir,
    accountStateDir: config.accountStateDir,
    browserProfileDir: config.browserProfileDir,
    authChallengeTimeoutMs: settings.twoFactorTimeoutMinutes * 60_000,
    captureScreenshots: settings.captureScreenshots,
    activityLookbackDays: settings.activityLookbackDays,
    grantMode: settings.grantMode ?? false,           // NEW
    reusePersistentSession: settings.reusePersistentSession,   // NEW (default true)
  },
```

And extend `runSingleAccountCheck` signature to accept `grantMode`:

```ts
export async function runSingleAccountCheck(
  account: GitHubAccount,
  config: AppConfig,
  settings: AutomationSettings,
  challenges: AuthenticationChallengeBroker,
  options: RunSingleAccountCheckOptions & { grantMode?: boolean } = {},
): Promise<RunSnapshot> {
```

- [ ] **Step 5: Run tests + typecheck + node check**

Run:
```bash
bun test scripts/agentrouter-worker-browser.test.mjs
node --check scripts/agentrouter-worker.mjs
bun run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/agentrouter-worker-mode.mjs scripts/agentrouter-worker-browser.test.mjs scripts/agentrouter-worker.mjs src/account-checker.ts
git commit -m "feat: gate AgentRouter logout on grant mode / session reuse"
```

---

### Task A3: Coordinator grant + read scheduling

**Files:**
- Modify: `src/coordinator.ts`
- Test: `src/coordinator.test.ts`

**Interfaces:**
- Consumes: `settings.grantIntervalHours`, `settings.reusePersistentSession`, `settings.endpointPollIntervalMinutes`.
- Produces: a `grantLoop()` that runs the full logout→login cycle on the grant interval; a `readLoop()` that runs the persistent read poller every minute; the existing 60-min full cycle becomes read-only (no logout) when reuse is on.

- [ ] **Step 1: Write the failing test**

```ts
// src/coordinator.test.ts
import { CheckCoordinator } from "./coordinator";
// ... existing harness fixtures ...

test("grant cycle runs on grantIntervalHours and read loop runs every endpointPollIntervalMinutes", async () => {
  // Use a scheduler with a tiny grant interval and a tiny poll interval; assert
  // that runCycle (grant mode) is invoked on the grant cadence and that the read
  // poller is invoked on the poll cadence without triggering a full logout.
  // (Implementation detail: call coordinator.startScheduler(), advance time, then
  //  assert the number of grant runs vs read polls, and that read polls pass
  //  grantMode=false.)
});
```

Note: because loop timing makes a wall-clock test flaky, test the *mode decision* and the *loop scheduling math* (see Step 3 helpers) rather than the real timers:

```ts
test("read loop never triggers logout; grant loop does", () => {
  const { cycleMode } = require("./coordinator-modes");
  expect(cycleMode({ grantDue: false, reuse: true })).toBe("read");
  expect(cycleMode({ grantDue: true, reuse: true })).toBe("grant");
  expect(cycleMode({ grantDue: false, reuse: false })).toBe("full-logout");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/coordinator.test.ts`
Expected: FAIL — `cycleMode` helper missing.

- [ ] **Step 3: Add the mode helper**

Create `src/coordinator-modes.ts`:

```ts
export type CycleMode = "read" | "grant" | "full-logout";

/**
 * Mode for a cycle:
 * - "read": persistent-session read (no logout) — the frequent path.
 * - "grant": explicit logout->login cycle (claims grants).
 * - "full-logout": legacy — logout every cycle (reuse disabled).
 */
export function cycleMode(input: { grantDue: boolean; reuse: boolean }): CycleMode {
  if (input.grantDue) return "grant";
  if (input.reuse) return "read";
  return "full-logout";
}
```

- [ ] **Step 4: Wire scheduling into coordinator**

In `src/coordinator.ts`:

- Add a `grantLoopStarted` flag and a `grantLoop()`:

```ts
private grantLoopStarted = false;
private grantLoopHandler: (() => Promise<void>) | null = null;

async startGrantLoop(handler: () => Promise<void>): Promise<void> {
  if (this.grantLoopStarted) return;
  this.grantLoopStarted = true;
  let nextRunAt = Date.now() + (await this.settings.load()).grantIntervalHours * 3600_000;
  const run = async () => {
    while (this.schedulerStarted) {
      if (Date.now() >= nextRunAt) {
        await handler().catch((error) => console.error(`[grant] ${error instanceof Error ? error.message : String(error)}`));
        nextRunAt = Date.now() + (await this.settings.load()).grantIntervalHours * 3600_000;
      }
      await delay(1_000);
    }
  };
  void run();
}
```

- In `startScheduler()`, after the existing loops, call `this.startGrantLoop(() => this.runGrantCycle())` and start the read loop when `settings.endpointPollingEnabled`:

```ts
private async runGrantCycle(): Promise<boolean> {
  return this.runCycle(undefined, { grantMode: true });
}
```

- Update `runCycle(accountId?, options?)` to accept `grantMode` and forward it:

```ts
async runCycle(accountId?: string, options?: { grantMode?: boolean }): Promise<boolean> {
  // ... pass options?.grantMode into runSingleAccountCheck as grantMode
}
```

- Ensure `endpointPollingLoop()` reads `settings.endpointPollingEnabled` (it already does) and is started when enabled.

- [ ] **Step 5: Run tests + typecheck**

Run:
```bash
bun test src/coordinator.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/coordinator-modes.ts src/coordinator.ts src/coordinator.test.ts
git commit -m "feat(coordinator): decouple grant cycle from frequent read polling"
```

---

### Task A4: Extend read poller to all current data

**Files:**
- Modify: `scripts/agentrouter-read-session-worker.mjs`
- Modify: `src/agentrouter-session.ts` (surface stats in the returned observation)
- Test: `scripts/agentrouter-read-session-worker.test.mjs`

**Interfaces:**
- Consumes: none new.
- Produces: the read poll returns balance, consumed, requestCount (already) plus console usage cards (statisticalTokens, statisticalQuota, averageRpm, averageTpm, availableModels).

- [ ] **Step 1: Write the failing test**

```ts
// scripts/agentrouter-read-session-worker.test.mjs
import { parseReadPayload } from "./agentrouter-read-session-worker.mjs";

test("parseReadPayload extracts console usage cards alongside balance", () => {
  const payload = {
    data: { id: 1, quota: 0, used_quota: 0, request_count: 0 },
    consoleCards: {
      statisticalTokens: 1234,
      statisticalQuota: 5.5,
      averageRpm: 12,
      averageTpm: 3000,
      availableModels: 4,
    },
  };
  const out = parseReadPayload(payload, 500_000);
  expect(out.balance).toBe(0);
  expect(out.statisticalTokens).toBe(1234);
  expect(out.averageRpm).toBe(12);
  expect(out.availableModels).toBe(4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test scripts/agentrouter-read-session-worker.test.mjs`
Expected: FAIL — `parseReadPayload` missing.

- [ ] **Step 3: Implement parse helper + extend observation**

In `scripts/agentrouter-read-session-worker.mjs`, add a pure parse helper and call it in `poll()`:

```js
export function parseReadPayload(payload, quotaPerUnit = 500_000) {
  const rec = payload?.data && typeof payload.data === "object" ? payload.data : (payload ?? {});
  const qpu = Math.max(1, Number(rec.quota_per_unit) || quotaPerUnit);
  const cards = (payload?.consoleCards && typeof payload.consoleCards === "object") ? payload.consoleCards : {};
  const num = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
  return {
    balance: num(rec.quota) / qpu,
    consumed: num(rec.used_quota) / qpu,
    requestCount: num(rec.request_count),
    statisticalTokens: num(cards.statisticalTokens),
    statisticalQuota: num(cards.statisticalQuota),
    averageRpm: num(cards.averageRpm),
    averageTpm: num(cards.averageTpm),
    availableModels: num(cards.availableModels),
  };
}
```

In `poll()`, after reading `/api/user/self`, also read the visible console cards via the existing `page.evaluate` pattern (extract the SPA-rendered numeric cards). Wire the cards into the returned payload so the coordinator stores them.

- [ ] **Step 4: Run test + node check**

Run:
```bash
bun test scripts/agentrouter-read-session-worker.test.mjs
node --check scripts/agentrouter-read-session-worker.mjs
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/agentrouter-read-session-worker.mjs scripts/agentrouter-read-session-worker.test.mjs src/agentrouter-session.ts
git commit -m "feat(read-loop): surface full console usage data in minute polls"
```

---

### Task A5: Grant detection + Telegram confirmation

**Files:**
- Modify: `src/coordinator.ts`
- Modify: `src/observatory/coordinator.ts` (emit `agentrouter_grant_received`)
- Test: `src/coordinator.test.ts` or `src/observatory/coordinator.test.ts`

**Interfaces:**
- Consumes: `snapshot.metrics.balance` (before/after).
- Produces: `agentrouter_grant_received` Observatory event on positive delta; deduped by fingerprint.

- [ ] **Step 1: Write the failing test**

```ts
test("detects a grant as a balance increase, not a consumption drop", () => {
  const { isGrant } = require("./grant-detect");
  expect(isGrant({ before: 100, after: 125 })).toBe(true);      // +25 grant
  expect(isGrant({ before: 100, after: 1100 })).toBe(true);     // random large grant
  expect(isGrant({ before: 125, after: 99 })).toBe(false);      // consumption drop
  expect(isGrant({ before: 100, after: 100 })).toBe(false);     // no change
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/coordinator.test.ts`
Expected: FAIL — `isGrant` missing.

- [ ] **Step 3: Implement grant detector**

Create `src/grant-detect.ts`:

```ts
/** A grant is a balance *increase*. Consumption only ever lowers balance. */
export function isGrant(input: { before: number; after: number; epsilon?: number }): boolean {
  const epsilon = input.epsilon ?? 0.01;
  return input.after > input.before + epsilon;
}
```

- [ ] **Step 4: Wire grant detection into the grant cycle + Telegram**

In `src/coordinator.ts` `runCycle` when `grantMode`:
- Before running, record the last stored balance.
- After the worker returns, read the new balance.
- If `isGrant({before, after})`, emit `agentrouter_grant_received` and send a Telegram confirmation through the existing path (balance before→after, account label, delta). Dedupe by fingerprint `[grant, accountId, date, amount]`.

- [ ] **Step 5: Run tests + typecheck**

Run:
```bash
bun test src/coordinator.test.ts src/observatory/coordinator.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/grant-detect.ts src/coordinator.ts
git commit -m "feat(grants): detect balance increase and confirm via Telegram once"
```

---

### Task A6: End-to-end verification

- [ ] **Step 1: Run full suite**

Run: `bun test`
Expected: zero failures (note 12 POSIX-only skips on Windows are expected).

- [ ] **Step 2: Typecheck + worker syntax**

Run:
```bash
bun run typecheck
node --check scripts/agentrouter-worker.mjs
node --check scripts/agentrouter-read-session-worker.mjs
node --check scripts/native-chrome-host.mjs
```
Expected: all PASS.

- [ ] **Step 3: Confirm no forbidden launch controls remain**

Run: `grep -rn "browserHeadless\|launchPersistentContext\|chromium.launch" src scripts --include=*.ts --include=*.mjs | grep -v "\.test\."`
Expected: only the two known helper scripts (`telegram-chart.mjs`, `ui-performance.mjs`) may match; no AgentRouter runtime path.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: verify Plan A read+grant cadence end to end" || echo "nothing new to commit"
```
