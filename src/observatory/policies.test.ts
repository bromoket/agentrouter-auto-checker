import { describe, expect, test } from "bun:test";
import {
  BASE_GLOBAL_POLICY,
  DEFAULT_THRESHOLDS,
  EVENT_DEFAULT_POLICIES,
  OBSERVATORY_EVENT_TYPES,
  POLICY_SCOPE_PRECEDENCE,
  SEVERITY_LEVELS,
  evaluateNotificationDispatch,
  getDigestSlotKey,
  getDueDigestSlot,
  isQuietHours,
  mergePolicyRule,
  parsePolicyTarget,
  resolveEffectivePolicy,
  ruleMatchesContext,
  validateAtomicQuietHours,
  validateDigestSchedule,
  validateIanaTimezone,
  validatePolicyRule,
  validateThresholdInvariants,
  validateTimeOfDay,
  type CanonicalObservatoryEventType,
  type NotificationPolicyRule,
  type PolicyResolutionContext,
} from "./policies";
import type { ObservatoryEventCandidate } from "./types";
import { ValidationError } from "./validation";

describe("Observatory Notification Policies & Taxonomy", () => {
  describe("Event Taxonomy & Closed Default Matrix", () => {
    test("closed taxonomy contains exact expected event types", () => {
      const expectedList: CanonicalObservatoryEventType[] = [
        "quota_warning",
        "quota_critical",
        "quota_exhausted",
        "quota_reset",
        "reset_credit_increased",
        "reset_credit_decreased",
        "provider_degraded",
        "provider_down",
        "provider_recovered",
        "credential_blocked",
        "credential_disabled",
        "credential_cooldown",
        "credential_recovered",
        "collector_failure",
        "collector_recovered",
        "host_offline",
        "host_recovered",
        "agentrouter_large_balance_drop",
        "agentrouter_balance_low",
        "agentrouter_grant_received",
        "agentrouter_challenge_required",
        "agentrouter_login_required",
        "agentrouter_login_failed",
        "agentrouter_endpoint_failed",
        "session_context_warning",
        "session_context_critical",
        "session_failed",
        "session_started",
        "session_closed",
        "digest_ready",
        "policy_changed",
        "import_completed",
      ];

      expect([...OBSERVATORY_EVENT_TYPES]).toEqual(expectedList);
      for (const et of expectedList) {
        expect(EVENT_DEFAULT_POLICIES[et]).toBeDefined();
      }
    });

    test("event-specific default matrix matches handoff routing contracts", () => {
      // Confirmed reset: notifies Telegram despite info severity
      expect(EVENT_DEFAULT_POLICIES.quota_reset.telegramImmediate).toBe(true);
      expect(EVENT_DEFAULT_POLICIES.quota_reset.minSeverity).toBe("info");

      // Reset credit decrease: dashboard only
      expect(EVENT_DEFAULT_POLICIES.reset_credit_decreased.telegramImmediate).toBe(false);
      expect(EVENT_DEFAULT_POLICIES.reset_credit_decreased.dashboardOnly).toBe(true);

      // Provider degraded: dashboard only by default (Telegram only after 3 consecutive failures)
      expect(EVENT_DEFAULT_POLICIES.provider_degraded.telegramImmediate).toBe(false);
      expect(EVENT_DEFAULT_POLICIES.provider_degraded.dashboardOnly).toBe(true);

      // Session context critical: dashboard only by default (Telegram-off even for critical!)
      expect(EVENT_DEFAULT_POLICIES.session_context_critical.telegramImmediate).toBe(false);
      expect(EVENT_DEFAULT_POLICIES.session_context_critical.dashboardOnly).toBe(true);

      // Quota critical & exhausted: bypass quiet hours
      expect(EVENT_DEFAULT_POLICIES.quota_critical.criticalBypassQuietHours).toBe(true);
      expect(EVENT_DEFAULT_POLICIES.quota_exhausted.criticalBypassQuietHours).toBe(true);

      // Host offline: telegram enabled after 15m delay
      expect(EVENT_DEFAULT_POLICIES.host_offline.telegramImmediate).toBe(true);
      expect(EVENT_DEFAULT_POLICIES.host_offline.minSeverity).toBe("error");
    });

    test("base global policy defaults adhere to remaining fraction contract", () => {
      expect(BASE_GLOBAL_POLICY.warningRemainingFraction).toBe(0.20);
      expect(BASE_GLOBAL_POLICY.criticalRemainingFraction).toBe(0.10);
      expect(BASE_GLOBAL_POLICY.exhaustedRemainingFraction).toBe(0.02);
      expect(BASE_GLOBAL_POLICY.hysteresisFraction).toBe(0.02);
      expect(BASE_GLOBAL_POLICY.consecutiveFailuresThreshold).toBe(3);
    });
  });

  describe("Server-Side Validation & Strict Scopes", () => {
    test("parses valid canonical targets", () => {
      expect(parsePolicyTarget("global")).toEqual({ scopeType: "global" });
      expect(parsePolicyTarget("event:quota_warning")).toEqual({ scopeType: "event", scopeKey: "quota_warning" });
      expect(parsePolicyTarget("provider:anthropic")).toEqual({ scopeType: "provider", scopeKey: "anthropic" });
      expect(parsePolicyTarget("identity:cred_123")).toEqual({ scopeType: "identity", scopeKey: "cred_123" });
      expect(parsePolicyTarget("account:acc_1")).toEqual({ scopeType: "account", scopeKey: "acc_1" });
      expect(parsePolicyTarget("host:host_alpha")).toEqual({ scopeType: "host", scopeKey: "host_alpha" });
      expect(parsePolicyTarget("session:sess_99")).toEqual({ scopeType: "session", scopeKey: "sess_99" });
    });

    test("rejects malformed targets, global with key, and unknown event scope keys", () => {
      expect(() => parsePolicyTarget("")).toThrow(ValidationError);
      expect(() => parsePolicyTarget("global:sub")).toThrow(ValidationError);
      expect(() => parsePolicyTarget("provider:")).toThrow(ValidationError);
      expect(() => parsePolicyTarget("event:unknown_event_type")).toThrow(ValidationError);
      expect(() => parsePolicyTarget("invalid_target_without_colon")).toThrow(ValidationError);
      expect(() => parsePolicyTarget("unknownscope:key")).toThrow(ValidationError);
    });

    test("sparse rule validation preserves undefined and does not inject nulls", () => {
      const sparse = validatePolicyRule({
        target: "provider:anthropic",
        cooldownMinutes: 25,
      });

      expect(sparse.cooldownMinutes).toBe(25);
      // Omitted fields MUST remain undefined, NOT null!
      expect(sparse.quietHoursStart).toBeUndefined();
      expect(sparse.quietHoursEnd).toBeUndefined();
      expect(sparse.digestSchedule).toBeUndefined();
      expect(sparse.warningRemainingFraction).toBeUndefined();
    });

    test("rejects mismatch between target and redundant scope fields", () => {
      expect(() =>
        validatePolicyRule({
          target: "provider:anthropic",
          scopeType: "session", // mismatch
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validatePolicyRule({
          target: "provider:anthropic",
          scopeKey: "openai", // mismatch
        }),
      ).toThrow(ValidationError);
    });

    test("validates strict types (rejects string booleans and non-integers)", () => {
      expect(() =>
        validatePolicyRule({
          target: "global",
          enabled: "true",
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validatePolicyRule({
          target: "global",
          consecutiveFailuresThreshold: 3.5,
        }),
      ).toThrow(ValidationError);
    });

    test("validates atomic quiet-hours configuration", () => {
      expect(validateAtomicQuietHours({ quietHoursEnabled: false }).quietHoursEnabled).toBe(false);

      expect(() =>
        validateAtomicQuietHours({
          quietHoursEnabled: true,
          quietHoursStart: "22:00",
          // missing end
        }),
      ).toThrow(ValidationError);

      const validAtomic = validateAtomicQuietHours({
        quietHoursEnabled: true,
        quietHoursTimezone: "America/New_York",
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
      });
      expect(validAtomic.quietHoursEnabled).toBe(true);
      expect(validAtomic.quietHoursTimezone).toBe("America/New_York");
    });

    test("validates strict digest schedules", () => {
      expect(validateDigestSchedule("hourly")).toBe("hourly");
      expect(validateDigestSchedule("daily@09:00")).toBe("daily@09:00");
      expect(validateDigestSchedule("interval:30")).toBe("interval:30");
      expect(() => validateDigestSchedule("every 5 minutes")).toThrow(ValidationError);
      expect(() => validateDigestSchedule("daily@25:00")).toThrow(ValidationError);
      expect(() => validateDigestSchedule("interval:2")).toThrow(ValidationError);
    });
  });

  describe("Final Merged Threshold Invariant Validation", () => {
    test("enforces warning >= critical >= exhausted on remaining fractions", () => {
      expect(() =>
        validateThresholdInvariants({
          warningRemainingFraction: 0.05, // warning < critical!
          criticalRemainingFraction: 0.10,
          exhaustedRemainingFraction: 0.02,
          hysteresisFraction: 0.02,
        }),
      ).toThrow(ValidationError);

      expect(() =>
        validateThresholdInvariants({
          warningRemainingFraction: 0.20,
          criticalRemainingFraction: 0.01, // critical < exhausted!
          exhaustedRemainingFraction: 0.02,
          hysteresisFraction: 0.02,
        }),
      ).toThrow(ValidationError);
    });

    test("rejects invalid effective combinations resulting from partial inheritance overrides", () => {
      const rules: NotificationPolicyRule[] = [
        {
          target: "global",
          warningRemainingFraction: 0.20,
          criticalRemainingFraction: 0.10,
          exhaustedRemainingFraction: 0.02,
        },
        {
          target: "provider:anthropic",
          // Partial override that conflicts with global critical (0.05 < 0.10)
          warningRemainingFraction: 0.05,
        },
      ];

      expect(() => resolveEffectivePolicy(rules, { provider: "anthropic" })).toThrow(ValidationError);
    });
  });

  describe("Hierarchical Scope Resolution & Explanation", () => {
    test("resolves complete hierarchy from global to session with sparse overrides", () => {
      const rules: NotificationPolicyRule[] = [
        {
          target: "global",
          cooldownMinutes: 10,
        },
        {
          target: "provider:anthropic",
          cooldownMinutes: 20,
        },
        {
          target: "host:host_alpha",
          consecutiveFailuresThreshold: 5,
        },
        {
          target: "session:sess_1",
          silenced: true,
        },
      ];

      const { policy, explanation } = resolveEffectivePolicy(rules, {
        provider: "anthropic",
        hostId: "host_alpha",
        sessionId: "sess_1",
      });

      expect(policy.cooldownMinutes).toBe(20);
      expect(policy.consecutiveFailuresThreshold).toBe(5);
      expect(policy.silenced).toBe(true);

      expect(explanation.appliedRules).toEqual([
        "global",
        "provider:anthropic",
        "host:host_alpha",
        "session:sess_1",
      ]);
      expect(explanation.fieldSources.silenced.sourceTarget).toBe("session:sess_1");
      expect(explanation.fieldSources.cooldownMinutes.sourceTarget).toBe("provider:anthropic");
    });
  });

  describe("Quiet Hours & 2026 DST Gap and Fold", () => {
    const nycQuietPolicy = {
      ...BASE_GLOBAL_POLICY,
      quietHoursEnabled: true,
      quietHoursTimezone: "America/New_York",
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
    };

    test("evaluates quiet hours across 2026 Spring Forward gap (March 8, 2026)", () => {
      // Clocks jump 02:00 -> 03:00 on March 8, 2026
      // March 8, 2026 01:30 EST (06:30 UTC): within 22:00-07:00 -> in quiet hours
      expect(isQuietHours(nycQuietPolicy, "2026-03-08T06:30:00Z")).toBe(true);

      // March 8, 2026 03:30 EDT (07:30 UTC): within 22:00-07:00 -> in quiet hours
      expect(isQuietHours(nycQuietPolicy, "2026-03-08T07:30:00Z")).toBe(true);

      // March 8, 2026 07:30 EDT (11:30 UTC): past 07:00 -> NOT quiet hours
      expect(isQuietHours(nycQuietPolicy, "2026-03-08T11:30:00Z")).toBe(false);
    });

    test("evaluates quiet hours across 2026 Fall Back fold (November 1, 2026)", () => {
      // Clocks fall back 02:00 -> 01:00 on November 1, 2026
      // Nov 1, 2026 01:30 EDT (05:30 UTC): in quiet hours
      expect(isQuietHours(nycQuietPolicy, "2026-11-01T05:30:00Z")).toBe(true);

      // Nov 1, 2026 01:30 EST (06:30 UTC): in quiet hours
      expect(isQuietHours(nycQuietPolicy, "2026-11-01T06:30:00Z")).toBe(true);

      // Nov 1, 2026 08:00 EST (13:00 UTC): NOT quiet hours
      expect(isQuietHours(nycQuietPolicy, "2026-11-01T13:00:00Z")).toBe(false);
    });
  });

  describe("Critical Bypass, Severity Filtering & Scoped Allowlist Filters", () => {
    test("severity filtering applies strictly before routing", () => {
      const policy = {
        ...BASE_GLOBAL_POLICY,
        minSeverity: "error" as const,
        telegramImmediate: true, // even if telegramImmediate is true, minSeverity filters info/warning!
      };

      const warningEvent: ObservatoryEventCandidate = {
        eventType: "quota_warning",
        severity: "warning",
        occurredAt: "2026-09-01T12:00:00Z",
        fingerprint: "fp_w",
      };

      const decision = evaluateNotificationDispatch(warningEvent, policy, "2026-09-01T12:00:00Z");
      expect(decision.shouldDeliver).toBe(false);
      expect(decision.reason).toBe("severity_filtered");
    });

    test("critical events bypass quiet hours when configured", () => {
      const policy = {
        ...BASE_GLOBAL_POLICY,
        quietHoursEnabled: true,
        quietHoursTimezone: "UTC",
        quietHoursStart: "00:00",
        quietHoursEnd: "23:59",
        criticalBypassQuietHours: true,
      };

      const criticalEvent: ObservatoryEventCandidate = {
        eventType: "quota_exhausted",
        severity: "critical",
        occurredAt: "2026-09-01T12:00:00Z",
        fingerprint: "fp_crit",
      };

      const decision = evaluateNotificationDispatch(criticalEvent, policy, "2026-09-01T12:00:00Z");
      expect(decision.shouldDeliver).toBe(true);
      expect(decision.criticalBypassed).toBe(true);
    });

    test("scoped filters reject events with missing or unscoped fields (fail closed)", () => {
      const policy = {
        ...BASE_GLOBAL_POLICY,
        matchHostIds: ["host_alpha"],
        matchIdentityIds: ["id_123"],
      };

      const missingHostEvent: ObservatoryEventCandidate = {
        eventType: "quota_warning",
        severity: "warning",
        identityId: "id_123",
        occurredAt: "2026-09-01T12:00:00Z",
        fingerprint: "fp_1",
      };
      const decision1 = evaluateNotificationDispatch(missingHostEvent, policy, "2026-09-01T12:00:00Z");
      expect(decision1.shouldDeliver).toBe(false);
      expect(decision1.reason).toBe("unmatched_host");

      const missingIdEvent: ObservatoryEventCandidate = {
        eventType: "quota_warning",
        severity: "warning",
        hostId: "host_alpha",
        occurredAt: "2026-09-01T12:00:00Z",
        fingerprint: "fp_2",
      };
      const decision2 = evaluateNotificationDispatch(missingIdEvent, policy, "2026-09-01T12:00:00Z");
      expect(decision2.shouldDeliver).toBe(false);
      expect(decision2.reason).toBe("unmatched_identity");
    });
  });

  describe("Digest Scheduling, DST Folds & Slot Keys", () => {
    test("generates unambiguous occurrence slot keys across DST fold", () => {
      // EDT 01:00 vs EST 01:00 have distinct epoch suffixes
      const slotEDT = getDigestSlotKey("hourly", "America/New_York", "2026-11-01T05:00:00Z"); // 01:00 EDT
      const slotEST = getDigestSlotKey("hourly", "America/New_York", "2026-11-01T06:00:00Z"); // 01:00 EST
      expect(slotEDT).not.toBe(slotEST);
    });

    test("getDueDigestSlot evaluates schedule and claims slots", () => {
      const dueRes = getDueDigestSlot("daily@09:00", "America/New_York", "2026-09-01T13:00:00Z");
      expect(dueRes.due).toBe(true);
      expect(dueRes.slotKey).toBe("digest:daily:America/New_York:2026-09-01T09:00");

      // Claimed slot returns due: false
      const claimedRes = getDueDigestSlot(
        "daily@09:00",
        "America/New_York",
        "2026-09-01T13:00:00Z",
        dueRes.slotKey,
      );
      expect(claimedRes.due).toBe(false);
    });
  });
});
