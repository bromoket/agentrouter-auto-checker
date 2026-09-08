/**
 * ChatGPT/Codex quota collector. Probes each account's wham/usage, derives quota
 * window observations + credit events, feeds the Observatory ingest sink so the
 * policy/delivery engine applies anti-spam.
 */

import { fetchChatgptUsage } from "./client";
import { CHATGPT_OBSERVATORY_PROVIDER, CHATGPT_PROBE_SOURCE } from "./constants";
import { deriveQuotaStatus } from "../antigravity/aggregate";
import { formatSafeIdentityLabel } from "../observatory/omp-usage";
import type {
  ObservatoryEventCandidate,
  ProviderIdentityObservation,
  QuotaObservationInput,
} from "../observatory/types";
import type { ChatgptStore } from "./store";
import type { ChatgptSnapshot } from "./store";

export interface ChatgptIngestSink {
  ingestBatch(observedAt: string, identities: ProviderIdentityObservation[], quotas: QuotaObservationInput[]): void | Promise<void>;
  emitEvent(candidate: ObservatoryEventCandidate): void;
}

export interface ChatgptCollectorOptions {
  store: ChatgptStore;
  sink: ChatgptIngestSink;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  sourceHostId: string;
}

export class ChatgptCollector {
  private readonly store: ChatgptStore;
  private readonly sink: ChatgptIngestSink;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly sourceHostId: string;
  private running = false;
  private loopStarted = false;
  private lastProbeAt: string | null = null;
  private nextProbeAt: string | null = null;
  private lastProbeStatus: "ok" | "error" | null = null;
  private lastProbeError: string | null = null;
  private consecutiveProbeFailures = 0;
  private probing = false;

  constructor(options: ChatgptCollectorOptions) {
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

  async probeAccountOnce(accountId: string): Promise<void> {
    const accessToken = this.store.getAccessToken(accountId);
    if (!accessToken) throw new Error("Stored ChatGPT access token is missing or could not be decrypted.");
    const publicAccount = this.store.listAccounts().find((a) => a.id === accountId);
    if (!publicAccount) throw new Error("Unknown account id.");

    const observedAt = new Date().toISOString();
    const result = await fetchChatgptUsage({ accessToken, timeoutMs: this.probeTimeoutMs });
    if (!result.ok) {
      const err = new Error(`${result.error.kind}: ${result.error.message}`);
      (err as Error & { category?: string }).category = result.error.kind;
      throw err;
    }

    const { usage } = result;
    const previous = this.store.getSnapshot(accountId);
    const prevCredits = previous?.resetCredits ?? null;
    const newCredits = usage.resetCredits;
    if (newCredits !== null && prevCredits !== null && newCredits !== prevCredits) {
      if (newCredits > prevCredits) this.emitCreditEvent("reset_credit_increased", accountId, observedAt, newCredits);
      else this.emitCreditEvent("reset_credit_decreased", accountId, observedAt, newCredits);
    }

    const quotas: QuotaObservationInput[] = [];
    for (const w of usage.windows) {
      const usedFraction = Math.min(1, Math.max(0, w.usedPercent / 100));
      const remainingFraction = Math.min(1, Math.max(0, 1 - usedFraction));
      quotas.push({
        identityId: accountId,
        provider: CHATGPT_OBSERVATORY_PROVIDER,
        windowId: w.windowId,
        bucketId: w.bucketId,
        windowDurationMs: w.limitWindowSeconds * 1000,
        meter: w.meter,
        model: null,
        tier: usage.planType,
        hostId: this.sourceHostId,
        fetchedAt: observedAt,
        observedAt,
        resetsAt: w.resetAt,
        resetLabel: w.windowId === "weekly" ? "Weekly reset" : "5-hour reset",
        usedFraction: Math.round(usedFraction * 1_000_000) / 1_000_000,
        remainingFraction: Math.round(remainingFraction * 1_000_000) / 1_000_000,
        usedUnits: null,
        totalUnits: null,
        remainingUnits: null,
        resetCredits: usage.resetCredits,
        unit: "percent",
        status: deriveQuotaStatus(remainingFraction),
        errorCategory: null,
        consecutiveFailures: 0,
        source: CHATGPT_PROBE_SOURCE,
        sourceVersion: "chatgpt-direct",
      });
    }

    const identity: ProviderIdentityObservation = {
      identityId: accountId,
      kind: "credential",
      provider: CHATGPT_OBSERVATORY_PROVIDER,
      sourceHostId: this.sourceHostId,
      sourceVersion: "chatgpt-direct",
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

    const snapshot: ChatgptSnapshot = {
      planType: usage.planType,
      email: usage.email,
      credits: usage.credits,
      resetCredits: usage.resetCredits,
      windows: usage.windows.map((w) => ({ bucketId: w.bucketId, windowId: w.windowId, usedPercent: w.usedPercent, limitWindowSeconds: w.limitWindowSeconds, resetAt: w.resetAt, meter: w.meter })),
      lastError: null,
      consecutiveFailures: 0,
      probedAt: observedAt,
    };
    this.store.saveSnapshot(accountId, snapshot);
    console.log(
      `[chatgpt] probe ok for ${this.buildIdentityLabel(accountId)}: ${usage.planType ?? "unknown"} plan, windows=${usage.windows.length}, resetCredits=${usage.resetCredits ?? "n/a"}`,
    );
  }

  /** Public so callers/tests can record a categorized probe failure (used by probeAll). */
  async persistFailure(accountId: string, message: string, attemptedAt: string): Promise<void> {
    const previous = this.store.getSnapshot(accountId);
    const publicAccount = this.store.listAccounts().find((a) => a.id === accountId);
    if (!publicAccount) return;
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const snapshot: ChatgptSnapshot = {
      planType: previous?.planType ?? null,
      email: previous?.email ?? null,
      credits: previous?.credits ?? null,
      resetCredits: previous?.resetCredits ?? null,
      windows: previous?.windows ?? null,
      lastError: message.slice(0, 500),
      consecutiveFailures: failures,
      probedAt: attemptedAt,
    };
    this.store.saveSnapshot(accountId, snapshot);
    console.warn(`[chatgpt] probe failed for ${this.buildIdentityLabel(accountId)}: ${this.categorizeMessage(message)} (${failures} consecutive)`);
    await this.sink.ingestBatch(attemptedAt, [
      {
        identityId: accountId,
        kind: "credential",
        provider: CHATGPT_OBSERVATORY_PROVIDER,
        sourceHostId: this.sourceHostId,
        sourceVersion: "chatgpt-direct",
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
      severity: "info",
      identityId: accountId,
      hostId: this.sourceHostId,
      provider: CHATGPT_OBSERVATORY_PROVIDER,
      identityKind: "credential",
      accountId,
      occurredAt: observedAt,
      fingerprint: `${eventType}:${CHATGPT_PROBE_SOURCE}:${accountId}:${amount}:${observedAt.slice(0, 13)}`,
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
    return formatSafeIdentityLabel(CHATGPT_OBSERVATORY_PROVIDER, accountId, false, null);
  }
}
