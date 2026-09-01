import { Database } from "bun:sqlite";
import { createHash, createHmac } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ObservatoryStore } from "./store";
import type {
  LegacyProjectedRow,
  ObservatoryAgentRouterAccount,
  ObservatoryAgentRouterBalanceObservation,
  ObservatoryAgentRouterEndpointObservation,
  ObservatoryAgentRouterGrantEvent,
  ObservatoryAgentRouterRun,
  ObservatoryAgentRouterUsagePoint,
} from "./types";
import { validateIsoUtcTimestamp, validateOpaqueId, validateSafeString } from "./validation";

const SOURCE_NAME = "legacy-agentrouter-snapshot";
const SOURCE_KEY_DOMAIN = "ai-fleet-observatory/legacy-agentrouter-source-key/v1";
const SAFE_MODEL_IDENTIFIER = /^[a-zA-Z0-9_.:-]{1,128}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const IMPORTER_VERSION = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_ROWS_PER_TABLE = 250_000;
const MAX_TOTAL_ROWS = 500_000;
const MAX_TEXT_BYTES = 1024 * 1024;
const STREAM_CHUNK_BYTES = 64 * 1024;

export type LegacyImportErrorCategory =
  | "invalid_options"
  | "source_unavailable"
  | "source_hash_mismatch"
  | "source_changed"
  | "unsupported_schema"
  | "invalid_source_data"
  | "projection_conflict"
  | "destination_failed";

/** Error messages are deliberately categorical: source values and paths are never included. */
export class LegacyImportError extends Error {
  readonly category: LegacyImportErrorCategory;

  constructor(category: LegacyImportErrorCategory) {
    super(`LEGACY_IMPORT_${category.toUpperCase()}`);
    this.name = "LegacyImportError";
    this.category = category;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface LegacyAgentRouterImportOptions {
  snapshotPath: string;
  expectedSha256: string;
  importerVersion: string;
  /** Exactly 32 secret bytes, used only in memory to make legacy source keys opaque. */
  grantIdHmacKey: Uint8Array;
  importedAt?: string;
}

export interface LegacyImportCounts {
  accounts: number;
  runs: number;
  usagePoints: number;
  balances: number;
  grants: number;
  endpoints: number;
}

export interface LegacyAgentRouterImportResult {
  outcome: "imported" | "duplicate";
  batchId: string;
  sourceSha256: string;
  projectionSha256: string;
  recordCount: number;
  counts: LegacyImportCounts;
}

export interface LegacyProjectedItem<T> {
  sourceTable: string;
  sourceKeyHmac: string;
  projectionSha256: string;
  value: T;
}

interface LegacyAgentRouterProjection {
  projectionSha256: string;
  accounts: ObservatoryAgentRouterAccount[];
  runs: Array<LegacyProjectedItem<ObservatoryAgentRouterRun>>;
  usagePoints: Array<LegacyProjectedItem<ObservatoryAgentRouterUsagePoint>>;
  balances: Array<LegacyProjectedItem<ObservatoryAgentRouterBalanceObservation>>;
  grants: Array<LegacyProjectedItem<ObservatoryAgentRouterGrantEvent>>;
  endpoints: Array<LegacyProjectedItem<ObservatoryAgentRouterEndpointObservation>>;
}

interface SchemaColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface RunRow {
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
}

interface UsageRow {
  account_id: string;
  granularity: string;
  created_at: number;
  model_name: string;
  request_count: number;
  token_used: number;
  quota: number;
}

interface BalanceRow {
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
  classification: string;
}

interface GrantRow {
  id: number;
  run_id: number;
  account_id: string;
  source_event_id: string;
  occurred_at: string;
  amount: number;
  classification: string;
}

interface EndpointRow {
  id: number;
  account_id: string;
  account_label: string;
  observed_at: string;
  status: string;
  balance: number | null;
  consumed: number | null;
  request_count: number | null;
  latency_ms: number;
  error_category: string | null;
}

const EXPECTED_COLUMNS: Readonly<Record<string, readonly SchemaColumn[]>> = {
  runs: [
    { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "account_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "account_label", type: "TEXT", notnull: 1, pk: 0 },
    { name: "started_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "ended_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, pk: 0 },
    { name: "login_ms", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "dashboard_ms", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "total_ms", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "summary", type: "TEXT", notnull: 1, pk: 0 },
    { name: "api_calls", type: "TEXT", notnull: 1, pk: 0 },
    { name: "error_message", type: "TEXT", notnull: 0, pk: 0 },
    { name: "screenshot_path", type: "TEXT", notnull: 0, pk: 0 },
    { name: "metrics", type: "TEXT", notnull: 1, pk: 0 },
    { name: "logged_out", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "session_reused", type: "INTEGER", notnull: 1, pk: 0 },
  ],
  usage_points: [
    { name: "account_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "granularity", type: "TEXT", notnull: 1, pk: 2 },
    { name: "created_at", type: "INTEGER", notnull: 1, pk: 3 },
    { name: "model_name", type: "TEXT", notnull: 1, pk: 4 },
    { name: "request_count", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "token_used", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "quota", type: "REAL", notnull: 1, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
  ],
  credit_observations: [
    { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "run_id", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "account_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "observed_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "balance", type: "REAL", notnull: 1, pk: 0 },
    { name: "consumed", type: "REAL", notnull: 1, pk: 0 },
    { name: "previous_balance", type: "REAL", notnull: 0, pk: 0 },
    { name: "previous_consumed", type: "REAL", notnull: 0, pk: 0 },
    { name: "balance_delta", type: "REAL", notnull: 0, pk: 0 },
    { name: "consumed_delta", type: "REAL", notnull: 0, pk: 0 },
    { name: "minutes_since_previous", type: "REAL", notnull: 0, pk: 0 },
    { name: "classification", type: "TEXT", notnull: 1, pk: 0 },
  ],
  credit_grant_events: [
    { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "run_id", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "account_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "source_event_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "occurred_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "amount", type: "REAL", notnull: 1, pk: 0 },
    { name: "classification", type: "TEXT", notnull: 1, pk: 0 },
    { name: "description", type: "TEXT", notnull: 1, pk: 0 },
  ],
  endpoint_observations: [
    { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "account_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "account_label", type: "TEXT", notnull: 1, pk: 0 },
    { name: "observed_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, pk: 0 },
    { name: "balance", type: "REAL", notnull: 0, pk: 0 },
    { name: "consumed", type: "REAL", notnull: 0, pk: 0 },
    { name: "request_count", type: "INTEGER", notnull: 0, pk: 0 },
    { name: "source_path", type: "TEXT", notnull: 0, pk: 0 },
    { name: "latency_ms", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "error_message", type: "TEXT", notnull: 0, pk: 0 },
  ],
};

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LegacyImportError("invalid_source_data");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new LegacyImportError("invalid_source_data");
}

function hashProjection(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

interface StagedSource {
  originalPath: string;
  originalHandle: FileHandle;
  originalIdentity: Stats;
  stagingDirectory: string;
  stagingPath: string;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function sidecarExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNoSidecars(path: string, category: LegacyImportErrorCategory): Promise<void> {
  const sidecars = [`${path}-wal`, `${path}-shm`, `${path}-journal`];
  const present = await Promise.all(sidecars.map(sidecarExists));
  if (present.some(Boolean)) throw new LegacyImportError(category);
}

async function hashOpenFile(handle: FileHandle): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  let bytes = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, bytes);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_SOURCE_BYTES) throw new LegacyImportError("invalid_options");
      hash.update(chunk.subarray(0, bytesRead));
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    chunk.fill(0);
  }
}

async function stageImmutableSource(pathInput: string, expectedSha256: string): Promise<StagedSource> {
  let originalHandle: FileHandle | undefined;
  let stagingDirectory: string | undefined;
  try {
    if (/^(?:\\\\|\/\/)/.test(pathInput)) throw new LegacyImportError("invalid_options");
    const originalPath = resolve(pathInput);
    const parent = dirname(originalPath);
    const [pathInfo, parentPathInfo, parentInfo, canonicalParent] = await Promise.all([
      lstat(originalPath),
      lstat(parent),
      stat(parent),
      realpath(parent),
    ]);
    const canonicalParentInfo = await stat(canonicalParent);
    const resolvedParent = resolve(parent);
    const parentMatches = process.platform === "win32"
      ? parentInfo.dev === canonicalParentInfo.dev && parentInfo.ino === canonicalParentInfo.ino
      : canonicalParent === resolvedParent;
    if (
      !pathInfo.isFile() ||
      pathInfo.isSymbolicLink() ||
      !parentPathInfo.isDirectory() ||
      parentPathInfo.isSymbolicLink() ||
      !parentInfo.isDirectory() ||
      !canonicalParentInfo.isDirectory() ||
      !parentMatches
    ) {
      throw new LegacyImportError("source_unavailable");
    }
    if (process.platform !== "win32") {
      const uid = typeof process.getuid === "function" ? process.getuid() : parentInfo.uid;
      if (pathInfo.uid !== uid || parentInfo.uid !== uid || (parentInfo.mode & 0o022) !== 0) {
        throw new LegacyImportError("source_unavailable");
      }
    }
    await assertNoSidecars(originalPath, "unsupported_schema");
    originalHandle = await open(originalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const originalIdentity = await originalHandle.stat();
    const openedPathInfo = await lstat(originalPath);
    if (!sameFileIdentity(originalIdentity, pathInfo) || !sameFileIdentity(originalIdentity, openedPathInfo)) {
      throw new LegacyImportError("source_changed");
    }
    if (originalIdentity.size > MAX_SOURCE_BYTES) throw new LegacyImportError("invalid_options");

    stagingDirectory = await mkdtemp(join(tmpdir(), "observatory-legacy-stage-"));
    await chmod(stagingDirectory, 0o700);
    const stagingPath = join(stagingDirectory, "snapshot.sqlite");
    const stagedHandle = await open(stagingPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    let bytes = 0;
    try {
      while (true) {
        const { bytesRead } = await originalHandle.read(chunk, 0, chunk.byteLength, bytes);
        if (bytesRead === 0) break;
        if (bytes + bytesRead > MAX_SOURCE_BYTES) throw new LegacyImportError("invalid_options");
        hash.update(chunk.subarray(0, bytesRead));
        let offset = 0;
        while (offset < bytesRead) {
          const written = await stagedHandle.write(chunk, offset, bytesRead - offset, bytes + offset);
          if (written.bytesWritten <= 0) throw new LegacyImportError("source_unavailable");
          offset += written.bytesWritten;
        }
        bytes += bytesRead;
      }
      await stagedHandle.sync();
    } finally {
      chunk.fill(0);
      await stagedHandle.close();
    }
    if (bytes !== originalIdentity.size || hash.digest("hex") !== expectedSha256) {
      throw new LegacyImportError("source_hash_mismatch");
    }
    await assertNoSidecars(originalPath, "source_changed");
    return { originalPath, originalHandle, originalIdentity, stagingDirectory, stagingPath };
  } catch (error) {
    try {
      await originalHandle?.close();
      if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true });
    } catch {
      // Cleanup diagnostics are intentionally discarded.
    }
    if (error instanceof LegacyImportError) throw error;
    throw new LegacyImportError("source_unavailable");
  }
}

async function verifyImmutableSource(source: StagedSource, expectedSha256: string): Promise<void> {
  try {
    await assertNoSidecars(source.originalPath, "source_changed");
    const [handleInfo, pathInfo, digest] = await Promise.all([
      source.originalHandle.stat(),
      lstat(source.originalPath),
      hashOpenFile(source.originalHandle),
    ]);
    if (
      !sameFileIdentity(source.originalIdentity, handleInfo) ||
      !sameFileIdentity(source.originalIdentity, pathInfo) ||
      digest.bytes !== source.originalIdentity.size ||
      digest.sha256 !== expectedSha256
    ) {
      throw new LegacyImportError("source_changed");
    }
    await assertNoSidecars(source.originalPath, "source_changed");
  } catch (error) {
    if (error instanceof LegacyImportError) throw error;
    throw new LegacyImportError("source_changed");
  }
}

async function cleanupStagedSource(source: StagedSource | undefined): Promise<void> {
  if (!source) return;
  try {
    await source.originalHandle.close();
    await rm(source.stagingDirectory, { recursive: true, force: true });
  } catch {
    // Cleanup diagnostics are intentionally discarded.
  }
}

function updateLengthDelimited(hmac: ReturnType<typeof createHmac>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hmac.update(length);
  hmac.update(bytes);
}

function opaqueSourceKey(secret: Uint8Array, table: string, ...parts: string[]): string {
  const hmac = createHmac("sha256", secret);
  updateLengthDelimited(hmac, SOURCE_KEY_DOMAIN);
  updateLengthDelimited(hmac, table);
  for (const part of parts) updateLengthDelimited(hmac, part);
  return hmac.digest("hex");
}

function item<T>(secret: Uint8Array, table: string, keys: string[], value: T): LegacyProjectedItem<T> {
  return {
    sourceTable: table,
    sourceKeyHmac: opaqueSourceKey(secret, table, ...keys),
    projectionSha256: hashProjection(value),
    value,
  };
}

function requireSafeInteger(value: unknown, allowZero = true): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new LegacyImportError("invalid_source_data");
  }
  return value;
}

function requireFinite(value: unknown, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LegacyImportError("invalid_source_data");
  }
  return Object.is(value, -0) ? 0 : value;
}

function requireBooleanInteger(value: unknown): boolean {
  if (value !== 0 && value !== 1) throw new LegacyImportError("invalid_source_data");
  return value === 1;
}

function safeAccountId(value: unknown): string {
  try {
    return validateOpaqueId(value, "accountId");
  } catch {
    throw new LegacyImportError("invalid_source_data");
  }
}

function safeLabel(value: unknown): string {
  try {
    return validateSafeString(value, "accountLabel", 128, true)!;
  } catch {
    throw new LegacyImportError("invalid_source_data");
  }
}

function safeTimestamp(value: unknown): string {
  try {
    return validateIsoUtcTimestamp(value, "timestamp");
  } catch {
    throw new LegacyImportError("invalid_source_data");
  }
}

function safeModelIdentifier(value: unknown): string | null {
  if (typeof value !== "string") throw new LegacyImportError("invalid_source_data");
  const trimmed = value.trim();
  return SAFE_MODEL_IDENTIFIER.test(trimmed) ? trimmed : null;
}

function assertExactSchema(db: Database): void {
  const tableRows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const actualTables = tableRows.map((row) => row.name);
  const expectedTables = Object.keys(EXPECTED_COLUMNS).sort();
  if (canonicalJson(actualTables) !== canonicalJson(expectedTables)) {
    throw new LegacyImportError("unsupported_schema");
  }

  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const actual = db
      .query<SchemaColumn, []>(`PRAGMA table_info(${table})`)
      .all()
      .map(({ name, type, notnull, pk }) => ({ name, type: type.toUpperCase(), notnull, pk }));
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new LegacyImportError("unsupported_schema");
    }
  }

  const balanceForeignKeys = db.query<Record<string, unknown>, []>("PRAGMA foreign_key_list(credit_observations)").all();
  const grantForeignKeys = db.query<Record<string, unknown>, []>("PRAGMA foreign_key_list(credit_grant_events)").all();
  const expectedForeignKey = (row: Record<string, unknown>) =>
    row.table === "runs" && row.from === "run_id" && row.to === "id" && row.on_delete === "CASCADE";
  if (balanceForeignKeys.length !== 1 || !expectedForeignKey(balanceForeignKeys[0])) {
    throw new LegacyImportError("unsupported_schema");
  }
  if (grantForeignKeys.length !== 1 || !expectedForeignKey(grantForeignKeys[0])) {
    throw new LegacyImportError("unsupported_schema");
  }
}

function assertSourceBounds(db: Database): void {
  let totalRows = 0;
  for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
    const count = db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || count > MAX_ROWS_PER_TABLE) {
      throw new LegacyImportError("invalid_source_data");
    }
    totalRows += count;
    if (totalRows > MAX_TOTAL_ROWS) throw new LegacyImportError("invalid_source_data");

    const textColumns = columns.filter((column) => column.type === "TEXT").map((column) => column.name);
    if (textColumns.length === 0 || count === 0) continue;
    const maxExpressions = textColumns.map(
      (column, index) => `MAX(length(CAST(${column} AS BLOB))) AS max_${index}`,
    );
    const maxima = db.query<Record<string, number | null>, []>(
      `SELECT ${maxExpressions.join(", ")} FROM ${table}`,
    ).get();
    if (!maxima || Object.values(maxima).some((value) => value !== null && value > MAX_TEXT_BYTES)) {
      throw new LegacyImportError("invalid_source_data");
    }
  }
}

function assertMetricsAreTyped(db: Database): void {
  const row = db.query<{ invalid: number }, []>(`
    SELECT COUNT(*) AS invalid
    FROM runs
    WHERE json_valid(metrics) <> 1
       OR json_type(metrics) <> 'object'
       OR (json_type(metrics, '$.balance') IS NOT NULL AND json_type(metrics, '$.balance') NOT IN ('integer', 'real', 'null'))
       OR (json_type(metrics, '$.consumed') IS NOT NULL AND json_type(metrics, '$.consumed') NOT IN ('integer', 'real', 'null'))
       OR (json_type(metrics, '$.requestCount') IS NOT NULL AND json_type(metrics, '$.requestCount') NOT IN ('integer', 'null'))
       OR (json_type(metrics, '$.quotaPerUnit') IS NOT NULL AND json_type(metrics, '$.quotaPerUnit') NOT IN ('integer', 'real', 'null'))
       OR (json_type(metrics, '$.averageRpm') IS NOT NULL AND json_type(metrics, '$.averageRpm') NOT IN ('integer', 'real', 'null'))
       OR (json_type(metrics, '$.averageTpm') IS NOT NULL AND json_type(metrics, '$.averageTpm') NOT IN ('integer', 'real', 'null'))
       OR (json_type(metrics, '$.availableModels') IS NOT NULL AND json_type(metrics, '$.availableModels') NOT IN ('integer', 'null'))
  `).get();
  if (!row || row.invalid !== 0) throw new LegacyImportError("invalid_source_data");
}

const ERROR_CATEGORY_SQL = `CASE
  WHEN status <> 'error' OR error_message IS NULL THEN NULL
  WHEN lower(error_message) LIKE '%challenge%' OR lower(error_message) LIKE '%captcha%' THEN 'challenge_required'
  WHEN lower(error_message) LIKE '%login%' OR lower(error_message) LIKE '%sign in%' THEN 'login_required'
  WHEN lower(error_message) LIKE '%timeout%' OR lower(error_message) LIKE '%timed out%' THEN 'timeout'
  WHEN lower(error_message) LIKE '%unauthorized%' OR lower(error_message) LIKE '%forbidden%' OR lower(error_message) LIKE '%authentication%' THEN 'authentication'
  WHEN lower(error_message) LIKE '%network%' OR lower(error_message) LIKE '%econn%' OR lower(error_message) LIKE '%fetch failed%' THEN 'network'
  ELSE 'unknown'
END`;

function loadProjection(db: Database, secret: Uint8Array): LegacyAgentRouterProjection {
  assertSourceBounds(db);
  assertMetricsAreTyped(db);

  const runRows = db.query<RunRow, []>(`
    SELECT id, account_id, account_label, started_at, ended_at, status,
      login_ms, dashboard_ms, total_ms, logged_out, session_reused,
      ${ERROR_CATEGORY_SQL} AS error_category,
      json_extract(metrics, '$.balance') AS balance,
      json_extract(metrics, '$.consumed') AS consumed,
      json_extract(metrics, '$.requestCount') AS request_count,
      json_extract(metrics, '$.quotaPerUnit') AS quota_per_unit,
      json_extract(metrics, '$.averageRpm') AS average_rpm,
      json_extract(metrics, '$.averageTpm') AS average_tpm,
      json_extract(metrics, '$.availableModels') AS available_models
    FROM runs ORDER BY id
  `).all();
  const usageRows = db.query<UsageRow, []>(`
    SELECT account_id, granularity, created_at, model_name, request_count, token_used, quota
    FROM usage_points ORDER BY account_id, granularity, created_at, model_name
  `).all();
  const balanceRows = db.query<BalanceRow, []>(`
    SELECT id, run_id, account_id, observed_at, balance, consumed,
      previous_balance, previous_consumed, balance_delta, consumed_delta,
      minutes_since_previous, classification
    FROM credit_observations ORDER BY id
  `).all();
  const grantRows = db.query<GrantRow, []>(`
    SELECT id, run_id, account_id, source_event_id, occurred_at, amount, classification
    FROM credit_grant_events ORDER BY id
  `).all();
  const endpointRows = db.query<EndpointRow, []>(`
    SELECT id, account_id, account_label, observed_at, status, balance, consumed,
      request_count, latency_ms, ${ERROR_CATEGORY_SQL} AS error_category
    FROM endpoint_observations ORDER BY id
  `).all();

  const runs = runRows.map((row) => {
    const id = requireSafeInteger(row.id, false);
    const status = row.status === "ok" || row.status === "error" ? row.status : null;
    if (!status) throw new LegacyImportError("invalid_source_data");
    const value: ObservatoryAgentRouterRun = {
      id,
      accountId: safeAccountId(row.account_id),
      accountLabel: safeLabel(row.account_label),
      startedAt: safeTimestamp(row.started_at),
      endedAt: safeTimestamp(row.ended_at),
      status,
      loginMs: requireSafeInteger(row.login_ms),
      dashboardMs: requireSafeInteger(row.dashboard_ms),
      totalMs: requireSafeInteger(row.total_ms),
      loggedOut: requireBooleanInteger(row.logged_out),
      sessionReused: requireBooleanInteger(row.session_reused),
      errorCategory: row.error_category,
      balance: requireFinite(row.balance, true),
      consumed: requireFinite(row.consumed, true),
      requestCount: row.request_count === null ? null : requireSafeInteger(row.request_count),
      quotaPerUnit: requireFinite(row.quota_per_unit, true),
      averageRpm: requireFinite(row.average_rpm, true),
      averageTpm: requireFinite(row.average_tpm, true),
      availableModels: row.available_models === null ? null : requireSafeInteger(row.available_models),
    };
    return item(secret, "runs", [String(id)], value);
  });

  const usagePoints = usageRows.map((row) => {
    const accountId = safeAccountId(row.account_id);
    const granularity = row.granularity === "hour" || row.granularity === "day" || row.granularity === "week"
      ? row.granularity
      : null;
    if (!granularity) throw new LegacyImportError("invalid_source_data");
    const createdAtTs = requireSafeInteger(row.created_at);
    if (typeof row.model_name !== "string") throw new LegacyImportError("invalid_source_data");
    const rawModelName = row.model_name;
    const value: ObservatoryAgentRouterUsagePoint = {
      accountId,
      granularity,
      createdAtTs,
      modelName: safeModelIdentifier(rawModelName),
      requestCount: requireSafeInteger(row.request_count),
      tokenUsed: requireSafeInteger(row.token_used),
      quota: requireFinite(row.quota)!,
    };
    return item(secret, "usage_points", [accountId, granularity, String(createdAtTs), rawModelName], value);
  });

  const balances = balanceRows.map((row) => {
    const id = requireSafeInteger(row.id, false);
    const classification = ["initial", "credit-increase", "usage", "mixed", "unchanged"].includes(row.classification)
      ? row.classification as ObservatoryAgentRouterBalanceObservation["classification"]
      : null;
    if (!classification) throw new LegacyImportError("invalid_source_data");
    const value: ObservatoryAgentRouterBalanceObservation = {
      runId: requireSafeInteger(row.run_id, false),
      accountId: safeAccountId(row.account_id),
      observedAt: safeTimestamp(row.observed_at),
      balance: requireFinite(row.balance)!,
      consumed: requireFinite(row.consumed)!,
      previousBalance: requireFinite(row.previous_balance, true),
      previousConsumed: requireFinite(row.previous_consumed, true),
      balanceDelta: requireFinite(row.balance_delta, true),
      consumedDelta: requireFinite(row.consumed_delta, true),
      minutesSincePrevious: requireFinite(row.minutes_since_previous, true),
      classification,
    };
    return item(secret, "credit_observations", [String(id)], value);
  });

  const grants = grantRows.map((row) => {
    requireSafeInteger(row.id, false);
    if (typeof row.source_event_id !== "string" || row.source_event_id.length === 0) {
      throw new LegacyImportError("invalid_source_data");
    }
    const accountId = safeAccountId(row.account_id);
    const sourceKey = opaqueSourceKey(secret, "credit_grant_events", accountId, row.source_event_id);
    if (row.classification !== "daily-signin") throw new LegacyImportError("invalid_source_data");
    const value: ObservatoryAgentRouterGrantEvent = {
      runId: requireSafeInteger(row.run_id, false),
      accountId,
      sourceEventId: sourceKey,
      occurredAt: safeTimestamp(row.occurred_at),
      amount: requireFinite(row.amount)!,
      classification: "daily-signin",
    };
    if (value.amount <= 0) throw new LegacyImportError("invalid_source_data");
    return {
      sourceTable: "credit_grant_events",
      sourceKeyHmac: sourceKey,
      projectionSha256: hashProjection(value),
      value,
    };
  });

  const endpoints = endpointRows.map((row) => {
    const id = requireSafeInteger(row.id, false);
    const status = row.status === "ok" || row.status === "error" ? row.status : null;
    if (!status) throw new LegacyImportError("invalid_source_data");
    const value: ObservatoryAgentRouterEndpointObservation = {
      accountId: safeAccountId(row.account_id),
      accountLabel: safeLabel(row.account_label),
      observedAt: safeTimestamp(row.observed_at),
      status,
      balance: requireFinite(row.balance, true),
      consumed: requireFinite(row.consumed, true),
      requestCount: row.request_count === null ? null : requireSafeInteger(row.request_count),
      latencyMs: requireSafeInteger(row.latency_ms),
      errorCategory: row.error_category,
    };
    return item(secret, "endpoint_observations", [String(id)], value);
  });

  const accountState = new Map<string, { label: string; first: string; last: string; labelAt: string }>();
  const observeAccount = (accountId: string, label: string, timestamp: string): void => {
    const current = accountState.get(accountId);
    if (!current) {
      accountState.set(accountId, { label, first: timestamp, last: timestamp, labelAt: timestamp });
      return;
    }
    if (timestamp < current.first) current.first = timestamp;
    if (timestamp > current.last) current.last = timestamp;
    if (timestamp > current.labelAt || (timestamp === current.labelAt && label < current.label)) {
      current.label = label;
      current.labelAt = timestamp;
    }
  };
  for (const record of runs) observeAccount(record.value.accountId, record.value.accountLabel, record.value.startedAt);
  for (const record of endpoints) observeAccount(record.value.accountId, record.value.accountLabel, record.value.observedAt);
  const observeFallbackAccount = (accountId: string, timestamp: string): void => {
    if (!accountState.has(accountId)) {
      accountState.set(accountId, {
        label: safeLabel(accountId),
        first: timestamp,
        last: timestamp,
        labelAt: timestamp,
      });
    }
  };
  for (const record of usagePoints) {
    let timestamp: string;
    try {
      timestamp = new Date(record.value.createdAtTs * 1000).toISOString();
    } catch {
      throw new LegacyImportError("invalid_source_data");
    }
    observeFallbackAccount(record.value.accountId, timestamp);
  }
  for (const record of balances) observeFallbackAccount(record.value.accountId, record.value.observedAt);
  for (const record of grants) observeFallbackAccount(record.value.accountId, record.value.occurredAt);

  const accounts = [...accountState.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([accountId, state]) => ({
      accountId,
      accountLabel: state.label,
    }));

  const projectionWithoutHash = { accounts, runs, usagePoints, balances, grants, endpoints };
  return {
    projectionSha256: hashProjection(projectionWithoutHash),
    ...projectionWithoutHash,
  };
}

interface ValidatedLegacyImportOptions {
  snapshotPath: string;
  expectedSha256: string;
  importerVersion: string;
  importedAt: string;
  hmacKey: Uint8Array;
}

function validateOptions(options: LegacyAgentRouterImportOptions): ValidatedLegacyImportOptions {
  if (!options || typeof options !== "object") throw new LegacyImportError("invalid_options");
  const snapshotPathInput = options.snapshotPath;
  const expectedSha256Input = options.expectedSha256;
  const importerVersionInput = options.importerVersion;
  const hmacKeyInput = options.grantIdHmacKey;
  const importedAtInput = options.importedAt;
  if (typeof snapshotPathInput !== "string" || snapshotPathInput.length === 0) {
    throw new LegacyImportError("invalid_options");
  }
  const snapshotPath = `${snapshotPathInput}`;
  const expectedSha256 = typeof expectedSha256Input === "string" ? `${expectedSha256Input}`.toLowerCase() : "";
  const importerVersion = typeof importerVersionInput === "string" ? `${importerVersionInput}` : "";
  if (!SHA256_HEX.test(expectedSha256) || !IMPORTER_VERSION.test(importerVersion)) {
    throw new LegacyImportError("invalid_options");
  }
  if (!(hmacKeyInput instanceof Uint8Array) || hmacKeyInput.byteLength !== 32) {
    throw new LegacyImportError("invalid_options");
  }
  const hmacKey = Uint8Array.from(hmacKeyInput);
  let importedAt: string;
  try {
    importedAt = validateIsoUtcTimestamp(importedAtInput ? `${importedAtInput}` : new Date().toISOString(), "importedAt");
  } catch {
    hmacKey.fill(0);
    throw new LegacyImportError("invalid_options");
  }
  return Object.freeze({ snapshotPath, expectedSha256, importerVersion, importedAt, hmacKey });
}

/**
 * Explicitly imports a sealed legacy snapshot. Merely importing this module has no side effects.
 * Source values and its path are never included in errors, the ledger, or returned data.
 */
export async function importLegacyAgentRouterHistory(
  store: ObservatoryStore,
  options: LegacyAgentRouterImportOptions,
): Promise<LegacyAgentRouterImportResult> {
  const validated = validateOptions(options);
  let stagedSource: StagedSource | undefined;
  try {
    stagedSource = await stageImmutableSource(validated.snapshotPath, validated.expectedSha256);
    const batchIdentity = hashProjection({
      importerVersion: validated.importerVersion,
      sourceSha256: validated.expectedSha256,
    });
    const batchId = `legacy-agentrouter:${batchIdentity}`;
    const keyId = createHash("sha256").update(validated.hmacKey).digest("hex");

    let source: Database | undefined;
    let projection: LegacyAgentRouterProjection | undefined;
    let projectionError: LegacyImportError | undefined;
    try {
      await assertNoSidecars(stagedSource.stagingPath, "unsupported_schema");
      source = new Database(stagedSource.stagingPath, { readonly: true, create: false, strict: true });
      source.exec("PRAGMA query_only = ON;");
      assertExactSchema(source);
      projection = loadProjection(source, validated.hmacKey);
    } catch (error) {
      projectionError = error instanceof LegacyImportError
        ? error
        : new LegacyImportError("invalid_source_data");
    } finally {
      try {
        source?.close();
      } catch {
        // No source-derived information is exposed from close failures.
      }
    }

    await assertNoSidecars(stagedSource.stagingPath, "source_changed");
    await verifyImmutableSource(stagedSource, validated.expectedSha256);
    if (projectionError) throw projectionError;
    if (!projection) throw new LegacyImportError("invalid_source_data");

    const counts: LegacyImportCounts = {
      accounts: projection.accounts.length,
      runs: projection.runs.length,
      usagePoints: projection.usagePoints.length,
      balances: projection.balances.length,
      grants: projection.grants.length,
      endpoints: projection.endpoints.length,
    };
    const projectedRows: LegacyProjectedRow[] = [
      ...projection.accounts.map((value) => ({
        sourceTable: "projected_accounts",
        sourceKeyHmac: opaqueSourceKey(validated.hmacKey, "projected_accounts", value.accountId),
        projectionSha256: hashProjection(value),
        destinationKind: "account" as const,
        value,
      })),
      ...projection.runs.map((row) => ({ ...row, destinationKind: "run" as const })),
      ...projection.usagePoints.map((row) => ({ ...row, destinationKind: "usage" as const })),
      ...projection.balances.map((row) => ({ ...row, destinationKind: "balance" as const })),
      ...projection.grants.map((row) => ({ ...row, destinationKind: "grant" as const })),
      ...projection.endpoints.map((row) => ({ ...row, destinationKind: "endpoint" as const })),
    ];
    const recordCount = projectedRows.length;

    let outcome: "imported" | "duplicate";
    try {
      const result = store.importLegacySnapshot({
        batchId,
        source: SOURCE_NAME,
        snapshotSha256: validated.expectedSha256,
        sourceVersion: validated.importerVersion,
        keyId,
        projectionSha256: projection.projectionSha256,
        importedAt: validated.importedAt,
        projectedRows,
      });
      if (result.outcome === "conflict") throw new LegacyImportError("projection_conflict");
      outcome = result.outcome;
    } catch (error) {
      if (error instanceof LegacyImportError) throw error;
      throw new LegacyImportError("destination_failed");
    }

    return {
      outcome,
      batchId,
      sourceSha256: validated.expectedSha256,
      projectionSha256: projection.projectionSha256,
      recordCount,
      counts,
    };
  } finally {
    await cleanupStagedSource(stagedSource);
    validated.hmacKey.fill(0);
  }
}
