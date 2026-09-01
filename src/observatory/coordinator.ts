import type { AppConfig } from "../config";
import type { RunSnapshot } from "../storage";
import type { TelegramNotifier } from "../telegram";
import { ObservatoryDeliveryManager } from "./delivery";
import {
  buildQuotaTrackerKey,
  createDeterministicFingerprint,
  evaluateAgentRouterBalanceTransition,
  evaluateProviderTransition,
  evaluateQuotaTransition,
  type AgentRouterTrackerState as EventAgentRouterTrackerState,
  type ProviderIncidentLevel,
  type ProviderTrackerState as EventProviderTrackerState,
  type QuotaTrackerState as EventQuotaTrackerState,
} from "./events";
import {
  collectOmpUsage,
  sanitizeOmpUsageError,
  type OmpUsageExecutor,
} from "./omp-usage";
import {
  evaluateNotificationDispatch,
  getDueDigestSlot,
  parsePolicyTarget,
  resolveEffectivePolicy,
  type PolicyResolutionContext,
} from "./policies";
import type { ObservatoryStore } from "./store";
import type {
  ObservatoryAgentRouterBalanceObservation,
  ObservatoryAgentRouterRun,
  ObservatoryAgentRouterUsagePoint,
  ObservatoryEventCandidate,
  StoredObservatoryEvent,
  StoredProviderTracker,
} from "./types";

export interface ObservatoryCoordinatorStatus {
  running: boolean;
  lastProbeAt: string | null;
  lastProbeStatus: "ok" | "error" | null;
  lastProbeError: string | null;
  nextProbeAt: string | null;
  consecutiveProbeFailures: number;
  activeHostId: string;
}

type EventListener = (event: StoredObservatoryEvent) => void;

function providerIncidentLevel(tracker: StoredProviderTracker): ProviderIncidentLevel {
  if (tracker.disabledIncidentActive) return "disabled";
  if (tracker.blockedIncidentActive) return "blocked";
  if (tracker.cooldownIncidentActive) return "cooldown";
  if (tracker.downIncidentActive) return "down";
  return tracker.health === "degraded" ? "degraded" : "none";
}

function policyContextForTarget(target: string): PolicyResolutionContext {
  const { scopeType, scopeKey } = parsePolicyTarget(target);
  if (!scopeKey) return {};
  switch (scopeType) {
    case "event": return { eventType: scopeKey };
    case "provider": return { provider: scopeKey };
    case "credential": return { credentialId: scopeKey };
    case "pool": return { poolId: scopeKey };
    case "identity": return { identityId: scopeKey };
    case "account": return { accountId: scopeKey };
    case "host": return { hostId: scopeKey };
    case "session": return { sessionId: scopeKey };
    default: return {};
  }
}

export class ObservatoryCoordinator {
  private running = false;
  private pollerStarted = false;
  private retentionStarted = false;
  private lastProbeAt: string | null = null;
  private lastProbeStatus: "ok" | "error" | null = null;
  private lastProbeError: string | null = null;
  private nextProbeAt: string | null = null;
  private consecutiveProbeFailures = 0;
  private readonly listeners = new Set<EventListener>();
  private readonly deliveryManagerInternal: ObservatoryDeliveryManager;
  private readonly ompExecutor: OmpUsageExecutor;

  constructor(
    private readonly store: ObservatoryStore,
    private readonly config: AppConfig,
    telegram: TelegramNotifier | null = null,
    ompExecutor?: OmpUsageExecutor,
  ) {
    this.deliveryManagerInternal = new ObservatoryDeliveryManager(store, telegram, config);
    this.ompExecutor = ompExecutor ?? (() => {
      const hmacKey = config.observatory.hmacKey;
      if (!hmacKey) throw new Error("OMP_USAGE_KEY_ERROR");
      return collectOmpUsage({
        hmacKey,
        hostId: config.observatory.sourceHostId,
        sourceVersion: "18.0.11",
        executable: config.observatory.ompExecutable,
        brokerUrl: config.ompQuota.brokerUrl ?? undefined,
        brokerToken: process.env.OMP_AUTH_BROKER_TOKEN?.trim() || undefined,
        timeoutMs: config.observatory.ompTimeoutMs,
        maxAccountsPerProvider: config.observatory.maxAccountsPerProvider,
        perAccountTimeoutMs: config.observatory.perAccountTimeoutMs,
      });
    });
  }

  get deliveryManager(): ObservatoryDeliveryManager {
    return this.deliveryManagerInternal;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcast(event: StoredObservatoryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        console.error("Observatory event listener failed.");
      }
    }
  }

  getStatus(): ObservatoryCoordinatorStatus {
    return {
      running: this.running,
      lastProbeAt: this.lastProbeAt,
      lastProbeStatus: this.lastProbeStatus,
      lastProbeError: this.lastProbeError,
      nextProbeAt: this.nextProbeAt,
      consecutiveProbeFailures: this.consecutiveProbeFailures,
      activeHostId: this.config.observatory.sourceHostId,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.pollerStarted) {
      this.pollerStarted = true;
      void this.pollingLoop();
    }
    if (!this.retentionStarted) {
      this.retentionStarted = true;
      void this.retentionLoop();
    }
  }

  stop(): void {
    this.running = false;
    this.pollerStarted = false;
    this.retentionStarted = false;
  }

  private async pollingLoop(): Promise<void> {
    let nextPoll = Date.now();
    while (this.running && this.pollerStarted) {
      if (Date.now() >= nextPoll) {
        await this.pollOnce();
        nextPoll = Date.now() + this.config.observatory.pollIntervalMinutes * 60_000;
        this.nextProbeAt = new Date(nextPoll).toISOString();
      }
      await Bun.sleep(1_000);
    }
  }

  private async retentionLoop(): Promise<void> {
    let nextPrune = Date.now() + 5_000;
    while (this.running && this.retentionStarted) {
      const now = new Date();
      this.processDueDigests(now);
      if (now.getTime() >= nextPrune) {
        try {
          this.pruneRetentionOnce();
        } catch {
          console.error("Observatory retention prune failed.");
        }
        nextPrune = now.getTime() + this.config.observatory.retentionPruneIntervalMinutes * 60_000;
      }
      await Bun.sleep(5_000);
    }
  }

  private processDueDigests(now: Date): void {
    for (const digestPolicy of this.store.listPolicies()) {
      if (!digestPolicy.digestEnabled || !digestPolicy.digestSchedule || !digestPolicy.digestTimezone) continue;
      const watermark = this.store.getDigestWatermark(digestPolicy.target);
      const due = getDueDigestSlot(
        digestPolicy.digestSchedule,
        digestPolicy.digestTimezone,
        now,
        watermark?.lastSlotKey,
      );
      if (!due.due || !due.slotKey || !due.occurrenceTime) continue;
      const claim = this.store.claimDigestSlot(digestPolicy.target, due.slotKey, due.occurrenceTime);
      if (!claim.claimed || !claim.eventId) continue;
      const event = this.store.getEvent(claim.eventId);
      if (!event) continue;
      this.routeStoredEvent(event, policyContextForTarget(digestPolicy.target));
      this.broadcast(event);
    }
  }

  pruneRetentionOnce(): void {
    const cutoffIso = new Date(
      Date.now() - this.config.observatory.retentionDays * 86_400_000,
    ).toISOString();
    this.store.pruneRetention({
      eventsOlderThan: cutoffIso,
      quotaObservationsOlderThan: cutoffIso,
      sessionsOlderThan: cutoffIso,
      deliveriesOlderThan: cutoffIso,
      auditOlderThan: cutoffIso,
      noncesOlderThan: cutoffIso,
      importLedgerOlderThan: cutoffIso,
      agentrouterRunsOlderThan: cutoffIso,
      agentrouterUsageOlderThan: cutoffIso,
      agentrouterBalancesOlderThan: cutoffIso,
      agentrouterGrantsOlderThan: cutoffIso,
      agentrouterEndpointsOlderThan: cutoffIso,
    });
  }

  async pollOnce(): Promise<void> {
    const attemptedAt = new Date().toISOString();
    this.lastProbeAt = attemptedAt;
    try {
      const normalized = await this.ompExecutor();

      const emitted: StoredObservatoryEvent[] = [];
      this.store.withTransaction(() => {
        this.store.upsertHost({
          hostId: this.config.observatory.sourceHostId,
          operatorLabel: "AgentRouter Local Node",
          platform: process.platform,
          collectorVersion: this.config.observatory.ompVersion ?? "unknown",
          observedAt: normalized.observedAt,
          lastSeenAt: normalized.observedAt,
          status: "online",
        });

        for (const identity of normalized.identities) {
          this.store.upsertIdentity(identity);
          const trackerKey = `provider:${identity.provider}:${identity.identityId}`;
          const stored = this.store.getProviderTracker(trackerKey);
          const level = stored ? providerIncidentLevel(stored) : "none";
          const previous: EventProviderTrackerState | null = stored ? {
            identityId: stored.identityId,
            provider: stored.provider,
            lastHealth: stored.health,
            consecutiveFailures: stored.consecutiveFailures,
            consecutiveBlocked: stored.consecutiveBlocked,
            consecutiveDisabled: stored.consecutiveDisabled,
            incidentId: level === "none" ? null : `${trackerKey}:${stored.incidentEpoch}`,
            incidentLevel: level,
            incidentEpoch: stored.incidentEpoch,
            lastObservedAt: stored.lastObservedAt,
          } : null;
          const transition = evaluateProviderTransition(previous, identity);
          const next = transition.nextState;
          this.store.upsertProviderTracker({
            trackerKey,
            identityId: next.identityId,
            provider: next.provider,
            sourceHostId: identity.sourceHostId,
            lastObservedAt: next.lastObservedAt,
            health: next.lastHealth,
            consecutiveFailures: next.consecutiveFailures,
            consecutiveBlocked: next.consecutiveBlocked,
            consecutiveDisabled: next.consecutiveDisabled,
            downIncidentActive: next.incidentLevel === "down",
            blockedIncidentActive: next.incidentLevel === "blocked",
            disabledIncidentActive: next.incidentLevel === "disabled",
            cooldownIncidentActive: next.incidentLevel === "cooldown",
            collectorFailureActive: false,
            incidentEpoch: next.incidentEpoch,
          });
          for (const candidate of transition.events) emitted.push(this.recordEventCandidate(candidate));
        }

        for (const quota of normalized.quotas) {
          const trackerKey = buildQuotaTrackerKey(quota);
          const stored = this.store.getQuotaTracker(trackerKey);
          const previous: EventQuotaTrackerState | null = stored ? {
            trackerKey: stored.trackerKey,
            identityId: stored.identityId,
            provider: stored.provider,
            bucketId: stored.bucketId,
            windowId: stored.windowId,
            meter: quota.meter,
            model: quota.model,
            tier: quota.tier,
            generation: stored.generation,
            warningArmEpoch: stored.warningArmEpoch,
            criticalArmEpoch: stored.criticalArmEpoch,
            exhaustedArmEpoch: stored.exhaustedArmEpoch,
            creditChangeSeq: stored.creditChangeSequence,
            lastObservedAt: stored.lastObservedAt,
            lastUsedFraction: stored.lastUsedFraction,
            lastRemainingFraction: stored.lastRemainingFraction ?? Math.max(0, 1 - stored.lastUsedFraction),
            lastResetCredits: stored.lastResetCredits ?? null,
            warningFired: stored.warningFired,
            criticalFired: stored.criticalFired,
            exhaustedFired: stored.exhaustedFired,
          } : null;
          const transition = evaluateQuotaTransition(previous, quota);
          const next = transition.nextState;
          this.store.recordQuotaObservation(quota);
          this.store.upsertQuotaTracker({
            trackerKey: next.trackerKey,
            identityId: next.identityId,
            provider: next.provider,
            bucketId: next.bucketId,
            windowId: next.windowId,
            generation: next.generation,
            lastObservedAt: next.lastObservedAt,
            lastUsedFraction: next.lastUsedFraction,
            lastRemainingFraction: next.lastRemainingFraction,
            lastResetCredits: next.lastResetCredits,
            warningFired: next.warningFired,
            criticalFired: next.criticalFired,
            exhaustedFired: next.exhaustedFired,
            warningArmEpoch: next.warningArmEpoch,
            criticalArmEpoch: next.criticalArmEpoch,
            exhaustedArmEpoch: next.exhaustedArmEpoch,
            creditChangeSequence: next.creditChangeSeq,
            consecutiveFailures: stored?.consecutiveFailures ?? 0,
            failureAlertSent: stored?.failureAlertSent ?? false,
            lastResetAt: transition.resetConfirmed ? next.lastObservedAt : stored?.lastResetAt,
            lastNotifiedResetAt: stored?.lastNotifiedResetAt,
          });
          for (const candidate of transition.events) emitted.push(this.recordEventCandidate(candidate));
        }
      });

      for (const event of emitted) this.broadcast(event);
      this.lastProbeStatus = "ok";
      this.lastProbeError = null;
      this.consecutiveProbeFailures = 0;
      await this.deliveryManagerInternal.processOutboxOnce();
    } catch (error) {
      const safeError = sanitizeOmpUsageError(error);
      this.lastProbeStatus = "error";
      this.lastProbeError = safeError;
      this.consecutiveProbeFailures += 1;
      console.warn(`[Observatory] ${safeError}`);
      if (this.consecutiveProbeFailures >= 3) {
        const event = this.store.withTransaction(() => this.recordEventCandidate({
          eventType: "collector_failure",
          severity: "warning",
          hostId: this.config.observatory.sourceHostId,
          fingerprint: createDeterministicFingerprint(
            "collector_failure",
            this.config.observatory.sourceHostId,
            this.consecutiveProbeFailures,
          ),
          occurredAt: attemptedAt,
        }));
        this.broadcast(event);
      }
    }
  }

  processEventCandidate(candidate: ObservatoryEventCandidate): StoredObservatoryEvent {
    const event = this.store.withTransaction(() => this.recordEventCandidate(candidate));
    this.broadcast(event);
    void this.deliveryManagerInternal.processOutboxOnce().catch(() => {
      console.error("Observatory outbox processing failed.");
    });
    return event;
  }

  private recordEventCandidate(candidate: ObservatoryEventCandidate): StoredObservatoryEvent {
    const { event, isDuplicate } = this.store.recordEvent(candidate);
    if (!isDuplicate) this.routeStoredEvent(event);
    return event;
  }

  private routeStoredEvent(
    event: StoredObservatoryEvent,
    extraContext: PolicyResolutionContext = {},
  ): void {
    const { policy } = resolveEffectivePolicy(this.store.listPolicies(), {
      ...extraContext,
      eventType: event.eventType,
      hostId: event.hostId ?? extraContext.hostId,
      identityId: event.identityId ?? extraContext.identityId,
    });
    const dispatch = evaluateNotificationDispatch(event, policy, event.occurredAt);
    if (dispatch.shouldDeliver && dispatch.channels.includes("telegram")) {
      this.store.recordDeliveryAttempt({
        eventId: event.eventId,
        channel: "telegram",
        status: "pending",
        fingerprint: createDeterministicFingerprint("delivery", event.eventId, "telegram"),
      });
    }
  }

  recordAgentRouterRun(snapshot: RunSnapshot, account: { id: string; label: string }): void {
    try {
      const emitted: StoredObservatoryEvent[] = [];
      this.store.withTransaction(() => {
        this.store.upsertAgentRouterAccount({
          accountId: account.id,
          accountLabel: account.label,
        });
        const runInput: ObservatoryAgentRouterRun = {
          accountId: account.id,
          accountLabel: account.label,
          startedAt: snapshot.startedAt,
          endedAt: snapshot.endedAt,
          status: snapshot.status,
          loginMs: snapshot.loginMs,
          dashboardMs: snapshot.dashboardMs,
          totalMs: snapshot.totalMs,
          loggedOut: snapshot.loggedOut,
          sessionReused: snapshot.sessionReused,
          errorCategory: snapshot.status === "error" ? "automation_failure" : null,
          balance: snapshot.metrics.balance,
          consumed: snapshot.metrics.consumed,
          requestCount: snapshot.metrics.requestCount,
          quotaPerUnit: snapshot.metrics.quotaPerUnit,
          averageRpm: snapshot.metrics.averageRpm,
          averageTpm: snapshot.metrics.averageTpm,
          availableModels: snapshot.metrics.availableModels,
        };
        const savedRun = this.store.recordAgentRouterRun(runInput);

        const balance = snapshot.metrics.balance;
        if (balance !== undefined) {
          const trackerKey = `agentrouter:${account.id}`;
          const stored = this.store.getAgentRouterTracker(trackerKey);
          const previous: EventAgentRouterTrackerState | null = stored ? {
            accountId: stored.accountId,
            lastBalance: stored.lastBalance ?? null,
            lowBalanceFired: stored.lowBalanceFired,
            lowBalanceArmEpoch: stored.lowBalanceArmEpoch,
            lastObservedAt: stored.lastObservedAt,
          } : null;
          const transition = evaluateAgentRouterBalanceTransition(previous, {
            accountId: account.id,
            balance,
            observedAt: snapshot.endedAt,
          });
          const previousBalance = stored?.lastBalance ?? null;
          const balanceDelta = previousBalance === null ? null : balance - previousBalance;
          const balanceObservation: ObservatoryAgentRouterBalanceObservation = {
            runId: savedRun.id,
            accountId: account.id,
            observedAt: snapshot.endedAt,
            balance,
            consumed: snapshot.metrics.consumed ?? 0,
            previousBalance,
            balanceDelta,
            classification: previousBalance === null
              ? "initial"
              : balanceDelta === 0
                ? "unchanged"
                : balanceDelta !== null && balanceDelta > 0
                  ? "credit-increase"
                  : "usage",
          };
          this.store.recordAgentRouterBalanceObservation(balanceObservation);
          this.store.upsertAgentRouterTracker({
            trackerKey,
            accountId: transition.nextState.accountId,
            lastObservedAt: transition.nextState.lastObservedAt,
            lastBalance: transition.nextState.lastBalance,
            lowBalanceFired: transition.nextState.lowBalanceFired,
            lowBalanceArmEpoch: transition.nextState.lowBalanceArmEpoch,
          });
          for (const candidate of transition.events) emitted.push(this.recordEventCandidate(candidate));
        }

        if (snapshot.usagePoints.length > 0) {
          const points: ObservatoryAgentRouterUsagePoint[] = snapshot.usagePoints.map((point) => ({
            accountId: account.id,
            granularity: point.granularity,
            createdAtTs: point.createdAt,
            modelName: point.modelName,
            requestCount: point.requestCount,
            tokenUsed: point.tokenUsed,
            quota: point.quota,
          }));
          this.store.recordAgentRouterUsagePoints(points);
        }
      });
      for (const event of emitted) this.broadcast(event);
      void this.deliveryManagerInternal.processOutboxOnce().catch(() => {
        console.error("Observatory outbox processing failed.");
      });
    } catch {
      console.warn(`[Observatory] AgentRouter run ingestion failed for account ${account.id}.`);
    }
  }

  recordAgentRouterEndpointObservation(observation: {
    accountId: string;
    accountLabel: string;
    observedAt: string;
    status: "ok" | "error";
    balance?: number | null;
    consumed?: number | null;
    requestCount?: number | null;
    latencyMs: number;
    errorCategory?: string | null;
  }): void {
    try {
      this.store.recordAgentRouterEndpointObservation(observation);
    } catch {
      console.warn(`[Observatory] Endpoint ingestion failed for account ${observation.accountId}.`);
    }
  }
}
