/**
 * Antigravity direct-account collector.
 *
 * Probes each enabled account through the same Google Cloud Code Assist endpoints and
 * header style as the Antigravity IDE (fingerprints stored per account), aggregates
 * per-model WTUS buckets into gemini / claude-gpt pools plus a CLI REQUESTS pool, then
 * feeds the Observatory quota machine (identities + quota observations) so existing
 * quota_reset / reset_credit events, policies, digests, and Telegram delivery apply.
 *
 * Credits (reset tokens) from loadCodeAssist are tracked per account in the antigravity
 * snapshot store; increases emit reset_credit_increased events through the ingest sink.
 */

import {
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_VERSION_FALLBACK,
} from "./constants";
import {
  aggregateCliBuckets,
  aggregatePoolBuckets,
  deriveQuotaStatus,
} from "./aggregate";
import {
  buildProbeHeaders,
  fetchAvailableModels,
  loadCodeAssist,
  retrieveCliQuota,
  retrieveUserQuota,
  type AntigravityClientFingerprint,
  type AntigravityOauthConfig,
  type HttpFetcher,
} from "./client";
import type { AntigravityPoolSummary, AntigravityAccountSnapshot } from "./types";
import { rotateAccessToken } from "./oauth";
import type { AntigravityStore } from "./store";
import { formatSafeIdentityLabel } from "../observatory/omp-usage";
import type {
  ObservatoryEventCandidate,
  ProviderIdentityObservation,
  QuotaObservationInput,
} from "../observatory/types";

export const ANTIGRAVITY_OBSERVATORY_PROVIDER = "google-antigravity";
export const ANTIGRAVITY_PROBE_SOURCE = "antigravity-direct";
export const ANTIGRAVITY_PROBE_SOURCE_VERSION = ANTIGRAVITY_VERSION_FALLBACK;

export interface AntigravityIngestSink {
  /** Feed identity + quota observations into the observatory store/event machine. */
  ingestBatch(
    observedAt: string,
    identities: ProviderIdentityObservation[],
    quotas: QuotaObservationInput[],
  ): void | Promise<void>;
  /** Emit a single observatory event candidate (dedupe/delivery handled upstream). */
  emitEvent(candidate: ObservatoryEventCandidate): void;
}

export interface AntigravityCollectorOptions {
  store: AntigravityStore;
  sink: AntigravityIngestSink;
  oauth: AntigravityOauthConfig;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  catalogIntervalMs: number;
  sourceHostId: string;
  fetcher?: HttpFetcher;
}

interface AccessCacheEntry {
  token: string;
  expiresAtMs: number;
}

const ACCESS_TOKEN_SKEW_MS = 60_000;

export class AntigravityCollector {
  private readonly store: AntigravityStore;
  private readonly sink: AntigravityIngestSink;
  private readonly oauth: AntigravityOauthConfig;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly catalogIntervalMs: number;
  private readonly sourceHostId: string;
  private readonly fetcher: HttpFetcher;
  private readonly accessCache = new Map<string, AccessCacheEntry>();
  private running = false;
  private loopStarted = false;
  private lastProbeAt: string | null = null;
  private nextProbeAt: string | null = null;
  private lastProbeStatus: "ok" | "error" | null = null;
  private lastProbeError: string | null = null;
  private consecutiveProbeFailures = 0;
  private probing = false;

  constructor(options: AntigravityCollectorOptions) {
    this.store = options.store;
    this.sink = options.sink;
    this.oauth = options.oauth;
    this.probeIntervalMs = options.probeIntervalMs;
    this.probeTimeoutMs = options.probeTimeoutMs;
    this.catalogIntervalMs = options.catalogIntervalMs;
    this.sourceHostId = options.sourceHostId;
    this.fetcher = options.fetcher ?? ((url, init, timeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
    });
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
          await this.persistFailure(account.id, message);
        }
      }
      this.lastProbeStatus = failures === 0 ? "ok" : "error";
      this.lastProbeError = failures === 0 ? null : `${failures} of ${accounts.length} account probe(s) failed`;
    } finally {
      this.probing = false;
    }
    return failures;
  }

  /** Probe a single account (enabled or not). Throws on failure. */
  async probeAccountOnce(accountId: string): Promise<void> {
    const refreshToken = this.store.getRefreshToken(accountId);
    if (!refreshToken) {
      throw new Error("Stored refresh token is missing or could not be decrypted.");
    }
    const publicAccount = this.store.listAccounts().find((a) => a.id === accountId);
    if (!publicAccount) throw new Error("Unknown account id.");

    let fingerprint: AntigravityClientFingerprint | null = null;
    if (publicAccount.hasFingerprint) {
      const record = this.store.getAccount(accountId);
      try {
        fingerprint = record?.fingerprintJson ? (JSON.parse(record.fingerprintJson) as AntigravityClientFingerprint) : null;
      } catch {
        fingerprint = null;
      }
    }

    const probeHeaders = buildProbeHeaders(fingerprint, ANTIGRAVITY_VERSION_FALLBACK);
    const observedAt = new Date().toISOString();

    // 1. Access token (memory cache with skew)
    const accessToken = await this.ensureAccessToken(accountId, refreshToken);

    // 2. loadCodeAssist: project id + tier/credits (endpoint discovery, prod first)
    const assist = await loadCodeAssist(
      accessToken,
      ANTIGRAVITY_LOAD_ENDPOINTS,
      probeHeaders,
      this.probeTimeoutMs,
      this.fetcher,
    );
    const projectId = publicAccount.projectId ?? assist.projectId ?? ANTIGRAVITY_DEFAULT_PROJECT_ID;

    // 3. IDE quota (WTUS buckets, endpoint fallback order)
    const quotaResult = await retrieveUserQuota(
      accessToken,
      projectId,
      ANTIGRAVITY_ENDPOINT_FALLBACKS,
      probeHeaders,
      this.probeTimeoutMs,
      this.fetcher,
    );

    // 4. CLI quota (REQUESTS buckets via prod + fixed CLI headers)
    let cliBuckets: Awaited<ReturnType<typeof retrieveCliQuota>> = [];
    try {
      cliBuckets = await retrieveCliQuota(
        accessToken,
        projectId,
        ANTIGRAVITY_ENDPOINT_PROD,
        this.probeTimeoutMs,
        this.fetcher,
      );
    } catch {
      // CLI path is best-effort; quota pools remain valid without it. A revoked token
      // already surfaces via loadCodeAssist / IDE quota (401/403) above.
    }

    // 5. Catalog (throttled per account)
    const previous = this.store.getSnapshot(accountId);
    const catalogDue = this.catalogIntervalMs > 0 &&
      (!previous?.catalogAt ||
        Date.now() - new Date(previous.catalogAt).getTime() >= this.catalogIntervalMs);
    if (catalogDue) {
      try {
        await fetchAvailableModels(
          accessToken,
          projectId,
          ANTIGRAVITY_ENDPOINT_FALLBACKS,
          probeHeaders,
          this.probeTimeoutMs,
          this.fetcher,
        );
      } catch {
        // catalog is advisory; quota windows remain authoritative
      }
    }

    // 6. Aggregate
    const pools: AntigravityPoolSummary[] = aggregatePoolBuckets(quotaResult.buckets, observedAt);
    const cliSummary = aggregateCliBuckets(cliBuckets, observedAt);
    if (cliSummary) pools.push(cliSummary);

    const subscription = {
      currentTierId: assist.currentTierId,
      currentTierName: assist.currentTierName,
      paidTierId: assist.paidTierId,
      availableCredits: assist.availableCredits ?? 0,
      gcpManaged: assist.gcpManaged,
      observedAt,
    };

    // 7. Credit increase event (reset token gained)
    const previousCredits = previous?.subscription?.availableCredits ?? null;
    const newCredits = assist.availableCredits;
    if (
      newCredits !== null &&
      previousCredits !== null &&
      newCredits > previousCredits
    ) {
      this.sink.emitEvent({
        eventType: "reset_credit_increased",
        severity: "info",
        identityId: accountId,
        hostId: this.sourceHostId,
        provider: ANTIGRAVITY_OBSERVATORY_PROVIDER,
        identityKind: "credential",
        accountId,
        occurredAt: observedAt,
        fingerprint: [
          "reset_credit_increased",
          ANTIGRAVITY_PROBE_SOURCE,
          accountId,
          newCredits,
        ].join(":"),
      });
    }

    // 8. Ingest identity + quota observations
    await this.sink.ingestBatch(observedAt, [
      this.buildIdentityObservation({
        accountId,
        label: this.buildIdentityLabel(accountId),
        pools,
        observedAt,
        projectId,
        error: null,
        errorCategory: null,
        statusCode: "ok",
        lastSuccessAt: observedAt,
      }),
    ], pools.map((pool) => this.buildQuotaObservation({
      accountId,
      observedAt,
      pool,
      projectId,
      tier: assist.currentTierId,
    })));

    // 9. Persist snapshot (fresh; resets failure state)
    const snapshot: AntigravityAccountSnapshot = {
      pools,
      subscription,
      verificationRequired: assist.verificationRequired,
      projectId,
      catalogAt: catalogDue ? new Date().toISOString() : previous?.catalogAt ?? null,
      probedAt: observedAt,
      lastError: null,
      consecutiveFailures: 0,
    };
    this.store.saveSnapshot(accountId, snapshot);
    if (publicAccount.projectId !== projectId) {
      this.store.setAccountProject(accountId, projectId);
    }
    const masked = this.buildIdentityLabel(accountId);
    const summary = pools
      .map((pool) => `${pool.pool}=${Math.round(pool.remainingFraction * 100)}%`)
      .join(" ");
    console.log(
      `[antigravity] probe ok for ${masked}: project=${projectId} ${summary} credits=${assist.availableCredits ?? "unknown"}`,
    );
  }

  private async persistFailure(accountId: string, message: string): Promise<void> {
    const attemptedAt = new Date().toISOString();
    const previous = this.store.getSnapshot(accountId);
    const publicAccount = this.store.listAccounts().find((a) => a.id === accountId);
    if (!publicAccount) return;
    const failures = (previous?.consecutiveFailures ?? 0) + 1;
    const snapshot: AntigravityAccountSnapshot = {
      pools: previous?.pools ?? [],
      subscription: previous?.subscription ?? null,
      verificationRequired: previous?.verificationRequired ?? false,
      projectId: previous?.projectId ?? publicAccount.projectId,
      catalogAt: previous?.catalogAt ?? null,
      probedAt: attemptedAt,
      lastError: message.slice(0, 500),
      consecutiveFailures: failures,
    };
    this.store.saveSnapshot(accountId, snapshot);
    console.warn(
      `[antigravity] probe failed for ${this.buildIdentityLabel(accountId)}: ${this.categorizeMessage(message)} (${failures} consecutive)`,
    );
    await this.sink.ingestBatch(attemptedAt, [
      this.buildIdentityObservation({
        accountId,
        label: this.buildIdentityLabel(accountId),
        pools: snapshot.pools,
        observedAt: attemptedAt,
        projectId: snapshot.projectId,
        error: snapshot.lastError,
        errorCategory: this.categorizeMessage(message),
        statusCode: this.shortStatus(message),
        lastFailureAt: attemptedAt,
        consecutiveFailures: failures,
      }),
    ], []);
  }

  private categorizeMessage(message: string): string {
    const lower = message.toLowerCase();
    if (lower.includes("401") || lower.includes("403") || lower.includes("invalid_grant")) return "auth";
    if (lower.includes("abort") || lower.includes("timeout") || lower.includes("network")) return "network";
    if (lower.includes("500") || lower.includes("502") || lower.includes("503")) return "server";
    return "unknown";
  }

  private shortStatus(message: string): string {
    const match = message.match(/(401|403|404|408|429|500|502|503|504)/);
    return match ? match[1]! : "error";
  }

  private async ensureAccessToken(accountId: string, refreshToken: string): Promise<string> {
    const cached = this.accessCache.get(accountId);
    if (cached && Date.now() + ACCESS_TOKEN_SKEW_MS < cached.expiresAtMs) {
      return cached.token;
    }
    if (!this.oauth.clientSecret) {
      throw new Error("Antigravity OAuth client secret is not configured.");
    }
    const rotated = await rotateAccessToken({
      oauth: this.oauth,
      refreshToken,
      timeoutMs: this.probeTimeoutMs,
      fetcher: this.fetcher,
    });
    if (rotated.refreshToken && rotated.refreshToken !== refreshToken) {
      this.store.updateAccountRefreshToken(accountId, rotated.refreshToken);
    }
    this.accessCache.set(accountId, {
      token: rotated.accessToken,
      expiresAtMs: Date.now() + rotated.expiresInSec * 1000,
    });
    return rotated.accessToken;
  }

  private buildIdentityLabel(accountId: string): string {
    return formatSafeIdentityLabel(ANTIGRAVITY_OBSERVATORY_PROVIDER, accountId, false, null);
  }

  private buildIdentityObservation(params: {
    accountId: string;
    label: string;
    pools: AntigravityPoolSummary[];
    observedAt: string;
    projectId: string | null;
    error: string | null;
    errorCategory: string | null;
    statusCode: string;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    consecutiveFailures?: number;
  }): ProviderIdentityObservation {
    let health: ProviderIdentityObservation["health"] = "healthy";
    if (params.error) {
      health = params.errorCategory === "auth" ? "rate_limited" : "unhealthy";
    } else {
      const worst = params.pools.reduce((acc, pool) => {
        const status = deriveQuotaStatus(pool.remainingFraction);
        if (status === "exhausted" || status === "critical") return "exhausted" as const;
        if (status === "warning") return "degraded" as const;
        return acc;
      }, "healthy" as ProviderIdentityObservation["health"]);
      if (worst !== "healthy") health = worst;
    }
    return {
      identityId: params.accountId,
      kind: "credential",
      provider: ANTIGRAVITY_OBSERVATORY_PROVIDER,
      sourceHostId: this.sourceHostId,
      sourceVersion: ANTIGRAVITY_PROBE_SOURCE_VERSION,
      label: params.label,
      observedAt: params.observedAt,
      health,
      disabled: false,
      blocked: false,
      cooldownUntilUtc: null,
      lastProbeAt: params.observedAt,
      statusCode: params.statusCode,
      statusMessage: params.error,
      activeModel: null,
      lastSuccessAt: params.lastSuccessAt ?? null,
      lastFailureAt: params.lastFailureAt ?? null,
      consecutiveFailures: params.consecutiveFailures ?? 0,
    };
  }

  private buildQuotaObservation(params: {
    accountId: string;
    observedAt: string;
    pool: AntigravityPoolSummary;
    projectId: string | null;
    tier: string | null;
  }): QuotaObservationInput {
    const { pool } = params;
    const remaining = Math.min(1, Math.max(0, pool.remainingFraction));
    const used = 1 - remaining;
    return {
      identityId: params.accountId,
      provider: ANTIGRAVITY_OBSERVATORY_PROVIDER,
      windowId: `antigravity-${pool.pool}`,
      bucketId: `antigravity-${pool.pool}`,
      windowDurationMs: null,
      meter: pool.meter,
      model: null,
      tier: params.tier,
      hostId: this.sourceHostId,
      fetchedAt: params.observedAt,
      observedAt: params.observedAt,
      resetsAt: pool.resetTime,
      resetLabel: null,
      usedFraction: Math.round(used * 1_000_000) / 1_000_000,
      remainingFraction: Math.round(remaining * 1_000_000) / 1_000_000,
      usedUnits: null,
      totalUnits: null,
      remainingUnits: null,
      resetCredits: null,
      unit: null,
      status: deriveQuotaStatus(remaining),
      errorCategory: null,
      consecutiveFailures: 0,
      source: ANTIGRAVITY_PROBE_SOURCE,
      sourceVersion: ANTIGRAVITY_PROBE_SOURCE_VERSION,
    };
  }
}
