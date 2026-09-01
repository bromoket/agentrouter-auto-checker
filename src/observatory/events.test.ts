import { describe, expect, test } from "bun:test";
import {
  buildQuotaTrackerKey,
  createAgentRouterChallengeEventCandidate,
  createAgentRouterFailureEventCandidate,
  createAgentRouterGrantEventCandidate,
  createAgentRouterLoginRequiredEventCandidate,
  createDeterministicFingerprint,
  evaluateAgentRouterBalanceTransition,
  evaluateHostTransition,
  evaluateProviderTransition,
  evaluateQuotaTransition,
  evaluateSessionTransition,
  getCanonicalRemainingFraction,
  isConfirmedQuotaReset,
  type AgentRouterTrackerState,
  type HostTrackerState,
  type ProviderTrackerState,
  type QuotaTrackerState,
  type SessionTrackerState,
} from "./events";
import { EVENT_DEFAULT_POLICIES } from "./policies";
import type {
  FleetHostObservation,
  OmpSessionSummaryInput,
  ProviderIdentityObservation,
  QuotaObservationInput,
} from "./types";
import { ValidationError } from "./validation";

describe("Observatory Event Transition Generators", () => {
  describe("Typed Length-Delimited Canonical Fingerprinting", () => {
    test("prevents boundary delimiter collisions across distinct tuples", () => {
      const fp1 = createDeterministicFingerprint("test_event", "id_1", "a|b", "c");
      const fp2 = createDeterministicFingerprint("test_event", "id_1", "a", "b|c");
      expect(fp1).not.toBe(fp2);
    });

    test("distinguishes null, undefined, empty string, 0, -0, and false", () => {
      const fpNull = createDeterministicFingerprint("event", "target", null);
      const fpUndefined = createDeterministicFingerprint("event", "target", undefined);
      const fpEmpty = createDeterministicFingerprint("event", "target", "");
      const fpZero = createDeterministicFingerprint("event", "target", 0);
      const fpNegZero = createDeterministicFingerprint("event", "target", -0);
      const fpFalse = createDeterministicFingerprint("event", "target", false);

      const set = new Set([fpNull, fpUndefined, fpEmpty, fpZero, fpNegZero, fpFalse]);
      expect(set.size).toBe(6);
    });

    test("rejects non-finite numbers at the fingerprint boundary", () => {
      expect(() => createDeterministicFingerprint("event", "target", Number.NaN)).toThrow(ValidationError);
      expect(() => createDeterministicFingerprint("event", "target", Number.POSITIVE_INFINITY)).toThrow(ValidationError);
      expect(() => createDeterministicFingerprint("event", "target", Number.NEGATIVE_INFINITY)).toThrow(ValidationError);
    });

    test("outputs full 64-hex SHA-256 digest format", () => {
      const fp = createDeterministicFingerprint("quota_warning", "target_123", 1, "window_a");
      const parts = fp.split(":");
      expect(parts.length).toBe(3);
      expect(parts[0]).toBe("quota_warning");
      expect(parts[1]).toBe("target_123");
      expect(parts[2]).toMatch(/^[a-f0-9]{64}$/); // Full SHA-256
    });
  });

  describe("Quota Remaining Fraction Thresholds, Dual Fractions & Monotonic Arm Epochs", () => {
    test("builds normalized canonical quota tracker key", () => {
      const key = buildQuotaTrackerKey({
        identityId: "cred_1",
        provider: "anthropic",
        bucketId: "bucket_main",
        windowId: "win_1",
        meter: "tokens",
        model: "claude-3-5",
        tier: "tier_1",
        observedAt: "2026-09-01T10:00:00Z",
        usedFraction: 0.5,
      });
      expect(key).toBe("quota:anthropic:cred_1:bucket_main:tokens:claude-3-5:tier_1");
    });

    test("triggers warning <= 0.20, critical <= 0.10, and exhausted <= 0.02", () => {
      const baseObs: QuotaObservationInput = {
        identityId: "synth_id",
        provider: "anthropic",
        windowId: "win_1",
        observedAt: "2026-09-01T10:00:00Z",
        usedFraction: 0.82,
        remainingFraction: 0.18, // <= 0.20 -> warning
      };

      const res1 = evaluateQuotaTransition(null, baseObs);
      expect(res1.events.length).toBe(1);
      expect(res1.events[0].eventType).toBe("quota_warning");
      expect(res1.events[0].severity).toBe("warning");

      const res2 = evaluateQuotaTransition(res1.nextState, {
        ...baseObs,
        observedAt: "2026-09-01T10:05:00Z",
        usedFraction: 0.92,
        remainingFraction: 0.08, // <= 0.10 -> critical
      });
      expect(res2.events.length).toBe(1);
      expect(res2.events[0].eventType).toBe("quota_critical");
      expect(res2.events[0].severity).toBe("critical");

      const res3 = evaluateQuotaTransition(res2.nextState, {
        ...baseObs,
        observedAt: "2026-09-01T10:10:00Z",
        usedFraction: 0.99,
        remainingFraction: 0.01, // <= 0.02 -> exhausted
      });
      expect(res3.events.length).toBe(1);
      expect(res3.events[0].eventType).toBe("quota_exhausted");
      expect(res3.events[0].severity).toBe("critical");
    });

    test("rearming increments arm epochs and generates unique fingerprints surviving durable deduplication", () => {
      const obs1: QuotaObservationInput = {
        identityId: "synth_id",
        provider: "anthropic",
        windowId: "win_1",
        observedAt: "2026-09-01T10:00:00Z",
        usedFraction: 0.82,
        remainingFraction: 0.18, // Warning 1
      };

      const res1 = evaluateQuotaTransition(null, obs1);
      expect(res1.events.length).toBe(1);
      const fp1 = res1.events[0].fingerprint;

      // Usage recovers to 25% remaining (> 20% + 2% = 22%) -> REARMED!
      const res2 = evaluateQuotaTransition(res1.nextState, {
        ...obs1,
        observedAt: "2026-09-01T10:05:00Z",
        usedFraction: 0.75,
        remainingFraction: 0.25,
      });
      expect(res2.nextState.warningFired).toBe(false);
      expect(res2.nextState.warningArmEpoch).toBe(2);

      // Usage crosses warning threshold again (0.18 remaining)
      const res3 = evaluateQuotaTransition(res2.nextState, {
        ...obs1,
        observedAt: "2026-09-01T10:10:00Z",
        usedFraction: 0.82,
        remainingFraction: 0.18,
      });
      expect(res3.events.length).toBe(1);
      const fp2 = res3.events[0].fingerprint;

      // Crucial: fp1 and fp2 must be distinct so durable deduplication does not drop the second alert!
      expect(fp1).not.toBe(fp2);
    });

    test("rejects inconsistent dual fractions", () => {
      expect(() =>
        getCanonicalRemainingFraction({
          identityId: "id",
          provider: "p",
          windowId: "w",
          observedAt: "2026-09-01T10:00:00Z",
          usedFraction: 0.80,
          remainingFraction: 0.50, // 0.80 + 0.50 = 1.30 != 1.0
        }),
      ).toThrow(ValidationError);
    });
  });

  describe("Confirmed Resets vs Moving Timestamps", () => {
    test("moving resetsAt timestamp alone without remaining fraction restoration is not a reset", () => {
      const prevState: QuotaTrackerState = {
        trackerKey: "quota:anthropic:id_1:win_1:::",
        identityId: "id_1",
        provider: "anthropic",
        bucketId: "win_1",
        windowId: "win_1",
        generation: 1,
        warningArmEpoch: 1,
        criticalArmEpoch: 1,
        exhaustedArmEpoch: 1,
        creditChangeSeq: 0,
        lastObservedAt: "2026-09-01T10:00:00Z",
        lastUsedFraction: 0.90,
        lastRemainingFraction: 0.10,
        lastResetCredits: null,
        warningFired: true,
        criticalFired: true,
        exhaustedFired: false,
      };

      const movingTsObs: QuotaObservationInput = {
        identityId: "id_1",
        provider: "anthropic",
        windowId: "win_1",
        observedAt: "2026-09-01T10:05:00Z",
        resetsAt: "2026-09-02T00:00:00Z",
        usedFraction: 0.90,
        remainingFraction: 0.10,
      };

      expect(isConfirmedQuotaReset(prevState, movingTsObs)).toBe(false);
      const res = evaluateQuotaTransition(prevState, movingTsObs);
      expect(res.resetConfirmed).toBe(false);
      expect(res.nextState.generation).toBe(1);
    });

    test("confirms quota reset on actual remaining fraction restoration and advances generation", () => {
      const prevState: QuotaTrackerState = {
        trackerKey: "quota:anthropic:id_1:win_1:::",
        identityId: "id_1",
        provider: "anthropic",
        bucketId: "win_1",
        windowId: "win_1",
        generation: 1,
        warningArmEpoch: 1,
        criticalArmEpoch: 1,
        exhaustedArmEpoch: 1,
        creditChangeSeq: 0,
        lastObservedAt: "2026-09-01T10:00:00Z",
        lastUsedFraction: 0.95,
        lastRemainingFraction: 0.05,
        lastResetCredits: null,
        warningFired: true,
        criticalFired: true,
        exhaustedFired: false,
      };

      const confirmedObs: QuotaObservationInput = {
        identityId: "id_1",
        provider: "anthropic",
        windowId: "win_1",
        observedAt: "2026-09-01T10:05:00Z",
        resetsAt: "2026-09-02T00:00:00Z",
        usedFraction: 0.05,
        remainingFraction: 0.95,
      };

      expect(isConfirmedQuotaReset(prevState, confirmedObs)).toBe(true);
      const res = evaluateQuotaTransition(prevState, confirmedObs);
      expect(res.resetConfirmed).toBe(true);
      expect(res.events[0].eventType).toBe("quota_reset");
      expect(res.nextState.generation).toBe(2);
      expect(res.nextState.warningFired).toBe(false);
    });
  });

  describe("Distinct Reset-Credit Changes with Sequences", () => {
    test("emits distinct increased and decreased credit events and generates unique sequence fingerprints", () => {
      const prevState: QuotaTrackerState = {
        trackerKey: "quota:anthropic:id_1:win_1:::",
        identityId: "id_1",
        provider: "anthropic",
        bucketId: "win_1",
        windowId: "win_1",
        generation: 1,
        warningArmEpoch: 1,
        criticalArmEpoch: 1,
        exhaustedArmEpoch: 1,
        creditChangeSeq: 0,
        lastObservedAt: "2026-09-01T10:00:00Z",
        lastUsedFraction: 0.50,
        lastRemainingFraction: 0.50,
        lastResetCredits: 5,
        warningFired: false,
        criticalFired: false,
        exhaustedFired: false,
      };

      // 1. Decrease 5 -> 4
      const resDec1 = evaluateQuotaTransition(prevState, {
        identityId: "id_1",
        provider: "anthropic",
        windowId: "win_1",
        observedAt: "2026-09-01T10:05:00Z",
        usedFraction: 0.50,
        remainingFraction: 0.50,
        resetCredits: 4,
      });
      expect(resDec1.events.length).toBe(1);
      expect(resDec1.events[0].eventType).toBe("reset_credit_decreased");
      const fpDec1 = resDec1.events[0].fingerprint;

      // 2. Increase 4 -> 5
      const resInc = evaluateQuotaTransition(resDec1.nextState, {
        identityId: "id_1",
        provider: "anthropic",
        windowId: "win_1",
        observedAt: "2026-09-01T10:10:00Z",
        usedFraction: 0.50,
        remainingFraction: 0.50,
        resetCredits: 5,
      });
      expect(resInc.events.length).toBe(1);
      expect(resInc.events[0].eventType).toBe("reset_credit_increased");

      // 3. Decrease 5 -> 4 again
      const resDec2 = evaluateQuotaTransition(resInc.nextState, {
        identityId: "id_1",
        provider: "anthropic",
        windowId: "win_1",
        observedAt: "2026-09-01T10:15:00Z",
        usedFraction: 0.50,
        remainingFraction: 0.50,
        resetCredits: 4,
      });
      expect(resDec2.events.length).toBe(1);
      const fpDec2 = resDec2.events[0].fingerprint;

      // Sequence increment ensures distinct fingerprints across identical count transitions!
      expect(fpDec1).not.toBe(fpDec2);
    });
  });

  describe("Provider Escalation State Machine", () => {
    test("escalates through degraded -> down -> blocked -> disabled", () => {
      const obs1: ProviderIdentityObservation = {
        identityId: "openai_main",
        kind: "credential",
        provider: "openai",
        sourceHostId: "host_1",
        label: "OpenAI Main",
        observedAt: "2026-09-01T10:00:00Z",
        health: "rate_limited",
        consecutiveFailures: 1,
      };

      // 1. Degraded (1 failure < 3) -> emits provider_degraded
      const res1 = evaluateProviderTransition(null, obs1, 3);
      expect(res1.events.length).toBe(1);
      expect(res1.events[0].eventType).toBe("provider_degraded");
      expect(res1.nextState.incidentLevel).toBe("degraded");

      // 2. Down after 3 failures -> escalates to provider_down (error)
      const res2 = evaluateProviderTransition(res1.nextState, {
        ...obs1,
        observedAt: "2026-09-01T10:05:00Z",
        health: "unhealthy",
        consecutiveFailures: 3,
      }, 3);
      expect(res2.events.length).toBe(1);
      expect(res2.events[0].eventType).toBe("provider_down");
      expect(res2.nextState.incidentLevel).toBe("down");

      // 3. Blocked after 2 consecutive blocked samples -> escalates to credential_blocked
      const res3 = evaluateProviderTransition(res2.nextState, {
        ...obs1,
        observedAt: "2026-09-01T10:10:00Z",
        health: "unhealthy",
        consecutiveFailures: 4,
        blocked: true,
      }, 3);
      expect(res3.events.length).toBe(0); // 1st blocked sample: no event yet

      const res4 = evaluateProviderTransition(res3.nextState, {
        ...obs1,
        observedAt: "2026-09-01T10:15:00Z",
        health: "unhealthy",
        consecutiveFailures: 5,
        blocked: true,
      }, 3);
      expect(res4.events.length).toBe(1);
      expect(res4.events[0].eventType).toBe("credential_blocked");
      expect(res4.nextState.incidentLevel).toBe("blocked");

      // 4. Disabled after 2 consecutive disabled samples -> escalates to credential_disabled
      const res5 = evaluateProviderTransition(res4.nextState, {
        ...obs1,
        observedAt: "2026-09-01T10:20:00Z",
        disabled: true,
      }, 3);
      expect(res5.events.length).toBe(0); // 1st disabled sample

      const res6 = evaluateProviderTransition(res5.nextState, {
        ...obs1,
        observedAt: "2026-09-01T10:25:00Z",
        disabled: true,
      }, 3);
      expect(res6.events.length).toBe(1);
      expect(res6.events[0].eventType).toBe("credential_disabled");
      expect(res6.nextState.incidentLevel).toBe("disabled");

      // 5. Recovery -> emits credential_recovered
      const res7 = evaluateProviderTransition(res6.nextState, {
        ...obs1,
        observedAt: "2026-09-01T10:30:00Z",
        health: "healthy",
        consecutiveFailures: 0,
        blocked: false,
        disabled: false,
      }, 3);
      expect(res7.events.length).toBe(1);
      expect(res7.events[0].eventType).toBe("credential_recovered");
      expect(res7.nextState.incidentLevel).toBe("none");
    });
  });

  describe("Host Offline 15-Minute Delay & Live Continuity", () => {
    test("emits host_offline only after 15 minutes of continuous offline status", () => {
      const obs: FleetHostObservation = {
        hostId: "node_alpha",
        observedAt: "2026-09-01T10:00:00Z",
        status: "offline",
      };

      const res1 = evaluateHostTransition(null, obs);
      expect(res1.events.length).toBe(0);
      expect(res1.nextState.offlineSince).toBe("2026-09-01T10:00:00Z");

      const res2 = evaluateHostTransition(res1.nextState, {
        ...obs,
        observedAt: "2026-09-01T10:10:00Z",
      });
      expect(res2.events.length).toBe(0);

      const res3 = evaluateHostTransition(res2.nextState, {
        ...obs,
        observedAt: "2026-09-01T10:15:00Z",
      });
      expect(res3.events.length).toBe(1);
      expect(res3.events[0].eventType).toBe("host_offline");

      // Degraded report breaks offline continuity and emits recovery
      const res4 = evaluateHostTransition(res3.nextState, {
        ...obs,
        observedAt: "2026-09-01T10:20:00Z",
        status: "degraded",
      });
      expect(res4.events.length).toBe(1);
      expect(res4.events[0].eventType).toBe("host_recovered");
    });
  });

  describe("Session Context Utilization & State Preservation", () => {
    test("triggers session_context_warning at >= 8000 bps, critical at >= 9500 bps, and preserves state on null", () => {
      const baseSession: OmpSessionSummaryInput = {
        sessionId: "sess_1",
        hostId: "host_1",
        startedAt: "2026-09-01T10:00:00Z",
        status: "active",
        contextBps: 8200, // 82%
      };

      const res1 = evaluateSessionTransition(null, baseSession);
      expect(res1.events.some((e) => e.eventType === "session_context_warning")).toBe(true);

      // Next observation has null contextBps -> preserves prior contextBps (8200) without resetting flags!
      const res2 = evaluateSessionTransition(res1.nextState, {
        ...baseSession,
        startedAt: "2026-09-01T10:05:00Z",
        contextBps: null,
      });
      expect(res2.nextState.lastContextBps).toBe(8200);
      expect(res2.nextState.contextWarningFired).toBe(true);

      // Context rises to 9600 bps -> critical
      const res3 = evaluateSessionTransition(res2.nextState, {
        ...baseSession,
        startedAt: "2026-09-01T10:10:00Z",
        contextBps: 9600,
      });
      expect(res3.events.some((e) => e.eventType === "session_context_critical")).toBe(true);
    });
  });

  describe("AgentRouter Transitions & Balance Drops", () => {
    test("triggers large balance drop >= $25 and low balance <= $50 with arm epochs", () => {
      const params1 = {
        accountId: "ar_acc_1",
        balance: 70.0,
        previousBalance: 100.0, // Drop of $30 >= $25
        observedAt: "2026-09-01T10:00:00Z",
      };

      const res1 = evaluateAgentRouterBalanceTransition(null, params1);
      expect(res1.events.length).toBe(1);
      expect(res1.events[0].eventType).toBe("agentrouter_large_balance_drop");

      // Balance drops by exactly $25 to $45. Both independent contracts apply:
      // large drop >= $25 and low balance <= $50.
      const res2 = evaluateAgentRouterBalanceTransition(res1.nextState, {
        accountId: "ar_acc_1",
        balance: 45.0,
        observedAt: "2026-09-01T10:05:00Z",
      });
      expect(res2.events.length).toBe(2);
      const largeDropEvent = res2.events.find((event) => event.eventType === "agentrouter_large_balance_drop");
      const lowBalanceEvent = res2.events.find((event) => event.eventType === "agentrouter_balance_low");
      expect(largeDropEvent).toBeDefined();
      expect(lowBalanceEvent).toBeDefined();
      expect(largeDropEvent!.fingerprint).not.toBe(lowBalanceEvent!.fingerprint);
      expect(EVENT_DEFAULT_POLICIES.agentrouter_large_balance_drop.telegramImmediate).toBe(true);
      expect(EVENT_DEFAULT_POLICIES.agentrouter_balance_low.telegramImmediate).toBe(true);
      const fpLow1 = lowBalanceEvent!.fingerprint;

      // Balance recovers to $60 (> $55) -> rearmed
      const res3 = evaluateAgentRouterBalanceTransition(res2.nextState, {
        accountId: "ar_acc_1",
        balance: 60.0,
        observedAt: "2026-09-01T10:10:00Z",
      });
      expect(res3.nextState.lowBalanceFired).toBe(false);
      expect(res3.nextState.lowBalanceArmEpoch).toBe(2);

      // Balance drops to $40 -> low balance again with fresh fingerprint
      const res4 = evaluateAgentRouterBalanceTransition(res3.nextState, {
        accountId: "ar_acc_1",
        balance: 40.0,
        observedAt: "2026-09-01T10:15:00Z",
      });
      expect(res4.events.length).toBe(1);
      const fpLow2 = res4.events[0].fingerprint;
      expect(fpLow1).not.toBe(fpLow2);
    });

    test("generates grants, challenges, login required, and failure candidates with pure timestamps", () => {
      const grant = createAgentRouterGrantEventCandidate({
        accountId: "ar_1",
        amount: 10,
        observedAt: "2026-09-01T10:00:00Z",
      });
      expect(grant.eventType).toBe("agentrouter_grant_received");

      const challenge = createAgentRouterChallengeEventCandidate({
        accountId: "ar_1",
        observedAt: "2026-09-01T10:00:00Z",
      });
      expect(challenge.eventType).toBe("agentrouter_challenge_required");

      const loginReq = createAgentRouterLoginRequiredEventCandidate({
        accountId: "ar_1",
        observedAt: "2026-09-01T10:00:00Z",
      });
      expect(loginReq.eventType).toBe("agentrouter_login_required");

      const fail = createAgentRouterFailureEventCandidate({
        accountId: "ar_1",
        type: "endpoint",
        observedAt: "2026-09-01T10:00:00Z",
      });
      expect(fail.eventType).toBe("agentrouter_endpoint_failed");
    });
  });

  describe("Monotonic Watermarks & Out-of-Order Rejection", () => {
    test("rejects or ignores stale and out-of-order observations", () => {
      const state: QuotaTrackerState = {
        trackerKey: "quota:p:id:w:::",
        identityId: "id",
        provider: "p",
        bucketId: "w",
        windowId: "w",
        generation: 1,
        warningArmEpoch: 1,
        criticalArmEpoch: 1,
        exhaustedArmEpoch: 1,
        creditChangeSeq: 0,
        lastObservedAt: "2026-09-01T10:10:00Z",
        lastUsedFraction: 0.50,
        lastRemainingFraction: 0.50,
        lastResetCredits: null,
        warningFired: false,
        criticalFired: false,
        exhaustedFired: false,
      };

      // Stale observation with older timestamp (10:05 < 10:10)
      const res = evaluateQuotaTransition(state, {
        identityId: "id",
        provider: "p",
        windowId: "w",
        observedAt: "2026-09-01T10:05:00Z",
        usedFraction: 0.95,
      });

      expect(res.events.length).toBe(0);
      expect(res.nextState).toBe(state); // Unmutated
    });
  });
});
