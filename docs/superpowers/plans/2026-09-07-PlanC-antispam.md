# Plan C — Anti-Spam Telemetry Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use skill://subagent-driven-development (recommended) or skill://executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee no spamming: quota threshold crossings fire once per arm epoch, reset-credit changes only notify on Telegram when credits increase, grants notify once per grant (deduped), and AgentRouter read failures throttle to N-consecutive + one recovery — never triggering a login/WAF challenge.

**Architecture:** The Observatory event/transition/policy machinery already implements hysteresis (arm epochs), deterministic dedup fingerprints, and the route through `TelegramNotifier`. This plan is targeted: (1) wire the grant notification once-per-grant into the existing dedup path, (2) confirm read-failure throttle rules, (3) verify default policy matrix routes grant/changes to the right delivery. No new event engine — just correct wiring + tests.

**Tech Stack:** Bun, TypeScript, SQLite.

## Global Constraints

- No new event types; reuse the closed taxonomy (`agentrouter_grant_received`, `reset_credit_increased`, `reset_credit_decreased`, `quota_warning/critical/exhausted`, `quota_reset`, `agentrouter_endpoint_failed`, `collector_failure`).
- All delivery reuses `ObservatoryDeliveryManager` + `TelegramNotifier`.
- `bun test` and `bun run typecheck` pass.
- No secrets in Telegram/dashboard/logs.

---

### Task C1: Grant notification dedupe

**Files:**
- Modify: `src/coordinator.ts` (or `src/observatory/coordinator.ts`) — emit `agentrouter_grant_received` with a stable fingerprint.
- Test: `src/observatory/events.test.ts` or `src/observatory/coordinator.test.ts`

**Interfaces:**
- Consumes: the grant detector from Plan A (`isGrant`).
- Produces: an `agentrouter_grant_received` event once per grant, deduped by a fingerprint that includes accountId + date + amount so re-polling the same grant never re-notifies.

- [ ] **Step 1: Write the failing test**

```ts
test("grant event dedupes across re-polls of the same grant", () => {
  const fpA = grantFingerprint({ accountId: "c1", balanceAfter: 125, amount: 25 });
  const fpB = grantFingerprint({ accountId: "c1", balanceAfter: 125, amount: 25 });
  const fpC = grantFingerprint({ accountId: "c1", balanceAfter: 1100, amount: 1000 });
  expect(fpA).toBe(fpB);
  expect(fpA).not.toBe(fpC);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/observatory/events.test.ts`
Expected: FAIL — `grantFingerprint` missing.

- [ ] **Step 3: Implement the fingerprint helper**

Add to `src/observatory/events.ts` (export) or a small `src/grant-detect.ts` addition:

```ts
import { createDeterministicFingerprint } from "../observatory/events";

/** Stable fingerprint so re-polling the same grant never re-notifies. */
export function grantFingerprint(input: { accountId: string; balanceAfter: number; amount: number; day?: string }): string {
  const day = input.day ?? new Date().toISOString().slice(0, 10);
  const rounded = Math.round(input.balanceAfter * 100) / 100;
  return createDeterministicFingerprint("agentrouter_grant_received", input.accountId, day, rounded, input.amount);
}
```

- [ ] **Step 4: Wire the event emission**

In the grant-cycle path (Plan A Task A5), on `isGrant(...)`, emit:

```ts
this.observatoryCoordinator?.recordAgentRouterGrant({
  accountId,
  accountLabel,
  observedAt,
  amount: delta,
  balanceAfter: newBalance,
  fingerprint: grantFingerprint({ accountId, balanceAfter: newBalance, amount: delta, day }),
});
```

Ensure the store persists the dedupe (`recordAgentRouterGrant` uses `INSERT OR IGNORE` on the fingerprint). Add the method to the Observatory coordinator/store if not present.

- [ ] **Step 5: Run test + typecheck**

Run:
```bash
bun test src/observatory/events.test.ts src/observatory/coordinator.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/observatory/events.ts src/coordinator.ts src/observatory/coordinator.ts
git commit -m "feat(grants): dedupe grant notifications by stable fingerprint"
```

---

### Task C2: Read-failure throttle + recovery

**Files:**
- Modify: `src/coordinator.ts`
- Test: `src/coordinator.test.ts`

**Interfaces:**
- Consumes: `settings.twoFactorTimeoutMinutes`, `config.telegram.repeatedFailureCount`.
- Produces: read-loop failures are counted; only after `repeatedFailureCount` consecutive does a Telegram failure notify; a single recovery notifies once. A session-dead signal triggers `healAgentRouterSession` (existing) with a cooldown — never a full WAF/email login on a read hiccup.

- [ ] **Step 1: Write the failing test**

```ts
test("read loop throttles failure notifications and recovers once", () => {
  const { shouldNotifyReadFailure, shouldNotifyRecovery } = require("./read-throttle");
  expect(shouldNotifyReadFailure({ consecutive: 2, threshold: 3 })).toBe(false);
  expect(shouldNotifyReadFailure({ consecutive: 3, threshold: 3 })).toBe(true);
  expect(shouldNotifyReadFailure({ consecutive: 4, threshold: 3 })).toBe(false); // already notified
  expect(shouldNotifyRecovery({ wasFailing: true })).toBe(true);
  expect(shouldNotifyRecovery({ wasFailing: false })).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/coordinator.test.ts`
Expected: FAIL — helpers missing.

- [ ] **Step 3: Implement the throttle helpers**

Create `src/read-throttle.ts`:

```ts
/** Notify a failure only exactly at the threshold (once per run), not on every poll. */
export function shouldNotifyReadFailure(input: { consecutive: number; threshold: number }): boolean {
  return input.consecutive === input.threshold;
}

/** Notify recovery exactly once after a failing stretch. */
export function shouldNotifyRecovery(input: { wasFailing: boolean }): boolean {
  return input.wasFailing;
}
```

- [ ] **Step 4: Wire into coordinator read loop**

In the read loop's error branch, track consecutive failures per account, call `shouldNotifyReadFailure`, and on success after a failing stretch call `shouldNotifyRecovery`. Emit `agentrouter_endpoint_failed` / `collector_recovered` accordingly.

- [ ] **Step 5: Run test + typecheck**

Run:
```bash
bun test src/coordinator.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/read-throttle.ts src/coordinator.ts
git commit -m "feat(reads): throttle read-failure notifications and recover once"
```

---

### Task C3: Policy matrix verification

**Files:**
- Test: `src/observatory/policies.test.ts`

**Interfaces:**
- Consumes: `OBSERVATORY_EVENT_TYPES` closed taxonomy and the default policy matrix.
- Produces: assertions that `agentrouter_grant_received`, `reset_credit_increased`, quota thresholds route per the no-spam defaults (grant → Telegram+dashboard once; reset_credit_increased → dashboard always + Telegram on increase; quota warning/critical/exhausted → once per arm epoch).

- [ ] **Step 1: Extend the policy test**

```ts
test("anti-spam defaults route grant and credit changes correctly", () => {
  const defaults = DEFAULT_EVENT_POLICIES;
  expect(defaults.agentrouter_grant_received.telegramImmediate).toBe(true);
  expect(defaults.agentrouter_grant_received.throttlePerGeneration).toBe(true);
  expect(defaults.reset_credit_increased.telegramImmediate).toBe(true); // increase
  expect(defaults.reset_credit_decreased.telegramImmediate).toBe(false); // decrease dashboard-only
});
```

- [ ] **Step 2: Run test**

Run: `bun test src/observatory/policies.test.ts`
Expected: PASS (adjust the assertions to match the actual default matrix, if they differ, update the matrix so it is no-spam and keep the test green).

- [ ] **Step 3: Commit**

```bash
git add src/observatory/policies.ts src/observatory/policies.test.ts
git commit -m "feat(policies): verify no-spam default routing for grants and credit changes"
```

---

### Task C4: End-to-end anti-spam verification

- [ ] **Step 1: Simulate a grant then re-poll**

Run a bounded integration test that emits the same grant twice and asserts only one Telegram send (via `ObservatoryDeliveryManager`).

- [ ] **Step 2: Simulate read failures**

Assert that 2 read-fail polls emit nothing, the 3rd emits one, and a subsequent success emits one recovery.

- [ ] **Step 3: Full suite + typecheck**

Run:
```bash
bun test
bun run typecheck
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: verify anti-spam telemetry end to end" || echo "nothing new to commit"
```
