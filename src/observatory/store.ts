/**
 * AI Fleet Observatory - SQLite Store Implementation
 *
 * Provides transactional, idempotent persistence for fleet hosts, provider identities,
 * quota observations, current windows, trackers, sessions, events, policies, deliveries,
 * nonces, audit records, import ledger, collector batches, digest watermarks,
 * and AgentRouter observatory entities.
 *
 * Implements schema versioning, retention pruning, replay protection, deduplication,
 * and safe export/deletion without touching legacy tables.
 */

import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type {
  AgentRouterTrackerState,
  CollectorBatchClaimInput,
  CollectorBatchClaimResult,
  CurrentQuotaWindow,
  DailyQuotaRollup,
  DailyQuotaRollupInput,
  DeliveryStatus,
  DigestWatermarkRecord,
  EffectiveNotificationPolicy,
  EffectivePolicyResolution,
  EventSeverity,
  ExportPaginationOptions,
  FleetHostObservation,
  HostTrackerState,
  ImportLedgerEntry,
  LegacyImportSnapshotInput,
  LegacyImportSnapshotResult,
  LegacyProjectedRow,
  StoredLegacyImportItem,
  NonceClaimInput,
  NotificationDeliveryRecord,
  NotificationPolicyRule,
  ObservatoryAgentRouterAccount,
  ObservatoryAgentRouterBalanceObservation,
  ObservatoryAgentRouterEndpointObservation,
  ObservatoryAgentRouterGrantEvent,
  ObservatoryAgentRouterRun,
  ObservatoryAgentRouterUsagePoint,
  ObservatoryAuditEntry,
  ObservatoryEventCandidate,
  ObservatoryEventType,
  ObservatoryExportData,
  OmpSessionSummaryInput,
  ProviderHealth,
  ProviderIdentityKind,
  ProviderIdentityObservation,
  ProviderTrackerState,
  QuotaObservationInput,
  QuotaTrackerState,
  RetentionPruneFilter,
  RetentionPruneResult,
  SchemaMigrationEntry,
  SessionTrackerState,
  StoredAgentRouterAccount,
  StoredAgentRouterBalanceObservation,
  StoredAgentRouterEndpointObservation,
  StoredAgentRouterGrantEvent,
  StoredAgentRouterRun,
  StoredAgentRouterTracker,
  StoredAgentRouterUsagePoint,
  StoredAuditEntry,
  StoredCollectorBatch,
  StoredFleetHost,
  StoredHostTracker,
  StoredImportLedgerEntry,
  StoredNonce,
  StoredNotificationDelivery,
  StoredNotificationPolicy,
  StoredObservatoryEvent,
  StoredProviderIdentity,
  StoredProviderTracker,
  StoredQuotaObservation,
  StoredQuotaTracker,
  StoredSessionSummary,
  StoredSessionTracker,
} from "./types";
import {
  validateAgentRouterTrackerState,
  validateAuditEntryInput,
  validateCollectorBatchClaimInput,
  validateEffectiveNotificationPolicy,
  validateDailyQuotaRollupInput,
  validateFleetHostObservation,
  validateHostTrackerState,
  validateImportLedgerEntry,
  validateIsoUtcTimestamp,
  validateNonceClaimInput,
  validateNotificationDeliveryRecord,
  validateObservatoryAgentRouterAccount,
  validateObservatoryAgentRouterBalanceObservation,
  validateObservatoryAgentRouterEndpointObservation,
  validateObservatoryAgentRouterGrantEvent,
  validateObservatoryAgentRouterRun,
  validateObservatoryAgentRouterUsagePoint,
  validateObservatoryEventCandidate,
  validateOmpSessionSummaryInput,
  validateOpaqueId,
  validatePagination,
  validateProviderIdentityObservation,
  validateProviderTrackerState,
  validateQuotaObservationInput,
  validateQuotaTrackerState,
  validateSafeString,
  validateSessionTrackerState,
  validateUtcDay,
} from "./validation";

export const CURRENT_SCHEMA_VERSION = 6;

const OBSERVATORY_APP_VERSION = "ai-fleet-observatory/1";
const LEGACY_TABLE_NAMES: Record<string, true> = {
  runs: true,
  accounts: true,
  account_balances: true,
  account_grants: true,
  endpoints: true,
  usage_points: true,
  checks: true,
};
const INITIAL_SCHEMA_DESCRIPTION =
  "Initial Observatory schema: hosts, identities, quota, trackers, sessions, events, policies, deliveries, nonces, audit, ledger, collector batches, and agentrouter entities";

interface SchemaMigrationDefinition {
  version: number;
  name: string;
  description: string;
  checksum: string;
  apply: (store: ObservatoryStore) => void;
}

function parseJsonSafe<T>(jsonStr: string | null | undefined, fallback: T): T {
  if (!jsonStr) return fallback;
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

export class ObservatoryStore {
  private readonly db: Database;
  private readonly ownsDb: boolean;

  constructor(dbOrPath: Database | string, options?: { autoMigrate?: boolean }) {
    if (typeof dbOrPath === "string") {
      this.db = new Database(dbOrPath, { create: true, strict: true });
      this.ownsDb = true;
    } else {
      this.db = dbOrPath;
      this.ownsDb = false;
    }

    this.configurePragmas();

    if (options?.autoMigrate !== false) {
      this.migrate();
    }
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }

  withTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private configurePragmas(): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (this.db.filename !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
  }

  // ==========================================
  // Schema Migration & Version Ledger
  // ==========================================

  getSchemaVersion(): number {
    return this.getMigrationLedger().length;
  }

  getMigrationLedger(): SchemaMigrationEntry[] {
    if (!this.hasMigrationLedger()) {
      return [];
    }
    return this.db
      .query<{
        version: number;
        name: string;
        checksum: string;
        applied_at: string;
        app_version: string;
        description: string;
      }, []>(
        "SELECT version, name, checksum, applied_at, app_version, description FROM observatory_schema_migrations ORDER BY version ASC",
      )
      .all()
      .map((row) => ({
        version: row.version,
        name: row.name,
        checksum: row.checksum,
        appliedAt: row.applied_at,
        appVersion: row.app_version,
        description: row.description,
      }));
  }

  migrate(): void {
    this.db.transaction(() => {
      this.assertDedicatedObservatoryDatabase();
      this.createMigrationLedger();
      const migrations = this.getMigrationDefinitions();
      const applied = this.getMigrationLedger();
      this.validateMigrationState(applied, migrations);

      for (let index = applied.length; index < migrations.length; index += 1) {
        const migration = migrations[index];
        migration.apply(this);
        this.recordMigration(migration);
        this.db.exec(`PRAGMA user_version = ${migration.version};`);
      }
    })();
  }

  private hasMigrationLedger(): boolean {
    return Boolean(
      this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'observatory_schema_migrations'").get(),
    );
  }

  private assertDedicatedObservatoryDatabase(): void {
    const tables = this.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
      )
      .all()
      .map((row) => row.name);
    const legacyTable = tables.find((name) => LEGACY_TABLE_NAMES[name]);
    if (legacyTable) {
      throw new Error(
        `Observatory database must be dedicated; refusing schema migration beside legacy table '${legacyTable}'.`,
      );
    }
    const hasLedger = tables.includes("observatory_schema_migrations");
    if (!hasLedger && tables.length > 0) {
      throw new Error("Observatory database must be empty before its first migration.");
    }
    if (hasLedger && tables.some((name) => !name.startsWith("observatory_"))) {
      throw new Error("Observatory database contains a non-Observatory table and cannot be migrated safely.");
    }
  }

  private createMigrationLedger(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observatory_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        app_version TEXT NOT NULL,
        description TEXT NOT NULL
      );
    `);
  }

  private getMigrationDefinitions(): SchemaMigrationDefinition[] {
    const createDefinition = (
      version: number,
      name: string,
      description: string,
      apply: (store: ObservatoryStore) => void,
    ): SchemaMigrationDefinition => ({
      version,
      name,
      description,
      checksum: createHash("sha256").update(`${version}\0${name}\0${description}`).digest("hex"),
      apply,
    });
    return [
      createDefinition(1, "001_foundation", INITIAL_SCHEMA_DESCRIPTION, (store) => store.applySchemaV1()),
      createDefinition(2, "002_quota", "Reserve immutable quota migration boundary.", () => {}),
      createDefinition(3, "003_sessions", "Reserve immutable session migration boundary.", () => {}),
      createDefinition(4, "004_agentrouter", "Reserve immutable AgentRouter migration boundary.", () => {}),
      createDefinition(5, "005_policy_events", "Reserve immutable policy and event migration boundary.", () => {}),
      createDefinition(6, "006_import", "Reserve immutable legacy import migration boundary.", () => {}),
    ];
  }

  private validateMigrationState(
    applied: SchemaMigrationEntry[],
    migrations: SchemaMigrationDefinition[],
  ): void {
    if (applied.length > migrations.length) {
      throw new Error("Database schema version is newer than this binary supports.");
    }
    const userVersion = this.db.query<{ user_version: number }, []>("PRAGMA user_version;").get()?.user_version ?? 0;
    if (userVersion !== applied.length) {
      throw new Error("Database PRAGMA user_version does not match the Observatory migration ledger.");
    }
    for (let index = 0; index < applied.length; index += 1) {
      const expected = migrations[index];
      const actual = applied[index];
      if (
        actual.version !== expected.version ||
        actual.name !== expected.name ||
        actual.checksum !== expected.checksum ||
        actual.appVersion !== OBSERVATORY_APP_VERSION ||
        actual.description !== expected.description
      ) {
        throw new Error(`Observatory migration ledger drift at version ${index + 1}.`);
      }
    }
  }

  private recordMigration(migration: SchemaMigrationDefinition): void {
    this.db
      .query(
        "INSERT INTO observatory_schema_migrations (version, name, checksum, applied_at, app_version, description) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
        OBSERVATORY_APP_VERSION,
        migration.description,
      );
  }

  private applySchemaV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observatory_hosts (
        host_id TEXT PRIMARY KEY,
        operator_label TEXT NOT NULL,
        platform TEXT NOT NULL,
        collector_version TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        status TEXT NOT NULL,
        active_sessions_count INTEGER NOT NULL DEFAULT 0,
        active_identities_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observatory_identities (
        identity_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_host_id TEXT NOT NULL,
        source_version TEXT,
        label TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        health TEXT NOT NULL CHECK(health IN ('healthy', 'degraded', 'unhealthy', 'rate_limited', 'exhausted', 'unknown')),
        disabled INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        cooldown_until_utc TEXT,
        last_probe_at TEXT,
        status_code TEXT,
        active_model TEXT,
        last_success_at TEXT,
        last_failure_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_host_id) REFERENCES observatory_hosts(host_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_identities_host ON observatory_identities(source_host_id);
      CREATE INDEX IF NOT EXISTS idx_observatory_identities_provider ON observatory_identities(provider);
      CREATE INDEX IF NOT EXISTS idx_observatory_identities_kind ON observatory_identities(kind);
      CREATE INDEX IF NOT EXISTS idx_observatory_identities_health ON observatory_identities(health);

      CREATE TABLE IF NOT EXISTS observatory_quota_current_windows (
        identity_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        bucket_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        window_duration_ms INTEGER,
        meter TEXT,
        model TEXT,
        tier TEXT,
        host_id TEXT,
        last_fetched_at TEXT,
        last_observed_at TEXT NOT NULL,
        resets_at TEXT,
        reset_label TEXT,
        used_fraction REAL NOT NULL CHECK(used_fraction >= 0.0 AND used_fraction <= 1.0),
        remaining_fraction REAL CHECK(remaining_fraction IS NULL OR (remaining_fraction >= 0.0 AND remaining_fraction <= 1.0)),
        used_units REAL,
        total_units REAL,
        remaining_units REAL,
        reset_credits REAL,
        unit TEXT,
        status TEXT NOT NULL DEFAULT 'ok',
        error_category TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        source_version TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (identity_id, bucket_id, window_id),
        FOREIGN KEY (identity_id) REFERENCES observatory_identities(identity_id)
      );

      CREATE TABLE IF NOT EXISTS observatory_quota_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identity_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        bucket_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        window_duration_ms INTEGER,
        meter TEXT,
        model TEXT,
        tier TEXT,
        host_id TEXT,
        fetched_at TEXT,
        observed_at TEXT NOT NULL,
        resets_at TEXT,
        reset_label TEXT,
        used_fraction REAL NOT NULL CHECK(used_fraction >= 0.0 AND used_fraction <= 1.0),
        remaining_fraction REAL CHECK(remaining_fraction IS NULL OR (remaining_fraction >= 0.0 AND remaining_fraction <= 1.0)),
        used_units REAL,
        total_units REAL,
        remaining_units REAL,
        reset_credits REAL,
        unit TEXT,
        status TEXT,
        error_category TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        source TEXT,
        source_version TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (identity_id) REFERENCES observatory_identities(identity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_quota_obs_identity ON observatory_quota_observations(identity_id, observed_at);
      CREATE INDEX IF NOT EXISTS idx_observatory_quota_obs_window ON observatory_quota_observations(identity_id, bucket_id, window_id, observed_at);
      CREATE INDEX IF NOT EXISTS idx_observatory_quota_obs_observed_at ON observatory_quota_observations(observed_at);

      CREATE TABLE IF NOT EXISTS observatory_daily_quota_rollups (
        rollup_id INTEGER PRIMARY KEY AUTOINCREMENT,
        day_utc TEXT NOT NULL,
        identity_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        bucket_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        meter TEXT,
        model TEXT,
        tier TEXT,
        observation_count INTEGER NOT NULL,
        min_used_fraction REAL NOT NULL,
        max_used_fraction REAL NOT NULL,
        avg_used_fraction REAL NOT NULL,
        min_remaining_fraction REAL,
        max_remaining_fraction REAL,
        avg_remaining_fraction REAL,
        min_reset_credits REAL,
        max_reset_credits REAL,
        first_observed_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        finalized_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (day_utc, identity_id, bucket_id, window_id),
        FOREIGN KEY (identity_id) REFERENCES observatory_identities(identity_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_daily_rollups_day ON observatory_daily_quota_rollups(day_utc);
      CREATE INDEX IF NOT EXISTS idx_observatory_daily_rollups_target ON observatory_daily_quota_rollups(identity_id, bucket_id, window_id, day_utc);

      CREATE TABLE IF NOT EXISTS observatory_quota_trackers (
        tracker_key TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        bucket_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        last_observed_at TEXT NOT NULL,
        last_used_fraction REAL NOT NULL DEFAULT 0.0,
        last_remaining_fraction REAL,
        last_reset_credits REAL,
        warning_fired INTEGER NOT NULL DEFAULT 0,
        critical_fired INTEGER NOT NULL DEFAULT 0,
        exhausted_fired INTEGER NOT NULL DEFAULT 0,
        warning_arm_epoch INTEGER NOT NULL DEFAULT 0,
        critical_arm_epoch INTEGER NOT NULL DEFAULT 0,
        exhausted_arm_epoch INTEGER NOT NULL DEFAULT 0,
        credit_change_sequence INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        failure_alert_sent INTEGER NOT NULL DEFAULT 0,
        last_reset_at TEXT,
        last_notified_reset_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (identity_id) REFERENCES observatory_identities(identity_id)
      );

      CREATE TABLE IF NOT EXISTS observatory_provider_trackers (
        tracker_key TEXT PRIMARY KEY,
        identity_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        source_host_id TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        health TEXT NOT NULL,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_blocked INTEGER NOT NULL DEFAULT 0,
        consecutive_disabled INTEGER NOT NULL DEFAULT 0,
        down_incident_active INTEGER NOT NULL DEFAULT 0,
        blocked_incident_active INTEGER NOT NULL DEFAULT 0,
        disabled_incident_active INTEGER NOT NULL DEFAULT 0,
        cooldown_incident_active INTEGER NOT NULL DEFAULT 0,
        collector_failure_active INTEGER NOT NULL DEFAULT 0,
        incident_epoch INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (identity_id) REFERENCES observatory_identities(identity_id)
      );

      CREATE TABLE IF NOT EXISTS observatory_host_trackers (
        tracker_key TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        status TEXT NOT NULL,
        offline_since TEXT,
        offline_alert_sent INTEGER NOT NULL DEFAULT 0,
        offline_incident_epoch INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (host_id) REFERENCES observatory_hosts(host_id)
      );

      CREATE TABLE IF NOT EXISTS observatory_session_trackers (
        tracker_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        identity_id TEXT,
        last_observed_at TEXT NOT NULL,
        last_context_bps INTEGER,
        context_warning_fired INTEGER NOT NULL DEFAULT 0,
        context_critical_fired INTEGER NOT NULL DEFAULT 0,
        context_arm_epoch INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (host_id) REFERENCES observatory_hosts(host_id)
      );

      CREATE TABLE IF NOT EXISTS observatory_agentrouter_trackers (
        tracker_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        last_observed_at TEXT NOT NULL,
        last_balance REAL,
        low_balance_fired INTEGER NOT NULL DEFAULT 0,
        low_balance_arm_epoch INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES observatory_agentrouter_accounts(account_id)
      );

      CREATE TABLE IF NOT EXISTS observatory_sessions (
        session_id TEXT NOT NULL,
        host_id TEXT NOT NULL,
        identity_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_active_at TEXT,
        closed_at TEXT,
        ended_at TEXT,
        model TEXT,
        provider TEXT,
        duration_ms INTEGER,
        input_tokens INTEGER,
        prompt_tokens INTEGER,
        output_tokens INTEGER,
        completion_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        cost_micros INTEGER,
        cost_estimate REAL,
        cost_trust TEXT CHECK(cost_trust IS NULL OR cost_trust IN ('exact', 'estimated', 'unknown')),
        context_bps INTEGER,
        tool_calls_count INTEGER,
        error_count INTEGER,
        exit_code INTEGER,
        collected_at TEXT,
        source TEXT,
        source_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (host_id, session_id),
        FOREIGN KEY (host_id) REFERENCES observatory_hosts(host_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_sessions_started_at ON observatory_sessions(started_at);
      CREATE INDEX IF NOT EXISTS idx_observatory_sessions_closed_at ON observatory_sessions(closed_at);
      CREATE INDEX IF NOT EXISTS idx_observatory_sessions_status ON observatory_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_observatory_sessions_identity ON observatory_sessions(identity_id);

      CREATE TABLE IF NOT EXISTS observatory_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'error', 'critical')),
        fingerprint TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        host_id TEXT,
        identity_id TEXT,
        session_id TEXT,
        provider TEXT,
        identity_kind TEXT,
        account_id TEXT,
        bucket_id TEXT,
        window_id TEXT,
        meter TEXT,
        model TEXT,
        tier TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_events_fingerprint ON observatory_events(fingerprint);
      CREATE INDEX IF NOT EXISTS idx_observatory_events_occurred_at ON observatory_events(occurred_at);
      CREATE INDEX IF NOT EXISTS idx_observatory_events_type ON observatory_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_observatory_events_severity ON observatory_events(severity);

      CREATE TABLE IF NOT EXISTS observatory_notification_policies (
        policy_id TEXT PRIMARY KEY,
        target TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        silenced INTEGER NOT NULL DEFAULT 0,
        telegram_immediate INTEGER NOT NULL DEFAULT 1,
        dashboard_only INTEGER NOT NULL DEFAULT 0,
        min_severity TEXT NOT NULL DEFAULT 'info' CHECK(min_severity IN ('info', 'warning', 'error', 'critical')),
        thresholds_json TEXT,
        consecutive_failures_threshold INTEGER,
        cooldown_minutes INTEGER NOT NULL DEFAULT 15,
        throttle_interval_ms INTEGER NOT NULL DEFAULT 60000,
        channels_json TEXT NOT NULL DEFAULT '[]',
        quiet_hours_enabled INTEGER NOT NULL DEFAULT 0,
        quiet_hours_timezone TEXT NOT NULL DEFAULT 'UTC',
        quiet_hours_start TEXT,
        quiet_hours_end TEXT,
        critical_bypass_quiet_hours INTEGER NOT NULL DEFAULT 1,
        digest_enabled INTEGER NOT NULL DEFAULT 0,
        digest_schedule TEXT,
        digest_timezone TEXT NOT NULL DEFAULT 'UTC',
        recipient TEXT,
        match_event_types_json TEXT NOT NULL DEFAULT '[]',
        match_host_ids_json TEXT NOT NULL DEFAULT '[]',
        match_identity_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observatory_digest_watermarks (
        target TEXT PRIMARY KEY,
        last_digest_at TEXT NOT NULL,
        last_slot_key TEXT NOT NULL,
        watermark_event_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observatory_notification_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'throttled', 'silenced')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        fingerprint TEXT NOT NULL,
        lease_token TEXT,
        lease_expires_at TEXT,
        sent_at TEXT,
        error_category TEXT,
        last_attempt_at TEXT,
        provider_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES observatory_events(event_id),
        UNIQUE (event_id, channel)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_deliveries_event ON observatory_notification_deliveries(event_id);
      CREATE INDEX IF NOT EXISTS idx_observatory_deliveries_status ON observatory_notification_deliveries(status);
      CREATE INDEX IF NOT EXISTS idx_observatory_deliveries_lease ON observatory_notification_deliveries(lease_expires_at);

      CREATE TABLE IF NOT EXISTS observatory_audit (
        audit_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_audit_action ON observatory_audit(action);
      CREATE INDEX IF NOT EXISTS idx_observatory_audit_target ON observatory_audit(target_type, target_id);
      CREATE INDEX IF NOT EXISTS idx_observatory_audit_occurred_at ON observatory_audit(occurred_at);

      CREATE TABLE IF NOT EXISTS observatory_ingestion_nonces (
        nonce TEXT NOT NULL,
        scope TEXT NOT NULL,
        host_id TEXT,
        claimed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (nonce, scope)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_nonces_expires ON observatory_ingestion_nonces(expires_at);

      CREATE TABLE IF NOT EXISTS observatory_import_ledger (
        batch_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        snapshot_sha256 TEXT,
        source_version TEXT,
        key_id TEXT,
        projection_sha256 TEXT,
        imported_at TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'completed', 'failed')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observatory_import_items (
        batch_id TEXT NOT NULL,
        source TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_key_hmac TEXT NOT NULL,
        projection_sha256 TEXT NOT NULL,
        destination_kind TEXT NOT NULL CHECK(destination_kind IN ('account', 'run', 'usage', 'balance', 'grant', 'endpoint')),
        destination_id TEXT,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (source, source_table, source_key_hmac)
      );
      CREATE TABLE IF NOT EXISTS observatory_import_batch_items (
        batch_id TEXT NOT NULL,
        source TEXT NOT NULL,
        source_table TEXT NOT NULL,
        source_key_hmac TEXT NOT NULL,
        projection_sha256 TEXT NOT NULL,
        PRIMARY KEY (batch_id, source, source_table, source_key_hmac),
        FOREIGN KEY (batch_id) REFERENCES observatory_import_ledger(batch_id)
      );


      CREATE TABLE IF NOT EXISTS observatory_collector_batches (
        host_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        body_sha256 TEXT NOT NULL,
        key_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('accepted', 'rejected')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (host_id, batch_id),
        FOREIGN KEY (host_id) REFERENCES observatory_hosts(host_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_collector_batches_received ON observatory_collector_batches(received_at);
      CREATE INDEX IF NOT EXISTS idx_observatory_collector_batches_status ON observatory_collector_batches(status);

      -- ==========================================
      -- AgentRouter Entities Schema
      -- ==========================================

      CREATE TABLE IF NOT EXISTS observatory_agentrouter_accounts (
        account_id TEXT PRIMARY KEY,
        account_label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS observatory_agentrouter_check_runs (
        id INTEGER PRIMARY KEY,
        account_id TEXT NOT NULL,
        account_label TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok', 'error')),
        login_ms INTEGER NOT NULL,
        dashboard_ms INTEGER NOT NULL,
        total_ms INTEGER NOT NULL,
        logged_out INTEGER NOT NULL DEFAULT 0,
        session_reused INTEGER NOT NULL DEFAULT 0,
        error_category TEXT,
        balance REAL,
        consumed REAL,
        request_count INTEGER,
        quota_per_unit REAL,
        average_rpm REAL,
        average_tpm REAL,
        available_models INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES observatory_agentrouter_accounts(account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_ar_runs_account ON observatory_agentrouter_check_runs(account_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_observatory_ar_runs_started ON observatory_agentrouter_check_runs(started_at);

      CREATE TABLE IF NOT EXISTS observatory_agentrouter_usage_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        granularity TEXT NOT NULL CHECK(granularity IN ('hour', 'day', 'week')),
        created_at_ts INTEGER NOT NULL,
        model_name TEXT,
        request_count INTEGER NOT NULL,
        token_used INTEGER NOT NULL,
        quota REAL NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, granularity, created_at_ts, model_name),
        FOREIGN KEY (account_id) REFERENCES observatory_agentrouter_accounts(account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_ar_usage_account_time ON observatory_agentrouter_usage_points(account_id, granularity, created_at_ts);

      CREATE TABLE IF NOT EXISTS observatory_agentrouter_balance_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER UNIQUE,
        account_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        balance REAL NOT NULL,
        consumed REAL NOT NULL,
        previous_balance REAL,
        previous_consumed REAL,
        balance_delta REAL,
        consumed_delta REAL,
        minutes_since_previous REAL,
        classification TEXT NOT NULL CHECK(classification IN ('initial', 'credit-increase', 'usage', 'mixed', 'unchanged')),
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES observatory_agentrouter_check_runs(id),
        FOREIGN KEY (account_id) REFERENCES observatory_agentrouter_accounts(account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_ar_balance_account_time ON observatory_agentrouter_balance_observations(account_id, observed_at);

      CREATE TABLE IF NOT EXISTS observatory_agentrouter_grant_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER,
        account_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        amount REAL NOT NULL CHECK(amount > 0),
        classification TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (account_id, source_event_id),
        FOREIGN KEY (run_id) REFERENCES observatory_agentrouter_check_runs(id),
        FOREIGN KEY (account_id) REFERENCES observatory_agentrouter_accounts(account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_ar_grant_account_time ON observatory_agentrouter_grant_events(account_id, occurred_at);

      CREATE TABLE IF NOT EXISTS observatory_agentrouter_endpoint_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        account_label TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok', 'error')),
        balance REAL,
        consumed REAL,
        request_count INTEGER,
        latency_ms INTEGER NOT NULL,
        error_category TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES observatory_agentrouter_accounts(account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_observatory_ar_endpoint_account_time ON observatory_agentrouter_endpoint_observations(account_id, observed_at);
    `);
  }

  // ==========================================
  // Fleet Hosts CRUD
  // ==========================================

  upsertHost(rawInput: FleetHostObservation): StoredFleetHost {
    const input = validateFleetHostObservation(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const existing = this.db
        .query<{ created_at: string }, [string]>(
          "SELECT created_at FROM observatory_hosts WHERE host_id = ?",
        )
        .get(input.hostId);

      const createdAt = existing?.created_at ?? now;
      const updatedAt = now;

      this.db
        .query(`
          INSERT INTO observatory_hosts (
            host_id, operator_label, platform, collector_version,
            last_seen_at, observed_at, status,
            active_sessions_count, active_identities_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(host_id) DO UPDATE SET
            operator_label = excluded.operator_label,
            platform = excluded.platform,
            collector_version = excluded.collector_version,
            last_seen_at = excluded.last_seen_at,
            observed_at = excluded.observed_at,
            status = excluded.status,
            active_sessions_count = excluded.active_sessions_count,
            active_identities_count = excluded.active_identities_count,
            updated_at = excluded.updated_at
        `)
        .run(
          input.hostId,
          input.operatorLabel!,
          input.platform!,
          input.collectorVersion!,
          input.lastSeenAt!,
          input.observedAt,
          input.status,
          input.activeSessionsCount ?? 0,
          input.activeIdentitiesCount ?? 0,
          createdAt,
          updatedAt,
        );

      return {
        ...input,
        operatorLabel: input.operatorLabel!,
        platform: input.platform!,
        collectorVersion: input.collectorVersion!,
        lastSeenAt: input.lastSeenAt!,
        activeSessionsCount: input.activeSessionsCount ?? 0,
        activeIdentitiesCount: input.activeIdentitiesCount ?? 0,
        createdAt,
        updatedAt,
      };
    })();
  }

  getHost(hostId: string): StoredFleetHost | null {
    validateOpaqueId(hostId, "hostId");
    const row = this.db
      .query<{
        host_id: string;
        operator_label: string;
        platform: string;
        collector_version: string;
        last_seen_at: string;
        observed_at: string;
        status: string;
        active_sessions_count: number;
        active_identities_count: number;
        created_at: string;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_hosts WHERE host_id = ?")
      .get(hostId);

    if (!row) return null;

    return {
      hostId: row.host_id,
      operatorLabel: row.operator_label,
      platform: row.platform,
      collectorVersion: row.collector_version,
      lastSeenAt: row.last_seen_at,
      observedAt: row.observed_at,
      status: row.status,
      activeSessionsCount: row.active_sessions_count,
      activeIdentitiesCount: row.active_identities_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listHosts(options?: { status?: string; limit?: number; offset?: number }): StoredFleetHost[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_hosts";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY observed_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      hostId: String(row.host_id),
      operatorLabel: String(row.operator_label),
      platform: String(row.platform),
      collectorVersion: String(row.collector_version),
      lastSeenAt: String(row.last_seen_at),
      observedAt: String(row.observed_at),
      status: String(row.status),
      activeSessionsCount: Number(row.active_sessions_count),
      activeIdentitiesCount: Number(row.active_identities_count),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  deleteHost(hostId: string): boolean {
    validateOpaqueId(hostId, "hostId");
    const result = this.db
      .query("DELETE FROM observatory_hosts WHERE host_id = ?")
      .run(hostId);
    return result.changes > 0;
  }

  // ==========================================
  // Provider Identities CRUD
  // ==========================================

  upsertIdentity(rawInput: ProviderIdentityObservation): StoredProviderIdentity {
    const input = validateProviderIdentityObservation(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      // Ensure host exists to satisfy FK
      const hostExists = this.db
        .query<{ host_id: string }, [string]>(
          "SELECT host_id FROM observatory_hosts WHERE host_id = ?",
        )
        .get(input.sourceHostId);

      if (!hostExists) {
        this.upsertHost({
          hostId: input.sourceHostId,
          observedAt: input.observedAt,
          status: "online",
        });
      }

      const existing = this.db
        .query<{ created_at: string }, [string]>(
          "SELECT created_at FROM observatory_identities WHERE identity_id = ?",
        )
        .get(input.identityId);

      const createdAt = existing?.created_at ?? now;
      const updatedAt = now;
      this.db
        .query(`
          INSERT INTO observatory_identities (
            identity_id, kind, provider, source_host_id, source_version,
            label, observed_at, health, disabled, blocked, cooldown_until_utc,
            last_probe_at, status_code, active_model, last_success_at,
            last_failure_at, consecutive_failures,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(identity_id) DO UPDATE SET
            kind = excluded.kind,
            provider = excluded.provider,
            source_host_id = excluded.source_host_id,
            source_version = excluded.source_version,
            label = excluded.label,
            observed_at = excluded.observed_at,
            health = excluded.health,
            disabled = excluded.disabled,
            blocked = excluded.blocked,
            cooldown_until_utc = excluded.cooldown_until_utc,
            last_probe_at = excluded.last_probe_at,
            status_code = excluded.status_code,
            active_model = excluded.active_model,
            last_success_at = excluded.last_success_at,
            last_failure_at = excluded.last_failure_at,
            consecutive_failures = excluded.consecutive_failures,
            updated_at = excluded.updated_at
        `)
        .run(
          input.identityId,
          input.kind,
          input.provider,
          input.sourceHostId,
          input.sourceVersion ?? null,
          input.label,
          input.observedAt,
          input.health,
          input.disabled ? 1 : 0,
          input.blocked ? 1 : 0,
          input.cooldownUntilUtc ?? null,
          input.lastProbeAt ?? null,
          input.statusCode ?? null,
          input.activeModel ?? null,
          input.lastSuccessAt ?? null,
          input.lastFailureAt ?? null,
          input.consecutiveFailures ?? 0,
          createdAt,
          updatedAt,
        );

      return {
        ...input,
        statusCode: input.statusCode ?? null,
        disabled: Boolean(input.disabled),
        blocked: Boolean(input.blocked),
        consecutiveFailures: input.consecutiveFailures ?? 0,
        createdAt,
        updatedAt,
      };
    })();
  }

  getIdentity(identityId: string): StoredProviderIdentity | null {
    validateOpaqueId(identityId, "identityId");
    const row = this.db
      .query<{
        identity_id: string;
        kind: string;
        provider: string;
        source_host_id: string;
        source_version: string | null;
        label: string;
        observed_at: string;
        health: string;
        disabled: number;
        blocked: number;
        cooldown_until_utc: string | null;
        last_probe_at: string | null;
        status_code: string | null;
        active_model: string | null;
        last_success_at: string | null;
        last_failure_at: string | null;
        consecutive_failures: number;
        created_at: string;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_identities WHERE identity_id = ?")
      .get(identityId);

    if (!row) return null;

    return {
      identityId: row.identity_id,
      kind: row.kind as ProviderIdentityKind,
      provider: row.provider,
      sourceHostId: row.source_host_id,
      sourceVersion: row.source_version,
      label: row.label,
      observedAt: row.observed_at,
      health: row.health as ProviderHealth,
      disabled: Boolean(row.disabled),
      blocked: Boolean(row.blocked),
      cooldownUntilUtc: row.cooldown_until_utc,
      lastProbeAt: row.last_probe_at,
      statusCode: row.status_code,
      activeModel: row.active_model,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      consecutiveFailures: row.consecutive_failures,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listIdentities(options?: {
    sourceHostId?: string;
    hostId?: string;
    provider?: string;
    kind?: string;
    health?: ProviderHealth;
    limit?: number;
    offset?: number;
  }): StoredProviderIdentity[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_identities";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    const hostFilter = options?.sourceHostId ?? options?.hostId;
    if (hostFilter) {
      conditions.push("source_host_id = ?");
      params.push(hostFilter);
    }
    if (options?.provider) {
      conditions.push("provider = ?");
      params.push(options.provider);
    }
    if (options?.kind) {
      conditions.push("kind = ?");
      params.push(options.kind);
    }
    if (options?.health) {
      conditions.push("health = ?");
      params.push(options.health);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY observed_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      identityId: String(row.identity_id),
      kind: row.kind as ProviderIdentityKind,
      provider: String(row.provider),
      sourceHostId: String(row.source_host_id),
      sourceVersion: (row.source_version as string | null) ?? null,
      label: String(row.label),
      observedAt: String(row.observed_at),
      health: row.health as ProviderHealth,
      disabled: Boolean(row.disabled),
      blocked: Boolean(row.blocked),
      cooldownUntilUtc: (row.cooldown_until_utc as string | null) ?? null,
      lastProbeAt: (row.last_probe_at as string | null) ?? null,
      statusCode: (row.status_code as string | null) ?? null,
      activeModel: (row.active_model as string | null) ?? null,
      lastSuccessAt: (row.last_success_at as string | null) ?? null,
      lastFailureAt: (row.last_failure_at as string | null) ?? null,
      consecutiveFailures: Number(row.consecutive_failures),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  deleteIdentity(identityId: string): boolean {
    validateOpaqueId(identityId, "identityId");
    const result = this.db
      .query("DELETE FROM observatory_identities WHERE identity_id = ?")
      .run(identityId);
    return result.changes > 0;
  }

  // ==========================================
  // Quota Observations, Windows, & Trackers
  // ==========================================

  recordQuotaObservation(rawInput: QuotaObservationInput): StoredQuotaObservation {
    const input = validateQuotaObservationInput(rawInput);
    const now = new Date().toISOString();
    const bucketId = input.bucketId ?? input.windowId;

    return this.db.transaction(() => {
      // Ensure identity exists
      const idExists = this.db
        .query<{ identity_id: string }, [string]>(
          "SELECT identity_id FROM observatory_identities WHERE identity_id = ?",
        )
        .get(input.identityId);

      if (!idExists) {
        this.upsertIdentity({
          identityId: input.identityId,
          kind: "credential",
          provider: input.provider,
          sourceHostId: input.hostId ?? "host-default",
          label: input.identityId,
          observedAt: input.observedAt,
          health: "healthy",
        });
      }

      // 1. Insert historical observation row
      const result = this.db
        .query(`
          INSERT INTO observatory_quota_observations (
            identity_id, provider, bucket_id, window_id, window_duration_ms,
            meter, model, tier, host_id, fetched_at, observed_at, resets_at,
            reset_label, used_fraction, remaining_fraction, used_units,
            total_units, remaining_units, reset_credits, unit, status,
            error_category, consecutive_failures, source, source_version,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.identityId,
          input.provider,
          bucketId,
          input.windowId,
          input.windowDurationMs ?? null,
          input.meter ?? null,
          input.model ?? null,
          input.tier ?? null,
          input.hostId ?? null,
          input.fetchedAt ?? null,
          input.observedAt,
          input.resetsAt ?? null,
          input.resetLabel ?? null,
          input.usedFraction,
          input.remainingFraction ?? null,
          input.usedUnits ?? null,
          input.totalUnits ?? null,
          input.remainingUnits ?? null,
          input.resetCredits ?? null,
          input.unit ?? null,
          input.status ?? "ok",
          input.errorCategory ?? null,
          input.consecutiveFailures ?? 0,
          input.source ?? null,
          input.sourceVersion ?? null,
          now,
        );
      const insertedId = Number(result.lastInsertRowid);

      // 2. Upsert current window protected against regressing on stale/delayed observedAt
      this.db
        .query(`
          INSERT INTO observatory_quota_current_windows (
            identity_id, provider, bucket_id, window_id, window_duration_ms,
            meter, model, tier, host_id, last_fetched_at, last_observed_at,
            resets_at, reset_label, used_fraction, remaining_fraction,
            used_units, total_units, remaining_units, reset_credits, unit,
            status, error_category, consecutive_failures, source, source_version,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(identity_id, bucket_id, window_id) DO UPDATE SET
            provider = excluded.provider,
            window_duration_ms = excluded.window_duration_ms,
            meter = excluded.meter,
            model = excluded.model,
            tier = excluded.tier,
            host_id = excluded.host_id,
            last_fetched_at = excluded.last_fetched_at,
            last_observed_at = excluded.last_observed_at,
            resets_at = excluded.resets_at,
            reset_label = excluded.reset_label,
            used_fraction = excluded.used_fraction,
            remaining_fraction = excluded.remaining_fraction,
            used_units = excluded.used_units,
            total_units = excluded.total_units,
            remaining_units = excluded.remaining_units,
            reset_credits = excluded.reset_credits,
            unit = excluded.unit,
            status = excluded.status,
            error_category = excluded.error_category,
            consecutive_failures = excluded.consecutive_failures,
            source = excluded.source,
            source_version = excluded.source_version,
            updated_at = excluded.updated_at
          WHERE excluded.last_observed_at >= observatory_quota_current_windows.last_observed_at
        `)
        .run(
          input.identityId,
          input.provider,
          bucketId,
          input.windowId,
          input.windowDurationMs ?? null,
          input.meter ?? null,
          input.model ?? null,
          input.tier ?? null,
          input.hostId ?? null,
          input.fetchedAt ?? null,
          input.observedAt,
          input.resetsAt ?? null,
          input.resetLabel ?? null,
          input.usedFraction,
          input.remainingFraction ?? null,
          input.usedUnits ?? null,
          input.totalUnits ?? null,
          input.remainingUnits ?? null,
          input.resetCredits ?? null,
          input.unit ?? null,
          input.status ?? "ok",
          input.errorCategory ?? null,
          input.consecutiveFailures ?? 0,
          input.source ?? null,
          input.sourceVersion ?? null,
          now,
        );

      return {
        ...input,
        id: insertedId,
        bucketId,
        status: input.status ?? "ok",
        consecutiveFailures: input.consecutiveFailures ?? 0,
        createdAt: now,
      };
    })();
  }

  getCurrentQuotaWindow(
    identityId: string,
    windowIdOrBucket: string,
    optionalWindowId?: string,
  ): CurrentQuotaWindow | null {
    validateOpaqueId(identityId, "identityId");
    validateOpaqueId(windowIdOrBucket, "windowIdOrBucket");

    let row: Record<string, unknown> | null = null;
    if (optionalWindowId) {
      validateOpaqueId(optionalWindowId, "optionalWindowId");
      row = this.db
        .query<Record<string, unknown>, [string, string, string]>(
          "SELECT * FROM observatory_quota_current_windows WHERE identity_id = ? AND bucket_id = ? AND window_id = ?",
        )
        .get(identityId, windowIdOrBucket, optionalWindowId);
    } else {
      row = this.db
        .query<Record<string, unknown>, [string, string, string]>(
          "SELECT * FROM observatory_quota_current_windows WHERE identity_id = ? AND (window_id = ? OR bucket_id = ?) LIMIT 1",
        )
        .get(identityId, windowIdOrBucket, windowIdOrBucket);
    }

    if (!row) return null;

    return {
      identityId: String(row.identity_id),
      provider: String(row.provider),
      bucketId: String(row.bucket_id),
      windowId: String(row.window_id),
      windowDurationMs: (row.window_duration_ms as number | null) ?? null,
      meter: (row.meter as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      tier: (row.tier as string | null) ?? null,
      hostId: (row.host_id as string | null) ?? null,
      lastFetchedAt: (row.last_fetched_at as string | null) ?? null,
      lastObservedAt: String(row.last_observed_at),
      resetsAt: (row.resets_at as string | null) ?? null,
      resetLabel: (row.reset_label as string | null) ?? null,
      usedFraction: Number(row.used_fraction),
      remainingFraction: (row.remaining_fraction as number | null) ?? null,
      usedUnits: (row.used_units as number | null) ?? null,
      totalUnits: (row.total_units as number | null) ?? null,
      remainingUnits: (row.remaining_units as number | null) ?? null,
      resetCredits: (row.reset_credits as number | null) ?? null,
      unit: (row.unit as string | null) ?? null,
      status: String(row.status),
      errorCategory: (row.error_category as string | null) ?? null,
      consecutiveFailures: Number(row.consecutive_failures),
      source: (row.source as string | null) ?? null,
      sourceVersion: (row.source_version as string | null) ?? null,
      updatedAt: String(row.updated_at),
    };
  }

  listCurrentQuotaWindows(options?: {
    identityId?: string;
    provider?: string;
    bucketId?: string;
    windowId?: string;
  }): CurrentQuotaWindow[] {
    let sql = "SELECT * FROM observatory_quota_current_windows";
    const params: string[] = [];
    const conditions: string[] = [];

    if (options?.identityId) {
      conditions.push("identity_id = ?");
      params.push(options.identityId);
    }
    if (options?.provider) {
      conditions.push("provider = ?");
      params.push(options.provider);
    }
    if (options?.bucketId) {
      conditions.push("bucket_id = ?");
      params.push(options.bucketId);
    }
    if (options?.windowId) {
      conditions.push("window_id = ?");
      params.push(options.windowId);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY last_observed_at DESC";

    const rows = this.db.query<Record<string, unknown>, string[]>(sql).all(...params);
    return rows.map((row) => ({
      identityId: String(row.identity_id),
      provider: String(row.provider),
      bucketId: String(row.bucket_id),
      windowId: String(row.window_id),
      windowDurationMs: (row.window_duration_ms as number | null) ?? null,
      meter: (row.meter as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      tier: (row.tier as string | null) ?? null,
      hostId: (row.host_id as string | null) ?? null,
      lastFetchedAt: (row.last_fetched_at as string | null) ?? null,
      lastObservedAt: String(row.last_observed_at),
      resetsAt: (row.resets_at as string | null) ?? null,
      resetLabel: (row.reset_label as string | null) ?? null,
      usedFraction: Number(row.used_fraction),
      remainingFraction: (row.remaining_fraction as number | null) ?? null,
      usedUnits: (row.used_units as number | null) ?? null,
      totalUnits: (row.total_units as number | null) ?? null,
      remainingUnits: (row.remaining_units as number | null) ?? null,
      resetCredits: (row.reset_credits as number | null) ?? null,
      unit: (row.unit as string | null) ?? null,
      status: String(row.status),
      errorCategory: (row.error_category as string | null) ?? null,
      consecutiveFailures: Number(row.consecutive_failures),
      source: (row.source as string | null) ?? null,
      sourceVersion: (row.source_version as string | null) ?? null,
      updatedAt: String(row.updated_at),
    }));
  }

  listQuotaObservations(options?: {
    identityId?: string;
    bucketId?: string;
    windowId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): StoredQuotaObservation[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_quota_observations";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.identityId) {
      conditions.push("identity_id = ?");
      params.push(options.identityId);
    }
    if (options?.bucketId) {
      conditions.push("bucket_id = ?");
      params.push(options.bucketId);
    }
    if (options?.windowId) {
      conditions.push("window_id = ?");
      params.push(options.windowId);
    }
    if (options?.since) {
      const canonicalSince = validateIsoUtcTimestamp(options.since, "since");
      conditions.push("observed_at >= ?");
      params.push(canonicalSince);
    }
    if (options?.until) {
      const canonicalUntil = validateIsoUtcTimestamp(options.until, "until");
      conditions.push("observed_at <= ?");
      params.push(canonicalUntil);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY observed_at DESC, id DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      id: Number(row.id),
      identityId: String(row.identity_id),
      provider: String(row.provider),
      bucketId: String(row.bucket_id),
      windowId: String(row.window_id),
      windowDurationMs: (row.window_duration_ms as number | null) ?? null,
      meter: (row.meter as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      tier: (row.tier as string | null) ?? null,
      hostId: (row.host_id as string | null) ?? null,
      fetchedAt: (row.fetched_at as string | null) ?? null,
      observedAt: String(row.observed_at),
      resetsAt: (row.resets_at as string | null) ?? null,
      resetLabel: (row.reset_label as string | null) ?? null,
      usedFraction: Number(row.used_fraction),
      remainingFraction: (row.remaining_fraction as number | null) ?? null,
      usedUnits: (row.used_units as number | null) ?? null,
      totalUnits: (row.total_units as number | null) ?? null,
      remainingUnits: (row.remaining_units as number | null) ?? null,
      resetCredits: (row.reset_credits as number | null) ?? null,
      unit: (row.unit as string | null) ?? null,
      status: String(row.status),
      errorCategory: (row.error_category as string | null) ?? null,
      consecutiveFailures: Number(row.consecutive_failures),
      source: (row.source as string | null) ?? null,
      sourceVersion: (row.source_version as string | null) ?? null,
      createdAt: String(row.created_at),
    }));
  }

  recordDailyQuotaRollup(rawInput: DailyQuotaRollupInput): DailyQuotaRollup {
    const input = validateDailyQuotaRollupInput(rawInput);
    const now = new Date().toISOString();
    const finalizedAt = input.finalizedAt ?? now;

    return this.db.transaction(() => {
      const idExists = this.db
        .query<{ identity_id: string }, [string]>(
          "SELECT identity_id FROM observatory_identities WHERE identity_id = ?",
        )
        .get(input.identityId);

      if (!idExists) {
        this.upsertIdentity({
          identityId: input.identityId,
          kind: "credential",
          provider: input.provider,
          sourceHostId: "host-default",
          label: input.identityId,
          observedAt: input.lastObservedAt,
          health: "healthy",
        });
      }

      this.db
        .query(`
          INSERT INTO observatory_daily_quota_rollups (
            day_utc, identity_id, provider, bucket_id, window_id,
            meter, model, tier, observation_count,
            min_used_fraction, max_used_fraction, avg_used_fraction,
            min_remaining_fraction, max_remaining_fraction, avg_remaining_fraction,
            min_reset_credits, max_reset_credits,
            first_observed_at, last_observed_at, finalized_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(day_utc, identity_id, bucket_id, window_id) DO UPDATE SET
            provider = excluded.provider,
            meter = excluded.meter,
            model = excluded.model,
            tier = excluded.tier,
            observation_count = excluded.observation_count,
            min_used_fraction = excluded.min_used_fraction,
            max_used_fraction = excluded.max_used_fraction,
            avg_used_fraction = excluded.avg_used_fraction,
            min_remaining_fraction = excluded.min_remaining_fraction,
            max_remaining_fraction = excluded.max_remaining_fraction,
            avg_remaining_fraction = excluded.avg_remaining_fraction,
            min_reset_credits = excluded.min_reset_credits,
            max_reset_credits = excluded.max_reset_credits,
            first_observed_at = excluded.first_observed_at,
            last_observed_at = excluded.last_observed_at,
            finalized_at = excluded.finalized_at,
            updated_at = excluded.updated_at
        `)
        .run(
          input.dayUtc,
          input.identityId,
          input.provider,
          input.bucketId ?? input.windowId,
          input.windowId,
          input.meter ?? null,
          input.model ?? null,
          input.tier ?? null,
          input.observationCount,
          input.minUsedFraction,
          input.maxUsedFraction,
          input.avgUsedFraction,
          input.minRemainingFraction ?? null,
          input.maxRemainingFraction ?? null,
          input.avgRemainingFraction ?? null,
          input.minResetCredits ?? null,
          input.maxResetCredits ?? null,
          input.firstObservedAt,
          input.lastObservedAt,
          finalizedAt,
          now,
          now,
        );

      return this.getDailyQuotaRollup(
        input.identityId,
        input.bucketId ?? input.windowId,
        input.windowId,
        input.dayUtc,
      )!;
    })();
  }

  getDailyQuotaRollup(
    identityId: string,
    bucketId: string,
    windowId: string,
    dayUtc: string,
  ): DailyQuotaRollup | null {
    validateOpaqueId(identityId, "identityId");
    validateOpaqueId(bucketId, "bucketId");
    validateOpaqueId(windowId, "windowId");
    const validDay = validateUtcDay(dayUtc, "dayUtc");

    const row = this.db
      .query<Record<string, unknown>, [string, string, string, string]>(
        "SELECT * FROM observatory_daily_quota_rollups WHERE identity_id = ? AND bucket_id = ? AND window_id = ? AND day_utc = ?",
      )
      .get(identityId, bucketId, windowId, validDay);

    if (!row) return null;

    return {
      rollupId: Number(row.rollup_id),
      dayUtc: String(row.day_utc),
      identityId: String(row.identity_id),
      provider: String(row.provider),
      bucketId: String(row.bucket_id),
      windowId: String(row.window_id),
      meter: (row.meter as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      tier: (row.tier as string | null) ?? null,
      observationCount: Number(row.observation_count),
      minUsedFraction: Number(row.min_used_fraction),
      maxUsedFraction: Number(row.max_used_fraction),
      avgUsedFraction: Number(row.avg_used_fraction),
      minRemainingFraction: (row.min_remaining_fraction as number | null) ?? null,
      maxRemainingFraction: (row.max_remaining_fraction as number | null) ?? null,
      avgRemainingFraction: (row.avg_remaining_fraction as number | null) ?? null,
      minResetCredits: (row.min_reset_credits as number | null) ?? null,
      maxResetCredits: (row.max_reset_credits as number | null) ?? null,
      firstObservedAt: String(row.first_observed_at),
      lastObservedAt: String(row.last_observed_at),
      finalizedAt: String(row.finalized_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listDailyQuotaRollups(options?: {
    identityId?: string;
    bucketId?: string;
    windowId?: string;
    dayUtc?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): DailyQuotaRollup[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_daily_quota_rollups";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.identityId) {
      conditions.push("identity_id = ?");
      params.push(options.identityId);
    }
    if (options?.bucketId) {
      conditions.push("bucket_id = ?");
      params.push(options.bucketId);
    }
    if (options?.windowId) {
      conditions.push("window_id = ?");
      params.push(options.windowId);
    }
    if (options?.dayUtc) {
      conditions.push("day_utc = ?");
      params.push(validateUtcDay(options.dayUtc, "dayUtc"));
    }
    if (options?.since) {
      conditions.push("day_utc >= ?");
      params.push(validateUtcDay(options.since, "since"));
    }
    if (options?.until) {
      conditions.push("day_utc <= ?");
      params.push(validateUtcDay(options.until, "until"));
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY day_utc DESC, rollup_id DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      rollupId: Number(row.rollup_id),
      dayUtc: String(row.day_utc),
      identityId: String(row.identity_id),
      provider: String(row.provider),
      bucketId: String(row.bucket_id),
      windowId: String(row.window_id),
      meter: (row.meter as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      tier: (row.tier as string | null) ?? null,
      observationCount: Number(row.observation_count),
      minUsedFraction: Number(row.min_used_fraction),
      maxUsedFraction: Number(row.max_used_fraction),
      avgUsedFraction: Number(row.avg_used_fraction),
      minRemainingFraction: (row.min_remaining_fraction as number | null) ?? null,
      maxRemainingFraction: (row.max_remaining_fraction as number | null) ?? null,
      avgRemainingFraction: (row.avg_remaining_fraction as number | null) ?? null,
      minResetCredits: (row.min_reset_credits as number | null) ?? null,
      maxResetCredits: (row.max_reset_credits as number | null) ?? null,
      firstObservedAt: String(row.first_observed_at),
      lastObservedAt: String(row.last_observed_at),
      finalizedAt: String(row.finalized_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  finalizeDailyQuotaRollup(target: {
    identityId: string;
    bucketId?: string;
    windowId: string;
    dayUtc: string;
    meter?: string | null;
    model?: string | null;
    tier?: string | null;
  }): DailyQuotaRollup | null {
    validateOpaqueId(target.identityId, "identityId");
    validateOpaqueId(target.windowId, "windowId");
    const bucketId = target.bucketId ? validateOpaqueId(target.bucketId, "bucketId") : target.windowId;
    const dayUtc = validateUtcDay(target.dayUtc, "dayUtc");

    return this.db.transaction(() => {
      const stats = this.db
        .query<{
          obs_count: number;
          min_used: number | null;
          max_used: number | null;
          avg_used: number | null;
          min_rem: number | null;
          max_rem: number | null;
          avg_rem: number | null;
          min_credits: number | null;
          max_credits: number | null;
          first_obs: string | null;
          last_obs: string | null;
          provider: string | null;
        }, [string, string, string, string]>(`
          SELECT
            COUNT(*) as obs_count,
            MIN(used_fraction) as min_used,
            MAX(used_fraction) as max_used,
            AVG(used_fraction) as avg_used,
            MIN(remaining_fraction) as min_rem,
            MAX(remaining_fraction) as max_rem,
            AVG(remaining_fraction) as avg_rem,
            MIN(reset_credits) as min_credits,
            MAX(reset_credits) as max_credits,
            MIN(observed_at) as first_obs,
            MAX(observed_at) as last_obs,
            MIN(provider) as provider
          FROM observatory_quota_observations
          WHERE identity_id = ?
            AND bucket_id = ?
            AND window_id = ?
            AND substr(observed_at, 1, 10) = ?
        `)
        .get(target.identityId, bucketId, target.windowId, dayUtc);

      if (!stats || stats.obs_count === 0 || !stats.first_obs || !stats.last_obs || !stats.provider) {
        return null;
      }

      return this.recordDailyQuotaRollup({
        dayUtc,
        identityId: target.identityId,
        provider: stats.provider,
        bucketId,
        windowId: target.windowId,
        meter: target.meter ?? null,
        model: target.model ?? null,
        tier: target.tier ?? null,
        observationCount: stats.obs_count,
        minUsedFraction: stats.min_used ?? 0,
        maxUsedFraction: stats.max_used ?? 0,
        avgUsedFraction: stats.avg_used ?? 0,
        minRemainingFraction: stats.min_rem,
        maxRemainingFraction: stats.max_rem,
        avgRemainingFraction: stats.avg_rem,
        minResetCredits: stats.min_credits,
        maxResetCredits: stats.max_credits,
        firstObservedAt: stats.first_obs,
        lastObservedAt: stats.last_obs,
        finalizedAt: new Date().toISOString(),
      });
    })();
  }


  // ==========================================
  // Trackers State Management (Quota, Provider, Host, Session, AgentRouter)
  // ==========================================

  getQuotaTracker(trackerKey: string): StoredQuotaTracker | null {
    validateSafeString(trackerKey, "trackerKey", 256, true);
    const row = this.db
      .query<{
        tracker_key: string;
        identity_id: string;
        provider: string;
        bucket_id: string;
        window_id: string;
        generation: number;
        last_observed_at: string;
        last_used_fraction: number;
        last_remaining_fraction: number | null;
        last_reset_credits: number | null;
        warning_fired: number;
        critical_fired: number;
        exhausted_fired: number;
        warning_arm_epoch: number;
        critical_arm_epoch: number;
        exhausted_arm_epoch: number;
        credit_change_sequence: number;
        consecutive_failures: number;
        failure_alert_sent: number;
        last_reset_at: string | null;
        last_notified_reset_at: string | null;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_quota_trackers WHERE tracker_key = ?")
      .get(trackerKey);

    if (!row) return null;

    return {
      trackerKey: row.tracker_key,
      identityId: row.identity_id,
      provider: row.provider,
      bucketId: row.bucket_id,
      windowId: row.window_id,
      generation: row.generation,
      lastObservedAt: row.last_observed_at,
      lastUsedFraction: row.last_used_fraction,
      lastRemainingFraction: row.last_remaining_fraction,
      lastResetCredits: row.last_reset_credits,
      warningFired: Boolean(row.warning_fired),
      criticalFired: Boolean(row.critical_fired),
      exhaustedFired: Boolean(row.exhausted_fired),
      warningArmEpoch: row.warning_arm_epoch,
      criticalArmEpoch: row.critical_arm_epoch,
      exhaustedArmEpoch: row.exhausted_arm_epoch,
      creditChangeSequence: row.credit_change_sequence,
      consecutiveFailures: row.consecutive_failures,
      failureAlertSent: Boolean(row.failure_alert_sent),
      lastResetAt: row.last_reset_at,
      lastNotifiedResetAt: row.last_notified_reset_at,
      updatedAt: row.updated_at,
    };
  }

  upsertQuotaTracker(rawInput: QuotaTrackerState): StoredQuotaTracker {
    const input = validateQuotaTrackerState(rawInput);
    const now = new Date().toISOString();
    const updatedAt = input.updatedAt ?? now;

    return this.db.transaction(() => {
      // Ensure identity exists
      const idExists = this.db
        .query<{ identity_id: string }, [string]>(
          "SELECT identity_id FROM observatory_identities WHERE identity_id = ?",
        )
        .get(input.identityId);

      if (!idExists) {
        this.upsertIdentity({
          identityId: input.identityId,
          kind: "credential",
          provider: input.provider,
          sourceHostId: "host-default",
          label: input.identityId,
          observedAt: input.lastObservedAt,
          health: "healthy",
        });
      }

      this.db
        .query(`
          INSERT INTO observatory_quota_trackers (
            tracker_key, identity_id, provider, bucket_id, window_id,
            generation, last_observed_at, last_used_fraction,
            last_remaining_fraction, last_reset_credits, warning_fired,
            critical_fired, exhausted_fired, warning_arm_epoch,
            critical_arm_epoch, exhausted_arm_epoch, credit_change_sequence,
            consecutive_failures, failure_alert_sent, last_reset_at,
            last_notified_reset_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tracker_key) DO UPDATE SET
            generation = excluded.generation,
            last_observed_at = excluded.last_observed_at,
            last_used_fraction = excluded.last_used_fraction,
            last_remaining_fraction = excluded.last_remaining_fraction,
            last_reset_credits = excluded.last_reset_credits,
            warning_fired = excluded.warning_fired,
            critical_fired = excluded.critical_fired,
            exhausted_fired = excluded.exhausted_fired,
            warning_arm_epoch = excluded.warning_arm_epoch,
            critical_arm_epoch = excluded.critical_arm_epoch,
            exhausted_arm_epoch = excluded.exhausted_arm_epoch,
            credit_change_sequence = excluded.credit_change_sequence,
            consecutive_failures = excluded.consecutive_failures,
            failure_alert_sent = excluded.failure_alert_sent,
            last_reset_at = excluded.last_reset_at,
            last_notified_reset_at = excluded.last_notified_reset_at,
            updated_at = excluded.updated_at
        `)
        .run(
          input.trackerKey,
          input.identityId,
          input.provider,
          input.bucketId,
          input.windowId,
          input.generation,
          input.lastObservedAt,
          input.lastUsedFraction,
          input.lastRemainingFraction ?? null,
          input.lastResetCredits ?? null,
          input.warningFired ? 1 : 0,
          input.criticalFired ? 1 : 0,
          input.exhaustedFired ? 1 : 0,
          input.warningArmEpoch,
          input.criticalArmEpoch,
          input.exhaustedArmEpoch,
          input.creditChangeSequence,
          input.consecutiveFailures,
          input.failureAlertSent ? 1 : 0,
          input.lastResetAt ?? null,
          input.lastNotifiedResetAt ?? null,
          updatedAt,
        );

      return {
        ...input,
        updatedAt,
      };
    })();
  }

  getProviderTracker(trackerKey: string): StoredProviderTracker | null {
    validateSafeString(trackerKey, "trackerKey", 256, true);
    const row = this.db
      .query<{
        tracker_key: string;
        identity_id: string;
        provider: string;
        source_host_id: string;
        last_observed_at: string;
        health: string;
        consecutive_failures: number;
        consecutive_blocked: number;
        consecutive_disabled: number;
        down_incident_active: number;
        blocked_incident_active: number;
        disabled_incident_active: number;
        cooldown_incident_active: number;
        collector_failure_active: number;
        incident_epoch: number;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_provider_trackers WHERE tracker_key = ?")
      .get(trackerKey);

    if (!row) return null;

    return {
      trackerKey: row.tracker_key,
      identityId: row.identity_id,
      provider: row.provider,
      sourceHostId: row.source_host_id,
      lastObservedAt: row.last_observed_at,
      health: row.health as ProviderHealth,
      consecutiveFailures: row.consecutive_failures,
      consecutiveBlocked: row.consecutive_blocked,
      consecutiveDisabled: row.consecutive_disabled,
      downIncidentActive: Boolean(row.down_incident_active),
      blockedIncidentActive: Boolean(row.blocked_incident_active),
      disabledIncidentActive: Boolean(row.disabled_incident_active),
      cooldownIncidentActive: Boolean(row.cooldown_incident_active),
      collectorFailureActive: Boolean(row.collector_failure_active),
      incidentEpoch: row.incident_epoch,
      updatedAt: row.updated_at,
    };
  }

  upsertProviderTracker(rawInput: ProviderTrackerState): StoredProviderTracker {
    const input = validateProviderTrackerState(rawInput);
    const now = new Date().toISOString();
    const updatedAt = input.updatedAt ?? now;

    return this.db.transaction(() => {
      this.db
        .query(`
          INSERT INTO observatory_provider_trackers (
            tracker_key, identity_id, provider, source_host_id,
            last_observed_at, health, consecutive_failures,
            consecutive_blocked, consecutive_disabled, down_incident_active,
            blocked_incident_active, disabled_incident_active,
            cooldown_incident_active, collector_failure_active,
            incident_epoch, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tracker_key) DO UPDATE SET
            last_observed_at = excluded.last_observed_at,
            health = excluded.health,
            consecutive_failures = excluded.consecutive_failures,
            consecutive_blocked = excluded.consecutive_blocked,
            consecutive_disabled = excluded.consecutive_disabled,
            down_incident_active = excluded.down_incident_active,
            blocked_incident_active = excluded.blocked_incident_active,
            disabled_incident_active = excluded.disabled_incident_active,
            cooldown_incident_active = excluded.cooldown_incident_active,
            collector_failure_active = excluded.collector_failure_active,
            incident_epoch = excluded.incident_epoch,
            updated_at = excluded.updated_at
        `)
        .run(
          input.trackerKey,
          input.identityId,
          input.provider,
          input.sourceHostId,
          input.lastObservedAt,
          input.health,
          input.consecutiveFailures,
          input.consecutiveBlocked,
          input.consecutiveDisabled,
          input.downIncidentActive ? 1 : 0,
          input.blockedIncidentActive ? 1 : 0,
          input.disabledIncidentActive ? 1 : 0,
          input.cooldownIncidentActive ? 1 : 0,
          input.collectorFailureActive ? 1 : 0,
          input.incidentEpoch,
          updatedAt,
        );

      return {
        ...input,
        updatedAt,
      };
    })();
  }

  getHostTracker(trackerKey: string): StoredHostTracker | null {
    validateSafeString(trackerKey, "trackerKey", 256, true);
    const row = this.db
      .query<{
        tracker_key: string;
        host_id: string;
        last_seen_at: string;
        last_observed_at: string;
        status: string;
        offline_since: string | null;
        offline_alert_sent: number;
        offline_incident_epoch: number;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_host_trackers WHERE tracker_key = ?")
      .get(trackerKey);

    if (!row) return null;

    return {
      trackerKey: row.tracker_key,
      hostId: row.host_id,
      lastSeenAt: row.last_seen_at,
      lastObservedAt: row.last_observed_at,
      status: row.status,
      offlineSince: row.offline_since,
      offlineAlertSent: Boolean(row.offline_alert_sent),
      offlineIncidentEpoch: row.offline_incident_epoch,
      updatedAt: row.updated_at,
    };
  }

  upsertHostTracker(rawInput: HostTrackerState): StoredHostTracker {
    const input = validateHostTrackerState(rawInput);
    const now = new Date().toISOString();
    const updatedAt = input.updatedAt ?? now;

    return this.db.transaction(() => {
      this.db
        .query(`
          INSERT INTO observatory_host_trackers (
            tracker_key, host_id, last_seen_at, last_observed_at,
            status, offline_since, offline_alert_sent,
            offline_incident_epoch, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tracker_key) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            last_observed_at = excluded.last_observed_at,
            status = excluded.status,
            offline_since = excluded.offline_since,
            offline_alert_sent = excluded.offline_alert_sent,
            offline_incident_epoch = excluded.offline_incident_epoch,
            updated_at = excluded.updated_at
        `)
        .run(
          input.trackerKey,
          input.hostId,
          input.lastSeenAt,
          input.lastObservedAt,
          input.status,
          input.offlineSince ?? null,
          input.offlineAlertSent ? 1 : 0,
          input.offlineIncidentEpoch,
          updatedAt,
        );

      return {
        ...input,
        updatedAt,
      };
    })();
  }

  getSessionTracker(trackerKey: string): StoredSessionTracker | null {
    validateSafeString(trackerKey, "trackerKey", 256, true);
    const row = this.db
      .query<{
        tracker_key: string;
        session_id: string;
        host_id: string;
        identity_id: string | null;
        last_observed_at: string;
        last_context_bps: number | null;
        context_warning_fired: number;
        context_critical_fired: number;
        context_arm_epoch: number;
        status: string;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_session_trackers WHERE tracker_key = ?")
      .get(trackerKey);

    if (!row) return null;

    return {
      trackerKey: row.tracker_key,
      sessionId: row.session_id,
      hostId: row.host_id,
      identityId: row.identity_id,
      lastObservedAt: row.last_observed_at,
      lastContextBps: row.last_context_bps,
      contextWarningFired: Boolean(row.context_warning_fired),
      contextCriticalFired: Boolean(row.context_critical_fired),
      contextArmEpoch: row.context_arm_epoch,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  upsertSessionTracker(rawInput: SessionTrackerState): StoredSessionTracker {
    const input = validateSessionTrackerState(rawInput);
    const now = new Date().toISOString();
    const updatedAt = input.updatedAt ?? now;

    return this.db.transaction(() => {
      this.db
        .query(`
          INSERT INTO observatory_session_trackers (
            tracker_key, session_id, host_id, identity_id,
            last_observed_at, last_context_bps, context_warning_fired,
            context_critical_fired, context_arm_epoch, status, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tracker_key) DO UPDATE SET
            identity_id = excluded.identity_id,
            last_observed_at = excluded.last_observed_at,
            last_context_bps = excluded.last_context_bps,
            context_warning_fired = excluded.context_warning_fired,
            context_critical_fired = excluded.context_critical_fired,
            context_arm_epoch = excluded.context_arm_epoch,
            status = excluded.status,
            updated_at = excluded.updated_at
        `)
        .run(
          input.trackerKey,
          input.sessionId,
          input.hostId,
          input.identityId ?? null,
          input.lastObservedAt,
          input.lastContextBps ?? null,
          input.contextWarningFired ? 1 : 0,
          input.contextCriticalFired ? 1 : 0,
          input.contextArmEpoch,
          input.status,
          updatedAt,
        );

      return {
        ...input,
        updatedAt,
      };
    })();
  }

  getAgentRouterTracker(trackerKey: string): StoredAgentRouterTracker | null {
    validateSafeString(trackerKey, "trackerKey", 256, true);
    const row = this.db
      .query<{
        tracker_key: string;
        account_id: string;
        last_observed_at: string;
        last_balance: number | null;
        low_balance_fired: number;
        low_balance_arm_epoch: number;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_agentrouter_trackers WHERE tracker_key = ?")
      .get(trackerKey);

    if (!row) return null;

    return {
      trackerKey: row.tracker_key,
      accountId: row.account_id,
      lastObservedAt: row.last_observed_at,
      lastBalance: row.last_balance,
      lowBalanceFired: Boolean(row.low_balance_fired),
      lowBalanceArmEpoch: row.low_balance_arm_epoch,
      updatedAt: row.updated_at,
    };
  }

  upsertAgentRouterTracker(rawInput: AgentRouterTrackerState): StoredAgentRouterTracker {
    const input = validateAgentRouterTrackerState(rawInput);
    const now = new Date().toISOString();
    const updatedAt = input.updatedAt ?? now;

    return this.db.transaction(() => {
      this.db
        .query(`
          INSERT INTO observatory_agentrouter_trackers (
            tracker_key, account_id, last_observed_at,
            last_balance, low_balance_fired, low_balance_arm_epoch,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tracker_key) DO UPDATE SET
            last_observed_at = excluded.last_observed_at,
            last_balance = excluded.last_balance,
            low_balance_fired = excluded.low_balance_fired,
            low_balance_arm_epoch = excluded.low_balance_arm_epoch,
            updated_at = excluded.updated_at
        `)
        .run(
          input.trackerKey,
          input.accountId,
          input.lastObservedAt,
          input.lastBalance ?? null,
          input.lowBalanceFired ? 1 : 0,
          input.lowBalanceArmEpoch,
          updatedAt,
        );

      return {
        ...input,
        updatedAt,
      };
    })();
  }

  // ==========================================
  // Session Summaries CRUD
  // ==========================================

  upsertSessionSummary(rawInput: OmpSessionSummaryInput): StoredSessionSummary {
    const input = validateOmpSessionSummaryInput(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      // Ensure host exists
      const hostExists = this.db
        .query<{ host_id: string }, [string]>(
          "SELECT host_id FROM observatory_hosts WHERE host_id = ?",
        )
        .get(input.hostId);

      if (!hostExists) {
        this.upsertHost({
          hostId: input.hostId,
          observedAt: input.startedAt,
          status: "online",
        });
      }

      const existing = this.db
        .query<{ created_at: string }, [string, string]>(
          "SELECT created_at FROM observatory_sessions WHERE host_id = ? AND session_id = ?",
        )
        .get(input.hostId, input.sessionId);

      const createdAt = existing?.created_at ?? now;
      const updatedAt = now;
      this.db
        .query(`
          INSERT INTO observatory_sessions (
            session_id, host_id, identity_id, status, started_at,
            last_active_at, closed_at, ended_at, model, provider,
            duration_ms, input_tokens, prompt_tokens, output_tokens,
            completion_tokens, cache_read_tokens, cache_write_tokens,
            reasoning_tokens, total_tokens, cost_micros, cost_estimate,
            cost_trust, context_bps, tool_calls_count, error_count,
            exit_code, collected_at, source, source_version,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(host_id, session_id) DO UPDATE SET
            identity_id = excluded.identity_id,
            status = excluded.status,
            started_at = excluded.started_at,
            last_active_at = excluded.last_active_at,
            closed_at = excluded.closed_at,
            ended_at = excluded.ended_at,
            model = excluded.model,
            provider = excluded.provider,
            duration_ms = excluded.duration_ms,
            input_tokens = excluded.input_tokens,
            prompt_tokens = excluded.prompt_tokens,
            output_tokens = excluded.output_tokens,
            completion_tokens = excluded.completion_tokens,
            cache_read_tokens = excluded.cache_read_tokens,
            cache_write_tokens = excluded.cache_write_tokens,
            reasoning_tokens = excluded.reasoning_tokens,
            total_tokens = excluded.total_tokens,
            cost_micros = excluded.cost_micros,
            cost_estimate = excluded.cost_estimate,
            cost_trust = excluded.cost_trust,
            context_bps = excluded.context_bps,
            tool_calls_count = excluded.tool_calls_count,
            error_count = excluded.error_count,
            exit_code = excluded.exit_code,
            collected_at = excluded.collected_at,
            source = excluded.source,
            source_version = excluded.source_version,
            updated_at = excluded.updated_at
        `)
        .run(
          input.sessionId,
          input.hostId,
          input.identityId ?? null,
          input.status,
          input.startedAt,
          input.lastActiveAt ?? null,
          input.closedAt ?? null,
          input.endedAt ?? null,
          input.model ?? null,
          input.provider ?? null,
          input.durationMs ?? null,
          input.inputTokens ?? null,
          input.promptTokens ?? null,
          input.outputTokens ?? null,
          input.completionTokens ?? null,
          input.cacheReadTokens ?? null,
          input.cacheWriteTokens ?? null,
          input.reasoningTokens ?? null,
          input.totalTokens ?? null,
          input.costMicros ?? null,
          input.costEstimate ?? null,
          input.costTrust ?? null,
          input.contextBps ?? null,
          input.toolCallsCount ?? null,
          input.errorCount ?? null,
          input.exitCode ?? null,
          input.collectedAt ?? null,
          input.source ?? null,
          input.sourceVersion ?? null,
          createdAt,
          updatedAt,
        );

      return {
        ...input,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        cacheReadTokens: input.cacheReadTokens ?? null,
        cacheWriteTokens: input.cacheWriteTokens ?? null,
        reasoningTokens: input.reasoningTokens ?? null,
        totalTokens: input.totalTokens ?? null,
        costMicros: input.costMicros ?? null,
        costTrust: input.costTrust ?? null,
        contextBps: input.contextBps ?? null,
        createdAt,
        updatedAt,
      };
    })();
  }

  getSessionSummary(sessionId: string, hostId?: string): StoredSessionSummary | null {
    validateOpaqueId(sessionId, "sessionId");

    let row: Record<string, unknown> | null = null;
    if (hostId) {
      validateOpaqueId(hostId, "hostId");
      row = this.db
        .query<Record<string, unknown>, [string, string]>(
          "SELECT * FROM observatory_sessions WHERE host_id = ? AND session_id = ?",
        )
        .get(hostId, sessionId);
    } else {
      row = this.db
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM observatory_sessions WHERE session_id = ? LIMIT 1",
        )
        .get(sessionId);
    }

    if (!row) return null;

    return {
      sessionId: String(row.session_id),
      hostId: String(row.host_id),
      identityId: (row.identity_id as string | null) ?? null,
      status: String(row.status),
      startedAt: String(row.started_at),
      lastActiveAt: (row.last_active_at as string | null) ?? null,
      closedAt: (row.closed_at as string | null) ?? null,
      endedAt: (row.ended_at as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      provider: (row.provider as string | null) ?? null,
      durationMs: (row.duration_ms as number | null) ?? null,
      inputTokens: (row.input_tokens as number | null) ?? null,
      promptTokens: (row.prompt_tokens as number | null) ?? null,
      outputTokens: (row.output_tokens as number | null) ?? null,
      completionTokens: (row.completion_tokens as number | null) ?? null,
      cacheReadTokens: (row.cache_read_tokens as number | null) ?? null,
      cacheWriteTokens: (row.cache_write_tokens as number | null) ?? null,
      reasoningTokens: (row.reasoning_tokens as number | null) ?? null,
      totalTokens: (row.total_tokens as number | null) ?? null,
      costMicros: (row.cost_micros as number | null) ?? null,
      costEstimate: (row.cost_estimate as number | null) ?? null,
      costTrust: (row.cost_trust as "exact" | "estimated" | "unknown" | null) ?? null,
      contextBps: (row.context_bps as number | null) ?? null,
      toolCallsCount: (row.tool_calls_count as number | null) ?? null,
      errorCount: (row.error_count as number | null) ?? null,
      exitCode: (row.exit_code as number | null) ?? null,
      collectedAt: (row.collected_at as string | null) ?? null,
      source: (row.source as string | null) ?? null,
      sourceVersion: (row.source_version as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listSessionSummaries(options?: {
    hostId?: string;
    identityId?: string;
    status?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): StoredSessionSummary[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_sessions";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.hostId) {
      conditions.push("host_id = ?");
      params.push(options.hostId);
    }
    if (options?.identityId) {
      conditions.push("identity_id = ?");
      params.push(options.identityId);
    }
    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options?.since) {
      const canonicalSince = validateIsoUtcTimestamp(options.since, "since");
      conditions.push("started_at >= ?");
      params.push(canonicalSince);
    }
    if (options?.until) {
      const canonicalUntil = validateIsoUtcTimestamp(options.until, "until");
      conditions.push("started_at <= ?");
      params.push(canonicalUntil);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY started_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      hostId: String(row.host_id),
      identityId: (row.identity_id as string | null) ?? null,
      status: String(row.status),
      startedAt: String(row.started_at),
      lastActiveAt: (row.last_active_at as string | null) ?? null,
      closedAt: (row.closed_at as string | null) ?? null,
      endedAt: (row.ended_at as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      provider: (row.provider as string | null) ?? null,
      durationMs: (row.duration_ms as number | null) ?? null,
      inputTokens: (row.input_tokens as number | null) ?? null,
      promptTokens: (row.prompt_tokens as number | null) ?? null,
      outputTokens: (row.output_tokens as number | null) ?? null,
      completionTokens: (row.completion_tokens as number | null) ?? null,
      cacheReadTokens: (row.cache_read_tokens as number | null) ?? null,
      cacheWriteTokens: (row.cache_write_tokens as number | null) ?? null,
      reasoningTokens: (row.reasoning_tokens as number | null) ?? null,
      totalTokens: (row.total_tokens as number | null) ?? null,
      costMicros: (row.cost_micros as number | null) ?? null,
      costEstimate: (row.cost_estimate as number | null) ?? null,
      costTrust: (row.cost_trust as "exact" | "estimated" | "unknown" | null) ?? null,
      contextBps: (row.context_bps as number | null) ?? null,
      toolCallsCount: (row.tool_calls_count as number | null) ?? null,
      errorCount: (row.error_count as number | null) ?? null,
      exitCode: (row.exit_code as number | null) ?? null,
      collectedAt: (row.collected_at as string | null) ?? null,
      source: (row.source as string | null) ?? null,
      sourceVersion: (row.source_version as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  deleteSessionSummary(sessionId: string, hostId?: string): boolean {
    validateOpaqueId(sessionId, "sessionId");
    if (hostId) {
      validateOpaqueId(hostId, "hostId");
      const result = this.db
        .query("DELETE FROM observatory_sessions WHERE host_id = ? AND session_id = ?")
        .run(hostId, sessionId);
      return result.changes > 0;
    }
    const result = this.db
      .query("DELETE FROM observatory_sessions WHERE session_id = ?")
      .run(sessionId);
    return result.changes > 0;
  }

  // ==========================================
  // Events & Deduplication
  // ==========================================

  findRecentEventByFingerprint(fingerprint: string): StoredObservatoryEvent | null {
    validateSafeString(fingerprint, "fingerprint", 256, true);

    const row = this.db
      .query<{
        event_id: string;
        event_type: string;
        severity: string;
        fingerprint: string;
        occurred_at: string;
        host_id: string | null;
        identity_id: string | null;
        session_id: string | null;
        provider: string | null;
        identity_kind: string | null;
        account_id: string | null;
        bucket_id: string | null;
        window_id: string | null;
        meter: string | null;
        model: string | null;
        tier: string | null;
        created_at: string;
      }, [string]>("SELECT * FROM observatory_events WHERE fingerprint = ? LIMIT 1")
      .get(fingerprint);

    if (!row) return null;

    return {
      eventId: row.event_id,
      eventType: row.event_type as ObservatoryEventType,
      severity: row.severity as EventSeverity,
      fingerprint: row.fingerprint,
      occurredAt: row.occurred_at,
      hostId: row.host_id,
      identityId: row.identity_id,
      sessionId: row.session_id,
      provider: row.provider,
      identityKind: (row.identity_kind as ProviderIdentityKind | null) ?? null,
      accountId: row.account_id,
      bucketId: row.bucket_id,
      windowId: row.window_id,
      meter: row.meter,
      model: row.model,
      tier: row.tier,
      createdAt: row.created_at,
    };
  }

  recordEvent(
    rawCandidate: ObservatoryEventCandidate,
  ): { event: StoredObservatoryEvent; isDuplicate: boolean } {
    const candidate = validateObservatoryEventCandidate(rawCandidate);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const existing = this.findRecentEventByFingerprint(candidate.fingerprint);

      if (existing) {
        return {
          event: existing,
          isDuplicate: true,
        };
      }

      const eventId = candidate.eventId ?? randomUUID().replace(/-/g, "");

      this.db
        .query(`
          INSERT INTO observatory_events (
            event_id, event_type, severity, fingerprint, occurred_at,
            host_id, identity_id, session_id, provider,
            identity_kind, account_id, bucket_id, window_id, meter,
            model, tier, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          eventId,
          candidate.eventType,
          candidate.severity,
          candidate.fingerprint,
          candidate.occurredAt,
          candidate.hostId ?? null,
          candidate.identityId ?? null,
          candidate.sessionId ?? null,
          candidate.provider ?? null,
          candidate.identityKind ?? null,
          candidate.accountId ?? null,
          candidate.bucketId ?? null,
          candidate.windowId ?? null,
          candidate.meter ?? null,
          candidate.model ?? null,
          candidate.tier ?? null,
          now,
        );

      return {
        event: {
          ...candidate,
          eventId,
          createdAt: now,
        },
        isDuplicate: false,
      };
    })();
  }

  getEvent(eventId: string): StoredObservatoryEvent | null {
    validateOpaqueId(eventId, "eventId");
    const row = this.db
      .query<{
        event_id: string;
        event_type: string;
        severity: string;
        fingerprint: string;
        occurred_at: string;
        host_id: string | null;
        identity_id: string | null;
        session_id: string | null;
        provider: string | null;
        identity_kind: string | null;
        account_id: string | null;
        bucket_id: string | null;
        window_id: string | null;
        meter: string | null;
        model: string | null;
        tier: string | null;
        created_at: string;
      }, [string]>("SELECT * FROM observatory_events WHERE event_id = ?")
      .get(eventId);

    if (!row) return null;

    return {
      eventId: row.event_id,
      eventType: row.event_type as ObservatoryEventType,
      severity: row.severity as EventSeverity,
      fingerprint: row.fingerprint,
      occurredAt: row.occurred_at,
      hostId: row.host_id,
      identityId: row.identity_id,
      sessionId: row.session_id,
      provider: row.provider,
      identityKind: (row.identity_kind as ProviderIdentityKind | null) ?? null,
      accountId: row.account_id,
      bucketId: row.bucket_id,
      windowId: row.window_id,
      meter: row.meter,
      model: row.model,
      tier: row.tier,
      createdAt: row.created_at,
    };
  }

  listEvents(options?: {
    eventType?: ObservatoryEventType | string;
    severity?: EventSeverity;
    hostId?: string;
    identityId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): StoredObservatoryEvent[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_events";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.eventType) {
      conditions.push("event_type = ?");
      params.push(options.eventType);
    }
    if (options?.severity) {
      conditions.push("severity = ?");
      params.push(options.severity);
    }
    if (options?.hostId) {
      conditions.push("host_id = ?");
      params.push(options.hostId);
    }
    if (options?.identityId) {
      conditions.push("identity_id = ?");
      params.push(options.identityId);
    }
    if (options?.since) {
      const canonicalSince = validateIsoUtcTimestamp(options.since, "since");
      conditions.push("occurred_at >= ?");
      params.push(canonicalSince);
    }
    if (options?.until) {
      const canonicalUntil = validateIsoUtcTimestamp(options.until, "until");
      conditions.push("occurred_at <= ?");
      params.push(canonicalUntil);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY occurred_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      eventId: String(row.event_id),
      eventType: row.event_type as ObservatoryEventType,
      severity: row.severity as EventSeverity,
      fingerprint: String(row.fingerprint),
      occurredAt: String(row.occurred_at),
      hostId: (row.host_id as string | null) ?? null,
      identityId: (row.identity_id as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
      provider: (row.provider as string | null) ?? null,
      identityKind: (row.identity_kind as ProviderIdentityKind | null) ?? null,
      accountId: (row.account_id as string | null) ?? null,
      bucketId: (row.bucket_id as string | null) ?? null,
      windowId: (row.window_id as string | null) ?? null,
      meter: (row.meter as string | null) ?? null,
      model: (row.model as string | null) ?? null,
      tier: (row.tier as string | null) ?? null,
      createdAt: String(row.created_at),
    }));
  }

  // ==========================================
  // Notification Policies CRUD & Resolution
  // ==========================================

  upsertPolicy(rawInput: NotificationPolicyRule | EffectiveNotificationPolicy): StoredNotificationPolicy {
    const input = validateEffectiveNotificationPolicy(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const existing = this.db
        .query<{ created_at: string }, [string]>(
          "SELECT created_at FROM observatory_notification_policies WHERE target = ?",
        )
        .get(input.target);

      const createdAt = existing?.created_at ?? now;

      this.db
        .query(`
          INSERT INTO observatory_notification_policies (
            policy_id, target, enabled, silenced, telegram_immediate,
            dashboard_only, min_severity, thresholds_json,
            consecutive_failures_threshold, cooldown_minutes,
            throttle_interval_ms, channels_json, quiet_hours_enabled,
            quiet_hours_timezone, quiet_hours_start, quiet_hours_end,
            critical_bypass_quiet_hours, digest_enabled, digest_schedule,
            digest_timezone, recipient, match_event_types_json,
            match_host_ids_json, match_identity_ids_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(target) DO UPDATE SET
            policy_id = excluded.policy_id,
            enabled = excluded.enabled,
            silenced = excluded.silenced,
            telegram_immediate = excluded.telegram_immediate,
            dashboard_only = excluded.dashboard_only,
            min_severity = excluded.min_severity,
            thresholds_json = excluded.thresholds_json,
            consecutive_failures_threshold = excluded.consecutive_failures_threshold,
            cooldown_minutes = excluded.cooldown_minutes,
            throttle_interval_ms = excluded.throttle_interval_ms,
            channels_json = excluded.channels_json,
            quiet_hours_enabled = excluded.quiet_hours_enabled,
            quiet_hours_timezone = excluded.quiet_hours_timezone,
            quiet_hours_start = excluded.quiet_hours_start,
            quiet_hours_end = excluded.quiet_hours_end,
            critical_bypass_quiet_hours = excluded.critical_bypass_quiet_hours,
            digest_enabled = excluded.digest_enabled,
            digest_schedule = excluded.digest_schedule,
            digest_timezone = excluded.digest_timezone,
            recipient = excluded.recipient,
            match_event_types_json = excluded.match_event_types_json,
            match_host_ids_json = excluded.match_host_ids_json,
            match_identity_ids_json = excluded.match_identity_ids_json,
            updated_at = excluded.updated_at
        `)
        .run(
          input.policyId,
          input.target,
          input.enabled ? 1 : 0,
          input.silenced ? 1 : 0,
          input.telegramImmediate ? 1 : 0,
          input.dashboardOnly ? 1 : 0,
          input.minSeverity,
          input.thresholds ? JSON.stringify(input.thresholds) : null,
          input.consecutiveFailuresThreshold ?? null,
          input.cooldownMinutes,
          input.throttleIntervalMs,
          JSON.stringify(input.channels),
          input.quietHoursEnabled ? 1 : 0,
          input.quietHoursTimezone,
          input.quietHoursStart ?? null,
          input.quietHoursEnd ?? null,
          input.criticalBypassQuietHours ? 1 : 0,
          input.digestEnabled ? 1 : 0,
          input.digestSchedule ?? null,
          input.digestTimezone,
          input.recipient ?? null,
          JSON.stringify(input.matchEventTypes),
          JSON.stringify(input.matchHostIds),
          JSON.stringify(input.matchIdentityIds),
          createdAt,
          input.updatedAt,
        );

      return {
        ...input,
        createdAt,
      };
    })();
  }

  getPolicy(target: string): StoredNotificationPolicy | null {
    validateSafeString(target, "target", 128, true);
    const row = this.db
      .query<{
        policy_id: string;
        target: string;
        enabled: number;
        silenced: number;
        telegram_immediate: number;
        dashboard_only: number;
        min_severity: string;
        thresholds_json: string | null;
        consecutive_failures_threshold: number | null;
        cooldown_minutes: number;
        throttle_interval_ms: number;
        channels_json: string;
        quiet_hours_enabled: number;
        quiet_hours_timezone: string;
        quiet_hours_start: string | null;
        quiet_hours_end: string | null;
        critical_bypass_quiet_hours: number;
        digest_enabled: number;
        digest_schedule: string | null;
        digest_timezone: string;
        recipient: string | null;
        match_event_types_json: string;
        match_host_ids_json: string;
        match_identity_ids_json: string;
        created_at: string;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_notification_policies WHERE target = ?")
      .get(target);

    if (!row) return null;

    return {
      policyId: row.policy_id,
      target: row.target,
      enabled: Boolean(row.enabled),
      silenced: Boolean(row.silenced),
      telegramImmediate: Boolean(row.telegram_immediate),
      dashboardOnly: Boolean(row.dashboard_only),
      minSeverity: row.min_severity as EventSeverity,
      thresholds: parseJsonSafe(row.thresholds_json, null),
      consecutiveFailuresThreshold: row.consecutive_failures_threshold,
      cooldownMinutes: row.cooldown_minutes,
      throttleIntervalMs: row.throttle_interval_ms,
      channels: parseJsonSafe(row.channels_json, []),
      quietHoursEnabled: Boolean(row.quiet_hours_enabled),
      quietHoursTimezone: row.quiet_hours_timezone,
      quietHoursStart: row.quiet_hours_start,
      quietHoursEnd: row.quiet_hours_end,
      criticalBypassQuietHours: Boolean(row.critical_bypass_quiet_hours),
      digestEnabled: Boolean(row.digest_enabled),
      digestSchedule: row.digest_schedule,
      digestTimezone: row.digest_timezone,
      recipient: row.recipient,
      matchEventTypes: parseJsonSafe(row.match_event_types_json, []),
      matchHostIds: parseJsonSafe(row.match_host_ids_json, []),
      matchIdentityIds: parseJsonSafe(row.match_identity_ids_json, []),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listPolicies(): StoredNotificationPolicy[] {
    const rows = this.db
      .query<Record<string, unknown>, []>(
        "SELECT * FROM observatory_notification_policies ORDER BY target ASC",
      )
      .all();

    return rows.map((row) => ({
      policyId: String(row.policy_id),
      target: String(row.target),
      enabled: Boolean(row.enabled),
      silenced: Boolean(row.silenced),
      telegramImmediate: Boolean(row.telegram_immediate),
      dashboardOnly: Boolean(row.dashboard_only),
      minSeverity: row.min_severity as EventSeverity,
      thresholds: parseJsonSafe(row.thresholds_json as string | null, null),
      consecutiveFailuresThreshold: (row.consecutive_failures_threshold as number | null) ?? null,
      cooldownMinutes: Number(row.cooldown_minutes),
      throttleIntervalMs: Number(row.throttle_interval_ms),
      channels: parseJsonSafe(row.channels_json as string, []),
      quietHoursEnabled: Boolean(row.quiet_hours_enabled),
      quietHoursTimezone: String(row.quiet_hours_timezone),
      quietHoursStart: (row.quiet_hours_start as string | null) ?? null,
      quietHoursEnd: (row.quiet_hours_end as string | null) ?? null,
      criticalBypassQuietHours: Boolean(row.critical_bypass_quiet_hours),
      digestEnabled: Boolean(row.digest_enabled),
      digestSchedule: (row.digest_schedule as string | null) ?? null,
      digestTimezone: String(row.digest_timezone),
      recipient: (row.recipient as string | null) ?? null,
      matchEventTypes: parseJsonSafe(row.match_event_types_json as string, []),
      matchHostIds: parseJsonSafe(row.match_host_ids_json as string, []),
      matchIdentityIds: parseJsonSafe(row.match_identity_ids_json as string, []),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  deletePolicy(policyId: string): boolean {
    validateOpaqueId(policyId, "policyId");
    const result = this.db
      .query("DELETE FROM observatory_notification_policies WHERE policy_id = ?")
      .run(policyId);
    return result.changes > 0;
  }
  resolveEffectivePolicy(
    target: string,
    defaults?: EffectiveNotificationPolicy,
  ): EffectiveNotificationPolicy {
    const exact = this.getPolicy(target);
    if (exact) return exact;

    if (target !== "default") {
      const fallback = this.getPolicy("default");
      if (fallback) return { ...fallback, target };
    }

    return defaults ?? {
      policyId: "default_fallback",
      target,
      enabled: true,
      silenced: false,
      telegramImmediate: true,
      dashboardOnly: false,
      minSeverity: "info",
      thresholds: null,
      consecutiveFailuresThreshold: null,
      cooldownMinutes: 15,
      throttleIntervalMs: 60000,
      channels: ["telegram"],
      quietHoursEnabled: false,
      quietHoursTimezone: "UTC",
      quietHoursStart: null,
      quietHoursEnd: null,
      criticalBypassQuietHours: true,
      digestEnabled: false,
      digestSchedule: null,
      digestTimezone: "UTC",
      recipient: null,
      matchEventTypes: [],
      matchHostIds: [],
      matchIdentityIds: [],
      updatedAt: new Date().toISOString(),
    };
  }


  // ==========================================
  // Digest Watermarks & Slot Claims
  // ==========================================

  getDigestWatermark(target: string): DigestWatermarkRecord | null {
    validateSafeString(target, "target", 128, true);
    const row = this.db
      .query<{
        target: string;
        last_digest_at: string;
        last_slot_key: string;
        watermark_event_id: string | null;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_digest_watermarks WHERE target = ?")
      .get(target);

    if (!row) return null;

    return {
      target: row.target,
      lastDigestAt: row.last_digest_at,
      lastSlotKey: row.last_slot_key,
      watermarkEventId: row.watermark_event_id,
      updatedAt: row.updated_at,
    };
  }

  claimDigestSlot(
    target: string,
    slotKey: string,
    slotTimeIso: string,
  ): {
    claimed: boolean;
    eventId: string | null;
    lastSlotKey: string | null;
    lastDigestAt: string | null;
  } {
    validateSafeString(target, "target", 128, true);
    validateSafeString(slotKey, "slotKey", 128, true);
    const slotTime = validateIsoUtcTimestamp(slotTimeIso, "slotTimeIso");
    const now = new Date().toISOString();
    const fingerprint = `digest_ready:${createHash("sha256")
      .update(`${target}\0${slotKey}`)
      .digest("hex")}`;

    return this.db.transaction(() => {
      const existing = this.getDigestWatermark(target);
      if (
        existing &&
        (existing.lastSlotKey === slotKey ||
          Date.parse(slotTime) <= Date.parse(existing.lastDigestAt))
      ) {
        return {
          claimed: false,
          eventId: existing.watermarkEventId ?? null,
          lastSlotKey: existing.lastSlotKey,
          lastDigestAt: existing.lastDigestAt,
        };
      }

      const eventId = randomUUID().replace(/-/g, "");
      const eventResult = this.db
        .query(`
          INSERT OR IGNORE INTO observatory_events (
            event_id, event_type, severity, fingerprint, occurred_at,
            created_at
          ) VALUES (?, 'digest_ready', 'info', ?, ?, ?)
        `)
        .run(
          eventId,
          fingerprint,
          slotTime,
          now,
        );

      if (eventResult.changes === 0) {
        const duplicate = this.findRecentEventByFingerprint(fingerprint);
        return {
          claimed: false,
          eventId: duplicate?.eventId ?? null,
          lastSlotKey: existing?.lastSlotKey ?? null,
          lastDigestAt: existing?.lastDigestAt ?? null,
        };
      }

      const watermarkResult = this.db
        .query(`
          INSERT INTO observatory_digest_watermarks (
            target, last_digest_at, last_slot_key, watermark_event_id, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(target) DO UPDATE SET
            last_digest_at = excluded.last_digest_at,
            last_slot_key = excluded.last_slot_key,
            watermark_event_id = excluded.watermark_event_id,
            updated_at = excluded.updated_at
          WHERE excluded.last_digest_at > observatory_digest_watermarks.last_digest_at
        `)
        .run(target, slotTime, slotKey, eventId, now);

      if (watermarkResult.changes === 0) {
        this.db.query("DELETE FROM observatory_events WHERE event_id = ?").run(eventId);
        const current = this.getDigestWatermark(target);
        return {
          claimed: false,
          eventId: current?.watermarkEventId ?? null,
          lastSlotKey: current?.lastSlotKey ?? null,
          lastDigestAt: current?.lastDigestAt ?? null,
        };
      }

      return {
        claimed: true,
        eventId,
        lastSlotKey: existing?.lastSlotKey ?? null,
        lastDigestAt: existing?.lastDigestAt ?? null,
      };
    })();
  }

  // ==========================================
  // Notification Deliveries Outbox with CAS Lease
  // ==========================================

  recordDeliveryAttempt(
    rawDelivery: NotificationDeliveryRecord,
  ): { delivery: StoredNotificationDelivery; isDuplicate: boolean } {
    const input = validateNotificationDeliveryRecord(rawDelivery);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const existing = this.db
        .query<{
          delivery_id: string;
          event_id: string;
          channel: string;
          status: string;
          attempt_count: number;
          fingerprint: string;
          lease_token: string | null;
          lease_expires_at: string | null;
          sent_at: string | null;
          error_category: string | null;
          last_attempt_at: string | null;
          provider_message_id: string | null;
          created_at: string;
          updated_at: string;
        }, [string, string]>(
          "SELECT * FROM observatory_notification_deliveries WHERE event_id = ? AND channel = ?",
        )
        .get(input.eventId, input.channel);

      if (existing) {
        return {
          delivery: {
            deliveryId: existing.delivery_id,
            eventId: existing.event_id,
            channel: existing.channel,
            status: existing.status as DeliveryStatus,
            attemptCount: existing.attempt_count,
            fingerprint: existing.fingerprint,
            leaseToken: existing.lease_token,
            leaseExpiresAt: existing.lease_expires_at,
            sentAt: existing.sent_at,
            errorCategory: existing.error_category,
            lastAttemptAt: existing.last_attempt_at,
            providerMessageId: existing.provider_message_id,
            createdAt: existing.created_at,
            updatedAt: existing.updated_at,
          },
          isDuplicate: true,
        };
      }

      const deliveryId = input.deliveryId ?? randomUUID().replace(/-/g, "");

      this.db
        .query(`
          INSERT INTO observatory_notification_deliveries (
            delivery_id, event_id, channel, status, attempt_count,
            fingerprint, lease_token, lease_expires_at, sent_at, error_category,
            last_attempt_at, provider_message_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          deliveryId,
          input.eventId,
          input.channel,
          input.status,
          input.attemptCount ?? 0,
          input.fingerprint,
          input.leaseToken ?? null,
          input.leaseExpiresAt ?? null,
          input.sentAt ?? null,
          input.errorCategory ?? null,
          input.lastAttemptAt ?? now,
          input.providerMessageId ?? null,
          now,
          now,
        );

      return {
        delivery: {
          ...input,
          deliveryId,
          attemptCount: input.attemptCount ?? 0,
          leaseToken: input.leaseToken ?? null,
          createdAt: now,
          updatedAt: now,
        },
        isDuplicate: false,
      };
    })();
  }

  claimDeliveryLease(
    channel: string,
    leaseDurationMs = 30000,
    maxRetries = 5,
    failedBefore?: string,
  ): StoredNotificationDelivery | null {
    validateSafeString(channel, "channel", 64, true);
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const failedCutoff = failedBefore
      ? validateIsoUtcTimestamp(failedBefore, "failedBefore")
      : null;
    const leaseToken = randomUUID();

    return this.db.transaction(() => {
      const candidate = this.db
        .query<{ delivery_id: string }, [string, string, number, string | null, string | null]>(`
          SELECT delivery_id FROM observatory_notification_deliveries
          WHERE channel = ?
            AND (
              status = 'pending'
              OR (status = 'sending' AND lease_expires_at < ?)
              OR (
                status = 'failed'
                AND attempt_count < ?
                AND (? IS NULL OR last_attempt_at < ?)
              )
            )
          ORDER BY created_at ASC
          LIMIT 1
        `)
        .get(channel, nowIso, maxRetries, failedCutoff, failedCutoff);

      if (!candidate) return null;

      const result = this.db
        .query(`
          UPDATE observatory_notification_deliveries
          SET status = 'sending',
              lease_token = ?,
              lease_expires_at = ?,
              attempt_count = attempt_count + 1,
              last_attempt_at = ?,
              updated_at = ?
          WHERE delivery_id = ?
        `)
        .run(leaseToken, leaseExpiresAt, nowIso, nowIso, candidate.delivery_id);

      if (result.changes === 0) return null;

      return this.getDelivery(candidate.delivery_id);
    })();
  }

  markDeliverySent(
    deliveryId: string,
    leaseToken: string,
    options?: { sentAt?: string; providerMessageId?: string },
  ): boolean {
    validateOpaqueId(deliveryId, "deliveryId");
    validateOpaqueId(leaseToken, "leaseToken");
    const nowIso = new Date().toISOString();
    const sentAt = options?.sentAt ? validateIsoUtcTimestamp(options.sentAt, "sentAt") : nowIso;
    const providerMessageId = options?.providerMessageId
      ? validateSafeString(options.providerMessageId, "providerMessageId", 128, false)
      : null;

    const result = this.db
      .query(`
        UPDATE observatory_notification_deliveries
        SET status = 'sent',
            sent_at = ?,
            provider_message_id = ?,
            lease_token = NULL,
            lease_expires_at = NULL,
            error_category = NULL,
            updated_at = ?
        WHERE delivery_id = ? AND status = 'sending' AND lease_token = ?
      `)
      .run(sentAt, providerMessageId, nowIso, deliveryId, leaseToken);

    return result.changes > 0;
  }

  markDeliveryFailed(
    deliveryId: string,
    leaseToken: string,
    options?: { errorCategory?: string; retryable?: boolean },
  ): boolean {
    validateOpaqueId(deliveryId, "deliveryId");
    validateOpaqueId(leaseToken, "leaseToken");
    const nowIso = new Date().toISOString();
    const errorCategory = options?.errorCategory
      ? validateSafeString(options.errorCategory, "errorCategory", 64, false)
      : "unknown";
    const nextStatus = options?.retryable !== false ? "failed" : "silenced";

    const result = this.db
      .query(`
        UPDATE observatory_notification_deliveries
        SET status = ?,
            error_category = ?,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE delivery_id = ? AND status = 'sending' AND lease_token = ?
      `)
      .run(nextStatus, errorCategory, nowIso, deliveryId, leaseToken);

    return result.changes > 0;
  }

  getDelivery(deliveryId: string): StoredNotificationDelivery | null {
    validateOpaqueId(deliveryId, "deliveryId");
    const row = this.db
      .query<{
        delivery_id: string;
        event_id: string;
        channel: string;
        status: string;
        attempt_count: number;
        fingerprint: string;
        lease_token: string | null;
        lease_expires_at: string | null;
        sent_at: string | null;
        error_category: string | null;
        last_attempt_at: string | null;
        provider_message_id: string | null;
        created_at: string;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_notification_deliveries WHERE delivery_id = ?")
      .get(deliveryId);

    if (!row) return null;

    return {
      deliveryId: row.delivery_id,
      eventId: row.event_id,
      channel: row.channel,
      status: row.status as DeliveryStatus,
      attemptCount: row.attempt_count,
      fingerprint: row.fingerprint,
      leaseToken: row.lease_token,
      leaseExpiresAt: row.lease_expires_at,
      sentAt: row.sent_at,
      errorCategory: row.error_category,
      lastAttemptAt: row.last_attempt_at,
      providerMessageId: row.provider_message_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listDeliveries(options?: {
    eventId?: string;
    channel?: string;
    status?: DeliveryStatus;
    limit?: number;
    offset?: number;
  }): StoredNotificationDelivery[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_notification_deliveries";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.eventId) {
      conditions.push("event_id = ?");
      params.push(options.eventId);
    }
    if (options?.channel) {
      conditions.push("channel = ?");
      params.push(options.channel);
    }
    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      deliveryId: String(row.delivery_id),
      eventId: String(row.event_id),
      channel: String(row.channel),
      status: row.status as DeliveryStatus,
      attemptCount: Number(row.attempt_count),
      fingerprint: String(row.fingerprint),
      leaseToken: (row.lease_token as string | null) ?? null,
      leaseExpiresAt: (row.lease_expires_at as string | null) ?? null,
      sentAt: (row.sent_at as string | null) ?? null,
      errorCategory: (row.error_category as string | null) ?? null,
      lastAttemptAt: (row.last_attempt_at as string | null) ?? null,
      providerMessageId: (row.provider_message_id as string | null) ?? null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  // ==========================================
  // Ingestion Nonce Claims (Replay Prevention)
  // ==========================================

  claimNonce(rawInput: NonceClaimInput): { claimed: boolean; existing?: StoredNonce } {
    const input = validateNonceClaimInput(rawInput);
    const serverNow = new Date().toISOString();

    return this.db.transaction(() => {
      const existing = this.db
        .query<{
          nonce: string;
          scope: string;
          host_id: string | null;
          claimed_at: string;
          expires_at: string;
        }, [string, string]>(
          "SELECT * FROM observatory_ingestion_nonces WHERE nonce = ? AND scope = ?",
        )
        .get(input.nonce, input.scope);

      if (existing) {
        if (Date.parse(existing.expires_at) > Date.parse(serverNow)) {
          return {
            claimed: false,
            existing: {
              nonce: existing.nonce,
              scope: existing.scope,
              hostId: existing.host_id,
              claimedAt: existing.claimed_at,
              expiresAt: existing.expires_at,
            },
          };
        }

        this.db
          .query(`
            UPDATE observatory_ingestion_nonces
            SET host_id = ?, claimed_at = ?, expires_at = ?
            WHERE nonce = ? AND scope = ?
          `)
          .run(input.hostId ?? null, serverNow, input.expiresAt, input.nonce, input.scope);

        return { claimed: true };
      }

      this.db
        .query(`
          INSERT INTO observatory_ingestion_nonces (
            nonce, scope, host_id, claimed_at, expires_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(input.nonce, input.scope, input.hostId ?? null, serverNow, input.expiresAt);

      return { claimed: true };
    })();
  }

  isNonceClaimed(nonce: string, scope: string, serverNow?: string): boolean {
    validateOpaqueId(nonce, "nonce");
    validateSafeString(scope, "scope", 64, true);
    const now = serverNow ? validateIsoUtcTimestamp(serverNow, "serverNow") : new Date().toISOString();

    const row = this.db
      .query<{ expires_at: string }, [string, string]>(
        "SELECT expires_at FROM observatory_ingestion_nonces WHERE nonce = ? AND scope = ?",
      )
      .get(nonce, scope);

    if (!row) return false;
    return Date.parse(row.expires_at) > Date.parse(now);
  }

  // ==========================================
  // Collector Batches Ledger
  // ==========================================

  claimCollectorBatch(rawInput: CollectorBatchClaimInput): CollectorBatchClaimResult {
    const input = validateCollectorBatchClaimInput(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction((): CollectorBatchClaimResult => {
      const hostExists = this.db
        .query<{ host_id: string }, [string]>(
          "SELECT host_id FROM observatory_hosts WHERE host_id = ?",
        )
        .get(input.hostId);

      if (!hostExists) {
        this.upsertHost({
          hostId: input.hostId,
          observedAt: input.receivedAt ?? now,
          status: "online",
        });
      }

      const existing = this.db
        .query<{
          host_id: string;
          batch_id: string;
          body_sha256: string;
          key_id: string;
          received_at: string;
          status: string;
          created_at: string;
        }, [string, string]>(
          "SELECT * FROM observatory_collector_batches WHERE host_id = ? AND batch_id = ?",
        )
        .get(input.hostId, input.batchId);

      if (existing) {
        const storedBatch: StoredCollectorBatch = {
          hostId: existing.host_id,
          batchId: existing.batch_id,
          bodySha256: existing.body_sha256,
          keyId: existing.key_id,
          receivedAt: existing.received_at,
          status: existing.status as "accepted" | "rejected",
          createdAt: existing.created_at,
        };

        if (
          existing.body_sha256 === input.bodySha256 &&
          existing.key_id === input.keyId
        ) {
          return {
            outcome: "duplicate",
            batch: storedBatch,
          };
        }

        return {
          outcome: "conflict",
          batch: storedBatch,
        };
      }

      const receivedAt = input.receivedAt ?? now;
      const status = input.status ?? "accepted";

      this.db
        .query(`
          INSERT INTO observatory_collector_batches (
            host_id, batch_id, body_sha256, key_id, received_at, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.hostId,
          input.batchId,
          input.bodySha256,
          input.keyId,
          receivedAt,
          status,
          now,
        );

      const batch: StoredCollectorBatch = {
        hostId: input.hostId,
        batchId: input.batchId,
        bodySha256: input.bodySha256,
        keyId: input.keyId,
        receivedAt,
        status,
        createdAt: now,
      };

      return {
        outcome: "new",
        batch,
      };
    })();
  }

  getCollectorBatch(hostId: string, batchId: string): StoredCollectorBatch | null {
    validateOpaqueId(hostId, "hostId");
    validateOpaqueId(batchId, "batchId");

    const row = this.db
      .query<{
        host_id: string;
        batch_id: string;
        body_sha256: string;
        key_id: string;
        received_at: string;
        status: string;
        created_at: string;
      }, [string, string]>(
        "SELECT * FROM observatory_collector_batches WHERE host_id = ? AND batch_id = ?",
      )
      .get(hostId, batchId);

    if (!row) return null;

    return {
      hostId: row.host_id,
      batchId: row.batch_id,
      bodySha256: row.body_sha256,
      keyId: row.key_id,
      receivedAt: row.received_at,
      status: row.status as "accepted" | "rejected",
      createdAt: row.created_at,
    };
  }

  listCollectorBatches(options?: {
    hostId?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): StoredCollectorBatch[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_collector_batches";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.hostId) {
      conditions.push("host_id = ?");
      params.push(options.hostId);
    }
    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY received_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      hostId: String(row.host_id),
      batchId: String(row.batch_id),
      bodySha256: String(row.body_sha256),
      keyId: String(row.key_id),
      receivedAt: String(row.received_at),
      status: row.status as "accepted" | "rejected",
      createdAt: String(row.created_at),
    }));
  }

  // ==========================================
  // Audit Ledger
  // ==========================================

  recordAuditEntry(rawEntry: ObservatoryAuditEntry): StoredAuditEntry {
    const input = validateAuditEntryInput(rawEntry);
    const now = new Date().toISOString();
    const auditId = input.auditId ?? randomUUID().replace(/-/g, "");
    this.db
      .query(`
        INSERT INTO observatory_audit (
          audit_id, action, actor, target_type, target_id,
          occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        auditId,
        input.action,
        input.actor,
        input.targetType,
        input.targetId,
        input.occurredAt,
        now,
      );

    return {
      ...input,
      auditId,
      createdAt: now,
    };
  }

  listAuditEntries(options?: {
    action?: string;
    actor?: string;
    targetType?: string;
    targetId?: string;
    since?: string;
    limit?: number;
    offset?: number;
  }): StoredAuditEntry[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_audit";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.action) {
      conditions.push("action = ?");
      params.push(options.action);
    }
    if (options?.actor) {
      conditions.push("actor = ?");
      params.push(options.actor);
    }
    if (options?.targetType) {
      conditions.push("target_type = ?");
      params.push(options.targetType);
    }
    if (options?.targetId) {
      conditions.push("target_id = ?");
      params.push(options.targetId);
    }
    if (options?.since) {
      const canonicalSince = validateIsoUtcTimestamp(options.since, "since");
      conditions.push("occurred_at >= ?");
      params.push(canonicalSince);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY occurred_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      auditId: String(row.audit_id),
      action: String(row.action),
      actor: String(row.actor),
      targetType: String(row.target_type),
      targetId: String(row.target_id),
      occurredAt: String(row.occurred_at),
      createdAt: String(row.created_at),
    }));
  }

  // ==========================================
  // Import Ledger
  // ==========================================

  recordImportBatch(rawBatch: ImportLedgerEntry): StoredImportLedgerEntry {
    const input = validateImportLedgerEntry(rawBatch);
    const now = new Date().toISOString();

    return this.db.transaction((): StoredImportLedgerEntry => {
      const existing = this.db
        .query<{
          batch_id: string;
          source: string;
          imported_at: string;
          record_count: number;
          status: string;
          details_json: string | null;
          created_at: string;
        }, [string]>(
          "SELECT * FROM observatory_import_ledger WHERE batch_id = ?",
        )
        .get(input.batchId);

      if (existing) {
        if (existing.status === "completed") {
          // Completed batches are immutable: return actual stored row
          return {
            batchId: existing.batch_id,
            source: existing.source,
            importedAt: existing.imported_at,
            recordCount: existing.record_count,
            status: "completed",
            createdAt: existing.created_at,
          };
        }

        this.db
          .query(`
            UPDATE observatory_import_ledger
            SET source = ?, imported_at = ?, record_count = ?, status = ?
            WHERE batch_id = ?
          `)
          .run(
            input.source,
            input.importedAt,
            input.recordCount,
            input.status,
            input.batchId,
          );
        return {
          ...input,
          createdAt: existing.created_at,
        };
      }

      this.db
        .query(`
          INSERT INTO observatory_import_ledger (
            batch_id, source, imported_at, record_count, status,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.batchId,
          input.source,
          input.importedAt,
          input.recordCount,
          input.status,
          now,
        );
      return {
        ...input,
        createdAt: now,
      };
    })();
  }

  updateImportBatchStatus(
    batchId: string,
    status: "pending" | "completed" | "failed",
  ): boolean {
    validateOpaqueId(batchId, "batchId");
    const sql = "UPDATE observatory_import_ledger SET status = ? WHERE batch_id = ?";
    const params: Array<string | null> = [status, batchId];
    const result = this.db.query(sql).run(...params);
    return result.changes > 0;
  }

  getImportBatch(batchId: string): StoredImportLedgerEntry | null {
    validateOpaqueId(batchId, "batchId");
    const row = this.db
      .query<{
        batch_id: string;
        source: string;
        imported_at: string;
        record_count: number;
        status: string;
        details_json: string | null;
        created_at: string;
      }, [string]>("SELECT * FROM observatory_import_ledger WHERE batch_id = ?")
      .get(batchId);

    if (!row) return null;

    return {
      batchId: row.batch_id,
      source: row.source,
      importedAt: row.imported_at,
      recordCount: row.record_count,
      status: row.status as "pending" | "completed" | "failed",
      createdAt: row.created_at,
    };
  }

  listImportBatches(options?: {
    source?: string;
    status?: string;
    limit?: number;
  }): StoredImportLedgerEntry[] {
    const { limit } = validatePagination(options);
    let sql = "SELECT * FROM observatory_import_ledger";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.source) {
      conditions.push("source = ?");
      params.push(options.source);
    }
    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY imported_at DESC LIMIT ?";
    params.push(limit);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      batchId: String(row.batch_id),
      source: String(row.source),
      importedAt: String(row.imported_at),
      recordCount: Number(row.record_count),
      status: row.status as "pending" | "completed" | "failed",
      createdAt: String(row.created_at),
    }));
  }

  importLegacySnapshot(input: LegacyImportSnapshotInput): LegacyImportSnapshotResult {
    const batchId = validateOpaqueId(input.batchId, "batchId");
    const source = validateSafeString(input.source, "source", 64, true)!;
    const sourceVersion = validateSafeString(input.sourceVersion, "sourceVersion", 64, true)!;
    const importedAt = validateIsoUtcTimestamp(input.importedAt, "importedAt");
    if (!/^[a-f0-9]{64}$/i.test(input.snapshotSha256)) {
      throw new Error("snapshotSha256 must be a 64-character hexadecimal SHA-256 digest");
    }
    const snapshotSha256 = input.snapshotSha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/i.test(input.keyId)) {
      throw new Error("keyId must be a 64-character hexadecimal SHA-256 key identifier");
    }
    const keyId = input.keyId.toLowerCase();
    if (!/^[a-f0-9]{64}$/i.test(input.projectionSha256)) {
      throw new Error("projectionSha256 must be a 64-character hexadecimal SHA-256 digest");
    }
    const batchProjectionSha256 = input.projectionSha256.toLowerCase();

    const projectedRows: LegacyProjectedRow[] = input.projectedRows.map((row) => {
      validateSafeString(row.sourceTable, "sourceTable", 64, true);
      if (!/^[a-f0-9]{64}$/i.test(row.sourceKeyHmac)) {
        throw new Error("sourceKeyHmac must be a 64-character hexadecimal HMAC-SHA256 digest");
      }
      if (!/^[a-f0-9]{64}$/i.test(row.projectionSha256)) {
        throw new Error("projectionSha256 must be a 64-character hexadecimal SHA-256 digest");
      }
      switch (row.destinationKind) {
        case "account":
          return { ...row, value: validateObservatoryAgentRouterAccount(row.value) };
        case "run":
          return { ...row, value: validateObservatoryAgentRouterRun(row.value) };
        case "usage":
          return { ...row, value: validateObservatoryAgentRouterUsagePoint(row.value) };
        case "balance":
          return { ...row, value: validateObservatoryAgentRouterBalanceObservation(row.value) };
        case "grant":
          return { ...row, value: validateObservatoryAgentRouterGrantEvent(row.value) };
        case "endpoint":
          return { ...row, value: validateObservatoryAgentRouterEndpointObservation(row.value) };
      }
    });

    return this.db.transaction((): LegacyImportSnapshotResult => {
      const existingBatch = this.db
        .query<{
          snapshot_sha256: string | null;
          source_version: string | null;
          key_id: string | null;
          projection_sha256: string | null;
          status: string;
        }, [string]>(
          "SELECT snapshot_sha256, source_version, key_id, projection_sha256, status FROM observatory_import_ledger WHERE batch_id = ?",
        )
        .get(batchId);

      if (existingBatch?.status === "completed") {
        const countRow = this.db
          .query<{ count: number }, [string]>(
            "SELECT COUNT(*) AS count FROM observatory_import_batch_items WHERE batch_id = ?",
          )
          .get(batchId);
        let exactItems = (countRow?.count ?? 0) === projectedRows.length;
        let conflictSourceKeyHmac: string | undefined;
        for (const row of projectedRows) {
          const existingItem = this.db
            .query<{ projection_sha256: string }, [string, string, string, string]>(
              "SELECT projection_sha256 FROM observatory_import_batch_items WHERE batch_id = ? AND source = ? AND source_table = ? AND source_key_hmac = ?",
            )
            .get(batchId, source, row.sourceTable, row.sourceKeyHmac.toLowerCase());
          if (!existingItem || existingItem.projection_sha256 !== row.projectionSha256.toLowerCase()) {
            exactItems = false;
            conflictSourceKeyHmac = row.sourceKeyHmac;
            break;
          }
        }
        const identical =
          existingBatch.snapshot_sha256 === snapshotSha256 &&
          existingBatch.source_version === sourceVersion &&
          existingBatch.key_id === keyId &&
          existingBatch.projection_sha256 === batchProjectionSha256 &&
          exactItems;
        return {
          outcome: identical ? "duplicate" : "conflict",
          batchId,
          itemCount: identical ? projectedRows.length : 0,
          ...(conflictSourceKeyHmac ? { conflictSourceKeyHmac } : {}),
        };
      }

      for (const row of projectedRows) {
        const existingItem = this.db
          .query<{ projection_sha256: string }, [string, string, string]>(
            "SELECT projection_sha256 FROM observatory_import_items WHERE source = ? AND source_table = ? AND source_key_hmac = ?",
          )
          .get(source, row.sourceTable, row.sourceKeyHmac.toLowerCase());
        if (existingItem && existingItem.projection_sha256 !== row.projectionSha256.toLowerCase()) {
          return {
            outcome: "conflict",
            batchId,
            itemCount: 0,
            conflictSourceKeyHmac: row.sourceKeyHmac,
          };
        }
      }

      const now = new Date().toISOString();
      this.db
        .query(`
          INSERT INTO observatory_import_ledger (
            batch_id, source, snapshot_sha256, source_version, key_id,
            projection_sha256, imported_at, record_count, status,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
          ON CONFLICT(batch_id) DO UPDATE SET
            source = excluded.source,
            snapshot_sha256 = excluded.snapshot_sha256,
            source_version = excluded.source_version,
            key_id = excluded.key_id,
            projection_sha256 = excluded.projection_sha256,
            imported_at = excluded.imported_at,
            record_count = excluded.record_count,
            status = 'pending'
        `)
        .run(
          batchId,
          source,
          snapshotSha256,
          sourceVersion,
          keyId,
          batchProjectionSha256,
          importedAt,
          projectedRows.length,
          now,
        );

      let importedCount = 0;
      for (const row of projectedRows) {
        const existingItem = this.db
          .query<{ projection_sha256: string }, [string, string, string]>(
            "SELECT projection_sha256 FROM observatory_import_items WHERE source = ? AND source_table = ? AND source_key_hmac = ?",
          )
          .get(source, row.sourceTable, row.sourceKeyHmac.toLowerCase());

        let destinationId: string | null = null;
        if (!existingItem) {
          switch (row.destinationKind) {
            case "account":
              destinationId = this.upsertAgentRouterAccount(row.value).accountId;
              break;
            case "run":
              destinationId = String(this.recordAgentRouterRun(row.value).id);
              break;
            case "usage":
              destinationId = String(this.recordAgentRouterUsagePoint(row.value).id);
              break;
            case "balance":
              destinationId = String(this.recordAgentRouterBalanceObservation(row.value).id);
              break;
            case "grant":
              destinationId = String(this.recordAgentRouterGrantEvent(row.value).id);
              break;
            case "endpoint":
              destinationId = String(this.recordAgentRouterEndpointObservation(row.value).id);
              break;
          }

          this.db
            .query(`
              INSERT INTO observatory_import_items (
                batch_id, source, source_table, source_key_hmac,
                projection_sha256, destination_kind, destination_id, imported_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              batchId,
              source,
              row.sourceTable,
              row.sourceKeyHmac.toLowerCase(),
              row.projectionSha256.toLowerCase(),
              row.destinationKind,
              destinationId,
              importedAt,
            );
          importedCount += 1;
        }

        this.db
          .query(`
            INSERT INTO observatory_import_batch_items (
              batch_id, source, source_table, source_key_hmac, projection_sha256
            ) VALUES (?, ?, ?, ?, ?)
          `)
          .run(
            batchId,
            source,
            row.sourceTable,
            row.sourceKeyHmac.toLowerCase(),
            row.projectionSha256.toLowerCase(),
          );
      }

      this.db
        .query("UPDATE observatory_import_ledger SET status = 'completed' WHERE batch_id = ?")
        .run(batchId);

      return {
        outcome: "imported",
        batchId,
        itemCount: importedCount,
      };
    })();
  }

  listLegacyImportItems(source: string): StoredLegacyImportItem[] {
    const safeSource = validateSafeString(source, "source", 64, true)!;
    const rows = this.db
      .query<Record<string, unknown>, [string]>(
        "SELECT * FROM observatory_import_items WHERE source = ? ORDER BY source_table, source_key_hmac",
      )
      .all(safeSource);
    return rows.map((row) => ({
      batchId: String(row.batch_id),
      source: String(row.source),
      sourceTable: String(row.source_table),
      sourceKeyHmac: String(row.source_key_hmac),
      projectionSha256: String(row.projection_sha256),
      destinationKind: row.destination_kind as StoredLegacyImportItem["destinationKind"],
      destinationId: (row.destination_id as string | null) ?? null,
      importedAt: String(row.imported_at),
    }));
  }

  // ==========================================
  // AgentRouter Entities CRUD & Idempotent Import
  // ==========================================

  upsertAgentRouterAccount(rawInput: ObservatoryAgentRouterAccount): StoredAgentRouterAccount {
    const input = validateObservatoryAgentRouterAccount(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const existing = this.db
        .query<{ created_at: string }, [string]>(
          "SELECT created_at FROM observatory_agentrouter_accounts WHERE account_id = ?",
        )
        .get(input.accountId);

      const createdAt = existing?.created_at ?? input.createdAt ?? now;
      const updatedAt = input.updatedAt ?? now;

      this.db
        .query(`
          INSERT INTO observatory_agentrouter_accounts (
            account_id, account_label, created_at, updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            account_label = excluded.account_label,
            updated_at = excluded.updated_at
        `)
        .run(
          input.accountId,
          input.accountLabel,
          createdAt,
          updatedAt,
        );

      return {
        ...input,
        createdAt,
        updatedAt,
      };
    })();
  }

  getAgentRouterAccount(accountId: string): StoredAgentRouterAccount | null {
    validateOpaqueId(accountId, "accountId");
    const row = this.db
      .query<{
        account_id: string;
        account_label: string;
        created_at: string;
        updated_at: string;
      }, [string]>("SELECT * FROM observatory_agentrouter_accounts WHERE account_id = ?")
      .get(accountId);

    if (!row) return null;

    return {
      accountId: row.account_id,
      accountLabel: row.account_label,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listAgentRouterAccounts(): StoredAgentRouterAccount[] {
    const rows = this.db
      .query<Record<string, unknown>, []>(
        "SELECT * FROM observatory_agentrouter_accounts ORDER BY account_label ASC",
      )
      .all();

    return rows.map((row) => ({
      accountId: String(row.account_id),
      accountLabel: String(row.account_label),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  deleteAgentRouterAccount(accountId: string): boolean {
    validateOpaqueId(accountId, "accountId");
    const result = this.db
      .query("DELETE FROM observatory_agentrouter_accounts WHERE account_id = ?")
      .run(accountId);
    return result.changes > 0;
  }

  recordAgentRouterRun(rawInput: ObservatoryAgentRouterRun): StoredAgentRouterRun {
    const input = validateObservatoryAgentRouterRun(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      // Ensure account exists to satisfy FK
      const acctExists = this.db
        .query<{ account_id: string }, [string]>(
          "SELECT account_id FROM observatory_agentrouter_accounts WHERE account_id = ?",
        )
        .get(input.accountId);

      if (!acctExists) {
        this.upsertAgentRouterAccount({
          accountId: input.accountId,
          accountLabel: input.accountLabel,
        });
      }

      let runId = input.id;
      let createdAt = now;

      if (runId !== undefined) {
        const row = this.db
          .query<{ id: number; created_at: string }, Array<string | number | null>>(`
            INSERT INTO observatory_agentrouter_check_runs (
              id, account_id, account_label, started_at, ended_at, status,
              login_ms, dashboard_ms, total_ms, logged_out, session_reused,
              error_category, balance, consumed, request_count, quota_per_unit,
              average_rpm, average_tpm, available_models, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              account_id = excluded.account_id,
              account_label = excluded.account_label,
              started_at = excluded.started_at,
              ended_at = excluded.ended_at,
              status = excluded.status,
              login_ms = excluded.login_ms,
              dashboard_ms = excluded.dashboard_ms,
              total_ms = excluded.total_ms,
              logged_out = excluded.logged_out,
              session_reused = excluded.session_reused,
              error_category = excluded.error_category,
              balance = excluded.balance,
              consumed = excluded.consumed,
              request_count = excluded.request_count,
              quota_per_unit = excluded.quota_per_unit,
              average_rpm = excluded.average_rpm,
              average_tpm = excluded.average_tpm,
              available_models = excluded.available_models
            RETURNING id, created_at
          `)
          .get(
            runId,
            input.accountId,
            input.accountLabel,
            input.startedAt,
            input.endedAt,
            input.status,
            input.loginMs,
            input.dashboardMs,
            input.totalMs,
            input.loggedOut ? 1 : 0,
            input.sessionReused ? 1 : 0,
            input.errorCategory ?? null,
            input.balance ?? null,
            input.consumed ?? null,
            input.requestCount ?? null,
            input.quotaPerUnit ?? null,
            input.averageRpm ?? null,
            input.averageTpm ?? null,
            input.availableModels ?? null,
            now,
          );

        if (row) {
          runId = row.id;
          createdAt = row.created_at;
        }
      } else {
        const row = this.db
          .query<{ id: number; created_at: string }, Array<string | number | null>>(`
            INSERT INTO observatory_agentrouter_check_runs (
              account_id, account_label, started_at, ended_at, status,
              login_ms, dashboard_ms, total_ms, logged_out, session_reused,
              error_category, balance, consumed, request_count, quota_per_unit,
              average_rpm, average_tpm, available_models, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id, created_at
          `)
          .get(
            input.accountId,
            input.accountLabel,
            input.startedAt,
            input.endedAt,
            input.status,
            input.loginMs,
            input.dashboardMs,
            input.totalMs,
            input.loggedOut ? 1 : 0,
            input.sessionReused ? 1 : 0,
            input.errorCategory ?? null,
            input.balance ?? null,
            input.consumed ?? null,
            input.requestCount ?? null,
            input.quotaPerUnit ?? null,
            input.averageRpm ?? null,
            input.averageTpm ?? null,
            input.availableModels ?? null,
            now,
          );
        if (row) {
          runId = row.id;
          createdAt = row.created_at;
        }
      }

      return {
        ...input,
        id: runId!,
        createdAt,
      };
    })();
  }

  getAgentRouterRun(id: number): StoredAgentRouterRun | null {
    const row = this.db
      .query<{
        id: number;
        account_id: string;
        account_label: string;
        started_at: string;
        ended_at: string;
        status: string;
        login_ms: number;
        dashboard_ms: number;
        total_ms: number;
        logged_out: number;
        session_reused: number;
        error_category: string | null;
        balance: number | null;
        consumed: number | null;
        request_count: number | null;
        quota_per_unit: number | null;
        average_rpm: number | null;
        average_tpm: number | null;
        available_models: number | null;
        created_at: string;
      }, [number]>("SELECT * FROM observatory_agentrouter_check_runs WHERE id = ?")
      .get(id);

    if (!row) return null;

    return {
      id: row.id,
      accountId: row.account_id,
      accountLabel: row.account_label,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      status: row.status as "ok" | "error",
      loginMs: row.login_ms,
      dashboardMs: row.dashboard_ms,
      totalMs: row.total_ms,
      loggedOut: Boolean(row.logged_out),
      sessionReused: Boolean(row.session_reused),
      errorCategory: row.error_category,
      balance: row.balance,
      consumed: row.consumed,
      requestCount: row.request_count,
      quotaPerUnit: row.quota_per_unit,
      averageRpm: row.average_rpm,
      averageTpm: row.average_tpm,
      availableModels: row.available_models,
      createdAt: row.created_at,
    };
  }

  listAgentRouterRuns(options?: {
    accountId?: string;
    status?: "ok" | "error";
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): StoredAgentRouterRun[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_agentrouter_check_runs";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.accountId) {
      conditions.push("account_id = ?");
      params.push(options.accountId);
    }
    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options?.since) {
      const canonicalSince = validateIsoUtcTimestamp(options.since, "since");
      conditions.push("started_at >= ?");
      params.push(canonicalSince);
    }
    if (options?.until) {
      const canonicalUntil = validateIsoUtcTimestamp(options.until, "until");
      conditions.push("started_at <= ?");
      params.push(canonicalUntil);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY started_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      id: Number(row.id),
      accountId: String(row.account_id),
      accountLabel: String(row.account_label),
      startedAt: String(row.started_at),
      endedAt: String(row.ended_at),
      status: row.status as "ok" | "error",
      loginMs: Number(row.login_ms),
      dashboardMs: Number(row.dashboard_ms),
      totalMs: Number(row.total_ms),
      loggedOut: Boolean(row.logged_out),
      sessionReused: Boolean(row.session_reused),
      errorCategory: (row.error_category as string | null) ?? null,
      balance: (row.balance as number | null) ?? null,
      consumed: (row.consumed as number | null) ?? null,
      requestCount: (row.request_count as number | null) ?? null,
      quotaPerUnit: (row.quota_per_unit as number | null) ?? null,
      averageRpm: (row.average_rpm as number | null) ?? null,
      averageTpm: (row.average_tpm as number | null) ?? null,
      availableModels: (row.available_models as number | null) ?? null,
      createdAt: String(row.created_at),
    }));
  }

  recordAgentRouterUsagePoint(rawInput: ObservatoryAgentRouterUsagePoint): StoredAgentRouterUsagePoint {
    const input = validateObservatoryAgentRouterUsagePoint(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      // Ensure account exists
      const acctExists = this.db
        .query<{ account_id: string }, [string]>(
          "SELECT account_id FROM observatory_agentrouter_accounts WHERE account_id = ?",
        )
        .get(input.accountId);

      if (!acctExists) {
        this.upsertAgentRouterAccount({
          accountId: input.accountId,
          accountLabel: input.accountId,
        });
      }

      const existing = this.db
        .query<{ id: number; created_at: string }, [string, string, number, string | null]>(
          "SELECT id, created_at FROM observatory_agentrouter_usage_points WHERE account_id = ? AND granularity = ? AND created_at_ts = ? AND model_name IS ?",
        )
        .get(input.accountId, input.granularity, input.createdAtTs, input.modelName);

      if (existing) {
        this.db
          .query(`
            UPDATE observatory_agentrouter_usage_points
            SET request_count = ?, token_used = ?, quota = ?
            WHERE id = ?
          `)
          .run(input.requestCount, input.tokenUsed, input.quota, existing.id);
        return {
          ...input,
          id: existing.id,
          createdAt: existing.created_at,
        };
      }

      const result = this.db
        .query(`
          INSERT INTO observatory_agentrouter_usage_points (
            account_id, granularity, created_at_ts, model_name,
            request_count, token_used, quota, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.accountId,
          input.granularity,
          input.createdAtTs,
          input.modelName,
          input.requestCount,
          input.tokenUsed,
          input.quota,
          now,
        );

      return {
        ...input,
        id: Number(result.lastInsertRowid),
        createdAt: now,
      };
    })();
  }

  recordAgentRouterUsagePoints(points: ObservatoryAgentRouterUsagePoint[]): StoredAgentRouterUsagePoint[] {
    return this.db.transaction(() => {
      return points.map((p) => this.recordAgentRouterUsagePoint(p));
    })();
  }

  listAgentRouterUsagePoints(options?: {
    accountId?: string;
    granularity?: string;
    modelName?: string;
    sinceTs?: number;
    untilTs?: number;
    limit?: number;
    offset?: number;
  }): StoredAgentRouterUsagePoint[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_agentrouter_usage_points";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.accountId) {
      conditions.push("account_id = ?");
      params.push(options.accountId);
    }
    if (options?.granularity) {
      conditions.push("granularity = ?");
      params.push(options.granularity);
    }
    if (options?.modelName) {
      conditions.push("model_name = ?");
      params.push(options.modelName);
    }
    if (options?.sinceTs !== undefined) {
      conditions.push("created_at_ts >= ?");
      params.push(options.sinceTs);
    }
    if (options?.untilTs !== undefined) {
      conditions.push("created_at_ts <= ?");
      params.push(options.untilTs);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY created_at_ts DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      id: Number(row.id),
      accountId: String(row.account_id),
      granularity: row.granularity as "hour" | "day" | "week",
      createdAtTs: Number(row.created_at_ts),
      modelName: (row.model_name as string | null) ?? null,
      requestCount: Number(row.request_count),
      tokenUsed: Number(row.token_used),
      quota: Number(row.quota),
      createdAt: String(row.created_at),
    }));
  }

  recordAgentRouterBalanceObservation(
    rawInput: ObservatoryAgentRouterBalanceObservation,
  ): StoredAgentRouterBalanceObservation {
    const input = validateObservatoryAgentRouterBalanceObservation(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const acctExists = this.db
        .query<{ account_id: string }, [string]>(
          "SELECT account_id FROM observatory_agentrouter_accounts WHERE account_id = ?",
        )
        .get(input.accountId);

      if (!acctExists) {
        this.upsertAgentRouterAccount({
          accountId: input.accountId,
          accountLabel: input.accountId,
        });
      }

      if (input.runId !== undefined && input.runId !== null) {
        const runExists = this.db
          .query<{ id: number }, [number]>(
            "SELECT id FROM observatory_agentrouter_check_runs WHERE id = ?",
          )
          .get(input.runId);

        if (!runExists) {
          this.recordAgentRouterRun({
            id: input.runId,
            accountId: input.accountId,
            accountLabel: input.accountId,
            startedAt: input.observedAt,
            endedAt: input.observedAt,
            status: "ok",
            loginMs: 0,
            dashboardMs: 0,
            totalMs: 0,
            loggedOut: false,
            sessionReused: false,
          });
        }
      }

      const row = this.db
        .query<{ id: number; created_at: string }, Array<string | number | null>>(`
          INSERT INTO observatory_agentrouter_balance_observations (
            run_id, account_id, observed_at, balance, consumed,
            previous_balance, previous_consumed, balance_delta,
            consumed_delta, minutes_since_previous, classification, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO UPDATE SET
            account_id = excluded.account_id,
            observed_at = excluded.observed_at,
            balance = excluded.balance,
            consumed = excluded.consumed,
            previous_balance = excluded.previous_balance,
            previous_consumed = excluded.previous_consumed,
            balance_delta = excluded.balance_delta,
            consumed_delta = excluded.consumed_delta,
            minutes_since_previous = excluded.minutes_since_previous,
            classification = excluded.classification
          RETURNING id, created_at
        `)
        .get(
          input.runId ?? null,
          input.accountId,
          input.observedAt,
          input.balance,
          input.consumed,
          input.previousBalance ?? null,
          input.previousConsumed ?? null,
          input.balanceDelta ?? null,
          input.consumedDelta ?? null,
          input.minutesSincePrevious ?? null,
          input.classification,
          now,
        );

      return {
        ...input,
        id: row?.id ?? 0,
        createdAt: row?.created_at ?? now,
      };
    })();
  }

  listAgentRouterBalanceObservations(options?: {
    accountId?: string;
    classification?: string;
    since?: string;
    limit?: number;
    offset?: number;
  }): StoredAgentRouterBalanceObservation[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_agentrouter_balance_observations";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.accountId) {
      conditions.push("account_id = ?");
      params.push(options.accountId);
    }
    if (options?.classification) {
      conditions.push("classification = ?");
      params.push(options.classification);
    }
    if (options?.since) {
      const canonicalSince = validateIsoUtcTimestamp(options.since, "since");
      conditions.push("observed_at >= ?");
      params.push(canonicalSince);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY observed_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      id: Number(row.id),
      runId: (row.run_id as number | null) ?? null,
      accountId: String(row.account_id),
      observedAt: String(row.observed_at),
      balance: Number(row.balance),
      consumed: Number(row.consumed),
      previousBalance: (row.previous_balance as number | null) ?? null,
      previousConsumed: (row.previous_consumed as number | null) ?? null,
      balanceDelta: (row.balance_delta as number | null) ?? null,
      consumedDelta: (row.consumed_delta as number | null) ?? null,
      minutesSincePrevious: (row.minutes_since_previous as number | null) ?? null,
      classification: row.classification as StoredAgentRouterBalanceObservation["classification"],
      createdAt: String(row.created_at),
    }));
  }

  recordAgentRouterGrantEvent(
    rawInput: ObservatoryAgentRouterGrantEvent,
  ): StoredAgentRouterGrantEvent {
    const input = validateObservatoryAgentRouterGrantEvent(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const acctExists = this.db
        .query<{ account_id: string }, [string]>(
          "SELECT account_id FROM observatory_agentrouter_accounts WHERE account_id = ?",
        )
        .get(input.accountId);

      if (!acctExists) {
        this.upsertAgentRouterAccount({
          accountId: input.accountId,
          accountLabel: input.accountId,
        });
      }

      if (input.runId !== undefined && input.runId !== null) {
        const runExists = this.db
          .query<{ id: number }, [number]>(
            "SELECT id FROM observatory_agentrouter_check_runs WHERE id = ?",
          )
          .get(input.runId);

        if (!runExists) {
          this.recordAgentRouterRun({
            id: input.runId,
            accountId: input.accountId,
            accountLabel: input.accountId,
            startedAt: input.occurredAt,
            endedAt: input.occurredAt,
            status: "ok",
            loginMs: 0,
            dashboardMs: 0,
            totalMs: 0,
            loggedOut: false,
            sessionReused: false,
          });
        }
      }

      const row = this.db
        .query<{ id: number; created_at: string }, Array<string | number | null>>(`
          INSERT INTO observatory_agentrouter_grant_events (
            run_id, account_id, source_event_id, occurred_at,
            amount, classification, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(account_id, source_event_id) DO UPDATE SET
            run_id = excluded.run_id,
            occurred_at = excluded.occurred_at,
            amount = excluded.amount,
            classification = excluded.classification
          RETURNING id, created_at
        `)
        .get(
          input.runId ?? null,
          input.accountId,
          input.sourceEventId,
          input.occurredAt,
          input.amount,
          input.classification,
          now,
        );

      return {
        ...input,
        id: row?.id ?? 0,
        createdAt: row?.created_at ?? now,
      };
    })();
  }

  listAgentRouterGrantEvents(options?: {
    accountId?: string;
    since?: string;
    limit?: number;
    offset?: number;
  }): StoredAgentRouterGrantEvent[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_agentrouter_grant_events";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.accountId) {
      conditions.push("account_id = ?");
      params.push(options.accountId);
    }
    if (options?.since) {
      const canonicalSince = validateIsoUtcTimestamp(options.since, "since");
      conditions.push("occurred_at >= ?");
      params.push(canonicalSince);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY occurred_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      id: Number(row.id),
      runId: (row.run_id as number | null) ?? null,
      accountId: String(row.account_id),
      sourceEventId: String(row.source_event_id),
      occurredAt: String(row.occurred_at),
      amount: Number(row.amount),
      classification: row.classification as "daily-signin",
      createdAt: String(row.created_at),
    }));
  }

  recordAgentRouterEndpointObservation(
    rawInput: ObservatoryAgentRouterEndpointObservation,
  ): StoredAgentRouterEndpointObservation {
    const input = validateObservatoryAgentRouterEndpointObservation(rawInput);
    const now = new Date().toISOString();

    return this.db.transaction(() => {
      const acctExists = this.db
        .query<{ account_id: string }, [string]>(
          "SELECT account_id FROM observatory_agentrouter_accounts WHERE account_id = ?",
        )
        .get(input.accountId);

      if (!acctExists) {
        this.upsertAgentRouterAccount({
          accountId: input.accountId,
          accountLabel: input.accountLabel,
        });
      }

      const res = this.db
        .query(`
          INSERT INTO observatory_agentrouter_endpoint_observations (
            account_id, account_label, observed_at, status, balance,
            consumed, request_count, latency_ms, error_category, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.accountId,
          input.accountLabel,
          input.observedAt,
          input.status,
          input.balance ?? null,
          input.consumed ?? null,
          input.requestCount ?? null,
          input.latencyMs,
          input.errorCategory ?? null,
          now,
        );

      return {
        ...input,
        id: Number(res.lastInsertRowid),
        createdAt: now,
      };
    })();
  }

  listAgentRouterEndpointObservations(options?: {
    accountId?: string;
    status?: "ok" | "error";
    since?: string;
    limit?: number;
    offset?: number;
  }): StoredAgentRouterEndpointObservation[] {
    const { limit, offset } = validatePagination(options);
    let sql = "SELECT * FROM observatory_agentrouter_endpoint_observations";
    const params: Array<string | number> = [];
    const conditions: string[] = [];

    if (options?.accountId) {
      conditions.push("account_id = ?");
      params.push(options.accountId);
    }
    if (options?.status) {
      conditions.push("status = ?");
      params.push(options.status);
    }
    if (options?.since) {
      const canonicalSince = validateIsoUtcTimestamp(options.since, "since");
      conditions.push("observed_at >= ?");
      params.push(canonicalSince);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    sql += " ORDER BY observed_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const rows = this.db.query<Record<string, unknown>, Array<string | number>>(sql).all(...params);
    return rows.map((row) => ({
      id: Number(row.id),
      accountId: String(row.account_id),
      accountLabel: String(row.account_label),
      observedAt: String(row.observed_at),
      status: row.status as "ok" | "error",
      balance: (row.balance as number | null) ?? null,
      consumed: (row.consumed as number | null) ?? null,
      requestCount: (row.request_count as number | null) ?? null,
      latencyMs: Number(row.latency_ms),
      errorCategory: (row.error_category as string | null) ?? null,
      createdAt: String(row.created_at),
    }));
  }

  // ==========================================
  // Retention Pruning
  // ==========================================

  pruneRetention(filter: RetentionPruneFilter): RetentionPruneResult {
    return this.db.transaction(() => {
      let eventsDeleted = 0;
      let quotaObservationsDeleted = 0;
      let sessionsDeleted = 0;
      let deliveriesDeleted = 0;
      let collectorBatchesDeleted = 0;
      let auditDeleted = 0;
      let noncesDeleted = 0;
      let importLedgerDeleted = 0;
      let agentrouterRunsDeleted = 0;
      let agentrouterUsageDeleted = 0;
      let agentrouterBalancesDeleted = 0;
      let agentrouterGrantsDeleted = 0;
      let agentrouterEndpointsDeleted = 0;

      if (filter.eventsOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.eventsOlderThan, "eventsOlderThan");
        const delRes = this.db
          .query(`
            DELETE FROM observatory_notification_deliveries
            WHERE event_id IN (SELECT event_id FROM observatory_events WHERE occurred_at < ?)
              AND status IN ('sent', 'silenced')
          `)
          .run(canonical);
        deliveriesDeleted += delRes.changes;

        const evRes = this.db
          .query(`
            DELETE FROM observatory_events
            WHERE occurred_at < ?
              AND NOT EXISTS (
                SELECT 1 FROM observatory_notification_deliveries d
                WHERE d.event_id = observatory_events.event_id
                  AND d.status IN ('pending', 'sending', 'failed', 'throttled')
              )
          `)
          .run(canonical);
        eventsDeleted = evRes.changes;
      }

      if (filter.deliveriesOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.deliveriesOlderThan, "deliveriesOlderThan");
        const res = this.db
          .query(`
            DELETE FROM observatory_notification_deliveries
            WHERE status IN ('sent', 'silenced')
            AND coalesce(last_attempt_at, sent_at, updated_at) < ?
          `)
          .run(canonical);
        deliveriesDeleted += res.changes;
      }

      if (filter.collectorBatchesOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.collectorBatchesOlderThan, "collectorBatchesOlderThan");
        const res = this.db
          .query("DELETE FROM observatory_collector_batches WHERE status = 'accepted' AND received_at < ?")
          .run(canonical);
        collectorBatchesDeleted = res.changes;
      }

      if (filter.quotaObservationsOlderThan) {
        const canonical = validateIsoUtcTimestamp(
          filter.quotaObservationsOlderThan,
          "quotaObservationsOlderThan",
        );
        const res = this.db
          .query(`
            DELETE FROM observatory_quota_observations
            WHERE observed_at < ?
              AND EXISTS (
                SELECT 1 FROM observatory_daily_quota_rollups r
                WHERE r.identity_id = observatory_quota_observations.identity_id
                  AND r.bucket_id = observatory_quota_observations.bucket_id
                  AND r.window_id = observatory_quota_observations.window_id
                  AND r.day_utc = substr(observatory_quota_observations.observed_at, 1, 10)
                  AND r.finalized_at IS NOT NULL
              )
          `)
          .run(canonical);
        quotaObservationsDeleted = res.changes;
      }

      if (filter.sessionsOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.sessionsOlderThan, "sessionsOlderThan");
        const res = this.db
          .query(
            "DELETE FROM observatory_sessions WHERE status IN ('closed', 'completed', 'failed', 'cancelled') AND closed_at IS NOT NULL AND closed_at < ?",
          )
          .run(canonical);
        sessionsDeleted = res.changes;
      }

      if (filter.auditOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.auditOlderThan, "auditOlderThan");
        const res = this.db
          .query("DELETE FROM observatory_audit WHERE occurred_at < ?")
          .run(canonical);
        auditDeleted = res.changes;
      }

      if (filter.noncesOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.noncesOlderThan, "noncesOlderThan");
        const res = this.db
          .query("DELETE FROM observatory_ingestion_nonces WHERE expires_at < ?")
          .run(canonical);
        noncesDeleted = res.changes;
      }

      if (filter.importLedgerOlderThan) {
        validateIsoUtcTimestamp(filter.importLedgerOlderThan, "importLedgerOlderThan");
        importLedgerDeleted = 0;
      }

      if (filter.agentrouterRunsOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.agentrouterRunsOlderThan, "agentrouterRunsOlderThan");
        const res = this.db
          .query("DELETE FROM observatory_agentrouter_check_runs WHERE started_at < ?")
          .run(canonical);
        agentrouterRunsDeleted = res.changes;
      }

      if (filter.agentrouterUsageOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.agentrouterUsageOlderThan, "agentrouterUsageOlderThan");
        const cutoffTs = Math.floor(Date.parse(canonical) / 1000);
        const res = this.db
          .query("DELETE FROM observatory_agentrouter_usage_points WHERE created_at_ts < ?")
          .run(cutoffTs);
        agentrouterUsageDeleted = res.changes;
      }

      if (filter.agentrouterBalancesOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.agentrouterBalancesOlderThan, "agentrouterBalancesOlderThan");
        const res = this.db
          .query("DELETE FROM observatory_agentrouter_balance_observations WHERE observed_at < ?")
          .run(canonical);
        agentrouterBalancesDeleted = res.changes;
      }

      if (filter.agentrouterGrantsOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.agentrouterGrantsOlderThan, "agentrouterGrantsOlderThan");
        const res = this.db
          .query("DELETE FROM observatory_agentrouter_grant_events WHERE occurred_at < ?")
          .run(canonical);
        agentrouterGrantsDeleted = res.changes;
      }

      if (filter.agentrouterEndpointsOlderThan) {
        const canonical = validateIsoUtcTimestamp(filter.agentrouterEndpointsOlderThan, "agentrouterEndpointsOlderThan");
        const res = this.db
          .query("DELETE FROM observatory_agentrouter_endpoint_observations WHERE observed_at < ?")
          .run(canonical);
        agentrouterEndpointsDeleted = res.changes;
      }

      return {
        eventsDeleted,
        quotaObservationsDeleted,
        sessionsDeleted,
        deliveriesDeleted,
        collectorBatchesDeleted,
        auditDeleted,
        noncesDeleted,
        importLedgerDeleted,
        agentrouterRunsDeleted,
        agentrouterUsageDeleted,
        agentrouterBalancesDeleted,
        agentrouterGrantsDeleted,
        agentrouterEndpointsDeleted,
      };
    })();
  }

  // ==========================================
  // Safe Complete Export & Truncation
  // ==========================================

  exportData(options?: ExportPaginationOptions): ObservatoryExportData {
    const since = options?.since ? validateIsoUtcTimestamp(options.since, "since") : undefined;
    const { limit, offset } = validatePagination(options);

    const hosts = this.listHosts({ limit, offset });
    const identities = this.listIdentities({ limit, offset });
    const quotaWindows = this.listCurrentQuotaWindows();
    const quotaObservations = this.listQuotaObservations({ since, limit, offset });
    const sessions = this.listSessionSummaries({ since, limit, offset });
    const events = this.listEvents({ since, limit, offset });
    const policies = this.listPolicies();
    const deliveries = this.listDeliveries({ limit, offset });
    const auditEntries = this.listAuditEntries({ since, limit, offset });
    const importLedger = this.listImportBatches({ limit });
    const collectorBatches = this.listCollectorBatches({ limit, offset });
    const agentrouterAccounts = this.listAgentRouterAccounts();
    const agentrouterRuns = this.listAgentRouterRuns({ since, limit, offset });
    const agentrouterUsagePoints = this.listAgentRouterUsagePoints({ limit, offset });
    const agentrouterBalances = this.listAgentRouterBalanceObservations({ since, limit, offset });
    const agentrouterGrants = this.listAgentRouterGrantEvents({ since, limit, offset });
    const agentrouterEndpoints = this.listAgentRouterEndpointObservations({ since, limit, offset });

    const totalRecords =
      hosts.length +
      identities.length +
      quotaWindows.length +
      quotaObservations.length +
      sessions.length +
      events.length +
      policies.length +
      deliveries.length +
      auditEntries.length +
      importLedger.length +
      collectorBatches.length +
      agentrouterAccounts.length +
      agentrouterRuns.length +
      agentrouterUsagePoints.length +
      agentrouterBalances.length +
      agentrouterGrants.length +
      agentrouterEndpoints.length;

    const truncated =
      hosts.length === limit ||
      identities.length === limit ||
      quotaObservations.length === limit ||
      sessions.length === limit ||
      events.length === limit ||
      deliveries.length === limit ||
      auditEntries.length === limit ||
      collectorBatches.length === limit ||
      agentrouterRuns.length === limit ||
      agentrouterUsagePoints.length === limit ||
      agentrouterBalances.length === limit ||
      agentrouterGrants.length === limit ||
      agentrouterEndpoints.length === limit;

    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: this.getSchemaVersion(),
      totalRecords,
      truncated,
      nextOffset: truncated ? offset + limit : null,
      hosts,
      identities,
      quotaWindows,
      quotaObservations,
      sessions,
      events,
      policies,
      deliveries,
      auditEntries,
      importLedger,
      collectorBatches,
      agentrouterAccounts,
      agentrouterRuns,
      agentrouterUsagePoints,
      agentrouterBalances,
      agentrouterGrants,
      agentrouterEndpoints,
    };
  }

  deleteAllObservatoryData(): void {
    this.db.transaction(() => {
      this.db.exec(`
        DELETE FROM observatory_notification_deliveries;
        DELETE FROM observatory_events;
        DELETE FROM observatory_quota_observations;
        DELETE FROM observatory_daily_quota_rollups;
        DELETE FROM observatory_quota_current_windows;
        DELETE FROM observatory_quota_trackers;
        DELETE FROM observatory_provider_trackers;
        DELETE FROM observatory_host_trackers;
        DELETE FROM observatory_session_trackers;
        DELETE FROM observatory_agentrouter_trackers;
        DELETE FROM observatory_digest_watermarks;
        DELETE FROM observatory_sessions;
        DELETE FROM observatory_collector_batches;
        DELETE FROM observatory_identities;
        DELETE FROM observatory_hosts;
        DELETE FROM observatory_notification_policies;
        DELETE FROM observatory_audit;
        DELETE FROM observatory_ingestion_nonces;
        DELETE FROM observatory_import_batch_items;
        DELETE FROM observatory_import_items;
        DELETE FROM observatory_import_ledger;
        DELETE FROM observatory_agentrouter_usage_points;
        DELETE FROM observatory_agentrouter_balance_observations;
        DELETE FROM observatory_agentrouter_grant_events;
        DELETE FROM observatory_agentrouter_endpoint_observations;
        DELETE FROM observatory_agentrouter_check_runs;
        DELETE FROM observatory_agentrouter_accounts;
      `);
    })();
  }
}
