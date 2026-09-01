/**
 * AI Fleet Observatory Notification Policies & Event Taxonomy
 *
 * Implements hierarchical policy inheritance (global -> event -> provider -> credential/pool/identity -> account -> host -> session),
 * server-side validation, IANA timezone quiet hours with DST gap/fold handling,
 * atomic quiet-hours and digest configuration, closed event-specific default policy matrix,
 * strict canonical scope targets, final merged invariant validation,
 * sparse nullable override merging, and effective policy explanation.
 */

import type {
  EffectiveNotificationPolicy,
  EventSeverity,
  NotificationPolicyOverrides,
  ObservatoryEventCandidate,
  ObservatoryEventType,
} from "./types";
import { ValidationError } from "./validation";

export type PolicyScopeType =
  | "global"
  | "event"
  | "provider"
  | "credential"
  | "pool"
  | "identity"
  | "account"
  | "host"
  | "session";

export const POLICY_SCOPE_PRECEDENCE: readonly PolicyScopeType[] = [
  "global",
  "event",
  "provider",
  "credential",
  "pool",
  "identity",
  "account",
  "host",
  "session",
] as const;

export const SEVERITY_LEVELS: Record<EventSeverity, number> = {
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

/**
 * Closed, canonical taxonomy of all AI Fleet Observatory event types.
 */
export const OBSERVATORY_EVENT_TYPES = [
  // Quota Events
  "quota_warning",
  "quota_critical",
  "quota_exhausted",
  "quota_reset",
  "reset_credit_increased",
  "reset_credit_decreased",
  // Provider / Credential Events
  "provider_degraded",
  "provider_down",
  "provider_recovered",
  "credential_blocked",
  "credential_disabled",
  "credential_cooldown",
  "credential_recovered",
  // Collector / Host Events
  "collector_failure",
  "collector_recovered",
  "host_offline",
  "host_recovered",
  // AgentRouter Events
  "agentrouter_large_balance_drop",
  "agentrouter_balance_low",
  "agentrouter_grant_received",
  "agentrouter_challenge_required",
  "agentrouter_login_required",
  "agentrouter_login_failed",
  "agentrouter_endpoint_failed",
  // Session Events
  "session_context_warning",
  "session_context_critical",
  "session_failed",
  "session_started",
  "session_closed",
  // System / Administrative Events
  "digest_ready",
  "policy_changed",
  "import_completed",
] as const;

export type CanonicalObservatoryEventType = (typeof OBSERVATORY_EVENT_TYPES)[number];

export interface ThresholdConfig {
  warningRemainingFraction: number; // default 0.20 (<=20% remaining / >=80% used)
  criticalRemainingFraction: number; // default 0.10 (<=10% remaining / >=90% used)
  exhaustedRemainingFraction: number; // default 0.02 (<=2% remaining / >=98% used)
  hysteresisFraction: number; // default 0.02 (2% rearming band)
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  warningRemainingFraction: 0.20,
  criticalRemainingFraction: 0.10,
  exhaustedRemainingFraction: 0.02,
  hysteresisFraction: 0.02,
};

export interface NotificationPolicyRule {
  id?: string;
  target: string; // Canonical format: "global" | "<scopeType>:<scopeKey>"
  scopeType?: PolicyScopeType;
  scopeKey?: string;
  enabled?: boolean | null;
  silenced?: boolean | null;
  telegramImmediate?: boolean | null;
  dashboardOnly?: boolean | null;
  minSeverity?: EventSeverity | null;
  cooldownMinutes?: number | null;
  throttleIntervalMs?: number | null;
  channels?: string[] | null;
  recipient?: string | null;
  // Atomic Quiet Hours Config
  quietHoursEnabled?: boolean | null;
  quietHoursTimezone?: string | null; // Valid IANA timezone
  quietHoursStart?: string | null; // HH:MM local
  quietHoursEnd?: string | null; // HH:MM local
  criticalBypassQuietHours?: boolean | null;
  // Digest Config
  digestEnabled?: boolean | null;
  digestSchedule?: string | null; // e.g. "hourly" | "daily@09:00" | "interval:60"
  digestTimezone?: string | null;
  // Matching Filters
  matchEventTypes?: ObservatoryEventType[] | null;
  matchHostIds?: string[] | null;
  matchIdentityIds?: string[] | null;
  // Threshold Overrides
  warningRemainingFraction?: number | null;
  criticalRemainingFraction?: number | null;
  exhaustedRemainingFraction?: number | null;
  hysteresisFraction?: number | null;
  consecutiveFailuresThreshold?: number | null;
  updatedAt?: string;
}

export interface EffectiveNotificationPolicyResolved extends EffectiveNotificationPolicy {
  scopeType: PolicyScopeType;
  scopeKey?: string;
  recipient: string | null;
  quietHoursEnabled: boolean;
  quietHoursTimezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  criticalBypassQuietHours: boolean;
  digestEnabled: boolean;
  digestSchedule: string | null;
  digestTimezone: string;
  warningRemainingFraction: number;
  criticalRemainingFraction: number;
  exhaustedRemainingFraction: number;
  hysteresisFraction: number;
  consecutiveFailuresThreshold: number;
}

/**
 * Event-specific default policies from the architectural handoff.
 */
export const EVENT_DEFAULT_POLICIES: Record<CanonicalObservatoryEventType, Partial<NotificationPolicyRule>> = {
  quota_warning: {
    minSeverity: "warning",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 15,
  },
  quota_critical: {
    minSeverity: "critical",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: true,
    cooldownMinutes: 5,
  },
  quota_exhausted: {
    minSeverity: "critical",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: true,
    cooldownMinutes: 5,
  },
  quota_reset: {
    minSeverity: "info",
    telegramImmediate: true, // Confirmed reset notifies via Telegram despite info severity
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
  reset_credit_increased: {
    minSeverity: "info",
    telegramImmediate: true, // Credit increase notifies Telegram
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 5,
  },
  reset_credit_decreased: {
    minSeverity: "info",
    telegramImmediate: false, // Credit decrease is dashboard-only by default
    dashboardOnly: true,
    criticalBypassQuietHours: false,
    cooldownMinutes: 15,
  },
  provider_degraded: {
    minSeverity: "warning",
    telegramImmediate: false, // Telegram only after 3 consecutive failures
    dashboardOnly: true,
    criticalBypassQuietHours: false,
    cooldownMinutes: 15,
  },
  provider_down: {
    minSeverity: "error",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: true,
    cooldownMinutes: 5,
  },
  provider_recovered: {
    minSeverity: "info",
    telegramImmediate: true, // Recovery notifies Telegram despite info severity
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
  credential_blocked: {
    minSeverity: "error",
    telegramImmediate: true, // After 2 consecutive observations
    dashboardOnly: false,
    criticalBypassQuietHours: true,
    cooldownMinutes: 5,
  },
  credential_disabled: {
    minSeverity: "error",
    telegramImmediate: true, // After 2 consecutive observations
    dashboardOnly: false,
    criticalBypassQuietHours: true,
    cooldownMinutes: 5,
  },
  credential_cooldown: {
    minSeverity: "warning",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 15,
  },
  credential_recovered: {
    minSeverity: "info",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
  collector_failure: {
    minSeverity: "error",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 15,
  },
  collector_recovered: {
    minSeverity: "info",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
  host_offline: {
    minSeverity: "error",
    telegramImmediate: true, // Only after 15m delay
    dashboardOnly: false,
    criticalBypassQuietHours: true,
    cooldownMinutes: 15,
  },
  host_recovered: {
    minSeverity: "info",
    telegramImmediate: true, // Recovery notifies Telegram
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
  agentrouter_large_balance_drop: {
    minSeverity: "warning", // Drop >= $25
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 15,
  },
  agentrouter_balance_low: {
    minSeverity: "warning", // Balance <= $50
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 30,
  },
  agentrouter_grant_received: {
    minSeverity: "info",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
  agentrouter_challenge_required: {
    minSeverity: "warning",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 5,
  },
  agentrouter_login_required: {
    minSeverity: "warning",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 15,
  },
  agentrouter_login_failed: {
    minSeverity: "error",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 15,
  },
  agentrouter_endpoint_failed: {
    minSeverity: "error",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 15,
  },
  session_context_warning: {
    minSeverity: "warning", // >= 80% contextBps (8000)
    telegramImmediate: false, // Dashboard only!
    dashboardOnly: true,
    criticalBypassQuietHours: false,
    cooldownMinutes: 30,
  },
  session_context_critical: {
    minSeverity: "critical", // >= 95% contextBps (9500)
    telegramImmediate: false, // Dashboard only by default (Telegram-off even for critical!)
    dashboardOnly: true,
    criticalBypassQuietHours: false,
    cooldownMinutes: 15,
  },
  session_failed: {
    minSeverity: "error",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 5,
  },
  session_started: {
    minSeverity: "info",
    telegramImmediate: false,
    dashboardOnly: true,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
  session_closed: {
    minSeverity: "info",
    telegramImmediate: false,
    dashboardOnly: true,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
  digest_ready: {
    minSeverity: "info",
    telegramImmediate: true,
    dashboardOnly: false,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
  policy_changed: {
    minSeverity: "info",
    telegramImmediate: false,
    dashboardOnly: true,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
  import_completed: {
    minSeverity: "info",
    telegramImmediate: false,
    dashboardOnly: true,
    criticalBypassQuietHours: false,
    cooldownMinutes: 0,
  },
};

export const BASE_GLOBAL_POLICY: EffectiveNotificationPolicyResolved = {
  policyId: "policy:default",
  target: "global",
  scopeType: "global",
  enabled: true,
  silenced: false,
  telegramImmediate: true,
  dashboardOnly: false,
  minSeverity: "warning",
  thresholds: {
    warningRemainingFraction: DEFAULT_THRESHOLDS.warningRemainingFraction,
    criticalRemainingFraction: DEFAULT_THRESHOLDS.criticalRemainingFraction,
    exhaustedRemainingFraction: DEFAULT_THRESHOLDS.exhaustedRemainingFraction,
    hysteresisFraction: DEFAULT_THRESHOLDS.hysteresisFraction,
  },
  consecutiveFailuresThreshold: 3,
  cooldownMinutes: 15,
  throttleIntervalMs: 60_000,
  channels: ["default"],
  recipient: null,
  quietHoursEnabled: false,
  quietHoursTimezone: "UTC",
  quietHoursStart: null,
  quietHoursEnd: null,
  criticalBypassQuietHours: true,
  digestEnabled: false,
  digestSchedule: null,
  digestTimezone: "UTC",
  matchEventTypes: [],
  matchHostIds: [],
  matchIdentityIds: [],
  warningRemainingFraction: DEFAULT_THRESHOLDS.warningRemainingFraction,
  criticalRemainingFraction: DEFAULT_THRESHOLDS.criticalRemainingFraction,
  exhaustedRemainingFraction: DEFAULT_THRESHOLDS.exhaustedRemainingFraction,
  hysteresisFraction: DEFAULT_THRESHOLDS.hysteresisFraction,
  updatedAt: new Date(0).toISOString(),
};

export interface PolicyResolutionContext {
  eventType?: string | ObservatoryEventType;
  provider?: string;
  credentialId?: string;
  poolId?: string;
  identityId?: string;
  accountId?: string;
  hostId?: string;
  sessionId?: string;
}

export interface PolicyFieldProvenance {
  value: unknown;
  sourceTarget: string;
  scopeType: PolicyScopeType;
  overriddenFrom?: string[];
}

export interface PolicyExplanation {
  target: string;
  appliedRules: string[];
  fieldSources: Record<string, PolicyFieldProvenance>;
  summary: string;
}

export interface NotificationDispatchDecision {
  shouldDeliver: boolean;
  reason:
    | "active"
    | "disabled"
    | "silenced"
    | "dashboard_only"
    | "severity_filtered"
    | "quiet_hours"
    | "unmatched_event_type"
    | "unmatched_host"
    | "unmatched_identity";
  channels: string[];
  isQuietHours: boolean;
  criticalBypassed: boolean;
  cooldownMinutes: number;
  throttleIntervalMs: number;
}

/**
 * Validates whether a given timezone string is a valid IANA timezone.
 */
export function validateIanaTimezone(timeZone: unknown, fieldName = "timeZone"): string {
  if (typeof timeZone !== "string" || timeZone.trim().length === 0) {
    throw new ValidationError(fieldName, "must be a non-empty string representing an IANA timezone");
  }
  const cleanTz = timeZone.trim();
  try {
    Intl.DateTimeFormat(undefined, { timeZone: cleanTz });
    return cleanTz;
  } catch {
    throw new ValidationError(fieldName, `invalid IANA timezone: "${timeZone}"`);
  }
}

/**
 * Validates a 24h time of day in HH:MM format (00:00 - 23:59).
 */
export function validateTimeOfDay(val: unknown, fieldName: string): string | null {
  if (val === undefined || val === null || val === "") {
    return null;
  }
  if (typeof val !== "string" || !/^\d{2}:\d{2}$/.test(val)) {
    throw new ValidationError(fieldName, `must be HH:MM in 24h format (e.g. "22:00"), got: ${String(val)}`);
  }
  const [h, m] = val.split(":").map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    throw new ValidationError(fieldName, `out of valid hour/minute range (00:00 to 23:59): ${val}`);
  }
  return val;
}

/**
 * Validates a strict digest schedule specification.
 * Supported formats:
 * - "hourly"
 * - "daily@HH:MM" (with 24h HH:MM)
 * - "interval:<minutes>" (where minutes >= 5 and <= 10080)
 */
export function validateDigestSchedule(val: unknown, fieldName = "digestSchedule"): string | null {
  if (val === undefined || val === null || val === "") {
    return null;
  }
  if (typeof val !== "string") {
    throw new ValidationError(fieldName, "must be a string format (e.g. 'hourly', 'daily@09:00', 'interval:60')");
  }
  const s = val.trim().toLowerCase();
  if (s === "hourly") {
    return "hourly";
  }
  if (/^daily@\d{2}:\d{2}$/.test(s)) {
    const timePart = s.slice("daily@".length);
    validateTimeOfDay(timePart, `${fieldName}.time`);
    return `daily@${timePart}`;
  }
  if (/^interval:\d+$/.test(s)) {
    const minStr = s.slice("interval:".length);
    const mins = parseInt(minStr, 10);
    if (!Number.isSafeInteger(mins) || mins < 5 || mins > 10_080) {
      throw new ValidationError(fieldName, "interval minutes must be an integer between 5 and 10080");
    }
    return `interval:${mins}`;
  }
  throw new ValidationError(
    fieldName,
    `unsupported digest schedule format: "${val}". Must be 'hourly', 'daily@HH:MM', or 'interval:<minutes>'`,
  );
}

/**
 * Parses a target string (e.g. "provider:openai-codex") into scope type and key.
 * Requires non-empty scopeKey for non-global scopes. Rejects global:<key>.
 */
export function parsePolicyTarget(target: string): { scopeType: PolicyScopeType; scopeKey?: string } {
  if (!target || typeof target !== "string" || target.trim().length === 0) {
    throw new ValidationError("target", "must be a non-empty string");
  }
  const cleanTarget = target.trim();
  if (cleanTarget === "global" || cleanTarget === "*") {
    return { scopeType: "global" };
  }

  const colonIndex = cleanTarget.indexOf(":");
  if (colonIndex === -1) {
    throw new ValidationError(
      "target",
      `non-global target must be formatted as "<scopeType>:<scopeKey>" (e.g. "provider:openai-codex"), got: "${target}"`,
    );
  }

  const prefix = cleanTarget.slice(0, colonIndex).toLowerCase();
  const key = cleanTarget.slice(colonIndex + 1).trim();

  if (prefix === "global") {
    throw new ValidationError("target", `global scope does not accept a sub-key: "${target}"`);
  }

  if (key.length === 0) {
    throw new ValidationError("target", `scope key for scope "${prefix}" cannot be empty: "${target}"`);
  }

  const validScopes: PolicyScopeType[] = [
    "global",
    "event",
    "provider",
    "credential",
    "pool",
    "identity",
    "account",
    "host",
    "session",
  ];

  if (!validScopes.includes(prefix as PolicyScopeType)) {
    throw new ValidationError("target", `unsupported policy scope "${prefix}". Valid: ${validScopes.join(", ")}`);
  }

  // If scope is event, validate against the closed taxonomy
  if (prefix === "event") {
    if (!OBSERVATORY_EVENT_TYPES.includes(key as CanonicalObservatoryEventType)) {
      throw new ValidationError("target", `unknown event type in scope target: "${key}"`);
    }
  }

  return { scopeType: prefix as PolicyScopeType, scopeKey: key };
}

/**
 * Validates atomic quiet-hours configuration.
 */
export function validateAtomicQuietHours(config: {
  quietHoursEnabled?: boolean | null;
  quietHoursTimezone?: string | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}): {
  quietHoursEnabled: boolean;
  quietHoursTimezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
} {
  const enabled = Boolean(config.quietHoursEnabled);
  if (!enabled) {
    return {
      quietHoursEnabled: false,
      quietHoursTimezone: config.quietHoursTimezone ? validateIanaTimezone(config.quietHoursTimezone) : "UTC",
      quietHoursStart: null,
      quietHoursEnd: null,
    };
  }

  if (!config.quietHoursStart || !config.quietHoursEnd) {
    throw new ValidationError(
      "quietHours",
      "atomic quiet hours configuration requires both quietHoursStart and quietHoursEnd when quietHoursEnabled is true",
    );
  }

  const start = validateTimeOfDay(config.quietHoursStart, "quietHoursStart")!;
  const end = validateTimeOfDay(config.quietHoursEnd, "quietHoursEnd")!;
  const tz = validateIanaTimezone(config.quietHoursTimezone || "UTC", "quietHoursTimezone");

  return {
    quietHoursEnabled: true,
    quietHoursTimezone: tz,
    quietHoursStart: start,
    quietHoursEnd: end,
  };
}

/**
 * Validates threshold ordering invariant on remaining fractions:
 * warning (e.g. 0.20) >= critical (e.g. 0.10) >= exhausted (e.g. 0.02) >= 0
 * and hysteresis in [0, 0.20].
 */
export function validateThresholdInvariants(thresholds: {
  warningRemainingFraction: number;
  criticalRemainingFraction: number;
  exhaustedRemainingFraction: number;
  hysteresisFraction: number;
}): void {
  const { warningRemainingFraction: w, criticalRemainingFraction: c, exhaustedRemainingFraction: e, hysteresisFraction: h } =
    thresholds;

  if (w < 0 || w > 1 || c < 0 || c > 1 || e < 0 || e > 1) {
    throw new ValidationError("thresholds", `threshold fractions must be in 0..1 range (got w:${w}, c:${c}, e:${e})`);
  }
  if (h < 0 || h > 0.20) {
    throw new ValidationError("hysteresisFraction", `hysteresis fraction must be between 0 and 0.20 (got ${h})`);
  }
  if (w < c || c < e) {
    throw new ValidationError(
      "thresholds",
      `remaining fraction ordering invariant violated: warning (${w}) >= critical (${c}) >= exhausted (${e}) required`,
    );
  }
}

/**
 * Validates a NotificationPolicyRule input.
 * Preserves undefined for omitted override fields (sparse rule preservation).
 */
export function validatePolicyRule(input: unknown): NotificationPolicyRule {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("NotificationPolicyRule", "must be a non-null object");
  }
  const obj = input as Record<string, unknown>;

  const parsed = parsePolicyTarget(String(obj.target || ""));
  const target = obj.target as string;

  // Strict check: if scopeType or scopeKey are supplied explicitly, they must match target
  if (obj.scopeType !== undefined && obj.scopeType !== null && obj.scopeType !== parsed.scopeType) {
    throw new ValidationError(
      "scopeType",
      `mismatch with target scope: target indicates "${parsed.scopeType}" but scopeType was "${String(obj.scopeType)}"`,
    );
  }
  if (obj.scopeKey !== undefined && obj.scopeKey !== null && obj.scopeKey !== parsed.scopeKey) {
    throw new ValidationError(
      "scopeKey",
      `mismatch with target scopeKey: target indicates "${parsed.scopeKey}" but scopeKey was "${String(obj.scopeKey)}"`,
    );
  }

  const validateStrictBoolean = (val: unknown, name: string): boolean | null | undefined => {
    if (val === undefined) return undefined;
    if (val === null) return null;
    if (typeof val !== "boolean") {
      throw new ValidationError(name, `must be a boolean value (got ${typeof val})`);
    }
    return val;
  };

  const enabled = validateStrictBoolean(obj.enabled, "enabled");
  const silenced = validateStrictBoolean(obj.silenced, "silenced");
  const telegramImmediate = validateStrictBoolean(obj.telegramImmediate, "telegramImmediate");
  const dashboardOnly = validateStrictBoolean(obj.dashboardOnly, "dashboardOnly");
  const criticalBypassQuietHours = validateStrictBoolean(obj.criticalBypassQuietHours, "criticalBypassQuietHours");
  const digestEnabled = validateStrictBoolean(obj.digestEnabled, "digestEnabled");
  let minSeverity: EventSeverity | null | undefined;
  if (obj.minSeverity === null) {
    minSeverity = null;
  } else if (obj.minSeverity !== undefined) {
    const validSeverities: EventSeverity[] = ["info", "warning", "error", "critical"];
    const s = String(obj.minSeverity).toLowerCase();
    if (!validSeverities.includes(s as EventSeverity)) {
      throw new ValidationError("minSeverity", `must be one of: ${validSeverities.join(", ")}`);
    }
    minSeverity = s as EventSeverity;
  }

  const validateStrictInteger = (val: unknown, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number | null | undefined => {
    if (val === undefined) return undefined;
    if (val === null) return null;
    if (typeof val !== "number" || !Number.isSafeInteger(val) || val < min || val > max) {
      throw new ValidationError(name, `must be an integer between ${min} and ${max}`);
    }
    return val;
  };

  const validateStrictFraction = (val: unknown, name: string, min = 0, max = 1): number | null | undefined => {
    if (val === undefined) return undefined;
    if (val === null) return null;
    if (typeof val !== "number" || !Number.isFinite(val) || val < min || val > max) {
      throw new ValidationError(name, `must be a finite number between ${min} and ${max}`);
    }
    return val;
  };

  const cooldownMinutes = validateStrictInteger(obj.cooldownMinutes, "cooldownMinutes", 0, 10_080);
  const throttleIntervalMs = validateStrictInteger(obj.throttleIntervalMs, "throttleIntervalMs", 0, 86_400_000);
  const consecutiveFailuresThreshold = validateStrictInteger(obj.consecutiveFailuresThreshold, "consecutiveFailuresThreshold", 1, 100);

  const warningRemainingFraction = validateStrictFraction(obj.warningRemainingFraction, "warningRemainingFraction", 0, 1);
  const criticalRemainingFraction = validateStrictFraction(obj.criticalRemainingFraction, "criticalRemainingFraction", 0, 1);
  const exhaustedRemainingFraction = validateStrictFraction(obj.exhaustedRemainingFraction, "exhaustedRemainingFraction", 0, 1);
  const hysteresisFraction = validateStrictFraction(obj.hysteresisFraction, "hysteresisFraction", 0, 0.20);

  // Validate atomic quiet hours if partially provided
  let quietHoursEnabled = validateStrictBoolean(obj.quietHoursEnabled, "quietHoursEnabled");
  let quietHoursTimezone: string | null | undefined;
  if (obj.quietHoursTimezone === null) {
    quietHoursTimezone = null;
  } else if (obj.quietHoursTimezone !== undefined) {
    quietHoursTimezone = validateIanaTimezone(obj.quietHoursTimezone, "quietHoursTimezone");
  }

  let quietHoursStart: string | null | undefined;
  if (obj.quietHoursStart === null) {
    quietHoursStart = null;
  } else if (obj.quietHoursStart !== undefined) {
    quietHoursStart = validateTimeOfDay(obj.quietHoursStart, "quietHoursStart");
  }

  let quietHoursEnd: string | null | undefined;
  if (obj.quietHoursEnd === null) {
    quietHoursEnd = null;
  } else if (obj.quietHoursEnd !== undefined) {
    quietHoursEnd = validateTimeOfDay(obj.quietHoursEnd, "quietHoursEnd");
  }

  if (quietHoursEnabled === true && (!quietHoursStart || !quietHoursEnd || !quietHoursTimezone)) {
    throw new ValidationError("quietHours", "quietHoursStart, quietHoursEnd, and quietHoursTimezone are required when quietHoursEnabled is true");
  }

  let digestSchedule: string | null | undefined;
  if (obj.digestSchedule === null) {
    digestSchedule = null;
  } else if (obj.digestSchedule !== undefined) {
    digestSchedule = validateDigestSchedule(obj.digestSchedule, "digestSchedule");
  }

  let digestTimezone: string | null | undefined;
  if (obj.digestTimezone === null) {
    digestTimezone = null;
  } else if (obj.digestTimezone !== undefined) {
    digestTimezone = validateIanaTimezone(obj.digestTimezone, "digestTimezone");
  }

  if (digestEnabled === true && (!digestSchedule || !digestTimezone)) {
    throw new ValidationError("digest", "digestSchedule and digestTimezone are required when digestEnabled is true");
  }

  const validateStrArray = (arr: unknown, name: string): string[] | null | undefined => {
    if (arr === undefined) return undefined;
    if (arr === null) return null;
    if (!Array.isArray(arr)) {
      throw new ValidationError(name, "must be an array of strings or null");
    }
    return arr.map((item, idx) => {
      if (typeof item !== "string" || item.trim().length === 0) {
        throw new ValidationError(`${name}[${idx}]`, "must be a non-empty string");
      }
      return item.trim();
    });
  };

  const channels = validateStrArray(obj.channels, "channels");
  const rawMatchEventTypes = validateStrArray(obj.matchEventTypes, "matchEventTypes");
  const matchEventTypes = rawMatchEventTypes as ObservatoryEventType[] | null | undefined;
  // Validate matchEventTypes against canonical taxonomy
  if (matchEventTypes) {
    for (const et of matchEventTypes) {
      if (!OBSERVATORY_EVENT_TYPES.includes(et as CanonicalObservatoryEventType)) {
        throw new ValidationError("matchEventTypes", `unknown event type in allowlist: "${et}"`);
      }
    }
  }

  const matchHostIds = validateStrArray(obj.matchHostIds, "matchHostIds");
  const matchIdentityIds = validateStrArray(obj.matchIdentityIds, "matchIdentityIds");
  const recipient = obj.recipient === null ? null : typeof obj.recipient === "string" ? obj.recipient.trim() : undefined;

  return {
    id: typeof obj.id === "string" ? obj.id : undefined,
    target: target.trim(),
    scopeType: parsed.scopeType,
    scopeKey: parsed.scopeKey,
    enabled,
    silenced,
    telegramImmediate,
    dashboardOnly,
    minSeverity,
    cooldownMinutes,
    throttleIntervalMs,
    channels,
    recipient,
    quietHoursEnabled,
    quietHoursTimezone,
    quietHoursStart,
    quietHoursEnd,
    criticalBypassQuietHours,
    digestEnabled,
    digestSchedule,
    digestTimezone,
    matchEventTypes,
    matchHostIds,
    matchIdentityIds,
    warningRemainingFraction,
    criticalRemainingFraction,
    exhaustedRemainingFraction,
    hysteresisFraction,
    consecutiveFailuresThreshold,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
  };
}

/**
 * Checks if a rule matches a given resolution context.
 */
export function ruleMatchesContext(rule: NotificationPolicyRule, context: PolicyResolutionContext): boolean {
  const scopeType = rule.scopeType ?? parsePolicyTarget(rule.target).scopeType;
  const scopeKey = rule.scopeKey ?? parsePolicyTarget(rule.target).scopeKey;

  switch (scopeType) {
    case "global":
      return true;
    case "event":
      return Boolean(scopeKey && context.eventType && scopeKey === context.eventType);
    case "provider":
      return Boolean(scopeKey && context.provider && scopeKey === context.provider);
    case "credential":
      return Boolean(scopeKey && context.credentialId && scopeKey === context.credentialId);
    case "pool":
      return Boolean(scopeKey && context.poolId && scopeKey === context.poolId);
    case "identity":
      return Boolean(scopeKey && context.identityId && scopeKey === context.identityId);
    case "account":
      return Boolean(scopeKey && context.accountId && scopeKey === context.accountId);
    case "host":
      return Boolean(scopeKey && context.hostId && scopeKey === context.hostId);
    case "session":
      return Boolean(scopeKey && context.sessionId && scopeKey === context.sessionId);
    default:
      return false;
  }
}

/**
 * Merges a rule onto an effective policy with sparse nullable override semantics.
 */
export function mergePolicyRule(
  base: EffectiveNotificationPolicyResolved,
  child: NotificationPolicyRule,
  provenanceMap?: Record<string, PolicyFieldProvenance>,
): EffectiveNotificationPolicyResolved {
  const next = { ...base };
  const target = child.target;
  const scopeType = child.scopeType ?? parsePolicyTarget(child.target).scopeType;

  const recordProvenance = (field: string, val: unknown) => {
    if (!provenanceMap) return;
    const prev = provenanceMap[field];
    provenanceMap[field] = {
      value: val,
      sourceTarget: target,
      scopeType,
      overriddenFrom: prev ? [...(prev.overriddenFrom || []), prev.sourceTarget] : undefined,
    };
  };

  if (child.enabled !== undefined) {
    next.enabled = child.enabled ?? true;
    recordProvenance("enabled", next.enabled);
  }
  if (child.silenced !== undefined) {
    next.silenced = child.silenced ?? false;
    recordProvenance("silenced", next.silenced);
  }
  if (child.telegramImmediate !== undefined) {
    next.telegramImmediate = child.telegramImmediate ?? true;
    recordProvenance("telegramImmediate", next.telegramImmediate);
  }
  if (child.dashboardOnly !== undefined) {
    next.dashboardOnly = child.dashboardOnly ?? false;
    recordProvenance("dashboardOnly", next.dashboardOnly);
  }
  if (child.minSeverity !== undefined) {
    next.minSeverity = child.minSeverity ?? BASE_GLOBAL_POLICY.minSeverity;
    recordProvenance("minSeverity", next.minSeverity);
  }
  if (child.cooldownMinutes !== undefined) {
    next.cooldownMinutes = child.cooldownMinutes ?? BASE_GLOBAL_POLICY.cooldownMinutes;
    recordProvenance("cooldownMinutes", next.cooldownMinutes);
  }
  if (child.throttleIntervalMs !== undefined) {
    next.throttleIntervalMs = child.throttleIntervalMs ?? BASE_GLOBAL_POLICY.throttleIntervalMs;
    recordProvenance("throttleIntervalMs", next.throttleIntervalMs);
  }
  if (child.channels !== undefined) {
    next.channels = child.channels ? [...child.channels] : [];
    recordProvenance("channels", next.channels);
  }
  if (child.recipient !== undefined) {
    next.recipient = child.recipient;
    recordProvenance("recipient", next.recipient);
  }
  if (child.quietHoursEnabled !== undefined) {
    next.quietHoursEnabled = child.quietHoursEnabled ?? false;
    recordProvenance("quietHoursEnabled", next.quietHoursEnabled);
  }
  if (child.quietHoursTimezone !== undefined) {
    next.quietHoursTimezone = child.quietHoursTimezone ?? BASE_GLOBAL_POLICY.quietHoursTimezone;
    recordProvenance("quietHoursTimezone", next.quietHoursTimezone);
  }
  if (child.quietHoursStart !== undefined) {
    next.quietHoursStart = child.quietHoursStart;
    recordProvenance("quietHoursStart", next.quietHoursStart);
  }
  if (child.quietHoursEnd !== undefined) {
    next.quietHoursEnd = child.quietHoursEnd;
    recordProvenance("quietHoursEnd", next.quietHoursEnd);
  }
  if (child.criticalBypassQuietHours !== undefined) {
    next.criticalBypassQuietHours = child.criticalBypassQuietHours ?? true;
    recordProvenance("criticalBypassQuietHours", next.criticalBypassQuietHours);
  }
  if (child.digestEnabled !== undefined) {
    next.digestEnabled = child.digestEnabled ?? false;
    recordProvenance("digestEnabled", next.digestEnabled);
  }
  if (child.digestSchedule !== undefined) {
    next.digestSchedule = child.digestSchedule;
    recordProvenance("digestSchedule", next.digestSchedule);
  }
  if (child.digestTimezone !== undefined) {
    next.digestTimezone = child.digestTimezone ?? BASE_GLOBAL_POLICY.digestTimezone;
    recordProvenance("digestTimezone", next.digestTimezone);
  }
  if (child.matchEventTypes !== undefined) {
    next.matchEventTypes = child.matchEventTypes ? [...child.matchEventTypes] : [];
    recordProvenance("matchEventTypes", next.matchEventTypes);
  }
  if (child.matchHostIds !== undefined) {
    next.matchHostIds = child.matchHostIds ? [...child.matchHostIds] : [];
    recordProvenance("matchHostIds", next.matchHostIds);
  }
  if (child.matchIdentityIds !== undefined) {
    next.matchIdentityIds = child.matchIdentityIds ? [...child.matchIdentityIds] : [];
    recordProvenance("matchIdentityIds", next.matchIdentityIds);
  }
  if (child.warningRemainingFraction !== undefined) {
    next.warningRemainingFraction = child.warningRemainingFraction ?? DEFAULT_THRESHOLDS.warningRemainingFraction;
    recordProvenance("warningRemainingFraction", next.warningRemainingFraction);
  }
  if (child.criticalRemainingFraction !== undefined) {
    next.criticalRemainingFraction = child.criticalRemainingFraction ?? DEFAULT_THRESHOLDS.criticalRemainingFraction;
    recordProvenance("criticalRemainingFraction", next.criticalRemainingFraction);
  }
  if (child.exhaustedRemainingFraction !== undefined) {
    next.exhaustedRemainingFraction = child.exhaustedRemainingFraction ?? DEFAULT_THRESHOLDS.exhaustedRemainingFraction;
    recordProvenance("exhaustedRemainingFraction", next.exhaustedRemainingFraction);
  }
  if (child.hysteresisFraction !== undefined) {
    next.hysteresisFraction = child.hysteresisFraction ?? DEFAULT_THRESHOLDS.hysteresisFraction;
    recordProvenance("hysteresisFraction", next.hysteresisFraction);
  }
  if (child.consecutiveFailuresThreshold !== undefined) {
    next.consecutiveFailuresThreshold =
      child.consecutiveFailuresThreshold ?? BASE_GLOBAL_POLICY.consecutiveFailuresThreshold;
    recordProvenance("consecutiveFailuresThreshold", next.consecutiveFailuresThreshold);
  }

  next.target = target;
  next.scopeType = scopeType;
  next.scopeKey = child.scopeKey ?? parsePolicyTarget(target).scopeKey;
  if (child.updatedAt) next.updatedAt = child.updatedAt;

  return next;
}

/**
 * Resolves effective policy across hierarchical scopes and validates final merged invariants.
 */
export function resolveEffectivePolicy(
  rules: NotificationPolicyRule[],
  context: PolicyResolutionContext = {},
): {
  policy: EffectiveNotificationPolicyResolved;
  explanation: PolicyExplanation;
} {
  const provenanceMap: Record<string, PolicyFieldProvenance> = {};

  // 1. Start from base global defaults
  let current: EffectiveNotificationPolicyResolved = {
    ...BASE_GLOBAL_POLICY,
    policyId: `effective:${context.identityId || context.hostId || context.eventType || "global"}`,
    updatedAt: new Date().toISOString(),
  };

  // 2. Apply event-specific baseline default if context.eventType has one
  const eventType = context.eventType ? String(context.eventType) : undefined;
  if (eventType && EVENT_DEFAULT_POLICIES[eventType as CanonicalObservatoryEventType]) {
    const eventBase = EVENT_DEFAULT_POLICIES[eventType as CanonicalObservatoryEventType];
    current = mergePolicyRule(
      current,
      {
        target: `event:${eventType}`,
        ...eventBase,
      },
      provenanceMap,
    );
  } else {
    // Seed standard global default provenance
    for (const [k, v] of Object.entries(BASE_GLOBAL_POLICY)) {
      provenanceMap[k] = {
        value: v,
        sourceTarget: "default",
        scopeType: "global",
      };
    }
  }

  // 3. Sort configured user rules by scope precedence
  const matchedRules = rules
    .filter((r) => ruleMatchesContext(r, context))
    .sort((a, b) => {
      const scopeA = a.scopeType ?? parsePolicyTarget(a.target).scopeType;
      const scopeB = b.scopeType ?? parsePolicyTarget(b.target).scopeType;
      const indexA = POLICY_SCOPE_PRECEDENCE.indexOf(scopeA);
      const indexB = POLICY_SCOPE_PRECEDENCE.indexOf(scopeB);
      return (indexA === -1 ? 99 : indexA) - (indexB === -1 ? 99 : indexB);
    });

  const appliedRuleTargets: string[] = [];
  for (const rule of matchedRules) {
    current = mergePolicyRule(current, rule, provenanceMap);
    appliedRuleTargets.push(rule.target);
  }

  // 4. Validate final merged invariants
  validateThresholdInvariants({
    warningRemainingFraction: current.warningRemainingFraction,
    criticalRemainingFraction: current.criticalRemainingFraction,
    exhaustedRemainingFraction: current.exhaustedRemainingFraction,
    hysteresisFraction: current.hysteresisFraction,
  });

  // Validate atomic quiet hours in merged policy
  if (current.quietHoursEnabled) {
    validateAtomicQuietHours({
      quietHoursEnabled: current.quietHoursEnabled,
      quietHoursTimezone: current.quietHoursTimezone,
      quietHoursStart: current.quietHoursStart,
      quietHoursEnd: current.quietHoursEnd,
    });
  }

  // Validate atomic digest in merged policy
  if (current.digestEnabled) {
    if (!current.digestSchedule || !current.digestTimezone) {
      throw new ValidationError("digest", "digestSchedule and digestTimezone are required when digestEnabled is true in effective policy");
    }
    validateDigestSchedule(current.digestSchedule);
    validateIanaTimezone(current.digestTimezone);
  }

  // Sync thresholds map for compatibility
  current.thresholds = {
    warningRemainingFraction: current.warningRemainingFraction,
    criticalRemainingFraction: current.criticalRemainingFraction,
    exhaustedRemainingFraction: current.exhaustedRemainingFraction,
    hysteresisFraction: current.hysteresisFraction,
  };

  const summary = `Resolved policy from ${appliedRuleTargets.length} rules (${appliedRuleTargets.join(" -> ") || "defaults only"}). MinSeverity: ${current.minSeverity}, TelegramImmediate: ${current.telegramImmediate}, DashboardOnly: ${current.dashboardOnly}, QuietHours: ${current.quietHoursEnabled ? `${current.quietHoursStart}-${current.quietHoursEnd} (${current.quietHoursTimezone})` : "disabled"}.`;

  const explanation: PolicyExplanation = {
    target: current.target,
    appliedRules: appliedRuleTargets,
    fieldSources: provenanceMap,
    summary,
  };

  return { policy: current, explanation };
}

/**
 * Evaluates whether a timestamp is in quiet hours for a policy.
 * Accurately accounts for IANA timezones, midnight crossing, and DST gap/fold boundaries.
 */
export function isQuietHours(
  policy: NotificationPolicyRule | EffectiveNotificationPolicyResolved,
  atTime: Date | string | number,
): boolean {
  if (!policy.quietHoursEnabled) {
    return false;
  }

  const date = typeof atTime === "number" || typeof atTime === "string" ? new Date(atTime) : atTime;
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const startStr = policy.quietHoursStart;
  const endStr = policy.quietHoursEnd;

  if (!startStr || !endStr) {
    return false;
  }

  const timezone = policy.quietHoursTimezone || "UTC";

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });

    const parts = formatter.formatToParts(date);
    const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
    const minPart = parts.find((p) => p.type === "minute")?.value ?? "0";

    const hour = parseInt(hourPart, 10) % 24;
    const min = parseInt(minPart, 10);
    const currentMinutes = hour * 60 + min;

    const [startH, startM] = startStr.split(":").map(Number);
    const [endH, endM] = endStr.split(":").map(Number);

    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes === endMinutes) {
      return true; // 24-hour quiet period
    }

    if (startMinutes < endMinutes) {
      // Same day: e.g. 09:00 to 17:00
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      // Crosses midnight: e.g. 22:00 to 08:00
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  } catch {
    return false;
  }
}

/**
 * Computes unambiguous canonical occurrence slot key for a digest schedule in a specific timezone,
 * including UTC timestamp for unambiguous DST fall-back fold representation.
 */
export function getDigestSlotKey(
  schedule: string,
  timezone: string,
  atTime: Date | string | number,
): string | null {
  const validSchedule = validateDigestSchedule(schedule);
  if (!validSchedule) return null;

  const date = typeof atTime === "number" || typeof atTime === "string" ? new Date(atTime) : atTime;
  if (Number.isNaN(date.getTime())) return null;

  const cleanTz = validateIanaTimezone(timezone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: cleanTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const yyyy = getPart("year");
  const mm = getPart("month");
  const dd = getPart("day");
  const hh = getPart("hour");
  const min = getPart("minute");

  const epochMs = date.getTime();

  if (validSchedule === "hourly") {
    const hourEpoch = Math.floor(epochMs / (60 * 60 * 1000)) * (60 * 60 * 1000);
    return `digest:hourly:${cleanTz}:${yyyy}-${mm}-${dd}T${hh}:00:U${hourEpoch}`;
  }
  if (validSchedule.startsWith("daily@")) {
    const timePart = validSchedule.slice("daily@".length);
    return `digest:daily:${cleanTz}:${yyyy}-${mm}-${dd}T${timePart}`;
  }
  if (validSchedule.startsWith("interval:")) {
    const intervalMins = parseInt(validSchedule.slice("interval:".length), 10);
    const totalMins = Math.floor(epochMs / (60 * 1000));
    const slotIdx = Math.floor(totalMins / intervalMins);
    return `digest:interval_${intervalMins}:${slotIdx}`;
  }

  return null;
}

export interface DueDigestSlotResult {
  due: boolean;
  slotKey: string | null;
  occurrenceTime: string | null;
}

/**
 * Computes whether an unclaimed digest slot is due between watermark and current time.
 */
export function getDueDigestSlot(
  schedule: string,
  timezone: string,
  currentTime: Date | string | number,
  lastClaimedSlotKey?: string | null,
): DueDigestSlotResult {
  const date = typeof currentTime === "number" || typeof currentTime === "string" ? new Date(currentTime) : currentTime;
  if (Number.isNaN(date.getTime())) {
    return { due: false, slotKey: null, occurrenceTime: null };
  }

  const slotKey = getDigestSlotKey(schedule, timezone, date);
  if (!slotKey) {
    return { due: false, slotKey: null, occurrenceTime: null };
  }

  if (lastClaimedSlotKey && lastClaimedSlotKey === slotKey) {
    return { due: false, slotKey, occurrenceTime: date.toISOString() };
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;
  const min = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);

  const cleanSchedule = schedule.trim().toLowerCase();

  if (cleanSchedule === "hourly") {
    return { due: min === 0, slotKey, occurrenceTime: date.toISOString() };
  }
  if (cleanSchedule.startsWith("daily@")) {
    const [targetH, targetM] = cleanSchedule.slice("daily@".length).split(":").map(Number);
    return { due: hour === targetH && min === targetM, slotKey, occurrenceTime: date.toISOString() };
  }
  if (cleanSchedule.startsWith("interval:")) {
    return { due: true, slotKey, occurrenceTime: date.toISOString() };
  }

  return { due: false, slotKey: null, occurrenceTime: null };
}

/**
 * Evaluates whether an event candidate should be dispatched.
 * Rejects missing scoped fields when allowlists are non-empty.
 * Severity filtering applies strictly before routing.
 */
export function evaluateNotificationDispatch(
  event: ObservatoryEventCandidate,
  policy: EffectiveNotificationPolicyResolved,
  now: Date | string | number,
): NotificationDispatchDecision {
  const inQuietHours = isQuietHours(policy, now);
  const isCritical = event.severity === "critical";
  const criticalBypassed = inQuietHours && isCritical && Boolean(policy.criticalBypassQuietHours);

  // 1. Explicitly disabled or silenced
  if (!policy.enabled) {
    return {
      shouldDeliver: false,
      reason: "disabled",
      channels: policy.channels,
      isQuietHours: inQuietHours,
      criticalBypassed: false,
      cooldownMinutes: policy.cooldownMinutes,
      throttleIntervalMs: policy.throttleIntervalMs,
    };
  }

  if (policy.silenced) {
    return {
      shouldDeliver: false,
      reason: "silenced",
      channels: policy.channels,
      isQuietHours: inQuietHours,
      criticalBypassed: false,
      cooldownMinutes: policy.cooldownMinutes,
      throttleIntervalMs: policy.throttleIntervalMs,
    };
  }

  // 2. Minimum Severity check applied independently
  const eventLevel = SEVERITY_LEVELS[event.severity] ?? 1;
  const minLevel = SEVERITY_LEVELS[policy.minSeverity] ?? 2;
  if (eventLevel < minLevel) {
    return {
      shouldDeliver: false,
      reason: "severity_filtered",
      channels: policy.channels,
      isQuietHours: inQuietHours,
      criticalBypassed: false,
      cooldownMinutes: policy.cooldownMinutes,
      throttleIntervalMs: policy.throttleIntervalMs,
    };
  }

  // 3. Dashboard-only check
  if (policy.dashboardOnly || !policy.telegramImmediate) {
    return {
      shouldDeliver: false,
      reason: "dashboard_only",
      channels: policy.channels,
      isQuietHours: inQuietHours,
      criticalBypassed: false,
      cooldownMinutes: policy.cooldownMinutes,
      throttleIntervalMs: policy.throttleIntervalMs,
    };
  }

  // 4. Scoped Allowlist Filters: require present matching values when non-empty (fail closed)
  if (policy.matchEventTypes && policy.matchEventTypes.length > 0) {
    if (!event.eventType || !policy.matchEventTypes.includes(event.eventType)) {
      return {
        shouldDeliver: false,
        reason: "unmatched_event_type",
        channels: policy.channels,
        isQuietHours: inQuietHours,
        criticalBypassed: false,
        cooldownMinutes: policy.cooldownMinutes,
        throttleIntervalMs: policy.throttleIntervalMs,
      };
    }
  }

  if (policy.matchHostIds && policy.matchHostIds.length > 0) {
    if (!event.hostId || !policy.matchHostIds.includes(event.hostId)) {
      return {
        shouldDeliver: false,
        reason: "unmatched_host",
        channels: policy.channels,
        isQuietHours: inQuietHours,
        criticalBypassed: false,
        cooldownMinutes: policy.cooldownMinutes,
        throttleIntervalMs: policy.throttleIntervalMs,
      };
    }
  }

  if (policy.matchIdentityIds && policy.matchIdentityIds.length > 0) {
    if (!event.identityId || !policy.matchIdentityIds.includes(event.identityId)) {
      return {
        shouldDeliver: false,
        reason: "unmatched_identity",
        channels: policy.channels,
        isQuietHours: inQuietHours,
        criticalBypassed: false,
        cooldownMinutes: policy.cooldownMinutes,
        throttleIntervalMs: policy.throttleIntervalMs,
      };
    }
  }

  // 5. Quiet Hours suppression
  if (inQuietHours && !criticalBypassed) {
    return {
      shouldDeliver: false,
      reason: "quiet_hours",
      channels: policy.channels,
      isQuietHours: true,
      criticalBypassed: false,
      cooldownMinutes: policy.cooldownMinutes,
      throttleIntervalMs: policy.throttleIntervalMs,
    };
  }

  return {
    shouldDeliver: true,
    reason: "active",
    channels: policy.channels,
    isQuietHours: inQuietHours,
    criticalBypassed,
    cooldownMinutes: policy.cooldownMinutes,
    throttleIntervalMs: policy.throttleIntervalMs,
  };
}
