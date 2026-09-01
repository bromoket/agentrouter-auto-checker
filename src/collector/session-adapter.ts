/**
 * OMP Stats SQLite Session Adapter
 * Pinned to OMP version 18.0.11
 *
 * Provides read-only aggregation of local omp-stats SQLite database records
 * into privacy-safe, opaque OmpSessionSummaryInput domain objects.
 *
 * Security & Integrity Guarantees:
 * - P1: Strict allowlist-only provider and model resolution; zero raw string / prompt / path leakage;
 *       all PRAGMA / query / open failures are wrapped into categorical stackless errors.
 * - P2: Exact full pinned schema fingerprint across all 5 tables (messages, file_offsets, user_messages,
 *       tool_calls, meta), PRAGMA tuples, PK/unique constraints, all 12 indexes (including
 *       idx_messages_timestamp_agent_type), and all 7 meta migration sentinels (even if empty);
 *       enforces installed writerVersion === "18.0.11".
 * - P3: Host-bound HMAC-SHA256 with >= 32-byte key validated at entry; canonical host and Windows path
 *       normalization (slashes, duplicate separators, relative dots, and casing).
 * - P4: Deterministic cursor pagination over file_offsets PK (session_file), covering all sessions
 *       with branch-retained metric scope labeling.
 * - P5: Canonical vocabulary (error -> failed, aborted -> cancelled), activeWindowMs validation,
 *       now-skew bounds, strict non-zero/non-future timestamps, duration validation, lastActiveAt,
 *       and endedAt/closedAt populated only when closed.
 * - P6: costTrust = "estimated" for priced OMP estimates, "unknown" (costEstimate = null) when any
 *       unpriced row exists, and "exact" for 0-message sessions; validates all cost components.
 * - P7: Indexed LIMIT max+1 preflight message bounding per session and bounded cursor pagination.
 */

import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { OmpSessionSummaryInput } from "../observatory/types";
import { validateOmpSessionSummaryInput } from "../observatory/validation";

/**
 * Pinned OMP version supported by this adapter.
 */
export const PINNED_OMP_VERSION = "18.0.11";

/**
 * Expected schema fingerprint for OMP 18.0.11 database.
 */
export const PINNED_SCHEMA_FINGERPRINT = "omp_18.0.11_v1";

/**
 * Default active window threshold: 5 minutes (in milliseconds).
 */
export const DEFAULT_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Maximum allowed active window: 24 hours.
 */
export const MAX_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Default page size / session limit for cursor pagination.
 */
export const DEFAULT_PAGE_SIZE = 100;

/**
 * Hard ceiling on page size / session limit for cursor pagination.
 */
export const HARD_MAX_PAGE_SIZE = 500;

/**
 * Hard ceiling on session limit.
 */
export const HARD_MAX_SESSION_LIMIT = HARD_MAX_PAGE_SIZE;

/**
 * Default maximum messages processed per individual session before capping.
 */
export const DEFAULT_MAX_MESSAGES_PER_SESSION = 2000;

/**
 * Hard ceiling on maximum messages per session.
 */
export const HARD_MAX_MESSAGES_PER_SESSION = 10000;

/**
 * Maximum permitted timestamp future skew relative to collector clock (5 minutes).
 */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Maximum permitted single request duration (24 hours).
 */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum required byte length for HMAC key material.
 */
export const MIN_HMAC_KEY_BYTES = 32;

/**
 * Explicit source identifier for message cost totals.
 */
export const COST_SOURCE_MESSAGES = "omp_stats_messages_cost_total";

/**
 * Scope identifier explaining metrics represent branch-retained messages after fork deduplication.
 */
export const METRICS_SCOPE_RETAINED = "retained_branch_messages";

/**
 * Scope identifier when a session exceeds the maximum per-session message work limit.
 */
export const METRICS_SCOPE_CAPPED = "capped_branch_messages";

/**
 * Status source provenance indicator.
 */
export const STATUS_SOURCE_HEURISTIC = "omp_activity_heuristic_v1";


/**
 * Canonical stop reasons in OMP 18.0.11.
 */
export const CANONICAL_STOP_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
]);

/**
 * Required meta sentinels in OMP 18.0.11 stats database.
 */
export const REQUIRED_META_SENTINELS: readonly string[] = [
  "fork_dedupe_v1",
  "messages_cost_reingest_v1",
  "agent_type_v1",
  "premium_requests_priority_v1",
  "user_messages_v8",
  "tool_calls_v1",
  "user_message_links_v1",
] as const;
export const REQUIRED_INDEX_DEFINITIONS: Record<string, { table: string; columns: readonly string[] }> = {
  idx_messages_timestamp: { table: "messages", columns: ["timestamp"] },
  idx_messages_model: { table: "messages", columns: ["model"] },
  idx_messages_folder: { table: "messages", columns: ["folder"] },
  idx_messages_session: { table: "messages", columns: ["session_file"] },
  idx_messages_timestamp_model_provider: { table: "messages", columns: ["timestamp", "model", "provider"] },
  idx_messages_timestamp_folder: { table: "messages", columns: ["timestamp", "folder"] },
  idx_messages_stop_reason_timestamp: { table: "messages", columns: ["stop_reason", "timestamp"] },
  idx_messages_timestamp_agent_type: { table: "messages", columns: ["timestamp", "agent_type"] },
  idx_user_messages_timestamp: { table: "user_messages", columns: ["timestamp"] },
  idx_user_messages_timestamp_model: { table: "user_messages", columns: ["timestamp", "model", "provider"] },
  idx_tool_calls_timestamp: { table: "tool_calls", columns: ["timestamp"] },
  idx_tool_calls_tool_timestamp: { table: "tool_calls", columns: ["tool_name", "timestamp"] },
};

/**
 * Base adapter error with categorical code and message.
 */
export class OmpSessionAdapterError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OmpSessionAdapterError";
    this.code = code;
    this.stack = undefined;
  }
}

/**
 * Error thrown when SQLite database fails schema or migration validation.
 * Uses fixed categorical message without echoing untrusted column/table/path data.
 */
export class OmpSchemaValidationError extends OmpSessionAdapterError {
  constructor(code: string = "ERR_SCHEMA_VALIDATION", message: string = "SCHEMA_VALIDATION_FAILED") {
    super(code, message);
    this.name = "OmpSchemaValidationError";
  }
}

/**
 * Error thrown when SQLite database cannot be opened.
 * Uses fixed categorical message without interpolating file paths or internal SQLite causes.
 */
export class OmpDatabaseOpenError extends OmpSessionAdapterError {
  constructor(code: string = "ERR_DATABASE_OPEN", message: string = "DATABASE_OPEN_FAILED") {
    super(code, message);
    this.name = "OmpDatabaseOpenError";
  }
}

/**
 * Error thrown when a database query execution fails at the SQLite layer.
 */
export class OmpQueryExecutionError extends OmpSessionAdapterError {
  constructor(code: string = "ERR_QUERY_EXECUTION", message: string = "QUERY_EXECUTION_FAILED") {
    super(code, message);
    this.name = "OmpQueryExecutionError";
  }
}

/**
 * Error thrown when raw data corruption (e.g. negative costs, invalid timestamps, unknown stop reason) is detected.
 */
export class OmpInvalidDataError extends OmpSessionAdapterError {
  constructor(code: string = "ERR_INVALID_DATA", message: string = "DATA_VALIDATION_FAILED") {
    super(code, message);
    this.name = "OmpInvalidDataError";
  }
}

/**
 * Base configuration options for OmpSessionAdapter.
 */
export interface OmpSessionAdapterOptions {
  /**
   * Path to the local omp-stats SQLite database file.
   * Required when `db` is not provided.
   */
  dbPath?: string;

  /**
   * Pre-opened Database instance (useful for testing and in-memory databases).
   */
  db?: Database;

  /**
   * Secret key/salt used to derive opaque HMAC-SHA256 session IDs.
   * MUST be at least 32 bytes of cryptographically secure key material.
   * Note: Rotating this key will change all derived session IDs.
   */
  hmacKey: string | Buffer;

  /**
   * Host identifier for FleetHost association and cross-host namespace isolation.
   */
  hostId: string;

  /** Explicit non-empty provider allowlist supplied by the runtime owner. */
  allowedProviders?: ReadonlySet<string> | readonly string[];

  /** Explicit non-empty model allowlist supplied by the runtime owner. */
  allowedModels?: ReadonlySet<string> | readonly string[];

  /**
   * Installed writer version. Collection requires the exact pinned version.
   */
  writerVersion?: string;

  /**
   * Threshold in milliseconds to consider a session active since its latest activity.
   * Defaults to 300,000 ms (5 minutes).
   */
  activeWindowMs?: number;

  /**
   * Maximum messages processed per session before capping.
   * Defaults to 2000.
   */
  maxMessagesPerSession?: number;

  /**
   * Maximum number of sessions / page size per query.
   * Defaults to 100, hard ceiling 500.
   */
  sessionLimit?: number;

  /**
   * Alias for sessionLimit / page size.
   */
  pageSize?: number;

  /**
   * Optional time provider for deterministic testing (defaults to Date.now).
   */
  now?: () => Date | number;
}

/**
 * Cursor pagination options.
 */
export interface OmpSessionPageOptions extends OmpSessionAdapterOptions {
  /**
   * Opaque continuation cursor (last session_file primary key from previous page).
   */
  cursor?: string | null;
}

/**
 * Cursor pagination result.
 */
export interface OmpSessionPageResult {
  summaries: OmpSessionSummaryInput[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCollected: number;
}

/**
 * Schema validation result.
 */
export interface SchemaValidationResult {
  valid: boolean;
  schemaFingerprint: string;
  tableCount: number;
  indexCount: number;
  sentinelsComplete: boolean;
}

/**
 * Canonicalize only filesystem-equivalent syntax while preserving exact
 * Unicode and whitespace bytes. Ambiguous relative/dot paths are rejected.
 */
export function normalizePath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0 || /[\u0000-\u001f\u007f]/.test(rawPath)) {
    throw new OmpSessionAdapterError("ERR_INVALID_PATH", "PATH_NORMALIZATION_FAILED");
  }

  // Detect platform spelling before any separator conversion. POSIX treats a
  // backslash as an ordinary byte and therefore preserves it exactly.
  const isUnc = rawPath.startsWith("\\\\") || rawPath.startsWith("//");
  const isDrive = /^[a-zA-Z]:[\\/]/.test(rawPath);
  const isPosix = rawPath.startsWith("/") && !isUnc;
  if (isPosix) {
    const segments = rawPath.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
      throw new OmpSessionAdapterError("ERR_AMBIGUOUS_PATH", "PATH_NORMALIZATION_FAILED");
    }
    return `/${segments.join("/")}`;
  }
  if (!isUnc && !isDrive) {
    throw new OmpSessionAdapterError("ERR_AMBIGUOUS_PATH", "PATH_NORMALIZATION_FAILED");
  }

  const normalized = rawPath.replace(/\\/g, "/");
  const body = isUnc ? normalized.replace(/^\/{2,}/, "") : normalized.slice(3);
  const segments = body.split("/").filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    (isUnc && segments.length < 2) ||
    segments.some((segment) => segment === "." || segment === ".." || /[. ]$/.test(segment))
  ) {
    throw new OmpSessionAdapterError("ERR_AMBIGUOUS_PATH", "PATH_NORMALIZATION_FAILED");
  }
  const folded = segments.map((segment) => segment.replace(/[A-Z]/g, (character) => character.toLowerCase()));
  return isUnc ? `//${folded.join("/")}` : `${rawPath[0].toLowerCase()}:/${folded.join("/")}`;
}

/**
 * Canonicalize hostId string.
 */
export function canonicalizeHostId(hostId: string): string {
  if (typeof hostId !== "string" || hostId.trim().length === 0) {
    throw new OmpSessionAdapterError("ERR_INVALID_HOST_ID", "INVALID_HOST_ID");
  }
  const trimmed = hostId.trim().toLowerCase();
  if (!/^[a-z0-9._:-]{1,128}$/.test(trimmed)) {
    throw new OmpSessionAdapterError("ERR_INVALID_HOST_ID", "INVALID_HOST_ID");
  }
  return trimmed;
}

/**
 * Validate HMAC key material length (>= 32 bytes).
 */
export function validateHmacKey(hmacKey: unknown): Buffer {
  if (!hmacKey || (typeof hmacKey !== "string" && !Buffer.isBuffer(hmacKey))) {
    throw new OmpSessionAdapterError("ERR_MISSING_HMAC_KEY", "HMAC_KEY_REQUIRED");
  }
  const keyBuf = Buffer.isBuffer(hmacKey) ? hmacKey : Buffer.from(String(hmacKey), "utf8");
  if (keyBuf.length < MIN_HMAC_KEY_BYTES) {
    throw new OmpSessionAdapterError(
      "ERR_WEAK_HMAC_KEY",
      `HMAC_KEY_TOO_SHORT: minimum ${MIN_HMAC_KEY_BYTES} bytes required`
    );
  }
  return keyBuf;
}

const CURSOR_VERSION = 1;
const CURSOR_IV_BYTES = 12;
const CURSOR_TAG_BYTES = 16;

function cursorKey(hmacKey: string | Buffer): Buffer {
  return createHash("sha256").update(validateHmacKey(hmacKey)).update("afo-session-cursor-v1").digest();
}

function sealCursor(rawCursor: string, hostId: string, hmacKey: string | Buffer): string {
  const iv = randomBytes(CURSOR_IV_BYTES);
  const key = cursorKey(hmacKey);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const plaintext = `${canonicalizeHostId(hostId)}\0${rawCursor}`;
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from([CURSOR_VERSION]), iv, tag, ciphertext]).toString("base64url");
  } finally {
    key.fill(0);
  }
}

function openCursor(
  cursor: string | null | undefined,
  hostId: string,
  hmacKey: string | Buffer
): string | null {
  if (!cursor) return null;
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.length <= 1 + CURSOR_IV_BYTES + CURSOR_TAG_BYTES || bytes[0] !== CURSOR_VERSION) {
      throw new Error();
    }
    const iv = bytes.subarray(1, 1 + CURSOR_IV_BYTES);
    const tag = bytes.subarray(1 + CURSOR_IV_BYTES, 1 + CURSOR_IV_BYTES + CURSOR_TAG_BYTES);
    const ciphertext = bytes.subarray(1 + CURSOR_IV_BYTES + CURSOR_TAG_BYTES);
    const key = cursorKey(hmacKey);
    const decipher = (() => {
      try {
        return createDecipheriv("aes-256-gcm", key, iv);
      } finally {
        key.fill(0);
      }
    })();
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const prefix = `${canonicalizeHostId(hostId)}\0`;
    if (!plaintext.startsWith(prefix)) throw new Error();
    return plaintext.slice(prefix.length);
  } catch {
    throw new OmpSessionAdapterError("ERR_INVALID_CURSOR", "INVALID_CURSOR");
  }
}

/**
 * Derive a stable, privacy-preserving, host-bound opaque session ID from a local session_file path.
 *
 * Implements: HMAC-SHA256(key, length-prefixed canonical host and path).
 * Rotating the HMAC key intentionally changes all derived identifiers and invalidates cursors.
 */
export function deriveOpaqueSessionId(
  sessionFile: string,
  hostId: string,
  hmacKey: string | Buffer
): string {
  const keyBuf = validateHmacKey(hmacKey);
  const canonicalHost = canonicalizeHostId(hostId);
  const canonicalPath = normalizePath(sessionFile);

  // Bind hostId and canonicalPath unambiguously using length-prefixed payload
  const hostBytes = Buffer.byteLength(canonicalHost, "utf8");
  const pathBytes = Buffer.byteLength(canonicalPath, "utf8");
  const payload = `host:${hostBytes}:${canonicalHost}\0path:${pathBytes}:${canonicalPath}`;

  const hmac = createHmac("sha256", keyBuf);
  hmac.update(payload);
  return `sess_${hmac.digest("hex")}`;
}

/**
 * Sanitize provider string through strict allowlist matching.
 * Never passes through arbitrary strings. Returns canonical allowlisted string or null.
 */
export function sanitizeProvider(provider: unknown, allowedProviders: ReadonlySet<string>): string | null {
  if (typeof provider !== "string") return null;
  const trimmed = provider.trim().toLowerCase();
  if (allowedProviders.has(trimmed)) {
    return trimmed;
  }
  return null;
}

export function sanitizeModel(model: unknown, allowedModels: ReadonlySet<string>): string | null {
  if (typeof model !== "string") return null;
  const trimmed = model.trim();
  for (const allowed of allowedModels) {
    if (allowed.toLowerCase() === trimmed.toLowerCase()) {
      return allowed;
    }
  }
  return null;
}

/**
 * Validate that an SQLite database matches the complete pinned OMP 18.0.11 DDL and meta sentinels.
 *
 * Checks:
 * 1. Writer version if provided must equal "18.0.11"
 * 2. Required tables: `messages`, `file_offsets`, `user_messages`, `tool_calls`, `meta`
 * 3. Exact column definitions, types, nullability, PK, and defaults for all 5 tables
 * 4. Exact UNIQUE constraints
 * 5. All 12 required indexes (including idx_messages_timestamp_agent_type)
 * 6. All 7 meta migration sentinels (must exist and equal "complete", even if tables are empty)
 *
 * @param db Bun SQLite Database instance
 * @param writerVersion Optional writer version string
 * @returns SchemaValidationResult
 */
export function validateOmpStatsSchema(db: Database, writerVersion?: string): SchemaValidationResult {
  if (!db) {
    throw new OmpSchemaValidationError("ERR_NULL_DATABASE", "SCHEMA_VALIDATION_FAILED");
  }

  if (writerVersion !== PINNED_OMP_VERSION) {
    throw new OmpSchemaValidationError("ERR_WRITER_VERSION_MISMATCH", "SCHEMA_VALIDATION_FAILED");
  }

  try {
    // 1. Verify required tables
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];

    const tablePresent: Record<string, true> = {};
    for (const t of tables) {
      tablePresent[t.name] = true;
    }

    const requiredTables = ["messages", "file_offsets", "user_messages", "tool_calls", "meta"];
    for (const rt of requiredTables) {
      if (!tablePresent[rt]) {
        throw new OmpSchemaValidationError("ERR_MISSING_TABLES", "SCHEMA_VALIDATION_FAILED");
      }
    }

    if (tables.length !== 5) {
      throw new OmpSchemaValidationError("ERR_UNEXPECTED_TABLES", "SCHEMA_VALIDATION_FAILED");
    }

    const tableDefinitions = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string; sql: string | null }[];
    for (const definition of tableDefinitions) {
      // The pinned schema has no explicit table-level collation. Refuse every
      // COLLATE clause rather than attempting to parse SQLite DDL (quoted
      // identifiers and comments make partial regex parsing unsound).
      if (!definition.sql || /\bCOLLATE\b/i.test(definition.sql)) {
        throw new OmpSchemaValidationError("ERR_TABLE_COLLATION", "SCHEMA_VALIDATION_FAILED");
      }
    }

    // 2. Verify messages table columns, types, nullability, pk, default
    const messageCols = db.prepare("PRAGMA table_info(messages)").all() as {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }[];

    const expectedMessageColumns: Record<string, { type: string; notnull: number; pk: number }> = {
      id: { type: "INTEGER", notnull: 0, pk: 1 },
      session_file: { type: "TEXT", notnull: 1, pk: 0 },
      entry_id: { type: "TEXT", notnull: 1, pk: 0 },
      folder: { type: "TEXT", notnull: 1, pk: 0 },
      model: { type: "TEXT", notnull: 1, pk: 0 },
      provider: { type: "TEXT", notnull: 1, pk: 0 },
      api: { type: "TEXT", notnull: 1, pk: 0 },
      timestamp: { type: "INTEGER", notnull: 1, pk: 0 },
      duration: { type: "INTEGER", notnull: 0, pk: 0 },
      ttft: { type: "INTEGER", notnull: 0, pk: 0 },
      stop_reason: { type: "TEXT", notnull: 1, pk: 0 },
      error_message: { type: "TEXT", notnull: 0, pk: 0 },
      input_tokens: { type: "INTEGER", notnull: 1, pk: 0 },
      output_tokens: { type: "INTEGER", notnull: 1, pk: 0 },
      cache_read_tokens: { type: "INTEGER", notnull: 1, pk: 0 },
      cache_write_tokens: { type: "INTEGER", notnull: 1, pk: 0 },
      total_tokens: { type: "INTEGER", notnull: 1, pk: 0 },
      premium_requests: { type: "REAL", notnull: 1, pk: 0 },
      cost_input: { type: "REAL", notnull: 1, pk: 0 },
      cost_output: { type: "REAL", notnull: 1, pk: 0 },
      cost_cache_read: { type: "REAL", notnull: 1, pk: 0 },
      cost_cache_write: { type: "REAL", notnull: 1, pk: 0 },
      cost_total: { type: "REAL", notnull: 1, pk: 0 },
      cost_no_cache_input: { type: "REAL", notnull: 0, pk: 0 },
      agent_type: { type: "TEXT", notnull: 1, pk: 0 },
    };

    if (messageCols.length !== Object.keys(expectedMessageColumns).length) {
      throw new OmpSchemaValidationError("ERR_MESSAGES_COLUMN_COUNT", "SCHEMA_VALIDATION_FAILED");
    }

    const messageNames = Object.keys(expectedMessageColumns);
    for (const c of messageCols) {
      const exp = expectedMessageColumns[c.name];
      const defaultMatches = c.name === "agent_type"
        ? c.dflt_value === "'main'"
        : c.name === "premium_requests"
          ? c.dflt_value === null || c.dflt_value === "0"
          : c.dflt_value === null;
      if (
        !exp ||
        c.cid !== messageNames.indexOf(c.name) ||
        exp.type !== c.type.toUpperCase() ||
        exp.notnull !== c.notnull ||
        exp.pk !== c.pk ||
        !defaultMatches
      ) {
        throw new OmpSchemaValidationError("ERR_MESSAGES_COLUMN_MISMATCH", "SCHEMA_VALIDATION_FAILED");
      }
    }

    // Verify messages UNIQUE(session_file, entry_id) constraint
    const messageIndexList = db.prepare("PRAGMA index_list(messages)").all() as {
      name: string;
      unique: number;
    }[];
    const hasMessageUnique = messageIndexList.some((idx) => {
      if (idx.unique !== 1) return false;
      const info = db.prepare(`PRAGMA index_info('${idx.name}')`).all() as { name: string }[];
      const cols = info.map((i) => i.name);
      return cols.length === 2 && cols.includes("session_file") && cols.includes("entry_id");
    });
    if (!hasMessageUnique) {
      throw new OmpSchemaValidationError("ERR_MESSAGES_UNIQUE_CONSTRAINT", "SCHEMA_VALIDATION_FAILED");
    }

    // 3. Verify file_offsets table
    const offsetCols = db.prepare("PRAGMA table_info(file_offsets)").all() as {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }[];

    const expectedOffsetColumns: Record<string, { type: string; notnull: number; pk: number }> = {
      session_file: { type: "TEXT", notnull: 0, pk: 1 },
      offset: { type: "INTEGER", notnull: 1, pk: 0 },
      last_modified: { type: "INTEGER", notnull: 1, pk: 0 },
    };

    if (offsetCols.length !== 3) {
      throw new OmpSchemaValidationError("ERR_OFFSETS_COLUMN_COUNT", "SCHEMA_VALIDATION_FAILED");
    }

    const offsetNames = Object.keys(expectedOffsetColumns);
    for (const c of offsetCols) {
      const exp = expectedOffsetColumns[c.name];
      if (
        !exp ||
        c.cid !== offsetNames.indexOf(c.name) ||
        exp.type !== c.type.toUpperCase() ||
        exp.notnull !== c.notnull ||
        exp.pk !== c.pk ||
        c.dflt_value !== null
      ) {
        throw new OmpSchemaValidationError("ERR_OFFSETS_COLUMN_MISMATCH", "SCHEMA_VALIDATION_FAILED");
      }
    }

    // 4. Verify user_messages table
    const userMsgCols = db.prepare("PRAGMA table_info(user_messages)").all() as {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }[];

    const expectedUserMsgColumns: Record<string, { type: string; notnull: number; pk: number }> = {
      id: { type: "INTEGER", notnull: 0, pk: 1 },
      session_file: { type: "TEXT", notnull: 1, pk: 0 },
      entry_id: { type: "TEXT", notnull: 1, pk: 0 },
      folder: { type: "TEXT", notnull: 1, pk: 0 },
      timestamp: { type: "INTEGER", notnull: 1, pk: 0 },
      model: { type: "TEXT", notnull: 0, pk: 0 },
      provider: { type: "TEXT", notnull: 0, pk: 0 },
      chars: { type: "INTEGER", notnull: 1, pk: 0 },
      words: { type: "INTEGER", notnull: 1, pk: 0 },
      yelling: { type: "INTEGER", notnull: 1, pk: 0 },
      profanity: { type: "INTEGER", notnull: 1, pk: 0 },
      anguish: { type: "INTEGER", notnull: 1, pk: 0 },
      negation: { type: "INTEGER", notnull: 1, pk: 0 },
      repetition: { type: "INTEGER", notnull: 1, pk: 0 },
      blame: { type: "INTEGER", notnull: 1, pk: 0 },
    };

    if (userMsgCols.length !== Object.keys(expectedUserMsgColumns).length) {
      throw new OmpSchemaValidationError("ERR_USER_MESSAGES_COLUMN_COUNT", "SCHEMA_VALIDATION_FAILED");
    }

    const userMessageNames = Object.keys(expectedUserMsgColumns);
    for (const c of userMsgCols) {
      const exp = expectedUserMsgColumns[c.name];
      const expectedDefault = ["negation", "repetition", "blame"].includes(c.name) ? "0" : null;
      if (
        !exp ||
        c.cid !== userMessageNames.indexOf(c.name) ||
        exp.type !== c.type.toUpperCase() ||
        exp.notnull !== c.notnull ||
        exp.pk !== c.pk ||
        c.dflt_value !== expectedDefault
      ) {
        throw new OmpSchemaValidationError("ERR_USER_MESSAGES_COLUMN_MISMATCH", "SCHEMA_VALIDATION_FAILED");
      }
    }

    const userUnique = (db.prepare("PRAGMA index_list(user_messages)").all() as { name: string; unique: number }[])
      .some((index) => {
        if (index.unique !== 1) return false;
        const columns = db.prepare(`PRAGMA index_info('${index.name}')`).all() as { name: string }[];
        return columns.map((column) => column.name).join(",") === "session_file,entry_id";
      });
    if (!userUnique) {
      throw new OmpSchemaValidationError("ERR_USER_MESSAGES_UNIQUE", "SCHEMA_VALIDATION_FAILED");
    }

    // 5. Verify tool_calls table
    const toolCallCols = db.prepare("PRAGMA table_info(tool_calls)").all() as {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }[];

    const expectedToolCallColumns: Record<string, { type: string; notnull: number; pk: number }> = {
      id: { type: "INTEGER", notnull: 0, pk: 1 },
      session_file: { type: "TEXT", notnull: 1, pk: 0 },
      entry_id: { type: "TEXT", notnull: 1, pk: 0 },
      tool_call_id: { type: "TEXT", notnull: 1, pk: 0 },
      folder: { type: "TEXT", notnull: 1, pk: 0 },
      tool_name: { type: "TEXT", notnull: 1, pk: 0 },
      model: { type: "TEXT", notnull: 1, pk: 0 },
      provider: { type: "TEXT", notnull: 1, pk: 0 },
      timestamp: { type: "INTEGER", notnull: 1, pk: 0 },
      agent_type: { type: "TEXT", notnull: 1, pk: 0 },
      calls_in_turn: { type: "INTEGER", notnull: 1, pk: 0 },
      args_chars: { type: "INTEGER", notnull: 1, pk: 0 },
      result_chars: { type: "INTEGER", notnull: 0, pk: 0 },
      is_error: { type: "INTEGER", notnull: 0, pk: 0 },
    };

    if (toolCallCols.length !== Object.keys(expectedToolCallColumns).length) {
      throw new OmpSchemaValidationError("ERR_TOOL_CALLS_COLUMN_COUNT", "SCHEMA_VALIDATION_FAILED");
    }

    const toolCallNames = Object.keys(expectedToolCallColumns);
    for (const c of toolCallCols) {
      const exp = expectedToolCallColumns[c.name];
      const expectedDefault = c.name === "agent_type" ? "'main'" : c.name === "calls_in_turn" ? "1" : c.name === "args_chars" ? "0" : null;
      if (
        !exp ||
        c.cid !== toolCallNames.indexOf(c.name) ||
        exp.type !== c.type.toUpperCase() ||
        exp.notnull !== c.notnull ||
        exp.pk !== c.pk ||
        c.dflt_value !== expectedDefault
      ) {
        throw new OmpSchemaValidationError("ERR_TOOL_CALLS_COLUMN_MISMATCH", "SCHEMA_VALIDATION_FAILED");
      }
    }

    const toolUnique = (db.prepare("PRAGMA index_list(tool_calls)").all() as { name: string; unique: number }[])
      .some((index) => {
        if (index.unique !== 1) return false;
        const columns = db.prepare(`PRAGMA index_info('${index.name}')`).all() as { name: string }[];
        return columns.map((column) => column.name).join(",") === "session_file,tool_call_id";
      });
    if (!toolUnique) {
      throw new OmpSchemaValidationError("ERR_TOOL_CALLS_UNIQUE", "SCHEMA_VALIDATION_FAILED");
    }

    // 6. Verify meta table
    const metaCols = db.prepare("PRAGMA table_info(meta)").all() as {
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }[];
    if (
      metaCols.length !== 2 ||
      metaCols[0].cid !== 0 ||
      metaCols[0].name !== "key" ||
      metaCols[0].type.toUpperCase() !== "TEXT" ||
      metaCols[0].notnull !== 0 ||
      metaCols[0].dflt_value !== null ||
      metaCols[0].pk !== 1 ||
      metaCols[1].cid !== 1 ||
      metaCols[1].name !== "value" ||
      metaCols[1].type.toUpperCase() !== "TEXT" ||
      metaCols[1].notnull !== 1 ||
      metaCols[1].dflt_value !== null ||
      metaCols[1].pk !== 0
    ) {
      throw new OmpSchemaValidationError("ERR_META_SCHEMA_MISMATCH", "SCHEMA_VALIDATION_FAILED");
    }

    // 7. Verify all 12 indexes
    const indexes = db
      .prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'")
      .all() as { name: string; tbl_name: string }[];

    if (indexes.length !== Object.keys(REQUIRED_INDEX_DEFINITIONS).length) {
      throw new OmpSchemaValidationError("ERR_INDEX_COUNT_MISMATCH", "SCHEMA_VALIDATION_FAILED");
    }

    const indexMap: Record<string, string> = {};
    for (const index of indexes) indexMap[index.name] = index.tbl_name;
    for (const [indexName, expected] of Object.entries(REQUIRED_INDEX_DEFINITIONS)) {
      if (indexMap[indexName] !== expected.table) {
        throw new OmpSchemaValidationError("ERR_INDEX_MISMATCH", "SCHEMA_VALIDATION_FAILED");
      }
      const info = db.prepare(`PRAGMA index_xinfo('${indexName}')`).all() as {
        name: string | null;
        key: number;
        coll: string;
        desc: number;
      }[];
      const keyColumns = info.filter((column) => column.key === 1);
      const columns = keyColumns.map((column) => column.name);
      if (
        columns.length !== expected.columns.length ||
        columns.some((column, position) => column !== expected.columns[position]) ||
        keyColumns.some((column) => column.coll !== "BINARY" || column.desc !== 0)
      ) {
        throw new OmpSchemaValidationError("ERR_INDEX_COLUMNS", "SCHEMA_VALIDATION_FAILED");
      }
      const list = db.prepare(`PRAGMA index_list('${expected.table}')`).all() as {
        name: string;
        unique: number;
        partial: number;
      }[];
      const declared = list.find((candidate) => candidate.name === indexName);
      if (!declared || declared.unique !== 0 || declared.partial !== 0) {
        throw new OmpSchemaValidationError("ERR_INDEX_FLAGS", "SCHEMA_VALIDATION_FAILED");
      }
    }

    // 8. Verify exact meta migration sentinels (all must be complete, with no unknown keys).
    const metaRows = db.prepare("SELECT key, value FROM meta ORDER BY key").all() as { key: string; value: string }[];
    if (metaRows.length !== REQUIRED_META_SENTINELS.length) {
      throw new OmpSchemaValidationError("ERR_SENTINEL_SET_MISMATCH", "SCHEMA_VALIDATION_FAILED");
    }
    const metaMap: Record<string, string> = {};
    for (const row of metaRows) metaMap[row.key] = row.value;
    for (const sentinel of REQUIRED_META_SENTINELS) {
      const val = metaMap[sentinel];
      if (val !== "complete") {
        throw new OmpSchemaValidationError("ERR_SENTINEL_INCOMPLETE", "SCHEMA_VALIDATION_FAILED");
      }
    }

    return {
      valid: true,
      schemaFingerprint: PINNED_SCHEMA_FINGERPRINT,
      tableCount: tables.length,
      indexCount: indexes.length,
      sentinelsComplete: true,
    };
  } catch (err) {
    if (err instanceof OmpSessionAdapterError) throw err;
    throw new OmpSchemaValidationError("ERR_SCHEMA_VALIDATION", "SCHEMA_VALIDATION_FAILED");
  }
}

/**
 * Execute bounded cursor pagination query over file_offsets PK (session_file).
 *
 * @param options Page collection options
 * @returns OmpSessionPageResult
 */
export function collectOmpSessionPage(options: OmpSessionPageOptions): OmpSessionPageResult {
  // Validate HMAC key at entry
  validateHmacKey(options.hmacKey);

  // Validate canonical hostId at entry
  const canonicalHost = canonicalizeHostId(options.hostId);

  if (!options.allowedProviders || !options.allowedModels) {
    throw new OmpSessionAdapterError("ERR_MISSING_ALLOWLIST", "MODEL_PROVIDER_ALLOWLIST_REQUIRED");
  }
  const allowedProviders = new Set([...options.allowedProviders].map((provider) => provider.toLowerCase()));
  const allowedModels = new Set([...options.allowedModels]);
  if (allowedProviders.size === 0 || allowedModels.size === 0) {
    throw new OmpSessionAdapterError("ERR_EMPTY_ALLOWLIST", "MODEL_PROVIDER_ALLOWLIST_REQUIRED");
  }

  // Validate pageSize / sessionLimit
  const rawPageSize = options.pageSize ?? options.sessionLimit ?? DEFAULT_PAGE_SIZE;
  if (
    typeof rawPageSize !== "number" ||
    isNaN(rawPageSize) ||
    !isFinite(rawPageSize) ||
    !Number.isInteger(rawPageSize) ||
    rawPageSize < 1 ||
    rawPageSize > HARD_MAX_PAGE_SIZE
  ) {
    throw new OmpSessionAdapterError(
      "ERR_INVALID_PAGE_SIZE",
      `INVALID_PAGE_SIZE: must be integer between 1 and ${HARD_MAX_PAGE_SIZE}`
    );
  }
  const pageSize = rawPageSize;

  // Validate activeWindowMs
  const rawActiveWindow = options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS;
  if (
    typeof rawActiveWindow !== "number" ||
    isNaN(rawActiveWindow) ||
    !isFinite(rawActiveWindow) ||
    rawActiveWindow < 0 ||
    rawActiveWindow > MAX_ACTIVE_WINDOW_MS
  ) {
    throw new OmpSessionAdapterError("ERR_INVALID_ACTIVE_WINDOW", "INVALID_ACTIVE_WINDOW");
  }
  const activeWindowMs = rawActiveWindow;

  // Validate maxMessagesPerSession
  const rawMaxMsg = options.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES_PER_SESSION;
  if (
    typeof rawMaxMsg !== "number" ||
    isNaN(rawMaxMsg) ||
    !isFinite(rawMaxMsg) ||
    !Number.isInteger(rawMaxMsg) ||
    rawMaxMsg < 1 ||
    rawMaxMsg > HARD_MAX_MESSAGES_PER_SESSION
  ) {
    throw new OmpSessionAdapterError("ERR_INVALID_MAX_MESSAGES", "INVALID_MAX_MESSAGES_PER_SESSION");
  }
  const maxMessages = rawMaxMsg;

  // Validate now timestamp
  const nowVal = options.now ? (typeof options.now === "function" ? options.now() : options.now) : Date.now();
  const nowMs = typeof nowVal === "number" ? nowVal : nowVal.getTime();
  if (isNaN(nowMs) || !isFinite(nowMs) || nowMs <= 0 || nowMs > 4102444800000) {
    throw new OmpInvalidDataError("ERR_INVALID_NOW", "DATA_VALIDATION_FAILED");
  }
  const collectedAtIso = new Date(nowMs).toISOString();

  let db: Database | null = null;
  let shouldCloseDb = false;

  if (options.db) {
    db = options.db;
  } else if (options.dbPath) {
    try {
      db = new Database(options.dbPath, { readonly: true, create: false });
      shouldCloseDb = true;
    } catch {
      throw new OmpDatabaseOpenError("ERR_DATABASE_OPEN", "DATABASE_OPEN_FAILED");
    }
  } else {
    throw new OmpSessionAdapterError("ERR_MISSING_DB", "DATABASE_PATH_OR_INSTANCE_REQUIRED");
  }

  try {
    try {
      // Synchronous reads are row-bounded below; never wait on a locked writer.
      db.run("PRAGMA busy_timeout = 0");
    } catch {
      throw new OmpQueryExecutionError("ERR_QUERY_EXECUTION", "QUERY_EXECUTION_FAILED");
    }
    // 1. Validate complete schema and sentinels
    const schemaResult = validateOmpStatsSchema(db, options.writerVersion);

    // 2. Query file_offsets via its primary-key order. Public cursors are encrypted and host-bound.
    const rawCursor = openCursor(options.cursor, canonicalHost, options.hmacKey);
    const offsetQuery = `
      SELECT session_file, offset, last_modified
      FROM file_offsets
      WHERE (? IS NULL OR session_file > ?)
      ORDER BY session_file ASC
      LIMIT ?
    `;

    let pageRows: { session_file: string; offset: number; last_modified: number }[];
    try {
      pageRows = db.prepare(offsetQuery).all(rawCursor, rawCursor, pageSize + 1) as {
        session_file: string;
        offset: number;
        last_modified: number;
      }[];
    } catch {
      throw new OmpQueryExecutionError("ERR_QUERY_EXECUTION", "QUERY_EXECUTION_FAILED");
    }

    const hasMore = pageRows.length > pageSize;
    const targetRows = hasMore ? pageRows.slice(0, pageSize) : pageRows;
    const nextCursor = hasMore
      ? sealCursor(targetRows[targetRows.length - 1].session_file, canonicalHost, options.hmacKey)
      : null;

    const summaries: OmpSessionSummaryInput[] = [];

    // 3. Process each target session within bounded limits
    for (const target of targetRows) {
      const sessionFile = target.session_file;
      const lastModifiedMs = target.last_modified;

      // Validate last_modified
      if (
        typeof lastModifiedMs !== "number" ||
        isNaN(lastModifiedMs) ||
        !isFinite(lastModifiedMs) ||
        lastModifiedMs <= 0 ||
        lastModifiedMs > nowMs + MAX_FUTURE_SKEW_MS
      ) {
        throw new OmpInvalidDataError("ERR_INVALID_LAST_MODIFIED", "DATA_VALIDATION_FAILED");
      }

      // Per-session work probe uses the indexed session lookup with a strict max+1 row bound.
      let messages: {
        id: number;
        model: string;
        provider: string;
        timestamp: number;
        duration: number | null;
        stop_reason: string;
        error_message: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        total_tokens: number;
        cost_input: number;
        cost_output: number;
        cost_cache_read: number;
        cost_cache_write: number;
        cost_total: number;
        cost_no_cache_input: number | null;
      }[];

      try {
        messages = db
          .prepare("SELECT * FROM messages WHERE session_file = ? ORDER BY session_file, id LIMIT ?")
          .all(sessionFile, maxMessages + 1) as typeof messages;
      } catch {
        throw new OmpQueryExecutionError("ERR_QUERY_EXECUTION", "QUERY_EXECUTION_FAILED");
      }
      const isCapped = messages.length > maxMessages;
      const metricsScope = isCapped ? METRICS_SCOPE_CAPPED : METRICS_SCOPE_RETAINED;
      const msgCount: number | null = isCapped ? null : messages.length;
      if (isCapped) messages = [];

      // Derive opaque session ID
      const sessionId = deriveOpaqueSessionId(sessionFile, canonicalHost, options.hmacKey);

      let minStartTs: number | null = null;
      let maxCompletionTs: number | null = null;
      let sumDuration = 0;
      let sumInputTokens = 0;
      let sumOutputTokens = 0;
      let sumCacheReadTokens = 0;
      let sumCacheWriteTokens = 0;
      let sumTotalTokens = 0;
      let sumCostTotal = 0;
      let unpricedCount = 0;
      let errorCount = 0;
      let latestModelRaw: string | null = null;
      let latestProviderRaw: string | null = null;
      let latestStopReason: string | null = null;
      let latestDuration: number | null = null;
      let latestTimestamp = -1;
      let latestId = -1;

      for (const msg of messages) {
        if (
          !Number.isFinite(msg.timestamp) ||
          msg.timestamp <= 0 ||
          msg.timestamp > nowMs + MAX_FUTURE_SKEW_MS
        ) {
          throw new OmpInvalidDataError("ERR_INVALID_TIMESTAMP", "DATA_VALIDATION_FAILED");
        }

        const duration = msg.duration ?? 0;
        if (!Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION_MS) {
          throw new OmpInvalidDataError("ERR_INVALID_DURATION", "DATA_VALIDATION_FAILED");
        }
        const completionTs = msg.timestamp + duration;
        if (!Number.isFinite(completionTs) || completionTs > nowMs + MAX_FUTURE_SKEW_MS) {
          throw new OmpInvalidDataError("ERR_FUTURE_COMPLETION", "DATA_VALIDATION_FAILED");
        }
        if (!CANONICAL_STOP_REASONS.has(msg.stop_reason)) {
          throw new OmpInvalidDataError("ERR_UNKNOWN_STOP_REASON", "DATA_VALIDATION_FAILED");
        }

        const tokens = [
          msg.input_tokens,
          msg.output_tokens,
          msg.cache_read_tokens,
          msg.cache_write_tokens,
          msg.total_tokens,
        ];
        if (tokens.some((value) => !Number.isSafeInteger(value) || value < 0)) {
          throw new OmpInvalidDataError("ERR_CORRUPT_TOKEN_COUNT", "DATA_VALIDATION_FAILED");
        }
        const componentTokens =
          msg.input_tokens + msg.output_tokens + msg.cache_read_tokens + msg.cache_write_tokens;
        if (!Number.isSafeInteger(componentTokens) || msg.total_tokens < componentTokens) {
          throw new OmpInvalidDataError("ERR_TOKEN_RELATIONSHIP", "DATA_VALIDATION_FAILED");
        }

        const costs = [
          msg.cost_input,
          msg.cost_output,
          msg.cost_cache_read,
          msg.cost_cache_write,
          msg.cost_total,
          ...(msg.cost_no_cache_input === null ? [] : [msg.cost_no_cache_input]),
        ];
        if (costs.some((value) => !Number.isFinite(value) || value < 0)) {
          throw new OmpInvalidDataError("ERR_CORRUPT_COST_COMPONENT", "DATA_VALIDATION_FAILED");
        }
        const componentCost =
          msg.cost_input + msg.cost_output + msg.cost_cache_read + msg.cost_cache_write;
        const totalOnlyLegacyCost = componentCost === 0 && msg.cost_total > 0;
        const costTolerance = 1e-9 * Math.max(1, componentCost, msg.cost_total);
        if (
          !Number.isFinite(componentCost) ||
          (!totalOnlyLegacyCost && Math.abs(msg.cost_total - componentCost) > costTolerance)
        ) {
          throw new OmpInvalidDataError("ERR_COST_RELATIONSHIP", "DATA_VALIDATION_FAILED");
        }

        minStartTs = minStartTs === null ? msg.timestamp : Math.min(minStartTs, msg.timestamp);
        maxCompletionTs = maxCompletionTs === null ? completionTs : Math.max(maxCompletionTs, completionTs);
        if (msg.timestamp > latestTimestamp || (msg.timestamp === latestTimestamp && msg.id > latestId)) {
          latestTimestamp = msg.timestamp;
          latestId = msg.id;
          latestModelRaw = msg.model;
          latestProviderRaw = msg.provider;
          latestStopReason = msg.stop_reason;
          latestDuration = msg.duration;
        }

        sumDuration += duration;
        sumInputTokens += msg.input_tokens;
        sumOutputTokens += msg.output_tokens;
        sumCacheReadTokens += msg.cache_read_tokens;
        sumCacheWriteTokens += msg.cache_write_tokens;
        sumTotalTokens += msg.total_tokens;
        sumCostTotal += componentCost;
        if (
          !Number.isSafeInteger(sumInputTokens) ||
          !Number.isSafeInteger(sumOutputTokens) ||
          !Number.isSafeInteger(sumCacheReadTokens) ||
          !Number.isSafeInteger(sumCacheWriteTokens) ||
          !Number.isSafeInteger(sumTotalTokens) ||
          !Number.isFinite(sumCostTotal)
        ) {
          throw new OmpInvalidDataError("ERR_AGGREGATE_OVERFLOW", "DATA_VALIDATION_FAILED");
        }

        if (msg.stop_reason === "error" || Boolean(msg.error_message)) errorCount++;
        if (
          totalOnlyLegacyCost ||
          (msg.total_tokens > 0 &&
            msg.cost_total === 0 &&
            (msg.provider === "xai-oauth" || msg.cost_no_cache_input === null))
        ) {
          unpricedCount++;
        }
      }

      const startedAt = minStartTs !== null ? new Date(minStartTs).toISOString() : new Date(lastModifiedMs).toISOString();

      const lastActiveMs = Math.max(lastModifiedMs, maxCompletionTs ?? lastModifiedMs);
      const lastActiveAt = new Date(lastActiveMs).toISOString();

      // Duration is unavailable if the bounded probe found more rows than permitted.
      let durationMs: number | null = null;
      if (isCapped) {
        durationMs = null;
      } else if (messages.length === 1) {
        durationMs = Math.max(0, latestDuration ?? sumDuration);
      } else if (minStartTs !== null && maxCompletionTs !== null) {
        durationMs = Math.max(0, maxCompletionTs - minStartTs);
      } else {
        durationMs = 0;
      }

      // Cost trust & estimate
      let costEstimate: number | null = null;
      let costMicros: number | null = null;
      let costTrustField: "exact" | "estimated" | "unknown" | null = null;
      let costTrustMeta: "complete" | "unpriced_rows_present" | "no_messages" | "metrics_unavailable";
      let pricedSubtotal: number | null = null;

      if (isCapped) {
        costEstimate = null;
        costMicros = null;
        costTrustField = "unknown";
        costTrustMeta = "metrics_unavailable";
      } else if (messages.length === 0) {
        costEstimate = 0;
        costMicros = 0;
        costTrustField = "exact";
        costTrustMeta = "no_messages";
        pricedSubtotal = 0;
      } else if (unpricedCount > 0) {
        costEstimate = null;
        costMicros = null;
        costTrustField = "unknown";
        costTrustMeta = "unpriced_rows_present";
        pricedSubtotal = Number(sumCostTotal.toFixed(6));
      } else {
        costEstimate = Number(sumCostTotal.toFixed(6));
        costMicros = Math.round(costEstimate * 1_000_000);
        if (!Number.isSafeInteger(costMicros)) {
          throw new OmpInvalidDataError("ERR_COST_OVERFLOW", "DATA_VALIDATION_FAILED");
        }
        costTrustField = "estimated";
        costTrustMeta = "complete";
        pricedSubtotal = costEstimate;
      }

      // Status derivation
      const isWithinActiveWindow = nowMs - lastActiveMs <= activeWindowMs;
      let status: string;

      if (isCapped) {
        status = "unknown";
      } else if (latestStopReason === "error" || (errorCount > 0 && latestStopReason === "error")) {
        status = "failed";
      } else if (latestStopReason === "aborted") {
        status = "cancelled";
      } else if (isWithinActiveWindow) {
        status = "active";
      } else {
        status = "completed";
      }
      // closedAt / endedAt populated only when session is closed
      let closedAt: string | null = null;
      if (["completed", "failed", "cancelled"].includes(status)) {
        closedAt = maxCompletionTs !== null ? new Date(maxCompletionTs).toISOString() : new Date(lastModifiedMs).toISOString();
        if (Date.parse(closedAt) < Date.parse(startedAt)) {
          closedAt = startedAt;
        }
      }
      const endedAt = closedAt;

      // Allowlist resolution for model and provider
      const resolvedModel = sanitizeModel(latestModelRaw, allowedModels);
      const resolvedProvider = sanitizeProvider(latestProviderRaw, allowedProviders);

      const summaryInput: OmpSessionSummaryInput = {
        sessionId,
        hostId: canonicalHost,
        identityId: null,
        status,
        startedAt,
        lastActiveAt,
        closedAt,
        endedAt,
        model: resolvedModel,
        provider: resolvedProvider,
        durationMs,
        inputTokens: isCapped ? null : sumInputTokens,
        promptTokens: isCapped ? null : sumInputTokens,
        outputTokens: isCapped ? null : sumOutputTokens,
        completionTokens: isCapped ? null : sumOutputTokens,
        cacheReadTokens: isCapped ? null : sumCacheReadTokens,
        cacheWriteTokens: isCapped ? null : sumCacheWriteTokens,
        reasoningTokens: null,
        totalTokens: isCapped ? null : sumTotalTokens,
        costMicros,
        costEstimate,
        costTrust: costTrustField,
        contextBps: null,
        toolCallsCount: null,
        errorCount: isCapped ? null : errorCount,
        exitCode: null,
        collectedAt: collectedAtIso,
        source: "omp_stats",
        sourceVersion: PINNED_OMP_VERSION,
      };

      try {
        summaries.push(validateOmpSessionSummaryInput(summaryInput));
      } catch (error) {
        if (error instanceof OmpSessionAdapterError) throw error;
        throw new OmpInvalidDataError("ERR_SUMMARY_VALIDATION", "DATA_VALIDATION_FAILED");
      }
    }

    return {
      summaries,
      nextCursor,
      hasMore,
      totalCollected: summaries.length,
    };
  } finally {
    if (shouldCloseDb && db) {
      try {
        db.close();
      } catch {
        // Ignore close error
      }
    }
  }
}

/**
 * Iterates all pages until all file_offsets rows are collected.
 */
export function collectAllSessions(options: OmpSessionPageOptions): OmpSessionSummaryInput[] {
  const allSummaries: OmpSessionSummaryInput[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const pageResult = collectOmpSessionPage({ ...options, cursor });
    allSummaries.push(...pageResult.summaries);
    cursor = pageResult.nextCursor;
    hasMore = pageResult.hasMore;
  }

  return allSummaries;
}

/**
 * Ordinary collection consumes every bounded page; database paths remain internal.
 */
export function collectOmpSessionSummaries(options: OmpSessionAdapterOptions): OmpSessionSummaryInput[] {
  return collectAllSessions(options);
}

/**
 * Class-based OMP Session Adapter instance.
 */
export class OmpSessionAdapter {
  private readonly options: OmpSessionAdapterOptions;
  private ownedDb: Database | null = null;

  constructor(options: OmpSessionAdapterOptions) {
    validateHmacKey(options.hmacKey);
    canonicalizeHostId(options.hostId);
    if (options.writerVersion !== PINNED_OMP_VERSION) {
      throw new OmpSchemaValidationError("ERR_WRITER_VERSION_MISMATCH", "SCHEMA_VALIDATION_FAILED");
    }
    if (!options.allowedProviders || !options.allowedModels) {
      throw new OmpSessionAdapterError("ERR_MISSING_ALLOWLIST", "MODEL_PROVIDER_ALLOWLIST_REQUIRED");
    }
    this.options = { ...options };
  }

  /**
   * Validate that the target database schema conforms to OMP 18.0.11.
   */
  public validateSchema(): SchemaValidationResult {
    const db = this.getDatabase();
    return validateOmpStatsSchema(db, this.options.writerVersion);
  }

  /**
   * Collect a single cursor page.
   */
  public collectPage(pageOptions?: Partial<OmpSessionPageOptions>): OmpSessionPageResult {
    const db = this.getDatabase();
    return collectOmpSessionPage({
      ...this.options,
      ...pageOptions,
      db,
    });
  }

  /**
   * Collect all sessions across all pages.
   */
  public collectAll(overrides?: Partial<OmpSessionPageOptions>): OmpSessionSummaryInput[] {
    const db = this.getDatabase();
    return collectAllSessions({
      ...this.options,
      ...overrides,
      db,
    });
  }

  /**
   * Collect first page of sessions (backward compatible).
   */
  public collect(overrides?: Partial<OmpSessionPageOptions>): OmpSessionSummaryInput[] {
    const db = this.getDatabase();
    return collectOmpSessionSummaries({
      ...this.options,
      ...overrides,
      db,
    });
  }

  /**
   * Close any owned database connection.
   */
  public close(): void {
    if (this.ownedDb) {
      try {
        this.ownedDb.close();
      } catch {
        // Ignore close error
      }
      this.ownedDb = null;
    }
  }

  private getDatabase(): Database {
    if (this.options.db) {
      return this.options.db;
    }
    if (this.ownedDb) {
      return this.ownedDb;
    }
    if (!this.options.dbPath) {
      throw new OmpSessionAdapterError("ERR_MISSING_DB_PATH", "DATABASE_PATH_OR_INSTANCE_REQUIRED");
    }
    try {
      this.ownedDb = new Database(this.options.dbPath, { readonly: true, create: false });
      return this.ownedDb;
    } catch {
      throw new OmpDatabaseOpenError("ERR_DATABASE_OPEN", "DATABASE_OPEN_FAILED");
    }
  }
}
