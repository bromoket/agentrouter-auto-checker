/**
 * AI Fleet Observatory - Shared Domain Types & Interfaces
 *
 * Core data contracts for hosts, identities, quota observations, current windows,
 * trackers, sessions, events, notification policies, deliveries, audit, nonces,
 * import ledger, collector batches, and AgentRouter observatory entities.
 */

export type ProviderIdentityKind = "credential" | "pool" | "custom" | (string & {});

export type ProviderHealth =
  | "healthy"
  | "degraded"
  | "unhealthy"
  | "rate_limited"
  | "exhausted"
  | "unknown";

export type EventSeverity = "info" | "warning" | "error" | "critical";

export type ObservatoryEventType =
  | "quota_warning"
  | "quota_critical"
  | "quota_exhausted"
  | "quota_reset"
  | "reset_credit_increased"
  | "reset_credit_decreased"
  | "provider_degraded"
  | "provider_down"
  | "provider_recovered"
  | "credential_blocked"
  | "credential_disabled"
  | "credential_cooldown"
  | "credential_recovered"
  | "collector_failure"
  | "collector_recovered"
  | "host_offline"
  | "host_recovered"
  | "agentrouter_large_balance_drop"
  | "agentrouter_balance_low"
  | "agentrouter_grant_received"
  | "agentrouter_challenge_required"
  | "agentrouter_login_required"
  | "agentrouter_login_failed"
  | "agentrouter_endpoint_failed"
  | "session_context_warning"
  | "session_context_critical"
  | "session_failed"
  | "session_started"
  | "session_closed"
  | "digest_ready"
  | "policy_changed"
  | "import_completed";

export type DeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "failed"
  | "throttled"
  | "silenced";

export type DeliveryErrorCategory =
  | "network"
  | "rate_limit"
  | "auth"
  | "invalid_payload"
  | "server_error"
  | "client_error"
  | "unknown";

export interface ProviderIdentityObservation {
  identityId: string;
  kind: ProviderIdentityKind;
  provider: string;
  sourceHostId: string;
  sourceVersion?: string | null;
  label: string;
  observedAt: string;
  health: ProviderHealth;
  disabled?: boolean;
  blocked?: boolean;
  cooldownUntilUtc?: string | null;
  lastProbeAt?: string | null;
  statusCode?: string | null;
  statusMessage?: string | null;
  activeModel?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures?: number;
}

export interface StoredProviderIdentity extends ProviderIdentityObservation {
  disabled: boolean;
  blocked: boolean;
  statusCode: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface FleetHostObservation {
  hostId: string;
  operatorLabel?: string | null;
  platform?: string | null;
  collectorVersion?: string | null;
  lastSeenAt?: string | null;
  observedAt: string;
  status: "online" | "degraded" | "offline" | "unknown" | string;
  activeSessionsCount?: number;
  activeIdentitiesCount?: number;
}

export interface StoredFleetHost extends FleetHostObservation {
  operatorLabel: string;
  platform: string;
  collectorVersion: string;
  lastSeenAt: string;
  activeSessionsCount: number;
  activeIdentitiesCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuotaObservationInput {
  identityId: string;
  provider: string;
  bucketId?: string | null; // Defaults to windowId if omitted
  windowId: string;
  windowDurationMs?: number | null;
  meter?: string | null;
  model?: string | null;
  tier?: string | null;
  hostId?: string | null;
  fetchedAt?: string | null;
  observedAt: string;
  resetsAt?: string | null;
  resetLabel?: string | null;
  usedFraction: number; // 0..1 inclusive
  remainingFraction?: number | null; // 0..1 inclusive
  usedUnits?: number | null;
  totalUnits?: number | null;
  remainingUnits?: number | null;
  resetCredits?: number | null;
  unit?: string | null;
  status?: "ok" | "warning" | "critical" | "exhausted" | string | null;
  errorCategory?: string | null;
  consecutiveFailures?: number | null;
  source?: string | null;
  sourceVersion?: string | null;
}

export interface StoredQuotaObservation extends QuotaObservationInput {
  id: number;
  bucketId: string;
  status: string;
  consecutiveFailures: number;
  createdAt: string;
}

export interface CurrentQuotaWindow {
  identityId: string;
  provider: string;
  bucketId: string;
  windowId: string;
  windowDurationMs: number | null;
  meter: string | null;
  model: string | null;
  tier: string | null;
  hostId: string | null;
  lastFetchedAt: string | null;
  lastObservedAt: string;
  resetsAt: string | null;
  resetLabel: string | null;
  usedFraction: number;
  remainingFraction: number | null;
  usedUnits: number | null;
  totalUnits: number | null;
  remainingUnits: number | null;
  resetCredits: number | null;
  unit: string | null;
  status: string;
  errorCategory: string | null;
  consecutiveFailures: number;
  source: string | null;
  sourceVersion: string | null;
  updatedAt: string;
}

export interface QuotaTrackerState {
  trackerKey: string;
  identityId: string;
  provider: string;
  bucketId: string;
  windowId: string;
  generation: number;
  lastObservedAt: string;
  lastUsedFraction: number;
  lastRemainingFraction?: number | null;
  lastResetCredits?: number | null;
  warningFired: boolean;
  criticalFired: boolean;
  exhaustedFired: boolean;
  warningArmEpoch: number;
  criticalArmEpoch: number;
  exhaustedArmEpoch: number;
  creditChangeSequence: number;
  consecutiveFailures: number;
  failureAlertSent: boolean;
  lastResetAt?: string | null;
  lastNotifiedResetAt?: string | null;
  updatedAt?: string;
}

export interface StoredQuotaTracker extends QuotaTrackerState {
  updatedAt: string;
}

export interface ProviderTrackerState {
  trackerKey: string;
  identityId: string;
  provider: string;
  sourceHostId: string;
  lastObservedAt: string;
  health: ProviderHealth;
  consecutiveFailures: number;
  consecutiveBlocked: number;
  consecutiveDisabled: number;
  downIncidentActive: boolean;
  blockedIncidentActive: boolean;
  disabledIncidentActive: boolean;
  cooldownIncidentActive: boolean;
  collectorFailureActive: boolean;
  incidentEpoch: number;
  updatedAt?: string;
}

export interface StoredProviderTracker extends ProviderTrackerState {
  updatedAt: string;
}

export interface HostTrackerState {
  trackerKey: string;
  hostId: string;
  lastSeenAt: string;
  lastObservedAt: string;
  status: string;
  offlineSince?: string | null;
  offlineAlertSent: boolean;
  offlineIncidentEpoch: number;
  updatedAt?: string;
}

export interface StoredHostTracker extends HostTrackerState {
  updatedAt: string;
}

export interface SessionTrackerState {
  trackerKey: string;
  sessionId: string;
  hostId: string;
  identityId?: string | null;
  lastObservedAt: string;
  lastContextBps?: number | null;
  contextWarningFired: boolean;
  contextCriticalFired: boolean;
  contextArmEpoch: number;
  status: string;
  updatedAt?: string;
}

export interface StoredSessionTracker extends SessionTrackerState {
  updatedAt: string;
}

export interface AgentRouterTrackerState {
  trackerKey: string;
  accountId: string;
  lastObservedAt: string;
  lastBalance?: number | null;
  lowBalanceFired: boolean;
  lowBalanceArmEpoch: number;
  updatedAt?: string;
}

export interface StoredAgentRouterTracker extends AgentRouterTrackerState {
  updatedAt: string;
}

export interface OmpSessionSummaryInput {
  sessionId: string;
  hostId: string;
  identityId?: string | null;
  status: "active" | "closed" | "completed" | "failed" | "cancelled" | string;
  startedAt: string;
  lastActiveAt?: string | null;
  closedAt?: string | null;
  endedAt?: string | null; // backward-compat alias for closedAt
  model?: string | null;
  provider?: string | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  promptTokens?: number | null; // backward-compat alias for inputTokens
  outputTokens?: number | null;
  completionTokens?: number | null; // backward-compat alias for outputTokens
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  totalTokens?: number | null;
  costMicros?: number | null;
  costEstimate?: number | null;
  costTrust?: "exact" | "estimated" | "unknown" | null;
  contextBps?: number | null; // 0..10000 basis points
  toolCallsCount?: number | null;
  errorCount?: number | null;
  exitCode?: number | null;
  collectedAt?: string | null;
  source?: string | null;
  sourceVersion?: string | null;
}

export interface StoredSessionSummary extends OmpSessionSummaryInput {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  costMicros: number | null;
  costTrust: "exact" | "estimated" | "unknown" | null;
  contextBps: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObservatoryEventCandidate {
  eventId?: string;
  eventType: ObservatoryEventType;
  severity: EventSeverity;
  fingerprint: string;
  occurredAt: string;
  hostId?: string | null;
  identityId?: string | null;
  sessionId?: string | null;
  provider?: string | null;
  identityKind?: ProviderIdentityKind | null;
  accountId?: string | null;
  bucketId?: string | null;
  windowId?: string | null;
  meter?: string | null;
  model?: string | null;
  tier?: string | null;
}

export interface StoredObservatoryEvent extends ObservatoryEventCandidate {
  eventId: string;
  createdAt: string;
}

export interface NotificationPolicyRule {
  policyId?: string;
  target: string;
  enabled?: boolean;
  silenced?: boolean;
  telegramImmediate?: boolean;
  dashboardOnly?: boolean;
  minSeverity?: EventSeverity;
  thresholds?: Record<string, number> | null;
  consecutiveFailuresThreshold?: number | null;
  cooldownMinutes?: number;
  throttleIntervalMs?: number;
  channels?: string[];
  quietHoursEnabled?: boolean;
  quietHoursTimezone?: string | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  criticalBypassQuietHours?: boolean;
  digestEnabled?: boolean;
  digestSchedule?: string | null;
  digestTimezone?: string | null;
  recipient?: string | null;
  matchEventTypes?: ObservatoryEventType[];
  matchHostIds?: string[];
  matchIdentityIds?: string[];
}

export type NotificationPolicyOverrides = NotificationPolicyRule;

export interface EffectiveNotificationPolicy {
  policyId: string;
  target: string;
  enabled: boolean;
  silenced: boolean;
  telegramImmediate: boolean;
  dashboardOnly: boolean;
  minSeverity: EventSeverity;
  thresholds: Record<string, number> | null;
  consecutiveFailuresThreshold: number | null;
  cooldownMinutes: number;
  throttleIntervalMs: number;
  channels: string[];
  quietHoursEnabled: boolean;
  quietHoursTimezone: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  criticalBypassQuietHours: boolean;
  digestEnabled: boolean;
  digestSchedule: string | null;
  digestTimezone: string;
  recipient: string | null;
  matchEventTypes: ObservatoryEventType[];
  matchHostIds: string[];
  matchIdentityIds: string[];
  updatedAt: string;
}

export interface StoredNotificationPolicy extends EffectiveNotificationPolicy {
  createdAt: string;
}
export interface EffectivePolicyResolution {
  policy: EffectiveNotificationPolicy;
  matchedTargets: string[];
}


export interface DigestWatermarkRecord {
  target: string;
  lastDigestAt: string;
  lastSlotKey: string;
  watermarkEventId?: string | null;
  updatedAt: string;
}

export interface NotificationDeliveryRecord {
  deliveryId?: string;
  eventId: string;
  channel: string;
  leaseToken?: string | null;
  status: DeliveryStatus;
  attemptCount?: number;
  fingerprint: string;
  leaseExpiresAt?: string | null;
  sentAt?: string | null;
  errorCategory?: DeliveryErrorCategory | string | null;
  lastAttemptAt?: string | null;
  providerMessageId?: string | null;
}

export interface StoredNotificationDelivery extends NotificationDeliveryRecord {
  deliveryId: string;
  attemptCount: number;
  leaseToken: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObservatoryAuditEntry {
  auditId?: string;
  action: string;
  actor: string;
  targetType: string;
  targetId: string;
  occurredAt: string;
}

export interface StoredAuditEntry extends ObservatoryAuditEntry {
  auditId: string;
  createdAt: string;
}

export interface NonceClaimInput {
  nonce: string;
  scope: string;
  hostId?: string | null;
  expiresAt: string;
  claimedAt?: string;
}

export interface StoredNonce {
  nonce: string;
  scope: string;
  hostId: string | null;
  claimedAt: string;
  expiresAt: string;
}

export interface ImportLedgerEntry {
  batchId: string;
  source: string;
  importedAt: string;
  recordCount: number;
  status: "pending" | "completed" | "failed";
}
export type LegacyImportDestinationKind =
  | "account"
  | "run"
  | "usage"
  | "balance"
  | "grant"
  | "endpoint";

export interface LegacyImportRowBase {
  sourceTable: string;
  sourceKeyHmac: string;
  projectionSha256: string;
}

export type LegacyProjectedRow =
  | (LegacyImportRowBase & { destinationKind: "account"; value: ObservatoryAgentRouterAccount })
  | (LegacyImportRowBase & { destinationKind: "run"; value: ObservatoryAgentRouterRun })
  | (LegacyImportRowBase & { destinationKind: "usage"; value: ObservatoryAgentRouterUsagePoint })
  | (LegacyImportRowBase & { destinationKind: "balance"; value: ObservatoryAgentRouterBalanceObservation })
  | (LegacyImportRowBase & { destinationKind: "grant"; value: ObservatoryAgentRouterGrantEvent })
  | (LegacyImportRowBase & { destinationKind: "endpoint"; value: ObservatoryAgentRouterEndpointObservation });

export interface LegacyImportSnapshotInput {
  batchId: string;
  source: string;
  snapshotSha256: string;
  sourceVersion: string;
  keyId: string;
  projectionSha256: string;
  importedAt: string;
  projectedRows: LegacyProjectedRow[];
}

export interface StoredLegacyImportItem {
  batchId: string;
  source: string;
  sourceTable: string;
  sourceKeyHmac: string;
  projectionSha256: string;
  destinationKind: LegacyImportDestinationKind;
  destinationId: string | null;
  importedAt: string;
}

export interface LegacyImportSnapshotResult {
  outcome: "imported" | "duplicate" | "conflict";
  batchId: string;
  itemCount: number;
  conflictSourceKeyHmac?: string;
}


export interface StoredImportLedgerEntry extends ImportLedgerEntry {
  createdAt: string;
}

export interface CollectorBatchClaimInput {
  hostId: string;
  batchId: string;
  bodySha256: string;
  keyId: string;
  receivedAt?: string;
  status?: "accepted" | "rejected";
}

export interface StoredCollectorBatch {
  hostId: string;
  batchId: string;
  bodySha256: string;
  keyId: string;
  receivedAt: string;
  status: "accepted" | "rejected";
  createdAt: string;
}

export interface CollectorBatchClaimResult {
  outcome: "new" | "duplicate" | "conflict";
  batch: StoredCollectorBatch;
}

export interface SchemaMigrationEntry {
  version: number;
  name: string;
  checksum: string;
  appliedAt: string;
  appVersion: string;
  description: string;
}

export interface StoredDeliveryAttempt {
  attemptId: string;
  deliveryId: string;
  attemptNumber: number;
  attemptedAt: string;
  outcome: "sent" | "failed" | "throttled" | "silenced";
  errorCategory: string | null;
  providerMessageId: string | null;
  createdAt: string;
}

export interface DailyQuotaRollup {
  rollupId: number;
  dayUtc: string;
  identityId: string;
  provider: string;
  bucketId: string;
  windowId: string;
  meter: string | null;
  model: string | null;
  tier: string | null;
  observationCount: number;
  minUsedFraction: number;
  maxUsedFraction: number;
  avgUsedFraction: number;
  minRemainingFraction: number | null;
  maxRemainingFraction: number | null;
  avgRemainingFraction: number | null;
  minResetCredits: number | null;
  maxResetCredits: number | null;
  firstObservedAt: string;
  lastObservedAt: string;
  finalizedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DailyQuotaRollupInput {
  dayUtc: string;
  identityId: string;
  provider: string;
  bucketId?: string | null;
  windowId: string;
  meter?: string | null;
  model?: string | null;
  tier?: string | null;
  observationCount: number;
  minUsedFraction: number;
  maxUsedFraction: number;
  avgUsedFraction: number;
  minRemainingFraction?: number | null;
  maxRemainingFraction?: number | null;
  avgRemainingFraction?: number | null;
  minResetCredits?: number | null;
  maxResetCredits?: number | null;
  firstObservedAt: string;
  lastObservedAt: string;
  finalizedAt?: string | null;
}

export interface RetentionPruneFilter {
  eventsOlderThan?: string;
  quotaObservationsOlderThan?: string;
  sessionsOlderThan?: string; // applies ONLY to closed/completed sessions based on closed_at
  deliveriesOlderThan?: string; // applies ONLY to terminal deliveries (sent, failed, silenced, throttled)
  collectorBatchesOlderThan?: string; // applies to accepted collector batches (72h retention)
  auditOlderThan?: string;
  noncesOlderThan?: string;
  importLedgerOlderThan?: string;
  agentrouterRunsOlderThan?: string;
  agentrouterUsageOlderThan?: string;
  agentrouterBalancesOlderThan?: string;
  agentrouterGrantsOlderThan?: string;
  agentrouterEndpointsOlderThan?: string;
}

export interface RetentionPruneResult {
  eventsDeleted: number;
  quotaObservationsDeleted: number;
  sessionsDeleted: number;
  deliveriesDeleted: number;
  collectorBatchesDeleted: number;
  auditDeleted: number;
  noncesDeleted: number;
  importLedgerDeleted: number;
  agentrouterRunsDeleted: number;
  agentrouterUsageDeleted: number;
  agentrouterBalancesDeleted: number;
  agentrouterGrantsDeleted: number;
  agentrouterEndpointsDeleted: number;
}

// ==========================================
// AgentRouter Specific Observatory Entities
// (Public metadata and scalars only - no credentials, site PII, or raw payloads)
// ==========================================

export interface ObservatoryAgentRouterAccount {
  accountId: string;
  accountLabel: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface StoredAgentRouterAccount extends ObservatoryAgentRouterAccount {
  createdAt: string;
  updatedAt: string;
}

export interface ObservatoryAgentRouterRun {
  id?: number;
  accountId: string;
  accountLabel: string;
  startedAt: string;
  endedAt: string;
  status: "ok" | "error";
  loginMs: number;
  dashboardMs: number;
  totalMs: number;
  loggedOut: boolean;
  sessionReused: boolean;
  errorCategory?: string | null;
  balance?: number | null;
  consumed?: number | null;
  requestCount?: number | null;
  quotaPerUnit?: number | null;
  averageRpm?: number | null;
  averageTpm?: number | null;
  availableModels?: number | null;
}

export interface StoredAgentRouterRun extends ObservatoryAgentRouterRun {
  id: number;
  createdAt: string;
}

export interface ObservatoryAgentRouterUsagePoint {
  id?: number;
  accountId: string;
  granularity: "hour" | "day" | "week";
  createdAtTs: number;
  modelName: string | null;
  requestCount: number;
  tokenUsed: number;
  quota: number;
}

export interface StoredAgentRouterUsagePoint extends ObservatoryAgentRouterUsagePoint {
  id: number;
  createdAt: string;
}

export interface ObservatoryAgentRouterBalanceObservation {
  id?: number;
  runId?: number | null;
  accountId: string;
  observedAt: string;
  balance: number;
  consumed: number;
  previousBalance?: number | null;
  previousConsumed?: number | null;
  balanceDelta?: number | null;
  consumedDelta?: number | null;
  minutesSincePrevious?: number | null;
  classification: "initial" | "credit-increase" | "usage" | "mixed" | "unchanged";
}

export interface StoredAgentRouterBalanceObservation
  extends ObservatoryAgentRouterBalanceObservation {
  id: number;
  createdAt: string;
}

export interface ObservatoryAgentRouterGrantEvent {
  id?: number;
  runId?: number | null;
  accountId: string;
  sourceEventId: string;
  occurredAt: string;
  amount: number;
  classification: "daily-signin" | (string & {});
}

export interface StoredAgentRouterGrantEvent extends ObservatoryAgentRouterGrantEvent {
  id: number;
  createdAt: string;
}

export interface ObservatoryAgentRouterEndpointObservation {
  id?: number;
  accountId: string;
  accountLabel: string;
  observedAt: string;
  status: "ok" | "error";
  balance?: number | null;
  consumed?: number | null;
  requestCount?: number | null;
  latencyMs: number;
  errorCategory?: string | null;
}

export interface StoredAgentRouterEndpointObservation
  extends ObservatoryAgentRouterEndpointObservation {
  id: number;
  createdAt: string;
}

export interface ExportPaginationOptions {
  since?: string;
  limit?: number;
  offset?: number;
}

export interface ObservatoryExportData {
  exportedAt: string;
  schemaVersion: number;
  totalRecords: number;
  truncated: boolean;
  nextOffset?: number | null;
  hosts: StoredFleetHost[];
  identities: StoredProviderIdentity[];
  quotaWindows: CurrentQuotaWindow[];
  quotaObservations: StoredQuotaObservation[];
  quotaTrackers?: StoredQuotaTracker[];
  providerTrackers?: StoredProviderTracker[];
  hostTrackers?: StoredHostTracker[];
  sessionTrackers?: StoredSessionTracker[];
  agentrouterTrackers?: StoredAgentRouterTracker[];
  sessions: StoredSessionSummary[];
  events: StoredObservatoryEvent[];
  policies: StoredNotificationPolicy[];
  deliveries: StoredNotificationDelivery[];
  deliveryAttempts?: StoredDeliveryAttempt[];
  dailyQuotaRollups?: DailyQuotaRollup[];
  auditEntries: StoredAuditEntry[];
  importLedger: StoredImportLedgerEntry[];
  collectorBatches?: StoredCollectorBatch[];
  agentrouterAccounts?: StoredAgentRouterAccount[];
  agentrouterRuns?: StoredAgentRouterRun[];
  agentrouterUsagePoints?: StoredAgentRouterUsagePoint[];
  agentrouterBalances?: StoredAgentRouterBalanceObservation[];
  agentrouterGrants?: StoredAgentRouterGrantEvent[];
  agentrouterEndpoints?: StoredAgentRouterEndpointObservation[];
}
