/**
 * AI Fleet Observatory Event Transition Generators
 *
 * Implements pure, deterministic state transition generation for:
 * - Quota warnings, critical, exhausted evaluated on remaining fractions (<= 0.20, <= 0.10, <= 0.02) with 2% hysteresis
 * - Confirmed quota resets via remaining/used discontinuity (never timestamp movement alone)
 * - Distinct reset_credit_increased and reset_credit_decreased events with sequence numbers
 * - Multi-level Provider/Credential escalation state machine (degraded -> down -> cooldown -> blocked -> disabled) and recovery
 * - Fleet host offline with 15-minute delay and live-report recovery (online/degraded breaks offline continuity)
 * - Session context utilization (contextBps 0..10000, 8000/9500) with state preservation for null samples, hysteresis, and lifecycle events
 * - Complete AgentRouter domain events ($25 large balance drop, $50 low balance, grants, challenges, login required, failures)
 * - Length-prefixed typed canonical fingerprints using full 64-hex SHA-256 for guaranteed restart stability
 * - Monotonic timestamp watermark guards across all state machines
 */

import { createHash } from "node:crypto";
import { DEFAULT_THRESHOLDS, type CanonicalObservatoryEventType, type ThresholdConfig } from "./policies";
import type {
  EventSeverity,
  FleetHostObservation,
  ObservatoryEventCandidate,
  ObservatoryEventType,
  OmpSessionSummaryInput,
  ProviderHealth,
  ProviderIdentityObservation,
  QuotaObservationInput,
} from "./types";
import { ValidationError } from "./validation";

/**
 * Length-prefixed, typed canonical fingerprint generator with full SHA-256 digest.
 * Rejects non-finite numbers.
 */
export function createDeterministicFingerprint(
  eventType: string,
  targetId: string,
  ...components: (string | number | boolean | null | undefined)[]
): string {
  const parts: string[] = [`T:${eventType.length}:${eventType}`, `I:${targetId.length}:${targetId}`];

  for (const c of components) {
    if (c === undefined) {
      parts.push("U");
    } else if (c === null) {
      parts.push("L");
    } else if (typeof c === "boolean") {
      parts.push(c ? "B:1" : "B:0");
    } else if (typeof c === "number") {
      if (!Number.isFinite(c)) {
        throw new ValidationError("fingerprint", `non-finite numbers (NaN, Infinity) are rejected in fingerprint components`);
      }
      if (Object.is(c, -0)) {
        parts.push("N:-0");
      } else {
        parts.push(`N:${c}`);
      }
    } else {
      const s = String(c);
      parts.push(`S:${s.length}:${s}`);
    }
  }

  const canonicalPayload = parts.join("/");
  const hash = createHash("sha256").update(canonicalPayload).digest("hex");
  return `${eventType}:${targetId}:${hash}`;
}

export interface QuotaTrackerState {
  trackerKey: string;
  identityId: string;
  provider: string;
  bucketId: string;
  windowId: string;
  meter?: string | null;
  model?: string | null;
  tier?: string | null;
  generation: number;
  warningArmEpoch: number;
  criticalArmEpoch: number;
  exhaustedArmEpoch: number;
  creditChangeSeq: number;
  lastObservedAt: string;
  lastUsedFraction: number;
  lastRemainingFraction: number;
  lastResetCredits: number | null;
  warningFired: boolean;
  criticalFired: boolean;
  exhaustedFired: boolean;
}

export interface QuotaTransitionResult {
  events: ObservatoryEventCandidate[];
  nextState: QuotaTrackerState;
  resetConfirmed: boolean;
}

/**
 * Normalizes full quota scope into canonical tracker key.
 */
export function buildQuotaTrackerKey(obs: QuotaObservationInput): string {
  const provider = obs.provider || "unknown";
  const identityId = obs.identityId || "unknown";
  const bucketId = obs.bucketId || obs.windowId || "default";
  const meter = obs.meter || "";
  const model = obs.model || "";
  const tier = obs.tier || "";
  return `quota:${provider}:${identityId}:${bucketId}:${meter}:${model}:${tier}`;
}

/**
 * Derives canonical remaining fraction and validates dual fraction consistency.
 */
export function getCanonicalRemainingFraction(obs: QuotaObservationInput): number {
  const used = obs.usedFraction;
  const remaining = obs.remainingFraction !== undefined && obs.remainingFraction !== null
    ? obs.remainingFraction
    : 1 - used;

  if (obs.remainingFraction !== undefined && obs.remainingFraction !== null) {
    if (Math.abs(used + remaining - 1.0) > 0.02) {
      throw new ValidationError("quota", `Inconsistent dual quota fractions: usedFraction (${used}) + remainingFraction (${remaining}) != 1.0`);
    }
  }

  return Math.min(1, Math.max(0, remaining));
}

/**
 * Checks whether an observation represents a confirmed quota reset.
 * Discontinuity in remaining/used fraction is mandatory. Timestamp movement alone is not a reset.
 */
export function isConfirmedQuotaReset(
  prevState: QuotaTrackerState | null,
  obs: QuotaObservationInput,
): boolean {
  if (!prevState) {
    return false;
  }

  const prevRemaining = prevState.lastRemainingFraction;
  const currRemaining = getCanonicalRemainingFraction(obs);
  const prevUsed = prevState.lastUsedFraction;
  const currUsed = obs.usedFraction;

  const isResetsAtAdvanced = Boolean(
    obs.resetsAt &&
      prevState.lastObservedAt &&
      new Date(obs.resetsAt).getTime() > new Date(prevState.lastObservedAt).getTime(),
  );

  const isRemainingJump = currRemaining > prevRemaining + 0.05;
  const isUsedDrop = currUsed < prevUsed - 0.05;
  const isDramaticReset = prevRemaining <= 0.20 && currRemaining >= 0.70;

  if (isResetsAtAdvanced && (isRemainingJump || isUsedDrop)) {
    return true;
  }

  if (isDramaticReset) {
    return true;
  }

  return false;
}

/**
 * Pure transition generator for quota observations.
 * Evaluates against remaining fraction thresholds:
 * - Warning: remainingFraction <= 0.20
 * - Critical: remainingFraction <= 0.10
 * - Exhausted: remainingFraction <= 0.02
 * With 2% (0.02) hysteresis and monotonic arm epochs.
 */
export function evaluateQuotaTransition(
  prevState: QuotaTrackerState | null,
  obs: QuotaObservationInput,
  thresholds: Partial<ThresholdConfig> = {},
): QuotaTransitionResult {
  if (!obs.observedAt || typeof obs.observedAt !== "string") {
    throw new ValidationError("observedAt", "source observedAt timestamp is required");
  }

  const trackerKey = buildQuotaTrackerKey(obs);

  // Monotonic watermark guard
  if (prevState) {
    const prevTime = new Date(prevState.lastObservedAt).getTime();
    const currTime = new Date(obs.observedAt).getTime();
    if (currTime <= prevTime) {
      // Stale or out-of-order observation: return unmutated state with zero events
      return { events: [], nextState: prevState, resetConfirmed: false };
    }
  }

  const warnRemaining = thresholds.warningRemainingFraction ?? DEFAULT_THRESHOLDS.warningRemainingFraction;
  const critRemaining = thresholds.criticalRemainingFraction ?? DEFAULT_THRESHOLDS.criticalRemainingFraction;
  const exhRemaining = thresholds.exhaustedRemainingFraction ?? DEFAULT_THRESHOLDS.exhaustedRemainingFraction;
  const hysteresis = thresholds.hysteresisFraction ?? DEFAULT_THRESHOLDS.hysteresisFraction;

  const currRemaining = getCanonicalRemainingFraction(obs);
  const events: ObservatoryEventCandidate[] = [];
  const resetConfirmed = isConfirmedQuotaReset(prevState, obs);

  let generation = prevState ? prevState.generation : 1;
  let warningArmEpoch = prevState ? prevState.warningArmEpoch : 1;
  let criticalArmEpoch = prevState ? prevState.criticalArmEpoch : 1;
  let exhaustedArmEpoch = prevState ? prevState.exhaustedArmEpoch : 1;
  let creditChangeSeq = prevState ? prevState.creditChangeSeq : 0;
  let warningFired = prevState ? prevState.warningFired : false;
  let criticalFired = prevState ? prevState.criticalFired : false;
  let exhaustedFired = prevState ? prevState.exhaustedFired : false;

  // 1. Confirmed Reset
  if (resetConfirmed && prevState) {
    generation = prevState.generation + 1;
    warningArmEpoch++;
    criticalArmEpoch++;
    exhaustedArmEpoch++;
    warningFired = false;
    criticalFired = false;
    exhaustedFired = false;

    events.push({
      eventType: "quota_reset",
      severity: "info",
      identityId: obs.identityId,
      hostId: obs.hostId ?? null,
      occurredAt: obs.observedAt,
      fingerprint: createDeterministicFingerprint(
        "quota_reset",
        trackerKey,
        obs.windowId,
        generation,
      ),
    });
  }

  // 2. Distinct Reset-Credit Changes
  if (
    prevState &&
    prevState.lastResetCredits !== null &&
    obs.resetCredits !== null &&
    obs.resetCredits !== undefined &&
    obs.resetCredits !== prevState.lastResetCredits
  ) {
    creditChangeSeq++;
    const diff = obs.resetCredits - prevState.lastResetCredits;
    const isIncrease = diff > 0;
    const eventType: CanonicalObservatoryEventType = isIncrease ? "reset_credit_increased" : "reset_credit_decreased";

    events.push({
      eventType,
      severity: "info",
      identityId: obs.identityId,
      hostId: obs.hostId ?? null,
      occurredAt: obs.observedAt,
      fingerprint: createDeterministicFingerprint(
        eventType,
        trackerKey,
        obs.windowId,
        generation,
        creditChangeSeq,
        obs.resetCredits,
      ),
    });
  }

  // 3. Hysteresis Rearming within same generation (increments armEpoch on valid rearm)
  if (warningFired && currRemaining > warnRemaining + hysteresis) {
    warningFired = false;
    warningArmEpoch++;
  }
  if (criticalFired && currRemaining > critRemaining + hysteresis) {
    criticalFired = false;
    criticalArmEpoch++;
  }
  if (exhaustedFired && currRemaining > exhRemaining + hysteresis) {
    exhaustedFired = false;
    exhaustedArmEpoch++;
  }

  // 4. Threshold Crossings
  const isExhausted = currRemaining <= exhRemaining;
  const isCritical = currRemaining <= critRemaining;
  const isWarning = currRemaining <= warnRemaining;

  if (isExhausted) {
    if (!exhaustedFired) {
      exhaustedFired = true;
      criticalFired = true;
      warningFired = true;

      events.push({
        eventType: "quota_exhausted",
        severity: "critical",
        identityId: obs.identityId,
        hostId: obs.hostId ?? null,
        occurredAt: obs.observedAt,
        fingerprint: createDeterministicFingerprint(
          "quota_exhausted",
          trackerKey,
          obs.windowId,
          generation,
          exhaustedArmEpoch,
        ),
      });
    }
  } else if (isCritical) {
    if (!criticalFired) {
      criticalFired = true;
      warningFired = true;

      events.push({
        eventType: "quota_critical",
        severity: "critical",
        identityId: obs.identityId,
        hostId: obs.hostId ?? null,
        occurredAt: obs.observedAt,
        fingerprint: createDeterministicFingerprint(
          "quota_critical",
          trackerKey,
          obs.windowId,
          generation,
          criticalArmEpoch,
        ),
      });
    }
  } else if (isWarning) {
    if (!warningFired) {
      warningFired = true;

      events.push({
        eventType: "quota_warning",
        severity: "warning",
        identityId: obs.identityId,
        hostId: obs.hostId ?? null,
        occurredAt: obs.observedAt,
        fingerprint: createDeterministicFingerprint(
          "quota_warning",
          trackerKey,
          obs.windowId,
          generation,
          warningArmEpoch,
        ),
      });
    }
  }

  const nextState: QuotaTrackerState = {
    trackerKey,
    identityId: obs.identityId,
    provider: obs.provider || "unknown",
    bucketId: obs.bucketId || obs.windowId || "default",
    windowId: obs.windowId,
    meter: obs.meter ?? null,
    model: obs.model ?? null,
    tier: obs.tier ?? null,
    generation,
    warningArmEpoch,
    criticalArmEpoch,
    exhaustedArmEpoch,
    creditChangeSeq,
    lastObservedAt: obs.observedAt,
    lastUsedFraction: obs.usedFraction,
    lastRemainingFraction: currRemaining,
    lastResetCredits: obs.resetCredits ?? (prevState ? prevState.lastResetCredits : null),
    warningFired,
    criticalFired,
    exhaustedFired,
  };

  return { events, nextState, resetConfirmed };
}

export type ProviderIncidentLevel = "none" | "degraded" | "down" | "cooldown" | "blocked" | "disabled";

export const PROVIDER_LEVEL_RANK: Record<ProviderIncidentLevel, number> = {
  none: 0,
  degraded: 1,
  down: 2,
  cooldown: 3,
  blocked: 4,
  disabled: 5,
};

export interface ProviderTrackerState {
  identityId: string;
  provider: string;
  lastHealth: ProviderHealth;
  consecutiveFailures: number;
  consecutiveBlocked: number;
  consecutiveDisabled: number;
  incidentId: string | null;
  incidentLevel: ProviderIncidentLevel;
  incidentEpoch: number;
  lastObservedAt: string;
}

export interface ProviderTransitionResult {
  events: ObservatoryEventCandidate[];
  nextState: ProviderTrackerState;
}

/**
 * Pure transition generator for provider / credential health observations.
 * Supports multi-level escalation and recovery.
 */
export function evaluateProviderTransition(
  prevState: ProviderTrackerState | null,
  obs: ProviderIdentityObservation,
  failureThreshold = 3,
): ProviderTransitionResult {
  if (!obs.observedAt || typeof obs.observedAt !== "string") {
    throw new ValidationError("observedAt", "source observedAt timestamp is required");
  }

  // Monotonic watermark guard
  if (prevState) {
    const prevTime = new Date(prevState.lastObservedAt).getTime();
    const currTime = new Date(obs.observedAt).getTime();
    if (currTime <= prevTime) {
      return { events: [], nextState: prevState };
    }
  }

  const events: ObservatoryEventCandidate[] = [];
  const prevHealth: ProviderHealth = prevState ? prevState.lastHealth : "healthy";
  const prevFailures = prevState ? prevState.consecutiveFailures : 0;
  const prevBlocked = prevState ? prevState.consecutiveBlocked : 0;
  const prevDisabled = prevState ? prevState.consecutiveDisabled : 0;
  let incidentId = prevState ? prevState.incidentId : null;
  let incidentLevel: ProviderIncidentLevel = prevState ? prevState.incidentLevel : "none";
  let incidentEpoch = prevState ? prevState.incidentEpoch : 1;

  const currentHealth = obs.health;
  const isHealthy = currentHealth === "healthy" && !obs.disabled && !obs.blocked;

  const currentFailures =
    obs.consecutiveFailures !== undefined && obs.consecutiveFailures !== null
      ? obs.consecutiveFailures
      : !isHealthy
      ? prevFailures + 1
      : 0;

  const currentBlocked = obs.blocked ? prevBlocked + 1 : 0;
  const currentDisabled = obs.disabled ? prevDisabled + 1 : 0;

  // Determine target incident level based on strict thresholds
  let targetLevel: ProviderIncidentLevel = "none";
  if (currentDisabled >= 2) {
    targetLevel = "disabled";
  } else if (currentBlocked >= 2) {
    targetLevel = "blocked";
  } else if (obs.cooldownUntilUtc && new Date(obs.cooldownUntilUtc).getTime() > new Date(obs.observedAt).getTime()) {
    targetLevel = "cooldown";
  } else if (currentFailures >= failureThreshold || currentHealth === "unhealthy" || currentHealth === "exhausted") {
    if (currentFailures >= failureThreshold) {
      targetLevel = "down";
    }
  } else if (currentHealth === "degraded" || currentHealth === "rate_limited") {
    targetLevel = "degraded";
  }

  // 1. Escalations: Target level strictly higher rank than current incident level
  const targetRank = PROVIDER_LEVEL_RANK[targetLevel];
  const currentRank = PROVIDER_LEVEL_RANK[incidentLevel];

  if (targetRank > currentRank && targetLevel !== "none") {
    incidentEpoch++;
    incidentId = createDeterministicFingerprint(
      "incident",
      obs.identityId,
      obs.observedAt,
      targetLevel,
      incidentEpoch,
    );
    incidentLevel = targetLevel;

    let eventType: CanonicalObservatoryEventType;
    let severity: EventSeverity;

    switch (targetLevel) {
      case "disabled":
        eventType = "credential_disabled";
        severity = "error";
        break;
      case "blocked":
        eventType = "credential_blocked";
        severity = "error";
        break;
      case "cooldown":
        eventType = "credential_cooldown";
        severity = "warning";
        break;
      case "down":
        eventType = "provider_down";
        severity = "error";
        break;
      case "degraded":
      default:
        eventType = "provider_degraded";
        severity = "warning";
        break;
    }

    events.push({
      eventType,
      severity,
      identityId: obs.identityId,
      hostId: obs.sourceHostId ?? null,
      occurredAt: obs.observedAt,
      fingerprint: createDeterministicFingerprint(eventType, obs.identityId, incidentId),
    });
  }

  // 2. Recovery: Only after an active notified incident
  if (isHealthy && incidentLevel !== "none" && incidentId !== null) {
    const closedIncidentId = incidentId;
    const isCred = incidentLevel === "blocked" || incidentLevel === "disabled" || incidentLevel === "cooldown";
    const eventType: CanonicalObservatoryEventType = isCred ? "credential_recovered" : "provider_recovered";

    events.push({
      eventType,
      severity: "info",
      identityId: obs.identityId,
      hostId: obs.sourceHostId ?? null,
      occurredAt: obs.observedAt,
      fingerprint: createDeterministicFingerprint(
        eventType,
        obs.identityId,
        closedIncidentId,
        incidentEpoch,
      ),
    });
    incidentId = null;
    incidentLevel = "none";
  }

  const nextState: ProviderTrackerState = {
    identityId: obs.identityId,
    provider: obs.provider || "unknown",
    lastHealth: currentHealth,
    consecutiveFailures: isHealthy ? 0 : currentFailures,
    consecutiveBlocked: isHealthy ? 0 : currentBlocked,
    consecutiveDisabled: isHealthy ? 0 : currentDisabled,
    incidentId,
    incidentLevel,
    incidentEpoch,
    lastObservedAt: obs.observedAt,
  };

  return { events, nextState };
}

export interface HostTrackerState {
  hostId: string;
  lastStatus: string;
  offlineSince: string | null;
  notifiedOffline: boolean;
  incidentId: string | null;
  incidentEpoch: number;
  lastObservedAt: string;
}

export interface HostTransitionResult {
  events: ObservatoryEventCandidate[];
  nextState: HostTrackerState;
}

/**
 * Pure transition generator for fleet host observations.
 * Emits host_offline ONLY after 15 minutes of continuous offline status.
 * Any live report (online or degraded) breaks offline continuity and emits host_recovered if notified.
 */
export function evaluateHostTransition(
  prevState: HostTrackerState | null,
  obs: FleetHostObservation,
  offlineThresholdMs = 15 * 60 * 1000,
): HostTransitionResult {
  if (!obs.observedAt || typeof obs.observedAt !== "string") {
    throw new ValidationError("observedAt", "source observedAt timestamp is required");
  }

  if (prevState) {
    const prevTime = new Date(prevState.lastObservedAt).getTime();
    const currTime = new Date(obs.observedAt).getTime();
    if (currTime <= prevTime) {
      return { events: [], nextState: prevState };
    }
  }

  const events: ObservatoryEventCandidate[] = [];
  const currentStatus = obs.status.toLowerCase();
  const isOffline = currentStatus === "offline" || currentStatus === "unhealthy";
  const isLive = currentStatus === "online" || currentStatus === "degraded";

  let offlineSince = prevState ? prevState.offlineSince : null;
  let notifiedOffline = prevState ? prevState.notifiedOffline : false;
  let incidentId = prevState ? prevState.incidentId : null;
  let incidentEpoch = prevState ? prevState.incidentEpoch : 1;

  if (isOffline) {
    if (!offlineSince) {
      offlineSince = obs.observedAt;
    }

    const durationMs = new Date(obs.observedAt).getTime() - new Date(offlineSince).getTime();

    if (durationMs >= offlineThresholdMs && !notifiedOffline) {
      notifiedOffline = true;
      incidentEpoch++;
      incidentId = createDeterministicFingerprint("host_incident", obs.hostId, offlineSince, incidentEpoch);

      events.push({
        eventType: "host_offline",
        severity: "error",
        hostId: obs.hostId,
        occurredAt: obs.observedAt,
        fingerprint: createDeterministicFingerprint("host_offline", obs.hostId, incidentId),
      });
    }
  } else if (isLive) {
    if (notifiedOffline && incidentId !== null) {
      const closedIncidentId = incidentId;
      events.push({
        eventType: "host_recovered",
        severity: "info",
        hostId: obs.hostId,
        occurredAt: obs.observedAt,
        fingerprint: createDeterministicFingerprint("host_recovered", obs.hostId, closedIncidentId, incidentEpoch),
      });
    }
    offlineSince = null;
    notifiedOffline = false;
    incidentId = null;
  }

  const nextState: HostTrackerState = {
    hostId: obs.hostId,
    lastStatus: currentStatus,
    offlineSince,
    notifiedOffline,
    incidentId,
    incidentEpoch,
    lastObservedAt: obs.observedAt,
  };

  return { events, nextState };
}

export interface SessionTrackerState {
  sessionId: string;
  hostId: string;
  contextWarningFired: boolean;
  contextCriticalFired: boolean;
  warningArmEpoch: number;
  criticalArmEpoch: number;
  lastContextBps: number | null;
  lastStatus: string;
  lastObservedAt: string;
}

export interface SessionTransitionResult {
  events: ObservatoryEventCandidate[];
  nextState: SessionTrackerState;
}

/**
 * Pure transition generator for OMP session observations using context utilization (contextBps).
 * Preserves prior context state when contextBps is null/omitted.
 */
export function evaluateSessionTransition(
  prevState: SessionTrackerState | null,
  session: OmpSessionSummaryInput,
): SessionTransitionResult {
  const sourceTimestamp = session.closedAt || session.endedAt || session.lastActiveAt || session.startedAt;
  if (!sourceTimestamp || typeof sourceTimestamp !== "string") {
    throw new ValidationError("timestamp", "session observation timestamp is required");
  }

  if (prevState) {
    const prevTime = new Date(prevState.lastObservedAt).getTime();
    const currTime = new Date(sourceTimestamp).getTime();
    if (currTime <= prevTime) {
      return { events: [], nextState: prevState };
    }
  }

  const events: ObservatoryEventCandidate[] = [];
  const currentStatus = session.status ? session.status.toLowerCase() : "active";
  const prevStatus = prevState ? prevState.lastStatus : "none";

  // Validate contextBps if provided
  let contextBps = prevState ? prevState.lastContextBps : null;
  if (session.contextBps !== undefined && session.contextBps !== null) {
    const raw = session.contextBps;
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > 10_000) {
      throw new ValidationError("contextBps", `contextBps must be an integer between 0 and 10000, got ${raw}`);
    }
    contextBps = raw;
  }

  let warningFired = prevState ? prevState.contextWarningFired : false;
  let criticalFired = prevState ? prevState.contextCriticalFired : false;
  let warningArmEpoch = prevState ? prevState.warningArmEpoch : 1;
  let criticalArmEpoch = prevState ? prevState.criticalArmEpoch : 1;

  // 1. Session Lifecycle events
  if (prevState === null && (currentStatus === "active" || currentStatus === "started")) {
    events.push({
      eventType: "session_started",
      severity: "info",
      sessionId: session.sessionId,
      hostId: session.hostId,
      identityId: session.identityId ?? null,
      occurredAt: sourceTimestamp,
      fingerprint: createDeterministicFingerprint("session_started", session.sessionId, sourceTimestamp),
    });
  }

  if (currentStatus === "failed" || (session.exitCode !== null && session.exitCode !== undefined && session.exitCode !== 0)) {
    if (prevStatus !== "failed") {
      events.push({
        eventType: "session_failed",
        severity: "error",
        sessionId: session.sessionId,
        hostId: session.hostId,
        identityId: session.identityId ?? null,
        occurredAt: sourceTimestamp,
        fingerprint: createDeterministicFingerprint(
          "session_failed",
          session.sessionId,
          session.exitCode ?? "err",
        ),
      });
    }
  } else if ((currentStatus === "closed" || currentStatus === "completed") && prevStatus !== "closed" && prevStatus !== "completed") {
    events.push({
      eventType: "session_closed",
      severity: "info",
      sessionId: session.sessionId,
      hostId: session.hostId,
      identityId: session.identityId ?? null,
      occurredAt: sourceTimestamp,
      fingerprint: createDeterministicFingerprint("session_closed", session.sessionId, sourceTimestamp),
    });
  }

  // 2. Context utilization evaluation (only if contextBps is measured)
  if (contextBps !== null) {
    // Hysteresis rearming: Warning below 7800 (78%), Critical below 9300 (93%)
    if (warningFired && contextBps < 7800) {
      warningFired = false;
      warningArmEpoch++;
    }
    if (criticalFired && contextBps < 9300) {
      criticalFired = false;
      criticalArmEpoch++;
    }

    if (contextBps >= 9500) {
      if (!criticalFired) {
        criticalFired = true;
        warningFired = true;

        events.push({
          eventType: "session_context_critical",
          severity: "critical",
          sessionId: session.sessionId,
          hostId: session.hostId,
          identityId: session.identityId ?? null,
          occurredAt: sourceTimestamp,
          fingerprint: createDeterministicFingerprint(
            "session_context_critical",
            session.sessionId,
            criticalArmEpoch,
          ),
        });
      }
    } else if (contextBps >= 8000) {
      if (!warningFired) {
        warningFired = true;

        events.push({
          eventType: "session_context_warning",
          severity: "warning",
          sessionId: session.sessionId,
          hostId: session.hostId,
          identityId: session.identityId ?? null,
          occurredAt: sourceTimestamp,
          fingerprint: createDeterministicFingerprint(
            "session_context_warning",
            session.sessionId,
            warningArmEpoch,
          ),
        });
      }
    }
  }

  const nextState: SessionTrackerState = {
    sessionId: session.sessionId,
    hostId: session.hostId,
    contextWarningFired: warningFired,
    contextCriticalFired: criticalFired,
    warningArmEpoch,
    criticalArmEpoch,
    lastContextBps: contextBps,
    lastStatus: currentStatus,
    lastObservedAt: sourceTimestamp,
  };

  return { events, nextState };
}

export interface AgentRouterTrackerState {
  accountId: string;
  lastBalance: number | null;
  lowBalanceFired: boolean;
  lowBalanceArmEpoch: number;
  lastObservedAt: string;
}

export interface AgentRouterTransitionResult {
  events: ObservatoryEventCandidate[];
  nextState: AgentRouterTrackerState;
}

/**
 * Pure transition generator for AgentRouter balance observations.
 * Handles large balance drops (>= $25) and low balance (<= $50) with arm epoch.
 */
export function evaluateAgentRouterBalanceTransition(
  prevState: AgentRouterTrackerState | null,
  params: {
    accountId: string;
    balance: number;
    previousBalance?: number | null;
    observedAt: string;
    hostId?: string | null;
  },
): AgentRouterTransitionResult {
  const { accountId, balance, observedAt, hostId } = params;
  if (!observedAt || typeof observedAt !== "string") {
    throw new ValidationError("observedAt", "source observedAt timestamp is required");
  }

  if (prevState) {
    const prevTime = new Date(prevState.lastObservedAt).getTime();
    const currTime = new Date(observedAt).getTime();
    if (currTime <= prevTime) {
      return { events: [], nextState: prevState };
    }
  }

  const events: ObservatoryEventCandidate[] = [];
  const prevBalance = params.previousBalance ?? (prevState ? prevState.lastBalance : null);

  let lowBalanceFired = prevState ? prevState.lowBalanceFired : false;
  let lowBalanceArmEpoch = prevState ? prevState.lowBalanceArmEpoch : 1;

  // 1. Large balance drop (>= $25)
  if (prevBalance !== null && prevBalance - balance >= 25) {
    const dropAmount = prevBalance - balance;
    events.push({
      eventType: "agentrouter_large_balance_drop",
      severity: "warning",
      identityId: `agentrouter:${accountId}`,
      hostId: hostId ?? null,
      occurredAt: observedAt,
      fingerprint: createDeterministicFingerprint(
        "agentrouter_large_balance_drop",
        accountId,
        observedAt,
        prevBalance,
        balance,
      ),
    });
  }

  // 2. Low balance (<= $50) with $5 hysteresis rearming (rearms above $55)
  if (lowBalanceFired && balance > 55) {
    lowBalanceFired = false;
    lowBalanceArmEpoch++;
  }

  if (balance <= 50) {
    if (!lowBalanceFired) {
      lowBalanceFired = true;

      events.push({
        eventType: "agentrouter_balance_low",
        severity: "warning",
        identityId: `agentrouter:${accountId}`,
        hostId: hostId ?? null,
        occurredAt: observedAt,
        fingerprint: createDeterministicFingerprint(
          "agentrouter_balance_low",
          accountId,
          lowBalanceArmEpoch,
        ),
      });
    }
  }

  const nextState: AgentRouterTrackerState = {
    accountId,
    lastBalance: balance,
    lowBalanceFired,
    lowBalanceArmEpoch,
    lastObservedAt: observedAt,
  };

  return { events, nextState };
}

/**
 * Generates typed event candidates for AgentRouter domain events.
 */
export function createAgentRouterGrantEventCandidate(params: {
  accountId: string;
  amount: number;
  description?: string | null;
  observedAt: string;
  hostId?: string | null;
}): ObservatoryEventCandidate {
  if (!params.observedAt) {
    throw new ValidationError("observedAt", "source observedAt timestamp is required");
  }
  return {
    eventType: "agentrouter_grant_received",
    severity: "info",
    identityId: `agentrouter:${params.accountId}`,
    hostId: params.hostId ?? null,
    occurredAt: params.observedAt,
    fingerprint: createDeterministicFingerprint(
      "agentrouter_grant_received",
      params.accountId,
      params.observedAt,
      params.amount,
    ),
  };
}

export function createAgentRouterChallengeEventCandidate(params: {
  accountId: string;
  challengeType?: string | null;
  observedAt: string;
  hostId?: string | null;
}): ObservatoryEventCandidate {
  if (!params.observedAt) {
    throw new ValidationError("observedAt", "source observedAt timestamp is required");
  }
  const challengeType = params.challengeType || "2fa";
  return {
    eventType: "agentrouter_challenge_required",
    severity: "warning",
    identityId: `agentrouter:${params.accountId}`,
    hostId: params.hostId ?? null,
    occurredAt: params.observedAt,
    fingerprint: createDeterministicFingerprint(
      "agentrouter_challenge_required",
      params.accountId,
      challengeType,
      params.observedAt,
    ),
  };
}

export function createAgentRouterLoginRequiredEventCandidate(params: {
  accountId: string;
  reason?: string | null;
  observedAt: string;
  hostId?: string | null;
}): ObservatoryEventCandidate {
  if (!params.observedAt) {
    throw new ValidationError("observedAt", "source observedAt timestamp is required");
  }
  return {
    eventType: "agentrouter_login_required",
    severity: "warning",
    identityId: `agentrouter:${params.accountId}`,
    hostId: params.hostId ?? null,
    occurredAt: params.observedAt,
    fingerprint: createDeterministicFingerprint(
      "agentrouter_login_required",
      params.accountId,
      params.observedAt,
    ),
  };
}

export function createAgentRouterFailureEventCandidate(params: {
  accountId: string;
  type: "login" | "endpoint";
  errorMessage?: string | null;
  observedAt: string;
  hostId?: string | null;
}): ObservatoryEventCandidate {
  if (!params.observedAt) {
    throw new ValidationError("observedAt", "source observedAt timestamp is required");
  }
  const eventType: CanonicalObservatoryEventType =
    params.type === "login" ? "agentrouter_login_failed" : "agentrouter_endpoint_failed";

  return {
    eventType,
    severity: "error",
    identityId: `agentrouter:${params.accountId}`,
    hostId: params.hostId ?? null,
    occurredAt: params.observedAt,
    fingerprint: createDeterministicFingerprint(eventType, params.accountId, params.observedAt),
  };
}
