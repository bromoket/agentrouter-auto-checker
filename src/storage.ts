import { Database } from "bun:sqlite";

export interface ApiCallSnapshot {
  path: string;
  method: string;
  status: number;
  ok: boolean;
  latencyMs: number;
  error?: string;
  contentType?: string;
  responsePath?: string;
  recovered?: boolean;
}

export interface AccountMetrics {
  siteUserId?: number;
  siteUsername?: string;
  quotaPerUnit?: number;
  balance?: number;
  consumed?: number;
  requestCount?: number;
  statisticalCount?: number;
  statisticalTokens?: number;
  statisticalQuota?: number;
  averageRpm?: number;
  averageTpm?: number;
  availableModels?: number;
}

export interface UsagePoint {
  accountId: string;
  granularity: "hour" | "day" | "week";
  createdAt: number;
  modelName: string;
  requestCount: number;
  tokenUsed: number;
  quota: number;
}

export interface RunSnapshot {
  accountId: string;
  accountLabel: string;
  startedAt: string;
  endedAt: string;
  status: "ok" | "error";
  loginMs: number;
  dashboardMs: number;
  totalMs: number;
  summary: Record<string, unknown>;
  metrics: AccountMetrics;
  usagePoints: UsagePoint[];
  apiCalls: ApiCallSnapshot[];
  loggedOut: boolean;
  sessionReused: boolean;
  errorMessage?: string;
  screenshotPath?: string;
  capturedApiToken?: string;
  capturedDashboardAccessToken?: string;
}

export interface EndpointObservation {
  id?: number;
  accountId: string;
  accountLabel: string;
  observedAt: string;
  status: "ok" | "error";
  balance?: number;
  consumed?: number;
  requestCount?: number;
  sourcePath?: string;
  latencyMs: number;
  errorMessage?: string;
}

interface RawRunSnapshot {
  id: number;
  account_id: string;
  account_label: string;
  started_at: string;
  ended_at: string;
  status: string;
  login_ms: number;
  dashboard_ms: number;
  total_ms: number;
  summary: string;
  metrics: string;
  api_calls: string;
  logged_out: number;
  session_reused: number;
  error_message: string | null;
  screenshot_path: string | null;
}

export interface StoredRun extends RunSnapshot {
  id: number;
}

export interface CreditObservation {
  id: number;
  runId: number;
  accountId: string;
  observedAt: string;
  balance: number;
  consumed: number;
  previousBalance: number | null;
  previousConsumed: number | null;
  balanceDelta: number | null;
  consumedDelta: number | null;
  minutesSincePrevious: number | null;
  classification: "initial" | "credit-increase" | "usage" | "mixed" | "unchanged";
  loginMs: number;
  loggedOut: boolean;
  sessionReused: boolean;
}

export interface CreditGrantEvent {
  id: number;
  runId: number;
  accountId: string;
  sourceEventId: string;
  occurredAt: string;
  amount: number;
  classification: "daily-signin";
  description: string;
}

function safeLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return 1;
  }
  return Math.min(value, maximum);
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseApiCalls(value: string): ApiCallSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ApiCallSnapshot[]) : [];
  } catch {
    return [];
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

export class Store {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    if (this.db.filename !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        account_label TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok', 'error')),
        login_ms INTEGER NOT NULL,
        dashboard_ms INTEGER NOT NULL,
        total_ms INTEGER NOT NULL,
        summary TEXT NOT NULL,
        api_calls TEXT NOT NULL,
        error_message TEXT,
        screenshot_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_account ON runs(account_id);
      CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
    `);

    const columns = new Set(
      (this.db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    const migrations = [
      ["metrics", "ALTER TABLE runs ADD COLUMN metrics TEXT NOT NULL DEFAULT '{}'"],
      ["logged_out", "ALTER TABLE runs ADD COLUMN logged_out INTEGER NOT NULL DEFAULT 0"],
      ["session_reused", "ALTER TABLE runs ADD COLUMN session_reused INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    for (const [column, sql] of migrations) {
      if (!columns.has(column)) {
        this.db.exec(sql);
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_points (
        account_id TEXT NOT NULL,
        granularity TEXT NOT NULL CHECK(granularity IN ('hour', 'day', 'week')),
        created_at INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        request_count INTEGER NOT NULL,
        token_used INTEGER NOT NULL,
        quota REAL NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, granularity, created_at, model_name)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_account_time
        ON usage_points(account_id, granularity, created_at);

      CREATE TABLE IF NOT EXISTS credit_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        balance REAL NOT NULL,
        consumed REAL NOT NULL,
        previous_balance REAL,
        previous_consumed REAL,
        balance_delta REAL,
        consumed_delta REAL,
        minutes_since_previous REAL,
        classification TEXT NOT NULL CHECK(
          classification IN ('initial', 'credit-increase', 'usage', 'mixed', 'unchanged')
        )
      );
      CREATE INDEX IF NOT EXISTS idx_credit_observations_account_time
        ON credit_observations(account_id, observed_at);

      CREATE TABLE IF NOT EXISTS credit_grant_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        amount REAL NOT NULL CHECK(amount > 0),
        classification TEXT NOT NULL CHECK(classification IN ('daily-signin')),
        description TEXT NOT NULL,
        UNIQUE(account_id, source_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_credit_grant_events_account_time
        ON credit_grant_events(account_id, occurred_at);

      CREATE TABLE IF NOT EXISTS endpoint_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        account_label TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok', 'error')),
        balance REAL,
        consumed REAL,
        request_count INTEGER,
        source_path TEXT,
        latency_ms INTEGER NOT NULL,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_endpoint_observations_account_time
        ON endpoint_observations(account_id, observed_at);
    `);
    this.backfillCreditObservations();
    this.backfillCreditGrantEvents();
  }

  saveEndpointObservation(observation: EndpointObservation): number {
    if (observation.status === "ok") {
      if (
        !Number.isFinite(observation.balance) ||
        !Number.isFinite(observation.consumed) ||
        Number(observation.consumed) < 0
      ) {
        throw new Error("A successful endpoint observation requires finite balance and consumption values.");
      }
    }
    const result = this.db.prepare(`
      INSERT INTO endpoint_observations (
        account_id, account_label, observed_at, status, balance, consumed,
        request_count, source_path, latency_ms, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.accountId,
      observation.accountLabel,
      observation.observedAt,
      observation.status,
      observation.balance ?? null,
      observation.consumed ?? null,
      observation.requestCount ?? null,
      observation.sourcePath ?? null,
      observation.latencyMs,
      observation.errorMessage ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  listEndpointObservations(accountId: string, limit: number): EndpointObservation[] {
    const rows = this.db.prepare(`
      SELECT * FROM endpoint_observations
      WHERE account_id = ?
      ORDER BY observed_at DESC
      LIMIT ?
    `).all(accountId, safeLimit(limit, 10_000)) as Array<{
      id: number;
      account_id: string;
      account_label: string;
      observed_at: string;
      status: "ok" | "error";
      balance: number | null;
      consumed: number | null;
      request_count: number | null;
      source_path: string | null;
      latency_ms: number;
      error_message: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      accountLabel: row.account_label,
      observedAt: row.observed_at,
      status: row.status,
      balance: row.balance ?? undefined,
      consumed: row.consumed ?? undefined,
      requestCount: row.request_count ?? undefined,
      sourcePath: row.source_path ?? undefined,
      latencyMs: row.latency_ms,
      errorMessage: row.error_message ?? undefined,
    }));
  }

  private backfillCreditObservations(): void {
    const rows = this.db
      .prepare(`
        SELECT id, account_id, ended_at, metrics
        FROM runs
        WHERE status = 'ok'
        ORDER BY account_id ASC, started_at ASC, id ASC
      `)
      .all() as Array<{ id: number; account_id: string; ended_at: string; metrics: string }>;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO credit_observations (
        run_id, account_id, observed_at, balance, consumed,
        previous_balance, previous_consumed, balance_delta, consumed_delta,
        minutes_since_previous, classification
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const previousByAccount = new Map<
      string,
      { balance: number; consumed: number; observedAt: string }
    >();
    const persist = this.db.transaction(() => {
      for (const row of rows) {
        const metrics = parseJsonObject(row.metrics) as AccountMetrics;
        const balance = Number(metrics.balance);
        const consumed = Number(metrics.consumed);
        if (!Number.isFinite(balance) || !Number.isFinite(consumed)) continue;
        const previous = previousByAccount.get(row.account_id);
        const balanceDelta = previous ? balance - previous.balance : null;
        const consumedDelta = previous ? consumed - previous.consumed : null;
        const minutesSincePrevious = previous
          ? Math.max(0, (Date.parse(row.ended_at) - Date.parse(previous.observedAt)) / 60_000)
          : null;
        const creditIncrease = (balanceDelta ?? 0) > 0.000_001;
        const usageIncrease = (consumedDelta ?? 0) > 0.000_001 || (balanceDelta ?? 0) < -0.000_001;
        const classification = !previous
          ? "initial"
          : creditIncrease && usageIncrease
            ? "mixed"
            : creditIncrease
              ? "credit-increase"
              : usageIncrease
                ? "usage"
                : "unchanged";
        insert.run(
          row.id,
          row.account_id,
          row.ended_at,
          balance,
          consumed,
          previous?.balance ?? null,
          previous?.consumed ?? null,
          balanceDelta,
          consumedDelta,
          minutesSincePrevious,
          classification,
        );
        previousByAccount.set(row.account_id, { balance, consumed, observedAt: row.ended_at });
      }
    });
    persist.immediate();
  }

  private backfillCreditGrantEvents(): void {
    const rows = this.db
      .prepare(`
        SELECT id, account_id, summary
        FROM runs
        ORDER BY id ASC
      `)
      .all() as Array<{ id: number; account_id: string; summary: string }>;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO credit_grant_events (
        run_id, account_id, source_event_id, occurred_at, amount, classification, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const persist = this.db.transaction(() => {
      for (const row of rows) {
        const rawGrants = parseJsonObject(row.summary).creditGrantEvents;
        if (!Array.isArray(rawGrants)) continue;
        for (const grant of rawGrants) {
          if (!grant || typeof grant !== "object" || Array.isArray(grant)) continue;
          const event = grant as Record<string, unknown>;
          const sourceEventId = typeof event.sourceEventId === "string"
            ? event.sourceEventId.slice(0, 300)
            : "";
          const occurredAtSeconds = Number(event.occurredAt);
          const amount = Number(event.amount);
          const description = typeof event.description === "string"
            ? event.description.slice(0, 500)
            : "";
          if (
            sourceEventId.length === 0 ||
            !Number.isSafeInteger(occurredAtSeconds) ||
            occurredAtSeconds <= 0 ||
            !Number.isFinite(amount) ||
            amount <= 0 ||
            event.classification !== "daily-signin"
          ) continue;
          insert.run(
            row.id,
            row.account_id,
            sourceEventId,
            new Date(occurredAtSeconds * 1_000).toISOString(),
            amount,
            "daily-signin",
            description,
          );
        }
      }
    });
    persist.immediate();
  }

  saveRun(snapshot: RunSnapshot): number {
    if (snapshot.status === "ok") {
      const balance = Number(snapshot.metrics.balance);
      const consumed = Number(snapshot.metrics.consumed);
      if (!snapshot.loggedOut) {
        throw new Error("A successful run must include a confirmed AgentRouter logout.");
      }
      if (!Number.isFinite(balance) || !Number.isFinite(consumed) || consumed < 0) {
        throw new Error("A successful run must include a finite balance and finite, non-negative consumption metrics.");
      }
    }
    const insertRun = this.db.prepare(`
      INSERT INTO runs (
        account_id, account_label, started_at, ended_at, status,
        login_ms, dashboard_ms, total_ms, summary, metrics, api_calls,
        logged_out, session_reused, error_message, screenshot_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertUsage = this.db.prepare(`
      INSERT INTO usage_points (
        account_id, granularity, created_at, model_name,
        request_count, token_used, quota, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, granularity, created_at, model_name) DO UPDATE SET
        request_count = excluded.request_count,
        token_used = excluded.token_used,
        quota = excluded.quota,
        updated_at = excluded.updated_at
    `);
    const previousMetric = this.db.prepare(`
      SELECT id, started_at, metrics
      FROM runs
      WHERE account_id = ? AND status = 'ok'
      ORDER BY id DESC
      LIMIT 1
    `);
    const insertCreditObservation = this.db.prepare(`
      INSERT INTO credit_observations (
        run_id, account_id, observed_at, balance, consumed,
        previous_balance, previous_consumed, balance_delta, consumed_delta,
        minutes_since_previous, classification
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCreditGrant = this.db.prepare(`
      INSERT OR IGNORE INTO credit_grant_events (
        run_id, account_id, source_event_id, occurred_at, amount, classification, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let runId = -1;
    const persist = this.db.transaction(() => {
      const previous = snapshot.status === "ok"
        ? (previousMetric.get(snapshot.accountId) as {
            id: number;
            started_at: string;
            metrics: string;
          } | null)
        : null;
      const result = insertRun.run(
        snapshot.accountId,
        snapshot.accountLabel,
        snapshot.startedAt,
        snapshot.endedAt,
        snapshot.status,
        snapshot.loginMs,
        snapshot.dashboardMs,
        snapshot.totalMs,
        JSON.stringify(snapshot.summary),
        JSON.stringify(snapshot.metrics),
        JSON.stringify(snapshot.apiCalls),
        snapshot.loggedOut ? 1 : 0,
        snapshot.sessionReused ? 1 : 0,
        snapshot.errorMessage ?? null,
        snapshot.screenshotPath ?? null,
      );
      runId = Number(result.lastInsertRowid);

      const balance = Number(snapshot.metrics.balance);
      const consumed = Number(snapshot.metrics.consumed);
      if (snapshot.status === "ok" && Number.isFinite(balance) && Number.isFinite(consumed)) {
        const previousValues = previous ? (parseJsonObject(previous.metrics) as AccountMetrics) : null;
        const previousBalance = previousValues ? Number(previousValues.balance) : Number.NaN;
        const previousConsumed = previousValues ? Number(previousValues.consumed) : Number.NaN;
        const hasPrevious = Boolean(
          previous && Number.isFinite(previousBalance) && Number.isFinite(previousConsumed),
        );
        const balanceDelta = hasPrevious ? balance - previousBalance : null;
        const consumedDelta = hasPrevious ? consumed - previousConsumed : null;
        const minutesSincePrevious = hasPrevious && previous
          ? Math.max(0, (Date.parse(snapshot.startedAt) - Date.parse(previous.started_at)) / 60_000)
          : null;
        const creditIncrease = (balanceDelta ?? 0) > 0.000_001;
        const usageIncrease = (consumedDelta ?? 0) > 0.000_001 || (balanceDelta ?? 0) < -0.000_001;
        const classification = !hasPrevious
          ? "initial"
          : creditIncrease && usageIncrease
            ? "mixed"
            : creditIncrease
              ? "credit-increase"
              : usageIncrease
                ? "usage"
                : "unchanged";
        insertCreditObservation.run(
          runId,
          snapshot.accountId,
          snapshot.endedAt,
          balance,
          consumed,
          hasPrevious ? previousBalance : null,
          hasPrevious ? previousConsumed : null,
          balanceDelta,
          consumedDelta,
          minutesSincePrevious,
          classification,
        );
      }

      for (const point of snapshot.usagePoints) {
        upsertUsage.run(
          point.accountId,
          point.granularity,
          point.createdAt,
          point.modelName,
          point.requestCount,
          point.tokenUsed,
          point.quota,
          snapshot.endedAt,
        );
      }

      const rawGrants = snapshot.summary.creditGrantEvents;
      if (Array.isArray(rawGrants)) {
        for (const grant of rawGrants) {
          if (!grant || typeof grant !== "object" || Array.isArray(grant)) continue;
          const event = grant as Record<string, unknown>;
          const sourceEventId = typeof event.sourceEventId === "string"
            ? event.sourceEventId.slice(0, 300)
            : "";
          const occurredAtSeconds = Number(event.occurredAt);
          const amount = Number(event.amount);
          const description = typeof event.description === "string"
            ? event.description.slice(0, 500)
            : "";
          if (
            sourceEventId.length === 0 ||
            !Number.isSafeInteger(occurredAtSeconds) ||
            occurredAtSeconds <= 0 ||
            !Number.isFinite(amount) ||
            amount <= 0 ||
            event.classification !== "daily-signin"
          ) continue;
          insertCreditGrant.run(
            runId,
            snapshot.accountId,
            sourceEventId,
            new Date(occurredAtSeconds * 1_000).toISOString(),
            amount,
            "daily-signin",
            description,
          );
        }
      }
    });
    persist.immediate();
    return runId;
  }

  listRuns(limit: number, accountId?: string): StoredRun[] {
    const safe = safeLimit(limit, 5_000);
    const rows = accountId
      ? this.db
          .prepare("SELECT * FROM runs WHERE account_id = ? ORDER BY started_at DESC LIMIT ?")
          .all(accountId, safe)
      : this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(safe);
    return (rows as RawRunSnapshot[]).map(parseRun);
  }

  getRunStatusCounts(): { successful: number; failed: number } {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS count FROM runs GROUP BY status")
      .all() as Array<{ status: "ok" | "error"; count: number }>;
    return rows.reduce(
      (counts, row) => {
        if (row.status === "ok") counts.successful = row.count;
        else counts.failed = row.count;
        return counts;
      },
      { successful: 0, failed: 0 },
    );
  }

  listMetricHistory(accountId: string, limit: number): Array<{
    startedAt: string;
    status: "ok" | "error";
    loginMs: number;
    dashboardMs: number;
    totalMs: number;
    loggedOut: boolean;
    metrics: AccountMetrics;
  }> {
    const rows = this.db
      .prepare(`
        SELECT started_at, status, login_ms, dashboard_ms, total_ms, logged_out, metrics
        FROM runs
        WHERE account_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .all(accountId, safeLimit(limit, 5_000)) as Array<{
      started_at: string;
      status: "ok" | "error";
      login_ms: number;
      dashboard_ms: number;
      total_ms: number;
      logged_out: number;
      metrics: string;
    }>;

    return rows.reverse().map((row) => ({
      startedAt: row.started_at,
      status: row.status,
      loginMs: row.login_ms,
      dashboardMs: row.dashboard_ms,
      totalMs: row.total_ms,
      loggedOut: row.logged_out === 1,
      metrics: parseJsonObject(row.metrics) as AccountMetrics,
    }));
  }

  listUsagePoints(
    accountId: string,
    granularity: UsagePoint["granularity"],
    fromTimestamp = 0,
  ): UsagePoint[] {
    const rows = this.db
      .prepare(`
        SELECT account_id, granularity, created_at, model_name, request_count, token_used, quota
        FROM usage_points
        WHERE account_id = ? AND granularity = ? AND created_at >= ?
        ORDER BY created_at ASC, model_name ASC
        LIMIT 20000
      `)
      .all(accountId, granularity, Math.max(0, Math.trunc(fromTimestamp))) as Array<{
      account_id: string;
      granularity: UsagePoint["granularity"];
      created_at: number;
      model_name: string;
      request_count: number;
      token_used: number;
      quota: number;
    }>;

    return rows.map((row) => ({
      accountId: row.account_id,
      granularity: row.granularity,
      createdAt: row.created_at,
      modelName: row.model_name,
      requestCount: row.request_count,
      tokenUsed: row.token_used,
      quota: row.quota,
    }));
  }

  listHistoricalAccounts(): Array<{
    accountId: string;
    label: string;
    lastRunAt: string | null;
    lastStatus: "ok" | "error" | null;
  }> {
    const rows = this.db
      .prepare(`
        SELECT r.account_id, r.account_label, r.started_at, r.status
        FROM runs r
        INNER JOIN (
          SELECT account_id, MAX(id) AS latest_id
          FROM runs
          GROUP BY account_id
        ) latest ON latest.latest_id = r.id
        ORDER BY r.started_at DESC
      `)
      .all() as Array<{
      account_id: string;
      account_label: string;
      started_at: string | null;
      status: "ok" | "error" | null;
    }>;

    return rows.map((row) => ({
      accountId: row.account_id,
      label: row.account_label,
      lastRunAt: row.started_at,
      lastStatus: row.status,
    }));
  }

  listCreditObservations(accountId: string, limit: number): CreditObservation[] {
    const rows = this.db
      .prepare(`
        SELECT c.*, r.login_ms, r.logged_out, r.session_reused
        FROM credit_observations c
        INNER JOIN runs r ON r.id = c.run_id
        WHERE c.account_id = ?
        ORDER BY c.observed_at DESC
        LIMIT ?
      `)
      .all(accountId, safeLimit(limit, 5_000)) as Array<{
      id: number;
      run_id: number;
      account_id: string;
      observed_at: string;
      balance: number;
      consumed: number;
      previous_balance: number | null;
      previous_consumed: number | null;
      balance_delta: number | null;
      consumed_delta: number | null;
      minutes_since_previous: number | null;
      classification: CreditObservation["classification"];
      login_ms: number;
      logged_out: number;
      session_reused: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      accountId: row.account_id,
      observedAt: row.observed_at,
      balance: row.balance,
      consumed: row.consumed,
      previousBalance: row.previous_balance,
      previousConsumed: row.previous_consumed,
      balanceDelta: row.balance_delta,
      consumedDelta: row.consumed_delta,
      minutesSincePrevious: row.minutes_since_previous,
      classification: row.classification,
      loginMs: row.login_ms,
      loggedOut: row.logged_out === 1,
      sessionReused: row.session_reused === 1,
    }));
  }

  listCreditGrantEvents(accountId: string, limit: number): CreditGrantEvent[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM credit_grant_events
        WHERE account_id = ?
        ORDER BY occurred_at DESC
        LIMIT ?
      `)
      .all(accountId, safeLimit(limit, 5_000)) as Array<{
      id: number;
      run_id: number;
      account_id: string;
      source_event_id: string;
      occurred_at: string;
      amount: number;
      classification: "daily-signin";
      description: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      accountId: row.account_id,
      sourceEventId: row.source_event_id,
      occurredAt: row.occurred_at,
      amount: row.amount,
      classification: row.classification,
      description: row.description,
    }));
  }

  getCreditObservationForRun(runId: number): CreditObservation | null {
    const row = this.db
      .prepare(`
        SELECT c.*, r.login_ms, r.logged_out, r.session_reused
        FROM credit_observations c
        INNER JOIN runs r ON r.id = c.run_id
        WHERE c.run_id = ?
      `)
      .get(runId) as {
      id: number;
      run_id: number;
      account_id: string;
      observed_at: string;
      balance: number;
      consumed: number;
      previous_balance: number | null;
      previous_consumed: number | null;
      balance_delta: number | null;
      consumed_delta: number | null;
      minutes_since_previous: number | null;
      classification: CreditObservation["classification"];
      login_ms: number;
      logged_out: number;
      session_reused: number;
    } | null;
    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      accountId: row.account_id,
      observedAt: row.observed_at,
      balance: row.balance,
      consumed: row.consumed,
      previousBalance: row.previous_balance,
      previousConsumed: row.previous_consumed,
      balanceDelta: row.balance_delta,
      consumedDelta: row.consumed_delta,
      minutesSincePrevious: row.minutes_since_previous,
      classification: row.classification,
      loginMs: row.login_ms,
      loggedOut: row.logged_out === 1,
      sessionReused: row.session_reused === 1,
    };
  }

  getLatestCreditGrantEventId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM credit_grant_events").get() as {
      id: number;
    };
    return row.id;
  }

  listCreditGrantEventsAfterId(id: number): CreditGrantEvent[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM credit_grant_events
        WHERE id > ?
        ORDER BY id ASC
        LIMIT 100
      `)
      .all(Math.max(0, Math.trunc(id))) as Array<{
      id: number;
      run_id: number;
      account_id: string;
      source_event_id: string;
      occurred_at: string;
      amount: number;
      classification: "daily-signin";
      description: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      runId: row.run_id,
      accountId: row.account_id,
      sourceEventId: row.source_event_id,
      occurredAt: row.occurred_at,
      amount: row.amount,
      classification: row.classification,
      description: row.description,
    }));
  }
}

export function parseRun(snapshot: RawRunSnapshot): StoredRun {
  return {
    id: snapshot.id,
    accountId: snapshot.account_id,
    accountLabel: snapshot.account_label,
    startedAt: snapshot.started_at,
    endedAt: snapshot.ended_at,
    status: snapshot.status === "ok" ? "ok" : "error",
    loginMs: snapshot.login_ms,
    dashboardMs: snapshot.dashboard_ms,
    totalMs: snapshot.total_ms,
    summary: parseJsonObject(snapshot.summary),
    metrics: parseJsonObject(snapshot.metrics) as AccountMetrics,
    usagePoints: [],
    apiCalls: parseApiCalls(snapshot.api_calls),
    loggedOut: snapshot.logged_out === 1,
    sessionReused: snapshot.session_reused === 1,
    errorMessage: snapshot.error_message
      ? stripAnsi(snapshot.error_message).slice(0, 2_000)
      : undefined,
    screenshotPath: snapshot.screenshot_path ?? undefined,
  };
}
