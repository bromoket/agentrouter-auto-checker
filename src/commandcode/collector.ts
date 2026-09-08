/**
 * Command Code subscription/quota collector.
 *
 * Probes each enabled account's API-key quota via the Command Code bearer API,
 * derives per-account quota windows (5-hour + weekly), emits quota event
 * candidates (warning/critical/exhausted/reset) and credit changes, then feeds the
 * Observatory ingest sink so the existing policy/delivery engine applies anti-spam.
 */

import { COMMANDCODE_USAGE_UNIT } from "./client";
import { fetchCommandCodeQuota } from "./client";
import { COMMANDCODE_OBSERVATORY_PROVIDER, COMMANDCODE_PROBE_SOURCE } from "./constants";
import { deriveQuotaStatus } from "../antigravity/aggregate";
import { formatSafeIdentityLabel } from "../observatory/omp-usage";
import type {
  ObservatoryEventCandidate,
  ProviderIdentityObservation,
  QuotaObservationInput,
} from "../observatory/types";
import type { CommandCodeStore } from "./store";
import type { CommandCodeSnapshot } from "./store";

export interface CommandCodeIngestSink {
  ingestBatch(
    observedAt: string,
    identities: ProviderIdentityObservation[],
    quotas: QuotaObservationInput[],
  ): void | Promise<void>;
  emitEvent(candidate: ObservatoryEventCandidate): void;
}

export interface CommandCodeCollectorOptions {
  store: CommandCodeStore;
  sink: CommandCodeIngestSink;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  sourceHostId: string;
}

interface AccessCacheEntry {
  key: string;
}

export class CommandCodeCollector {
  private readonly store: CommandCodeStore;
  private readonly sink: CommandCodeIngestSink;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly sourceHostId: string;
  private readonly accessCache = new Map<string, AccessCacheEntry>();
  private running = false;
  private loopStarted = false;
  private lastProbeAt: string | null = null;
  private nextProbeAt: string | null = null;
  private lastProbeStatus: "ok" | "error" | null = null;
  private lastProbeError: string | null = null;
  private consecutiveProbeFailures = 0;
  private probing = false;

  constructor(options: CommandCodeCollectorOptions) {
    this.store = options.store;
    this.sink = options.sink;
    this.probeIntervalMs = options.probeIntervalMs;
    this.probeTimeoutMs = options.probeTimeoutMs;
    this.sourceHostId = options.sourceHostId;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.loopStarted) {
      this.loopStarted = true;
      void this.pollingLoop();
    }
  }

  stop(): void {
    this.running = false;
    this.loopStarted = false;
  }

  getStatus(): {
    running: boolean;
    probing: boolean;
    lastProbeAt: string | null;
    nextProbeAt: string | null;
    lastProbeStatus: "ok" | "error" | null;
    lastProbeError: string | null;
    consecutiveProbeFailures: number;
    accountCount: number;
    enabledAccountCount: number;
  } {
    const accounts = this.store.listAccounts();
    return {
      running: this.running,
      probing: this.probing,
      lastProbeAt: this.lastProbeAt,
      nextProbeAt: this.nextProbeAt,
      lastProbeStatus: this.lastProbeStatus,
      lastProbeError: this.lastProbeError,
      consecutiveProbeFailures: this.consecutiveProbeFailures,
      accountCount: accounts.length,
      enabledAccountCount: accounts.filter((a) => a.enabled).length,
    };
  }

  private async pollingLoop(): Promise<void> {
    let nextProbe = Date.now();
    while (this.running && this.loopStarted) {
      if (Date.now() >= nextProbe) {
        const errors = await this.probeAll();
        this.consecutiveProbeFailures = errors > 0 ? this.consecutiveProbeFailures + 1 : 0;
        nextProbe = Date.now() + this.probeIntervalMs;
        this.nextProbeAt = new Date(nextProbe).toISOString();
      }
      await Bun.sleep(1_000);
    }
  }

  /** Probe all enabled accounts. Returns number of account-level failures. */
  async probeAll(): Promise<number> {
    if (this.probing) return 0;
    this.probing = true;
    const attemptedAt = new Date().toISOString();
    this.lastProbeAt = attemptedAt;
    let failures = 0;
    try {
      const accounts = this.store.listEnabledAccounts();
      for (const account of accounts) {
        try {
          await this.probeAccountOnce(account.id);
        } catch (error) {
          failures += 1;
          const message = error instanceof Error ? error.message : String(error);
          await this.persistFailure(account.id, message, attemptedAt);
        }
      }
      this.lastProbeStatus = failures === 0 ? "ok" : "error";
      this.lastProbeError = failures === 0 ? null : `${failures} of ${accounts.length} account probe(s) failed`;
    } finally {
      this.probing = false;
    }
    return failures;
  }

  /** Probe a single account. Throws on failure. */
  async probeAccountOnce(accountId: string): Promise<void> {
    const apiKey = this.store.getApiKey(accountId);
    if (!apiKey) throw new Error("Stored Command Code API key is missing or could not be decrypted.");
    const publicAccount = this.store.listAccounts().find((a) => a.id === accountId);
    if (!publicAccount) throw new Error("Unknown account id.");

    const observedAt = new Date().toISOString();
    const result = await fetchCommandCodeQuota({ apiKey, timeoutMs: this.probeTimeoutMs });
    if (!result.ok) {
      const err = new Error(`${result.error.kind}: ${result.error.message}`);
      (err as Error & { category?: string }).category = result.error.kind;
      throw err;
    }

    const { quota } = result;
    const previous = this.store.getSnapshot(accountId);

    // Emit credit change events (only clear increases; decrease is dashboard inform).
    const previousCredits = previous?.remainingCredits ?? null;
    const newCredits = quota.credits?.remainingCredits ?? null;
    if (newCredits !== null && previousCredits !== null && newCredits !== previousCredits) {
      if (newCredits > previousCredits) this.emitCreditEvent("reset_credit_increased", accountId, observedAt, newCredits);
      else this.emitCreditEvent("reset_credit_decreased", accountId, observedAt, newCredits);
    }

    // Build quota observations for each window.
    const quotas: QuotaObservationInput[] = [];
    for (const window of quota.credits?.windowLimits ?? []) {
      if (window.cap <= 0) continue;
      const remaining = window.cap > 0 ? Math.max(0, window.cap - window.used) / window.cap : 0;
      const remainingFraction = Math.min(1, Math.max(0, remaining));
      const usedFraction = Math.min(1, Math.max(0, window.used / window.cap));
      quotas.push({
        identityId: accountId,
        provider: COMMANDCODE_OBSERVATORY_PROVIDER,
        windowId: window.window === "weekly" ? "weekly" : "5h",
        bucketId: `commandcode-${window.window}`,
        windowDurationMs: window.window === "weekly" ? 7 * 24 * 3600_000 : 5 * 3600_000,
        meter: COMMANDCODE_USAGE_UNIT,
        model: null,
        tier: quota.subscription?.planId ?? null,
        hostId: this.sourceHostId,
        fetchedAt: observedAt,
        observedAt,
        resetsAt: window.resetAt,
        resetLabel: window.window === "weekly" ? "Weekly reset" : "5-hour reset",
        usedFraction: Math.round(usedFraction * 1_000_000) / 1_000_000,
        remainingFraction: Math.round(remainingFraction * 1_000_000) / 1_000_000,
        usedUnits: window.used,
        totalUnits: window.cap,
        remainingUnits: Math.max(0, window.cap - window.used),
        resetCredits: null,
        unit: COMMANDCODE_USAGE_UNIT,
        status: deriveQuotaStatus(remainingFraction),
        errorCategory: null,
        consecutiveFailures: 0,
        source: COMMANDCODE_PROBE_SOURCE,
        sourceVersion: "commandcode-direct",
      });
    }

    // Identity observation.
    const identity: ProviderIdentityObservation = {
      identityId: accountId,
      kind: "credential",
      provider: COMMANDCODE_OBSERVATORY_PROVIDER,
      sourceHostId: this.sourceHostId,
      sourceVersion: "commandcode-direct",
      label: this.buildIdentityLabel(accountId),
      observedAt,
      health: this.deriveHealth(quotas),
      disabled: false,
      blocked: false,
      cooldownUntilUtc: null,
      lastProbeAt: observedAt,
      statusCode: "200",
      statusMessage: null,
      activeModel: null,
      lastSuccessAt: observedAt,
      lastFailureAt: null,
      consecutiveFailures: 0,
    };

    await this.sink.ingestBatch(observedAt, [identity], quotas);

    const snapshot: CommandCodeSnapshot = {
      planId: quota.subscription?.planId ?? null,
      status: quota.subscription?.status ?? null,
      remainingCredits: quota.credits?.remainingCredits ?? null,
      monthlyCredits: quota.credits?.monthlyCredits ?? null,
      purchasedCredits: quota.credits?.purchasedCredits ?? null,
      freeCredits: quota.credits?.freeCredits ?? null,
      windows: (quota.credits?.windowLimits ?? []).map((w) => ({
        window: w.window,
        used: w.used,
        cap: w.cap,
        resetAt: w.resetAt,
      })) ?? null,
      totalCost: quota.summary?.totalCost ?? null,
      totalCount: quota.summary?.totalCount ?? null,
      totalTokens: quota.summary?.totalTokens ?? null,
      lastError: null,
      consecutiveFailures: 0,
      probedAt: observedAt,
    };
    this.store.saveSnapshot(accountId, snapshot);
    console.log(
      `[commandcode] probe ok for ${this.buildIdentityLabel(accountId)}: ${quota.account.login} plan=${quota.subscription?.planId ?? "unknown"} credits=${quota.credits?.remainingCredits ?? "unknown"}`,
    );
  }

  /** Public so callers/tests can record a categorized probe failure (used by probeAll). */
  async persistFailure(accountId: string, message: string, attemptedAt: string): Promise<void> {
    const previous = this.store.getSnapshot(accountId);
    const publicAccount = this.store.listAccounts().find((a) => a.id === accountId);
    if (!publicAccount) return;
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const snapshot: CommandCodeSnapshot = {
      planId: previous?.planId ?? null,
      status: previous?.status ?? null,
      remainingCredits: previous?.remainingCredits ?? null,
      monthlyCredits: previous?.monthlyCredits ?? null,
      purchasedCredits: previous?.purchasedCredits ?? null,
      freeCredits: previous?.freeCredits ?? null,
      windows: previous?.windows ?? null,
      totalCost: previous?.totalCost ?? null,
      totalCount: previous?.totalCount ?? null,
      totalTokens: previous?.totalTokens ?? null,
      lastError: message.slice(0, 500),
      consecutiveFailures: failures,
      probedAt: attemptedAt,
    };
    this.store.saveSnapshot(accountId, snapshot);
    console.warn(`[commandcode] probe failed for ${this.buildIdentityLabel(accountId)}: ${this.categorizeMessage(message)} (${failures} consecutive)`);
    await this.sink.ingestBatch(attemptedAt, [
      {
        identityId: accountId,
        kind: "credential",
        provider: COMMANDCODE_OBSERVATORY_PROVIDER,
        sourceHostId: this.sourceHostId,
        sourceVersion: "commandcode-direct",
        label: this.buildIdentityLabel(accountId),
        observedAt: attemptedAt,
        health: this.categorizeMessage(message) === "auth" ? "rate_limited" : "unhealthy",
        disabled: false,
        blocked: false,
        cooldownUntilUtc: null,
        lastProbeAt: attemptedAt,
        statusCode: this.shortStatus(message),
        statusMessage: snapshot.lastError,
        activeModel: null,
        lastFailureAt: attemptedAt,
        consecutiveFailures: failures,
      } satisfies ProviderIdentityObservation,
    ], []);
  }

  private emitCreditEvent(eventType: "reset_credit_increased" | "reset_credit_decreased", accountId: string, observedAt: string, amount: number): void {
    this.sink.emitEvent({
      eventType,
      severity: eventType === "reset_credit_increased" ? "info" : "info",
      identityId: accountId,
      hostId: this.sourceHostId,
      provider: COMMANDCODE_OBSERVATORY_PROVIDER,
      identityKind: "credential",
      accountId,
      occurredAt: observedAt,
      fingerprint: `${eventType}:${COMMANDCODE_PROBE_SOURCE}:${accountId}:${amount}:${observedAt.slice(0, 13)}`,
    });
  }

  private categorizeMessage(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes("401") || lower.includes("403") || lower.includes("bearer")) return "auth";
    if (lower.includes("abort") || lower.includes("timeout") || lower.includes("network")) return "network";
    if (lower.includes("500") || lower.includes("502") || lower.includes("503")) return "server";
    return "unknown";
  }

  private shortStatus(message: string): string {
    const match = message.match(/(401|403|404|408|429|500|502|503|504)/);
    return match ? match[1]! : "error";
  }

  private deriveHealth(quotas: QuotaObservationInput[]): ProviderIdentityObservation["health"] {
    let health: ProviderIdentityObservation["health"] = "healthy";
    for (const q of quotas) {
      if (q.status === "exhausted" || q.status === "critical") return "degraded";
      if (q.status === "warning") health = "degraded";
    }
    return health;
  }

  private buildIdentityLabel(accountId: string): string {
    return formatSafeIdentityLabel(COMMANDCODE_OBSERVATORY_PROVIDER, accountId, false, null);
  }
}
