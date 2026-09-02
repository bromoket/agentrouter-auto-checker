import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION, ObservatoryStore } from "./store";
import type {
  EffectiveNotificationPolicy,
  FleetHostObservation,
  ImportLedgerEntry,
  ObservatoryAgentRouterAccount,
  ObservatoryAgentRouterBalanceObservation,
  ObservatoryAgentRouterEndpointObservation,
  ObservatoryAgentRouterGrantEvent,
  ObservatoryAgentRouterRun,
  ObservatoryAgentRouterUsagePoint,
  ObservatoryAuditEntry,
  ObservatoryEventCandidate,
  OmpSessionSummaryInput,
  ProviderIdentityObservation,
  QuotaObservationInput,
  QuotaTrackerState,
} from "./types";
import { ValidationError } from "./validation";

describe("ObservatoryStore V1 Comprehensive Suite", () => {
  test("schema initialization writes the immutable six-step ledger and rejects drift", () => {
    const db = new Database(":memory:", { strict: true });
    const store1 = new ObservatoryStore(db);

    expect(store1.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    const ledger1 = store1.getMigrationLedger();
    expect(ledger1.length).toBe(6);
    expect(ledger1.map((entry) => entry.version)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ledger1.every((entry) => entry.name.startsWith("00") && entry.checksum.length === 64)).toBe(true);
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version;").get()?.user_version).toBe(CURRENT_SCHEMA_VERSION);

    const store2 = new ObservatoryStore(db);
    expect(store2.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(store2.getMigrationLedger()).toEqual(ledger1);

    db.run(
      "UPDATE observatory_schema_migrations SET checksum = 'tampered' WHERE version = 3",
    );
    expect(() => new ObservatoryStore(db, { autoMigrate: true })).toThrow(/ledger drift/);
  });

  test("schema migration rejects an empty-ledger gap and user_version divergence", () => {
    const gapDb = new Database(":memory:", { strict: true });
    const gapStore = new ObservatoryStore(gapDb);
    gapDb.run("DELETE FROM observatory_schema_migrations WHERE version = 2");
    expect(() => new ObservatoryStore(gapDb)).toThrow(/user_version/);

    const versionDb = new Database(":memory:", { strict: true });
    new ObservatoryStore(versionDb);
    versionDb.exec("PRAGMA user_version = 5;");
    expect(() => new ObservatoryStore(versionDb)).toThrow(/user_version/);
  });

  test("fleet hosts CRUD with operatorLabel, platform, and collectorVersion", () => {
    const store = new ObservatoryStore(":memory:");

    const hostObs1: FleetHostObservation = {
      hostId: "host-alpha",
      operatorLabel: "prod-us-east-1",
      platform: "linux-x64",
      collectorVersion: "18.0.11",
      lastSeenAt: "2026-09-01T10:00:00.000Z",
      observedAt: "2026-09-01T10:00:00.000Z",
      status: "online",
      activeSessionsCount: 2,
      activeIdentitiesCount: 3,
    };

    const created = store.upsertHost(hostObs1);
    expect(created.hostId).toBe("host-alpha");
    expect(created.operatorLabel).toBe("prod-us-east-1");
    expect(created.platform).toBe("linux-x64");
    expect(created.collectorVersion).toBe("18.0.11");

    const fetched = store.getHost("host-alpha");
    expect(fetched).not.toBeNull();
    expect(fetched?.activeSessionsCount).toBe(2);
    // Update host (idempotent upsert)
    const hostObs2: FleetHostObservation = {
      hostId: "host-alpha",
      operatorLabel: "prod-us-east-1-updated",
      platform: "linux-x64",
      collectorVersion: "18.0.12",
      lastSeenAt: "2026-09-01T11:00:00.000Z",
      observedAt: "2026-09-01T11:00:00.000Z",
      status: "degraded",
      activeSessionsCount: 5,
      activeIdentitiesCount: 4,
    };
    store.upsertHost(hostObs2);
    const updated = store.getHost("host-alpha");
    expect(updated?.operatorLabel).toBe("prod-us-east-1-updated");
    expect(updated?.collectorVersion).toBe("18.0.12");
    expect(updated?.status).toBe("degraded");
    expect(updated?.activeSessionsCount).toBe(5);

    const list = store.listHosts({ status: "degraded" });
    expect(list.length).toBe(1);
    expect(list[0].hostId).toBe("host-alpha");

    const deleted = store.deleteHost("host-alpha");
    expect(deleted).toBe(true);
    expect(store.getHost("host-alpha")).toBeNull();
  });

  test("provider identities CRUD with credential/pool kind, provider, disabled, blocked, cooldown", () => {
    const store = new ObservatoryStore(":memory:");

    const identity: ProviderIdentityObservation = {
      identityId: "id-openai-01",
      kind: "credential",
      provider: "openai-codex",
      sourceHostId: "host-beta",
      sourceVersion: "18.0.11",
      label: "Synthetic Codex 01",
      observedAt: "2026-09-01T12:00:00.000Z",
      health: "healthy",
      disabled: false,
      blocked: false,
      cooldownUntilUtc: null,
      lastProbeAt: "2026-09-01T11:59:00.000Z",
      statusMessage: "Operational",
      activeModel: "gpt-4o",
      lastSuccessAt: "2026-09-01T11:59:00.000Z",
      consecutiveFailures: 0,
    };

    // Upserting identity auto-creates host if not exists
    const stored = store.upsertIdentity(identity);
    expect(stored.identityId).toBe("id-openai-01");
    expect(stored.kind).toBe("credential");
    expect(stored.provider).toBe("openai-codex");
    expect(stored.health).toBe("healthy");

    const host = store.getHost("host-beta");
    expect(host).not.toBeNull();

    const fetched = store.getIdentity("id-openai-01");
    expect(fetched?.label).toBe("Synthetic Codex 01");
    // Update disabled & cooldown
    store.upsertIdentity({
      ...identity,
      health: "rate_limited",
      disabled: true,
      blocked: true,
      cooldownUntilUtc: "2026-09-01T13:00:00.000Z",
      consecutiveFailures: 3,
    });

    const updated = store.getIdentity("id-openai-01");
    expect(updated?.health).toBe("rate_limited");
    expect(updated?.disabled).toBe(true);
    expect(updated?.blocked).toBe(true);
    expect(updated?.cooldownUntilUtc).toBe("2026-09-01T13:00:00.000Z");
    expect(updated?.consecutiveFailures).toBe(3);

    const limitedList = store.listIdentities({ health: "rate_limited" });
    expect(limitedList.length).toBe(1);
    expect(limitedList[0].identityId).toBe("id-openai-01");
  });

  test("quota observations with distinct bucketId vs windowId, multi-model isolation, and stale protection", () => {
    const store = new ObservatoryStore(":memory:");

    // Two observations for same identity sharing windowId="7d" but differing in bucket/model/tier
    const obsCodex: QuotaObservationInput = {
      identityId: "id-multi-quota",
      provider: "openai-codex",
      bucketId: "limit_codex_7d",
      windowId: "7d",
      windowDurationMs: 604800000,
      meter: "requests",
      model: "gpt-4o",
      tier: "tier_1",
      hostId: "host-quota",
      observedAt: "2026-09-01T13:00:00.000Z",
      resetsAt: "2026-09-08T13:00:00.000Z",
      usedFraction: 0.35,
      remainingFraction: 0.65,
      usedUnits: 350,
      totalUnits: 1000,
      remainingUnits: 650,
      resetCredits: 5,
      status: "ok",
    };

    const obsGpt35: QuotaObservationInput = {
      identityId: "id-multi-quota",
      provider: "openai-codex",
      bucketId: "limit_gpt35_7d",
      windowId: "7d",
      windowDurationMs: 604800000,
      meter: "requests",
      model: "gpt-3.5-turbo",
      tier: "free",
      hostId: "host-quota",
      observedAt: "2026-09-01T13:00:00.000Z",
      resetsAt: "2026-09-08T13:00:00.000Z",
      usedFraction: 0.90,
      remainingFraction: 0.10,
      usedUnits: 900,
      totalUnits: 1000,
      remainingUnits: 100,
      resetCredits: 0,
      status: "warning",
    };

    store.recordQuotaObservation(obsCodex);
    store.recordQuotaObservation(obsGpt35);

    // Current windows must NOT collide
    const winCodex = store.getCurrentQuotaWindow("id-multi-quota", "limit_codex_7d", "7d");
    expect(winCodex).not.toBeNull();
    expect(winCodex?.usedFraction).toBe(0.35);
    expect(winCodex?.model).toBe("gpt-4o");

    const winGpt35 = store.getCurrentQuotaWindow("id-multi-quota", "limit_gpt35_7d", "7d");
    expect(winGpt35).not.toBeNull();
    expect(winGpt35?.usedFraction).toBe(0.90);
    expect(winGpt35?.model).toBe("gpt-3.5-turbo");

    const allWindows = store.listCurrentQuotaWindows({ identityId: "id-multi-quota" });
    expect(allWindows.length).toBe(2);

    // Stale delivery protection: older observation arriving later must NOT regress current window
    const staleObs: QuotaObservationInput = {
      ...obsCodex,
      observedAt: "2026-09-01T12:00:00.000Z", // Older timestamp
      usedFraction: 0.10,
      remainingUnits: 900,
    };
    store.recordQuotaObservation(staleObs);

    const winAfterStale = store.getCurrentQuotaWindow("id-multi-quota", "limit_codex_7d", "7d");
    expect(winAfterStale?.usedFraction).toBe(0.35); // Retained newer 0.35!

    // History contains both
    const history = store.listQuotaObservations({ identityId: "id-multi-quota", bucketId: "limit_codex_7d" });
    expect(history.length).toBe(2);
  });

  test("quota tracker state persistence and hysteresis tracking", () => {
    const store = new ObservatoryStore(":memory:");

    const tracker: QuotaTrackerState = {
      trackerKey: "id-tracker-01:limit_5h:sliding_5h",
      identityId: "id-tracker-01",
      provider: "google",
      bucketId: "limit_5h",
      windowId: "sliding_5h",
      generation: 1,
      lastObservedAt: "2026-09-01T14:00:00.000Z",
      lastUsedFraction: 0.82,
      lastRemainingFraction: 0.18,
      lastResetCredits: 2,
      warningFired: true,
      criticalFired: false,
      exhaustedFired: false,
      warningArmEpoch: 1,
      criticalArmEpoch: 0,
      exhaustedArmEpoch: 0,
      creditChangeSequence: 0,
      consecutiveFailures: 0,
      failureAlertSent: false,
      lastResetAt: "2026-09-01T10:00:00.000Z",
      lastNotifiedResetAt: "2026-09-01T10:00:00.000Z",
    };

    const stored = store.upsertQuotaTracker(tracker);
    expect(stored.generation).toBe(1);
    expect(stored.warningFired).toBe(true);

    const fetched = store.getQuotaTracker("id-tracker-01:limit_5h:sliding_5h");
    expect(fetched?.warningFired).toBe(true);
    expect(fetched?.lastUsedFraction).toBe(0.82);

    // Update generation and alert flags
    store.upsertQuotaTracker({
      ...tracker,
      generation: 2,
      lastUsedFraction: 0.98,
      exhaustedFired: true,
      exhaustedArmEpoch: 1,
    });

    const updated = store.getQuotaTracker("id-tracker-01:limit_5h:sliding_5h");
    expect(updated?.generation).toBe(2);
    expect(updated?.exhaustedFired).toBe(true);
  });

  test("session summaries composite key (hostId, sessionId), tokens, costMicros, and status lifecycle", () => {
    const store = new ObservatoryStore(":memory:");

    const session: OmpSessionSummaryInput = {
      sessionId: "session-comp-01",
      hostId: "host-gamma",
      identityId: "id-claude-01",
      status: "active",
      startedAt: "2026-09-01T15:00:00.000Z",
      lastActiveAt: "2026-09-01T15:02:00.000Z",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
      inputTokens: 2000,
      outputTokens: 500,
      cacheReadTokens: 1500,
      cacheWriteTokens: 500,
      reasoningTokens: 200,
      totalTokens: 2500,
      costMicros: 45000,
      costEstimate: 0.045,
      costTrust: "exact",
      contextBps: 1024,
      toolCallsCount: 4,
      errorCount: 0,
      collectedAt: "2026-09-01T15:02:00.000Z",
      source: "omp-session",
      sourceVersion: "18.0.11",
    };

    const stored = store.upsertSessionSummary(session);
    expect(stored.sessionId).toBe("session-comp-01");
    expect(stored.cacheReadTokens).toBe(1500);
    expect(stored.costMicros).toBe(45000);
    expect(stored.status).toBe("active");

    const fetched = store.getSessionSummary("session-comp-01", "host-gamma");
    expect(fetched?.lastActiveAt).toBe("2026-09-01T15:02:00.000Z");
    // Close session
    store.upsertSessionSummary({
      ...session,
      status: "closed",
      closedAt: "2026-09-01T15:05:00.000Z",
      durationMs: 300000,
      totalTokens: 3200,
    });

    const closed = store.getSessionSummary("session-comp-01", "host-gamma");
    expect(closed?.status).toBe("closed");
    expect(closed?.closedAt).toBe("2026-09-01T15:05:00.000Z");
    expect(closed?.durationMs).toBe(300000);
  });

  test("event deduplication on unique fingerprint independent of occurredAt", () => {
    const store = new ObservatoryStore(":memory:");

    const eventCand: ObservatoryEventCandidate = {
      eventType: "quota_warning",
      severity: "warning",
      fingerprint: "unique-fp-quota-warning-123",
      hostId: "host-1",
      identityId: "id-1",
      occurredAt: "2026-09-01T16:00:00.000Z",
    };

    const res1 = store.recordEvent(eventCand);
    expect(res1.isDuplicate).toBe(false);
    expect(res1.event.eventId).toBeDefined();

    // Duplicate with a different timestamp but identical fingerprint must be detected as duplicate
    const res2 = store.recordEvent({
      ...eventCand,
      occurredAt: "2026-09-01T16:05:00.000Z",
    });
    expect(res2.isDuplicate).toBe(true);
    expect(res2.event.eventId).toBe(res1.event.eventId);

    const fetched = store.findRecentEventByFingerprint("unique-fp-quota-warning-123");
    expect(fetched).not.toBeNull();
    expect(fetched?.eventId).toBe(res1.event.eventId);
  });

  test("notification policies with scoped overrides, thresholds, quiet hours timezone, and critical bypass", () => {
    const store = new ObservatoryStore(":memory:");

    const policy: EffectiveNotificationPolicy = {
      policyId: "pol-prod-default",
      target: "default",
      enabled: true,
      silenced: false,
      telegramImmediate: true,
      dashboardOnly: false,
      minSeverity: "warning",
      thresholds: { warningFraction: 0.8, criticalFraction: 0.95 },
      consecutiveFailuresThreshold: 3,
      cooldownMinutes: 10,
      throttleIntervalMs: 30000,
      channels: ["telegram"],
      quietHoursEnabled: true,
      quietHoursTimezone: "America/New_York",
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      criticalBypassQuietHours: true,
      digestEnabled: true,
      digestSchedule: "daily@09:00",
      digestTimezone: "America/New_York",
      recipient: "@oncall_admin",
      matchEventTypes: ["quota_warning", "quota_exhausted"],
      matchHostIds: [],
      matchIdentityIds: [],
      updatedAt: "2026-09-01T10:00:00.000Z",
    };

    store.upsertPolicy(policy);
    const fetched = store.getPolicy("default");
    expect(fetched?.thresholds?.warningFraction).toBe(0.8);
    expect(fetched?.consecutiveFailuresThreshold).toBe(3);
    expect(fetched?.quietHoursTimezone).toBe("America/New_York");
    expect(fetched?.criticalBypassQuietHours).toBe(true);

    const resolved = store.resolveEffectivePolicy("unknown_scope");
    expect(resolved.minSeverity).toBe("warning");
    expect(resolved.recipient).toBe("@oncall_admin");
  });

  test("digest slot claim atomically persists event and monotonic watermark", () => {
    const store = new ObservatoryStore(":memory:");

    const first = store.claimDigestSlot(
      "provider:synthetic",
      "2026-09-01T10:00Z",
      "2026-09-01T10:00:00.000Z",
    );
    expect(first.claimed).toBe(true);
    expect(first.eventId).toBeTruthy();
    expect(store.getEvent(first.eventId!)).not.toBeNull();
    expect(store.getDigestWatermark("provider:synthetic")?.watermarkEventId).toBe(first.eventId);

    // Concurrent/equivalent claimant loses to the durable fingerprint and watermark.
    const duplicate = store.claimDigestSlot(
      "provider:synthetic",
      "2026-09-01T10:00Z",
      "2026-09-01T10:00:00.000Z",
    );
    expect(duplicate.claimed).toBe(false);

    // Older slot can never rewind the watermark.
    const older = store.claimDigestSlot(
      "provider:synthetic",
      "2026-09-01T09:00Z",
      "2026-09-01T09:00:00.000Z",
    );
    expect(older.claimed).toBe(false);
    expect(store.getDigestWatermark("provider:synthetic")?.lastSlotKey).toBe("2026-09-01T10:00Z");

    // Outer transaction rollback removes both digest event and watermark together.
    expect(() =>
      store.withTransaction(() => {
        const claimed = store.claimDigestSlot(
          "provider:rollback",
          "2026-09-01T11:00Z",
          "2026-09-01T11:00:00.000Z",
        );
        expect(claimed.claimed).toBe(true);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(store.getDigestWatermark("provider:rollback")).toBeNull();
    expect(store.listEvents({ eventType: "digest_ready" })).toHaveLength(1);
  });

  test("notification deliveries outbox CAS lease state machine and error categories", () => {
    const store = new ObservatoryStore(":memory:");

    const ev = store.recordEvent({
      eventType: "quota_exhausted",
      severity: "critical",
      fingerprint: "fp-del-lease-test",
      occurredAt: "2026-09-01T17:00:00.000Z",
    });

    const deliveryRes = store.recordDeliveryAttempt({
      eventId: ev.event.eventId,
      channel: "telegram",
      status: "pending",
      fingerprint: "fp-del-lease-test",
    });
    expect(deliveryRes.isDuplicate).toBe(false);
    const deliveryId = deliveryRes.delivery.deliveryId;

    const passStart = new Date().toISOString();
    // Worker 1 claims lease
    const lease = store.claimDeliveryLease("telegram", 30000, 3, passStart);
    expect(lease).not.toBeNull();
    expect(lease?.deliveryId).toBe(deliveryId);
    expect(lease?.status).toBe("sending");
    expect(lease?.attemptCount).toBe(1);
    expect(lease?.leaseToken).toBeTruthy();

    // Competing worker cannot claim while lease is active
    const competingLease = store.claimDeliveryLease("telegram", 30000, 3, passStart);
    expect(competingLease).toBeNull();

    // Mark failed with retryable network error
    const failed = store.markDeliveryFailed(deliveryId, lease!.leaseToken!, {
      errorCategory: "network",
      retryable: true,
    });
    expect(failed).toBe(true);

    const afterFail = store.getDelivery(deliveryId);
    expect(afterFail?.status).toBe("failed");
    expect(afterFail?.errorCategory).toBe("network");

    // Same processing pass cannot immediately reclaim a newly failed row.
    expect(store.claimDeliveryLease("telegram", 30000, 3, passStart)).toBeNull();

    // A later pass can claim it with a fresh lease token.
    const retryLease = store.claimDeliveryLease("telegram", 30000, 3);
    expect(retryLease?.deliveryId).toBe(deliveryId);
    expect(retryLease?.attemptCount).toBe(2);
    expect(retryLease?.leaseToken).not.toBe(lease?.leaseToken);

    // Expired/stale worker token cannot finalize the newer lease.
    expect(store.markDeliverySent(deliveryId, lease!.leaseToken!)).toBe(false);

    // Current lease owner marks sent successfully.
    const sent = store.markDeliverySent(deliveryId, retryLease!.leaseToken!, {
      sentAt: "2026-09-01T17:01:00.000Z",
      providerMessageId: "tg_msg_98765",
    });
    expect(sent).toBe(true);

    const finalDelivery = store.getDelivery(deliveryId);
    expect(finalDelivery?.status).toBe("sent");
    expect(finalDelivery?.providerMessageId).toBe("tg_msg_98765");
  });

  test("nonce atomic claim with strict TTL and server time comparison", () => {
    const store = new ObservatoryStore(":memory:");
    const claimedAt = new Date(Date.now() + 2 * 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 12 * 60_000).toISOString();

    const claim1 = store.claimNonce({
      nonce: "nonce-atomic-1001",
      scope: "quota-ingest",
      hostId: "host-1",
      claimedAt,
      expiresAt,
    });
    expect(claim1.claimed).toBe(true);

    // Replay claim before expiration must be rejected
    const claim2 = store.claimNonce({
      nonce: "nonce-atomic-1001",
      scope: "quota-ingest",
      hostId: "host-1",
      claimedAt: new Date(Date.now() + 7 * 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 17 * 60_000).toISOString(),
    });
    expect(claim2.claimed).toBe(false);

    // Invalid nonces: expiresAt <= claimedAt
    expect(() => {
      store.claimNonce({
        nonce: "nonce-bad-ttl",
        scope: "quota-ingest",
        claimedAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    }).toThrow(ValidationError);

    // Excessive TTL (> 24 hours)
    expect(() => {
      store.claimNonce({
        nonce: "nonce-bad-long-ttl",
        scope: "quota-ingest",
        claimedAt: "2026-09-01T18:00:00.000Z",
        expiresAt: "2026-09-03T18:00:00.000Z",
      });
    }).toThrow(ValidationError);
  });

  test("import ledger atomic claim and immutability for completed batches", () => {
    const store = new ObservatoryStore(":memory:");

    const batch: ImportLedgerEntry = {
      batchId: "batch-import-001",
      source: "legacy-sqlite",
      importedAt: "2026-09-01T19:00:00.000Z",
      recordCount: 250,
      status: "completed",
    };

    const stored = store.recordImportBatch(batch);
    expect(stored.status).toBe("completed");

    // Attempting to overwrite a completed batch with 'pending' must be rejected (completed is immutable)
    const replay = store.recordImportBatch({
      ...batch,
      status: "pending",
      recordCount: 999,
    });
    expect(replay.status).toBe("completed");
    expect(replay.recordCount).toBe(250);
  });
  test("collector batches ledger atomic claim with new, duplicate, conflict, and 72h retention", () => {
    const store = new ObservatoryStore(":memory:");

    const hash1 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const hash2 = "ca978112ca1bbdcafac231b39a23dc4da7860819c1966c820985c6c2e51486fb";

    // 1. New batch claim
    const claimNew = store.claimCollectorBatch({
      hostId: "host-collector-01",
      batchId: "batch-101",
      bodySha256: hash1,
      keyId: "key-v1",
      receivedAt: "2026-09-01T10:00:00.000Z",
      status: "accepted",
    });
    expect(claimNew.outcome).toBe("new");
    expect(claimNew.batch.batchId).toBe("batch-101");
    expect(claimNew.batch.bodySha256).toBe(hash1);

    // 2. Duplicate batch claim (same host, same batchId, same bodySha256 & keyId)
    const claimDup = store.claimCollectorBatch({
      hostId: "host-collector-01",
      batchId: "batch-101",
      bodySha256: hash1,
      keyId: "key-v1",
      receivedAt: "2026-09-01T10:01:00.000Z",
      status: "accepted",
    });
    expect(claimDup.outcome).toBe("duplicate");
    expect(claimDup.batch.bodySha256).toBe(hash1);

    // 3. Conflict batch claim (same host, same batchId, but DIFFERENT bodySha256)
    const claimConflict = store.claimCollectorBatch({
      hostId: "host-collector-01",
      batchId: "batch-101",
      bodySha256: hash2,
      keyId: "key-v1",
      receivedAt: "2026-09-01T10:02:00.000Z",
      status: "accepted",
    });
    expect(claimConflict.outcome).toBe("conflict");
    expect(claimConflict.batch.bodySha256).toBe(hash1); // Retained original batch

    // 4. Query batch
    const fetched = store.getCollectorBatch("host-collector-01", "batch-101");
    expect(fetched).not.toBeNull();
    expect(fetched?.keyId).toBe("key-v1");

    // 5. 72h retention pruning (older than cutoff)
    store.claimCollectorBatch({
      hostId: "host-collector-01",
      batchId: "batch-old-72h",
      bodySha256: hash1,
      keyId: "key-v1",
      receivedAt: "2026-08-20T00:00:00.000Z",
      status: "accepted",
    });

    const pruneRes = store.pruneRetention({
      collectorBatchesOlderThan: "2026-08-25T00:00:00.000Z",
    });
    expect(pruneRes.collectorBatchesDeleted).toBe(1);
    expect(store.getCollectorBatch("host-collector-01", "batch-old-72h")).toBeNull();
    expect(store.getCollectorBatch("host-collector-01", "batch-101")).not.toBeNull();
  });


  test("AgentRouter entities CRUD, check runs referential integrity, and RETURNING row on conflict", () => {
    const store = new ObservatoryStore(":memory:");

    const acct: ObservatoryAgentRouterAccount = {
      accountId: "acct-ar-01",
      accountLabel: "Synthetic AgentRouter Account",
    };
    store.upsertAgentRouterAccount(acct);

    const run: ObservatoryAgentRouterRun = {
      id: 501,
      accountId: "acct-ar-01",
      accountLabel: "Synthetic AgentRouter Account",
      startedAt: "2026-09-01T19:00:00.000Z",
      endedAt: "2026-09-01T19:01:00.000Z",
      status: "ok",
      loginMs: 250,
      dashboardMs: 400,
      totalMs: 650,
      loggedOut: false,
      sessionReused: true,
      balance: 100.5,
      consumed: 25.2,
      requestCount: 42,
    };
    const storedRun = store.recordAgentRouterRun(run);
    expect(storedRun.id).toBe(501);

    // Balance observation referencing check run
    const balObs: ObservatoryAgentRouterBalanceObservation = {
      runId: 501,
      accountId: "acct-ar-01",
      observedAt: "2026-09-01T19:01:00.000Z",
      balance: 100.5,
      consumed: 25.2,
      classification: "usage",
    };
    const storedBal = store.recordAgentRouterBalanceObservation(balObs);
    expect(storedBal.runId).toBe(501);

    // Grant event referencing check run
    const grant: ObservatoryAgentRouterGrantEvent = {
      runId: 501,
      accountId: "acct-ar-01",
      sourceEventId: "grant-evt-777",
      occurredAt: "2026-09-01T19:00:30.000Z",
      amount: 10.0,
      classification: "daily-signin",
    };
    const storedGrant = store.recordAgentRouterGrantEvent(grant);
    expect(storedGrant.sourceEventId).toBe("grant-evt-777");

    // Conflict upsert on grant returns same immutable row
    const updatedGrant = store.recordAgentRouterGrantEvent(grant);
    expect(updatedGrant.id).toBe(storedGrant.id);

    // Usage points
    const up: ObservatoryAgentRouterUsagePoint = {
      accountId: "acct-ar-01",
      granularity: "hour",
      createdAtTs: 1788280000,
      modelName: "gpt-4o",
      requestCount: 15,
      tokenUsed: 2500,
      quota: 50.0,
    };
    const storedUp = store.recordAgentRouterUsagePoint(up);
    expect(storedUp.modelName).toBe("gpt-4o");
  });

  test("retention pruning: closed sessions deleted after cutoff while active sessions are strictly preserved", () => {
    const store = new ObservatoryStore(":memory:");

    // 1. Old closed session
    store.upsertSessionSummary({
      sessionId: "session-old-closed",
      hostId: "host-ret",
      status: "closed",
      startedAt: "2026-05-01T00:00:00.000Z",
      closedAt: "2026-05-01T01:00:00.000Z",
    });

    // 2. Old active session (must NOT be pruned)
    store.upsertSessionSummary({
      sessionId: "session-old-active",
      hostId: "host-ret",
      status: "active",
      startedAt: "2026-05-01T00:00:00.000Z",
      closedAt: null,
    });

    // 3. New closed session
    store.upsertSessionSummary({
      sessionId: "session-new-closed",
      hostId: "host-ret",
      status: "closed",
      startedAt: "2026-09-01T00:00:00.000Z",
      closedAt: "2026-09-01T01:00:00.000Z",
    });

    // 4. Old AR usage point
    store.recordAgentRouterUsagePoint({
      accountId: "acct-ret-01",
      granularity: "day",
      createdAtTs: Math.floor(Date.parse("2026-05-01T00:00:00.000Z") / 1000),
      modelName: "gpt-4o",
      requestCount: 10,
      tokenUsed: 1000,
      quota: 20.0,
    });

    const pruneRes = store.pruneRetention({
      sessionsOlderThan: "2026-08-01T00:00:00.000Z",
      agentrouterUsageOlderThan: "2026-08-01T00:00:00.000Z",
    });

    expect(pruneRes.sessionsDeleted).toBe(1);
    expect(pruneRes.agentrouterUsageDeleted).toBe(1);

    // Active session and new closed session remain
    expect(store.getSessionSummary("session-old-active", "host-ret")).not.toBeNull();
    expect(store.getSessionSummary("session-new-closed", "host-ret")).not.toBeNull();
    expect(store.getSessionSummary("session-old-closed", "host-ret")).toBeNull();
  });

  test("safe export with pagination, total count, truncation metadata, and legacy table isolation", () => {
    const legacyDb = new Database(":memory:", { strict: true });

    // Legacy table setup
    legacyDb.exec(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        account_label TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO runs (account_id, account_label, started_at, ended_at, status)
      VALUES ('legacy-acct-1', 'Legacy Account', '2026-08-01T00:00:00.000Z', '2026-08-01T00:01:00.000Z', 'ok');
    `);

    expect(() => new ObservatoryStore(legacyDb)).toThrow(/dedicated/);
    expect(
      legacyDb.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all(),
    ).toEqual([{ name: "runs" }]);

    const store = new ObservatoryStore(":memory:");

    store.upsertHost({
      hostId: "host-export-01",
      operatorLabel: "prod-node",
      observedAt: "2026-09-01T12:00:00.000Z",
      status: "online",
    });

    store.upsertIdentity({
      identityId: "id-export-01",
      kind: "credential",
      provider: "anthropic",
      sourceHostId: "host-export-01",
      label: "Claude Export",
      observedAt: "2026-09-01T12:00:00.000Z",
      health: "healthy",
    });

    const exportData = store.exportData({ limit: 10 });
    expect(exportData.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(exportData.totalRecords).toBeGreaterThan(0);
    expect(exportData.truncated).toBe(false);
    expect(exportData.hosts.length).toBe(1);

    // Delete all observatory data
    store.deleteAllObservatoryData();
    expect(store.listHosts().length).toBe(0);
    expect(store.listIdentities().length).toBe(0);

    // Verify legacy table is completely intact
    const legacyRows = legacyDb.query("SELECT * FROM runs").all();
    expect(legacyRows.length).toBe(1);
    expect((legacyRows[0] as Record<string, unknown>).account_id).toBe("legacy-acct-1");
  });

  test("validation errors on invalid inputs, fractional counts, path injection, and forbidden content", () => {
    const store = new ObservatoryStore(":memory:");

    // Invalid fraction (> 1)
    expect(() => {
      store.recordQuotaObservation({
        identityId: "id-bad",
        provider: "google",
        windowId: "window-1",
        observedAt: "2026-09-01T12:00:00.000Z",
        usedFraction: 1.5,
      });
    }).toThrow(ValidationError);

    // Invalid timestamp
    expect(() => {
      store.upsertHost({
        hostId: "host-bad",
        observedAt: "invalid-timestamp",
        status: "online",
      });
    }).toThrow(ValidationError);

    // Path traversal in ID
    expect(() => {
      store.upsertHost({
        hostId: "../../etc/passwd",
        observedAt: "2026-09-01T12:00:00.000Z",
        status: "online",
      });
    }).toThrow(ValidationError);

    // Windows absolute path in ID
    expect(() => {
      store.upsertHost({
        hostId: "C:\\Windows\\System32",
        observedAt: "2026-09-01T12:00:00.000Z",
        status: "online",
      });
    }).toThrow(ValidationError);

    // Forbidden credential in identity label
    expect(() => {
      store.upsertIdentity({
        identityId: "id-bad-label-key",
        kind: "credential",
        provider: "generic",
        sourceHostId: "host-1",
        label: "sk-1234567890abcdef123456",
        observedAt: "2026-09-01T12:00:00.000Z",
        health: "healthy",
      });
    }).toThrow(ValidationError);

    // Fractional integer count
    expect(() => {
      store.recordAgentRouterRun({
        id: 1.5 as number,
        accountId: "acct-1",
        accountLabel: "Acct",
        startedAt: "2026-09-01T10:00:00.000Z",
        endedAt: "2026-09-01T10:01:00.000Z",
        status: "ok",
        loginMs: 100,
        dashboardMs: 100,
        totalMs: 200,
        loggedOut: false,
        sessionReused: false,
      });
    }).toThrow(ValidationError);
  });
});
