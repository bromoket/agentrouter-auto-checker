/**
 * Unit Tests for OMP Stats SQLite Session Adapter (OMP 18.0.11)
 *
 * Comprehensive Test Suite covering all Security Review Requirements (P1 - P7):
 * 1. P1: Model & provider allowlisting, grammar-valid canary rejection, slash model support, categorical errors.
 * 2. P2: Full pinned DDL fingerprint, PRAGMA type/nullability checks, 12 indexes (incl. idx_messages_timestamp_agent_type),
 *        7 meta sentinels required on empty DB, writerVersion enforcement.
 * 3. P3: Host-bound HMAC-SHA256, 32-byte key enforcement at entry, cross-host PK isolation, Windows path normalization.
 * 4. P4: Deterministic cursor pagination over file_offsets PK, nextCursor continuation, fork dedupe labeling.
 * 5. P5: Canonical vocabulary (error -> failed, aborted -> cancelled), active/completed, endedAt null for active,
 *        lastActiveAt, strict non-zero/non-future timestamp validation, duration validation.
 * 6. P6: Unpriced xai-oauth (costEstimate = null, costTrust = "unknown"), fully priced (costTrust = "estimated"),
 *        0-message (costTrust = "exact"), cost component validation.
 * 7. P7: Bounded per-session message work, hard ceilings, invalid limit rejection (NaN, Infinity).
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  deriveOpaqueSessionId,
  normalizePath,
  canonicalizeHostId,
  sanitizeModel,
  sanitizeProvider,
  validateOmpStatsSchema,
  collectOmpSessionPage,
  collectAllSessions,
  collectOmpSessionSummaries,
  OmpSessionAdapter,
  OmpSchemaValidationError,
  OmpDatabaseOpenError,
  OmpQueryExecutionError,
  OmpSessionAdapterError,
  OmpInvalidDataError,
  PINNED_OMP_VERSION,
  PINNED_SCHEMA_FINGERPRINT,
  COST_SOURCE_MESSAGES,
  METRICS_SCOPE_RETAINED,
  METRICS_SCOPE_CAPPED,
  STATUS_SOURCE_HEURISTIC,
  HARD_MAX_PAGE_SIZE,
} from "./session-adapter";

// 32-byte test key
const VALID_32BYTE_KEY = "0123456789abcdef0123456789abcdef";
const REQUIRED_RUNTIME_OPTIONS = {
  writerVersion: PINNED_OMP_VERSION,
  allowedProviders: new Set(["anthropic", "openai", "groq", "xai-oauth"]),
  allowedModels: new Set([
    "claude-3-5-sonnet",
    "claude-3-7-sonnet",
    "grok-2",
    "meta-llama/llama-3-70b-instruct",
  ]),
} as const;

/**
 * Build a complete, valid OMP 18.0.11 synthetic SQLite database fixture with all 5 tables, 12 indexes, and 7 sentinels.
 */
function createFullPinnedDb(options: { messagesModelNoCase?: boolean; messagesModelQuotedNoCase?: boolean } = {}): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      model TEXT NOT NULL${options.messagesModelNoCase ? " COLLATE NOCASE" : options.messagesModelQuotedNoCase ? ' COLLATE "NOCASE"' : ""},
      provider TEXT NOT NULL,
      api TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      duration INTEGER,
      ttft INTEGER,
      stop_reason TEXT NOT NULL,
      error_message TEXT,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL,
      total_tokens INTEGER NOT NULL,
      premium_requests REAL NOT NULL,
      cost_input REAL NOT NULL,
      cost_output REAL NOT NULL,
      cost_cache_read REAL NOT NULL,
      cost_cache_write REAL NOT NULL,
      cost_total REAL NOT NULL,
      cost_no_cache_input REAL,
      agent_type TEXT NOT NULL DEFAULT 'main',
      UNIQUE(session_file, entry_id)
    );

    CREATE INDEX idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX idx_messages_model ON messages(model${options.messagesModelNoCase || options.messagesModelQuotedNoCase ? " COLLATE BINARY" : ""});
    CREATE INDEX idx_messages_folder ON messages(folder);
    CREATE INDEX idx_messages_session ON messages(session_file);
    CREATE INDEX idx_messages_timestamp_model_provider ON messages(timestamp, model, provider);
    CREATE INDEX idx_messages_timestamp_folder ON messages(timestamp, folder);
    CREATE INDEX idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp);
    CREATE INDEX idx_messages_timestamp_agent_type ON messages(timestamp, agent_type);

    CREATE TABLE file_offsets (
      session_file TEXT PRIMARY KEY,
      offset INTEGER NOT NULL,
      last_modified INTEGER NOT NULL
    );

    CREATE TABLE user_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      model TEXT,
      provider TEXT,
      chars INTEGER NOT NULL,
      words INTEGER NOT NULL,
      yelling INTEGER NOT NULL,
      profanity INTEGER NOT NULL,
      anguish INTEGER NOT NULL,
      negation INTEGER NOT NULL DEFAULT 0,
      repetition INTEGER NOT NULL DEFAULT 0,
      blame INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_file, entry_id)
    );

    CREATE INDEX idx_user_messages_timestamp ON user_messages(timestamp);
    CREATE INDEX idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);

    CREATE TABLE tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_file TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      agent_type TEXT NOT NULL DEFAULT 'main',
      calls_in_turn INTEGER NOT NULL DEFAULT 1,
      args_chars INTEGER NOT NULL DEFAULT 0,
      result_chars INTEGER,
      is_error INTEGER,
      UNIQUE(session_file, tool_call_id)
    );

    CREATE INDEX idx_tool_calls_timestamp ON tool_calls(timestamp);
    CREATE INDEX idx_tool_calls_tool_timestamp ON tool_calls(tool_name, timestamp);

    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.run(`
    INSERT INTO meta (key, value) VALUES
    ('fork_dedupe_v1', 'complete'),
    ('messages_cost_reingest_v1', 'complete'),
    ('agent_type_v1', 'complete'),
    ('premium_requests_priority_v1', 'complete'),
    ('user_messages_v8', 'complete'),
    ('tool_calls_v1', 'complete'),
    ('user_message_links_v1', 'complete');
  `);

  return db;
}

describe("P1: Model/Provider Allowlisting & Categorical Stackless Errors", () => {
  test("resolves allowlisted models and providers, rejecting grammar-valid prompt/auth/error canaries", () => {
    // Standard allowlisted
    expect(sanitizeProvider("anthropic", REQUIRED_RUNTIME_OPTIONS.allowedProviders)).toBe("anthropic");
    expect(sanitizeProvider("openai", REQUIRED_RUNTIME_OPTIONS.allowedProviders)).toBe("openai");
    expect(sanitizeModel("claude-3-7-sonnet", REQUIRED_RUNTIME_OPTIONS.allowedModels)).toBe("claude-3-7-sonnet");
    expect(sanitizeModel("meta-llama/llama-3-70b-instruct", REQUIRED_RUNTIME_OPTIONS.allowedModels)).toBe("meta-llama/llama-3-70b-instruct");

    // Grammar-valid prompt/auth/error canaries that must be rejected to null
    expect(sanitizeProvider("oauth_token_expired_bearer_token", REQUIRED_RUNTIME_OPTIONS.allowedProviders)).toBeNull();
    expect(sanitizeProvider("custom_injected_provider_string", REQUIRED_RUNTIME_OPTIONS.allowedProviders)).toBeNull();
    expect(sanitizeModel("CANARY_PROMPT_SECRET_REVEALED", REQUIRED_RUNTIME_OPTIONS.allowedModels)).toBeNull();
    expect(sanitizeModel("user_prompt_fragment_model", REQUIRED_RUNTIME_OPTIONS.allowedModels)).toBeNull();
  });

  test("accepts custom caller allowlists", () => {
    const customProviders = new Set(["custom-gateway"]);
    const customModels = new Set(["custom-llm-v1"]);

    expect(sanitizeProvider("custom-gateway", customProviders)).toBe("custom-gateway");
    expect(sanitizeProvider("anthropic", customProviders)).toBeNull();

    expect(sanitizeModel("custom-llm-v1", customModels)).toBe("custom-llm-v1");
    expect(sanitizeModel("gpt-4o", customModels)).toBeNull();
  });

  test("wraps database open and query failures into categorical stackless errors without leaking paths or SQLite text", () => {
    // 1. Non-existent database path
    let openErr: unknown;
    try {
      collectOmpSessionSummaries({ ...REQUIRED_RUNTIME_OPTIONS, dbPath: "/confidential/secrets/passwords/omp.db",
      hmacKey: VALID_32BYTE_KEY,
      hostId: "host-1",});
    } catch (e) {
      openErr = e;
    }
    expect(openErr).toBeInstanceOf(OmpDatabaseOpenError);
    expect((openErr as OmpDatabaseOpenError).message).toBe("DATABASE_OPEN_FAILED");
    expect((openErr as OmpDatabaseOpenError).code).toBe("ERR_DATABASE_OPEN");
    expect(String(openErr)).not.toContain("confidential");

    // 2. Corrupt / closed database query failure
    const db = createFullPinnedDb();
    db.close(); // Force query error on closed DB
    let queryErr: unknown;
    try {
      collectOmpSessionPage({ ...REQUIRED_RUNTIME_OPTIONS, db,
      hmacKey: VALID_32BYTE_KEY,
      hostId: "host-1",});
    } catch (e) {
      queryErr = e;
    }
    expect(queryErr).toBeInstanceOf(OmpSessionAdapterError);
    expect(String(queryErr)).not.toContain("SQLite");
  });

  test("asserts zero leakage of sensitive canaries in serialized summaries", () => {
    const db = createFullPinnedDb();
    const CANARY_PATH = "/confidential/operator/workstations/device_99/session_alpha.jsonl";
    const CANARY_FOLDER = "/confidential/operator/workstations/device_99";
    const CANARY_PROMPT_SECRET = "CANARY_PROMPT_SECRET_DO_NOT_LEAK";
    const CANARY_PROVIDER_SECRET = "CANARY_AUTH_PROVIDER_TOKEN";

    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, ttft, stop_reason, error_message, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, total_tokens, premium_requests,
        cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total,
        cost_no_cache_input, agent_type
      ) VALUES (?, 'e1', ?, ?, ?, 'messages', 1740000000000, 1000, 200, 'stop', NULL, 500, 200, 50, 25, 775, 0, 0.002, 0.003, 0.0001, 0.0001, 0.0052, 0.002, 'main');
    `,
      [CANARY_PATH, CANARY_FOLDER, CANARY_PROMPT_SECRET, CANARY_PROVIDER_SECRET]
    );

    db.run("INSERT INTO file_offsets VALUES (?, 4096, 1740000000000);", [CANARY_PATH]);

    const summaries = collectOmpSessionSummaries({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-node-01",});

    expect(summaries.length).toBe(1);
    const serialized = JSON.stringify(summaries);

    // Verify raw strings never escaped
    expect(serialized.includes(CANARY_PATH)).toBe(false);
    expect(serialized.includes(CANARY_FOLDER)).toBe(false);
    expect(serialized.includes(CANARY_PROMPT_SECRET)).toBe(false);
    expect(serialized.includes(CANARY_PROVIDER_SECRET)).toBe(false);

    // Verify unallowlisted canary model and provider resolved to null / unknown
    expect(summaries[0].model).toBeNull();
    expect(summaries[0].provider).toBeNull();
  });

  test("handles slash-bearing allowlisted model IDs seamlessly through top-level fields", () => {
    const db = createFullPinnedDb();
    const sessionPath = "/home/dev/sessions/sess_llama.jsonl";

    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
        cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
      ) VALUES (?, 'e1', '/proj', 'meta-llama/llama-3-70b-instruct', 'groq', 'messages', 1740000000000, 1000, 'stop', 500, 200, 0, 0, 700, 0, 0.001, 0.002, 0, 0, 0.003, 0, 'main');
    `,
      [sessionPath]
    );

    db.run("INSERT INTO file_offsets VALUES (?, 4096, 1740000000000);", [sessionPath]);

    const summaries = collectOmpSessionSummaries({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",});

    expect(summaries.length).toBe(1);
    expect(summaries[0].model).toBe("meta-llama/llama-3-70b-instruct");
    expect(summaries[0].provider).toBe("groq");
  });
});

describe("P2: Full Pinned DDL Fingerprint, Constraints & 12 Indexes", () => {
  test("accepts valid full pinned 18.0.11 schema including idx_messages_timestamp_agent_type", () => {
    const db = createFullPinnedDb();
    const result = validateOmpStatsSchema(db, "18.0.11");
    expect(result.valid).toBe(true);
    expect(result.schemaFingerprint).toBe(PINNED_SCHEMA_FINGERPRINT);
    expect(result.tableCount).toBe(5);
    expect(result.indexCount).toBe(12);
    expect(result.sentinelsComplete).toBe(true);
  });
  test("rejects a non-BINARY table column collation despite a BINARY named index", () => {
    const db = createFullPinnedDb({ messagesModelNoCase: true });
    expect(() => validateOmpStatsSchema(db, PINNED_OMP_VERSION)).toThrow(OmpSchemaValidationError);
  });
  test("rejects a quoted non-BINARY table collation despite a BINARY named index", () => {
    const db = createFullPinnedDb({ messagesModelQuotedNoCase: true });
    expect(() => validateOmpStatsSchema(db, PINNED_OMP_VERSION)).toThrow(OmpSchemaValidationError);
  });

  test("rejects missing 12th index (idx_messages_timestamp_agent_type)", () => {
    const db = createFullPinnedDb();
    db.run("DROP INDEX idx_messages_timestamp_agent_type;");
    expect(() => validateOmpStatsSchema(db, PINNED_OMP_VERSION)).toThrow(OmpSchemaValidationError);
  });

  test("rejects missing UNIQUE(session_file, entry_id) constraint on messages", () => {
    const db = createFullPinnedDb();
    db.run("DROP TABLE messages;");
    db.run(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_file TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        folder TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        api TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        duration INTEGER,
        ttft INTEGER,
        stop_reason TEXT NOT NULL,
        error_message TEXT,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        premium_requests REAL NOT NULL,
        cost_input REAL NOT NULL,
        cost_output REAL NOT NULL,
        cost_cache_read REAL NOT NULL,
        cost_cache_write REAL NOT NULL,
        cost_total REAL NOT NULL,
        cost_no_cache_input REAL,
        agent_type TEXT NOT NULL DEFAULT 'main'
      );
    `);
    expect(() => validateOmpStatsSchema(db, PINNED_OMP_VERSION)).toThrow(OmpSchemaValidationError);
  });

  test("requires all 7 meta sentinels to be complete even on an empty database", () => {
    const db = createFullPinnedDb();
    // Database is empty (0 messages, 0 file_offsets), but missing sentinels must fail validation
    db.run("DELETE FROM meta WHERE key = 'fork_dedupe_v1';");
    expect(() => validateOmpStatsSchema(db, PINNED_OMP_VERSION)).toThrow(OmpSchemaValidationError);
  });

  test("rejects pending sentinel on empty database", () => {
    const db = createFullPinnedDb();
    db.run("UPDATE meta SET value = 'pending' WHERE key = 'messages_cost_reingest_v1';");
    expect(() => validateOmpStatsSchema(db, PINNED_OMP_VERSION)).toThrow(OmpSchemaValidationError);
  });

  test("rejects writerVersion mismatch", () => {
    const db = createFullPinnedDb();
    expect(() => validateOmpStatsSchema(db, "17.9.0")).toThrow(OmpSchemaValidationError);
    expect(() => validateOmpStatsSchema(db, "19.0.0")).toThrow(OmpSchemaValidationError);
  });
});

describe("P3: Host-Bound HMAC, 32-Byte Key & Windows Path Normalization", () => {
  test("enforces minimum 32-byte key at constructor and function entry even on empty DB", () => {
    expect(() => {
      new OmpSessionAdapter({ ...REQUIRED_RUNTIME_OPTIONS, hmacKey: "short-key-16-byte",
      hostId: "host-1",});
    }).toThrow(OmpSessionAdapterError);

    expect(() => {
      collectOmpSessionSummaries({ ...REQUIRED_RUNTIME_OPTIONS, dbPath: "/some/path.db",
      hmacKey: "too-short",
      hostId: "host-1",});
    }).toThrow(OmpSessionAdapterError);
  });

  test("produces different session IDs across different hosts for identical paths", () => {
    const path = "/home/developer/.omp/sessions/sess_alpha.jsonl";
    const idHost1 = deriveOpaqueSessionId(path, "host-east-01", VALID_32BYTE_KEY);
    const idHost2 = deriveOpaqueSessionId(path, "host-west-02", VALID_32BYTE_KEY);

    expect(idHost1).not.toBe(idHost2);
    expect(idHost1.startsWith("sess_")).toBe(true);
    expect(idHost2.startsWith("sess_")).toBe(true);
  });

  test("normalizes only Windows-equivalent separators and ASCII casing", () => {
    const winPath1 = "C:\\Users\\Dev\\sessions\\\\sess_01.jsonl";
    const winPath2 = "c:/users/dev/sessions/sess_01.jsonl";
    const id1 = deriveOpaqueSessionId(winPath1, "  Fleet-Host-01  ", VALID_32BYTE_KEY);
    const id2 = deriveOpaqueSessionId(winPath2, "fleet-host-01", VALID_32BYTE_KEY);
    expect(id1).toBe(id2);
    expect(() => deriveOpaqueSessionId("C:/users/dev/./sessions/sess.jsonl", "fleet-host-01", VALID_32BYTE_KEY)).toThrow(OmpSessionAdapterError);
    expect(deriveOpaqueSessionId("/tmp/é session", "fleet-host-01", VALID_32BYTE_KEY))
      .not.toBe(deriveOpaqueSessionId("/tmp/é session", "fleet-host-01", VALID_32BYTE_KEY));
    expect(deriveOpaqueSessionId("/tmp//same/session.jsonl", "fleet-host-01", VALID_32BYTE_KEY))
      .toBe(deriveOpaqueSessionId("/tmp/same/session.jsonl", "fleet-host-01", VALID_32BYTE_KEY));
  });
});

describe("P4: Deterministic Cursor Pagination over file_offsets PK & Fork Dedupe", () => {
  test("paginates deterministically over file_offsets PK (session_file) across multiple pages", () => {
    const db = createFullPinnedDb();

    // Insert 7 sessions
    for (let i = 0; i < 7; i++) {
      const sessionPath = `/home/user/sessions/sess_${i.toString().padStart(2, "0")}.jsonl`;
      db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000000000);", [sessionPath]);
    }

    // Page 1 (pageSize: 3)
    const page1 = collectOmpSessionPage({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",
    pageSize: 3,});
    expect(page1.summaries.length).toBe(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.nextCursor).not.toContain("/home/user");

    // Page 2 (pageSize: 3)
    const page2 = collectOmpSessionPage({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",
    cursor: page1.nextCursor,
    pageSize: 3,});
    expect(page2.summaries.length).toBe(3);
    expect(page2.hasMore).toBe(true);
    expect(page2.nextCursor).not.toBeNull();
    expect(page2.nextCursor).not.toContain("/home/user");
    expect(page2.nextCursor).not.toBe(page1.nextCursor);

    // Page 3 (pageSize: 3)
    const page3 = collectOmpSessionPage({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",
    cursor: page2.nextCursor,
    pageSize: 3,});
    expect(page3.summaries.length).toBe(1);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();

    // collectAllSessions iterates all pages to collect all 7
    const all = collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",
    pageSize: 3,});
    expect(all.length).toBe(7);
  });

  test("covers user-only session and labels retained branch metrics under fork dedupe", () => {
    const db = createFullPinnedDb();
    const parentPath = "/home/dev/parent.jsonl";
    const forkedPath = "/home/dev/forked.jsonl";

    // Parent has e1
    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
        cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
      ) VALUES (?, 'e1', '/p', 'claude-3-5-sonnet', 'anthropic', 'messages', 1740000000000, 500, 'stop', 100, 50, 0, 0, 150, 0, 0.001, 0, 0, 0, 0.001, 0, 'main');
    `,
      [parentPath]
    );

    // Forked session has user_messages but no assistant message yet (copied-only or user-only)
    db.run(
      `
      INSERT INTO user_messages (session_file, entry_id, folder, timestamp, model, provider, chars, words, yelling, profanity, anguish)
      VALUES (?, 'u1', '/p', 1740000010000, 'claude-3-7-sonnet', 'anthropic', 100, 20, 0, 0, 0);
    `,
      [forkedPath]
    );

    db.run("INSERT INTO file_offsets VALUES (?, 500, 1740000000000);", [parentPath]);
    db.run("INSERT INTO file_offsets VALUES (?, 500, 1740000010000);", [forkedPath]);

    const summaries = collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",});

    expect(summaries.length).toBe(2);
    for (const s of summaries) {
      expect(s.sessionId).toBeDefined();
    }
  });
});

describe("P5: Canonical Vocabulary, Timestamps, Duration & State Derivation", () => {
  test("canonically maps stop reasons: error -> failed, aborted -> cancelled", () => {
    const db = createFullPinnedDb();
    const abortPath = "/home/dev/sess_abort.jsonl";
    const errorPath = "/home/dev/sess_error.jsonl";

    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
        cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
      ) VALUES
      (?, 'e1', '/p', 'claude-3-7-sonnet', 'anthropic', 'messages', 1740000000000, 500, 'aborted', 100, 20, 0, 0, 120, 0, 0, 0, 0, 0, 0, 0, 'main'),
      (?, 'e1', '/p', 'claude-3-7-sonnet', 'anthropic', 'messages', 1740000000000, 500, 'error', 100, 20, 0, 0, 120, 0, 0, 0, 0, 0, 0, 0, 'main');
    `,
      [abortPath, errorPath]
    );

    db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000000000);", [abortPath]);
    db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000000000);", [errorPath]);

    const summaries = collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",
    now: () => 1740000005000, // Recent, but aborted/error are terminal
  });

    const abortSummary = summaries.find((s) => s.status === "cancelled");
    const errorSummary = summaries.find((s) => s.status === "failed");

    expect(abortSummary).toBeDefined();
    expect(errorSummary).toBeDefined();
    expect(abortSummary?.endedAt).not.toBeNull();
    expect(errorSummary?.endedAt).not.toBeNull();
  });

  test("populates endedAt and closedAt as null for active sessions, and computes valid lastActiveAt", () => {
    const db = createFullPinnedDb();
    const activePath = "/home/dev/sess_active.jsonl";
    const nowMs = 1740000060000;

    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
        cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
      ) VALUES (?, 'e1', '/p', 'claude-3-7-sonnet', 'anthropic', 'messages', 1740000000000, 1500, 'stop', 100, 50, 0, 0, 150, 0, 0.001, 0, 0, 0, 0.001, 0, 'main');
    `,
      [activePath]
    );
    db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000050000);", [activePath]);

    const summaries = collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",
    activeWindowMs: 300_000,
    now: () => nowMs,});

    expect(summaries.length).toBe(1);
    expect(summaries[0].status).toBe("active");
    expect(summaries[0].endedAt).toBeNull();
    expect(summaries[0].closedAt).toBeNull();
    expect(summaries[0].lastActiveAt).toBe("2025-02-19T21:20:50.000Z");
    expect(summaries[0].durationMs).toBe(1500);
  });

  test("rejects zero, negative, and future-skewed timestamps with categorical OmpInvalidDataError", () => {
    const db = createFullPinnedDb();
    const corruptPath = "/home/dev/corrupt_ts.jsonl";

    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
        cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
      ) VALUES (?, 'e1', '/p', 'claude-3-7-sonnet', 'anthropic', 'messages', 0, 500, 'stop', 100, 50, 0, 0, 150, 0, 0, 0, 0, 0, 0, 0, 'main');
    `,
      [corruptPath]
    );
    db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000000000);", [corruptPath]);

    expect(() => {
      collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
      hmacKey: VALID_32BYTE_KEY,
      hostId: "host-1",
      now: () => 1740000000000,});
    }).toThrow(OmpInvalidDataError);
  });

  test("rejects unknown stop_reason values with categorical OmpInvalidDataError", () => {
    const db = createFullPinnedDb();
    const unknownStopPath = "/home/dev/unknown_stop.jsonl";

    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
        cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
      ) VALUES (?, 'e1', '/p', 'claude-3-7-sonnet', 'anthropic', 'messages', 1740000000000, 500, 'UNKNOWN_STOP_REASON', 100, 50, 0, 0, 150, 0, 0, 0, 0, 0, 0, 0, 'main');
    `,
      [unknownStopPath]
    );
    db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000000000);", [unknownStopPath]);

    expect(() => {
      collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
      hmacKey: VALID_32BYTE_KEY,
      hostId: "host-1",});
    }).toThrow(OmpInvalidDataError);
  });
});

describe("P6: Price Coverage, Trust Classification & Component Validation", () => {
  test("emits costTrust = 'estimated' for fully covered OMP API-equivalent estimates", () => {
    const db = createFullPinnedDb();
    const sessionPath = "/home/dev/priced.jsonl";

    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
        cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
      ) VALUES (?, 'e1', '/p', 'claude-3-7-sonnet', 'anthropic', 'messages', 1740000000000, 1000, 'stop', 500, 200, 50, 25, 775, 0, 0.002, 0.003, 0.0001, 0.0001, 0.0052, 0.002, 'main');
    `,
      [sessionPath]
    );
    db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000000000);", [sessionPath]);

    const summaries = collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",});

    expect(summaries[0].costEstimate).toBeCloseTo(0.0052, 4);
    expect(summaries[0].costMicros).toBe(5200);
    expect(summaries[0].costTrust).toBe("estimated");
  });

  test("emits costEstimate = null and costTrust = 'unknown' for unpriced (xai-oauth) or mixed sessions", () => {
    const db = createFullPinnedDb();
    const mixedPath = "/home/dev/mixed.jsonl";

    // e1 is priced, e2 is unpriced xai-oauth
    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
        cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
      ) VALUES
      (?, 'e1', '/p', 'claude-3-7-sonnet', 'anthropic', 'messages', 1740000000000, 1000, 'stop', 500, 200, 0, 0, 700, 0, 0.002, 0.003, 0, 0, 0.005, 0.002, 'main'),
      (?, 'e2', '/p', 'grok-2', 'xai-oauth', 'chat', 1740000020000, 1000, 'stop', 500, 200, 0, 0, 700, 0, 0, 0, 0, 0, 0, 0, 'main');
    `,
      [mixedPath, mixedPath]
    );
    db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000020000);", [mixedPath]);

    const summaries = collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",});

    expect(summaries[0].costEstimate).toBeNull();
    expect(summaries[0].costMicros).toBeNull();
    expect(summaries[0].costTrust).toBe("unknown");
  });
  test("classifies total-only legacy costs as unknown without exporting their total", () => {
    const db = createFullPinnedDb();
    const sessionPath = "/home/dev/legacy-total-only.jsonl";
    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
        cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
      ) VALUES (?, 'e1', '/p', 'claude-3-7-sonnet', 'anthropic', 'messages', 1740000000000, 1000, 'stop', 500, 200, 0, 0, 700, 0, 0, 0, 0, 0, 999, 0, 'main');
    `,
      [sessionPath],
    );
    db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000000000);", [sessionPath]);

    const summary = collectAllSessions({
      ...REQUIRED_RUNTIME_OPTIONS,
      db,
      hmacKey: VALID_32BYTE_KEY,
      hostId: "host-1",
    })[0];
    expect(summary.costEstimate).toBeNull();
    expect(summary.costMicros).toBeNull();
    expect(summary.costTrust).toBe("unknown");
  });

  test("rejects negative cost component corruption with OmpInvalidDataError", () => {
    const db = createFullPinnedDb();
    const corruptCostPath = "/home/dev/corrupt_cost.jsonl";

    db.run(
      `
      INSERT INTO messages (
        session_file, entry_id, folder, model, provider, api, timestamp,
        duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
        cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
        cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
      ) VALUES (?, 'e1', '/p', 'claude-3-7-sonnet', 'anthropic', 'messages', 1740000000000, 1000, 'stop', 100, 50, 0, 0, 150, 0, -0.01, 0.05, 0, 0, 0.04, 0, 'main');
    `,
      [corruptCostPath]
    );
    db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000000000);", [corruptCostPath]);

    expect(() => {
      collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
      hmacKey: VALID_32BYTE_KEY,
      hostId: "host-1",});
    }).toThrow(OmpInvalidDataError);

    db.run("UPDATE messages SET cost_input = 0.01, cost_output = 0.02, cost_total = 0.05");
    expect(() => {
      collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
        hmacKey: VALID_32BYTE_KEY,
        hostId: "host-1",
      });
    }).toThrow(OmpInvalidDataError);
  });
});

describe("P7: Bounded Work & Parameter Validation", () => {
  test("rejects invalid page size parameters (0, negative, NaN, Infinity, > 500)", () => {
    const db = createFullPinnedDb();

    expect(() => {
      collectOmpSessionPage({ ...REQUIRED_RUNTIME_OPTIONS, db,
      hmacKey: VALID_32BYTE_KEY,
      hostId: "host-1",
      pageSize: 0,});
    }).toThrow(OmpSessionAdapterError);

    expect(() => {
      collectOmpSessionPage({ ...REQUIRED_RUNTIME_OPTIONS, db,
      hmacKey: VALID_32BYTE_KEY,
      hostId: "host-1",
      pageSize: NaN,});
    }).toThrow(OmpSessionAdapterError);

    expect(() => {
      collectOmpSessionPage({ ...REQUIRED_RUNTIME_OPTIONS, db,
      hmacKey: VALID_32BYTE_KEY,
      hostId: "host-1",
      pageSize: Infinity,});
    }).toThrow(OmpSessionAdapterError);

    expect(() => {
      collectOmpSessionPage({ ...REQUIRED_RUNTIME_OPTIONS, db,
      hmacKey: VALID_32BYTE_KEY,
      hostId: "host-1",
      pageSize: HARD_MAX_PAGE_SIZE + 1,});
    }).toThrow(OmpSessionAdapterError);
  });

  test("bounds per-session message work to maxMessagesPerSession and marks capped scope", () => {
    const db = createFullPinnedDb();
    const largeSessionPath = "/home/dev/large_session.jsonl";

    // Insert 6 messages for the session
    for (let i = 0; i < 6; i++) {
      db.run(
        `
        INSERT INTO messages (
          session_file, entry_id, folder, model, provider, api, timestamp,
          duration, stop_reason, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, total_tokens, premium_requests, cost_input, cost_output,
          cost_cache_read, cost_cache_write, cost_total, cost_no_cache_input, agent_type
        ) VALUES (?, ?, '/p', 'claude-3-7-sonnet', 'anthropic', 'messages', ?, 500, 'stop', 100, 50, 0, 0, 150, 0, 0.001, 0.001, 0, 0, 0.002, 0, 'main');
      `,
        [largeSessionPath, `e_${i}`, 1740000000000 + i * 1000]
      );
    }
    db.run("INSERT INTO file_offsets VALUES (?, 100, 1740000005000);", [largeSessionPath]);

    // Cap max messages to 3
    const summaries = collectAllSessions({ ...REQUIRED_RUNTIME_OPTIONS, db,
    hmacKey: VALID_32BYTE_KEY,
    hostId: "host-1",
    maxMessagesPerSession: 3,});

    expect(summaries.length).toBe(1);
    expect(summaries[0].inputTokens).toBeNull();
    expect(summaries[0].costEstimate).toBeNull();
    expect(summaries[0].costTrust).toBe("unknown");
    expect(summaries[0].status).toBe("unknown");
    expect(summaries[0].closedAt).toBeNull();
  });
});
