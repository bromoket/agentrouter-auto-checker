import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Store as LegacyStore } from "../storage";
import {
  importLegacyAgentRouterHistory,
  LegacyImportError,
  type LegacyAgentRouterImportOptions,
} from "./legacy-importer";
import { ObservatoryStore } from "./store";

const CANARIES = [
  "SUMMARY_CANARY_SECRET_TOKEN",
  "METRICS_SITE_ID_CANARY",
  "METRICS_USERNAME_CANARY",
  "METRICS_PROFILE_PATH_CANARY",
  "API_CALLS_CANARY_CREDENTIAL",
  "RUN_ERROR_CANARY",
  "SCREENSHOT_PATH_CANARY",
  "UNSAFE_MODEL_CANARY",
  "GRANT_EVENT_ID_CANARY",
  "GRANT_DESCRIPTION_CANARY",
  "ENDPOINT_SOURCE_PATH_CANARY",
  "ENDPOINT_ERROR_CANARY",
] as const;

const HMAC_KEY = new Uint8Array(32).fill(0x41);
const IMPORTED_AT = "2026-09-01T12:00:00.000Z";
const temporaryDirectories: string[] = [];
const destinationStores: ObservatoryStore[] = [];

async function sha256(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer();
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}

// Windows releases sqlite file handles asynchronously after close; there is no
// event to await, so bounded real backoff is the only cleanup signal. Temp
// cleanup is best-effort: suite parallelism can hold a handle past the retries,
// and a leaked temp dir must never fail the run.
async function removePathWithRetry(path: string, recursive = false): Promise<void> {
  const attempts = process.platform === "win32" ? 10 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive, force: true });
      return;
    } catch (error) {
      lastError = error;
      Bun.gc(true);
      if (attempt + 1 < attempts) {
        await Bun.sleep(25 * (attempt + 1));
      }
    }
  }
  if (process.platform === "win32") return;
  throw lastError;
}

async function makeLegacySnapshot(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "observatory-legacy-import-"));
  temporaryDirectories.push(directory);
  const mutablePath = join(directory, "mutable-legacy.sqlite");
  const path = join(directory, "poisoned-legacy-snapshot.sqlite");

  // Build in WAL mode as production does, then seal logical state into one immutable file.
  let initializer: LegacyStore | null = new LegacyStore(mutablePath);
  initializer.close();
  initializer = null;
  Bun.gc(true);
  let db: Database | null = new Database(mutablePath, { create: false, strict: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.query(`
    INSERT INTO runs (
      id, account_id, account_label, started_at, ended_at, status,
      login_ms, dashboard_ms, total_ms, summary, api_calls,
      error_message, screenshot_path, metrics, logged_out, session_reused
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    11,
    "account-safe-1",
    "Safe Account One",
    "2026-08-31T10:00:00.000Z",
    "2026-08-31T10:00:05.000Z",
    "error",
    1200,
    800,
    5000,
    JSON.stringify({ secret: CANARIES[0], statePath: CANARIES[3] }),
    JSON.stringify([{ path: CANARIES[4], authorization: "Bearer poison" }]),
    `${CANARIES[5]}: login failed with credential details`,
    `C:\\state\\${CANARIES[6]}.png`,
    JSON.stringify({
      siteUserId: CANARIES[1],
      siteUsername: CANARIES[2],
      profilePath: CANARIES[3],
      balance: 42.5,
      consumed: 7.25,
      requestCount: 9,
      quotaPerUnit: 500000,
      averageRpm: 1.5,
      averageTpm: 120,
      availableModels: 2,
    }),
    0,
    1,
  );
  db.query(`
    INSERT INTO usage_points (
      account_id, granularity, created_at, model_name,
      request_count, token_used, quota, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "account-safe-1", "day", 1788134400, "gpt-4o", 3, 1000, 4.5, IMPORTED_AT,
    "account-safe-1", "day", 1788134400, `unsafe model ${CANARIES[7]}`, 2, 700, 3.25, IMPORTED_AT,
  );
  db.query(`
    INSERT INTO credit_observations (
      id, run_id, account_id, observed_at, balance, consumed,
      previous_balance, previous_consumed, balance_delta, consumed_delta,
      minutes_since_previous, classification
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    21,
    11,
    "account-safe-1",
    "2026-08-31T10:00:05.000Z",
    42.5,
    7.25,
    40,
    7,
    2.5,
    0.25,
    60,
    "credit-increase",
  );
  db.query(`
    INSERT INTO credit_grant_events (
      id, run_id, account_id, source_event_id, occurred_at,
      amount, classification, description
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    31,
    11,
    "account-safe-1",
    `raw-source-${CANARIES[8]}`,
    "2026-08-31T10:00:04.000Z",
    2.5,
    "daily-signin",
    CANARIES[9],
  );
  db.query(`
    INSERT INTO endpoint_observations (
      id, account_id, account_label, observed_at, status,
      balance, consumed, request_count, source_path, latency_ms, error_message
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    41,
    "account-safe-1",
    "Safe Account One",
    "2026-08-31T11:00:00.000Z",
    "error",
    41.75,
    8,
    10,
    `/private/state/${CANARIES[10]}`,
    55,
    `${CANARIES[11]}: challenge required`,
  );
  db.query("VACUUM INTO ?").run(path);
  db.close();
  db = null;
  Bun.gc(true);
  const snapshot = new Database(path, { create: false, strict: true });
  snapshot.exec("PRAGMA journal_mode = WAL;");
  snapshot.close();
  Bun.gc(true);
  for (const mutableFile of [
    mutablePath,
    `${mutablePath}-wal`,
    `${mutablePath}-shm`,
    `${mutablePath}-journal`,
  ]) {
    await removePathWithRetry(mutableFile);
  }
  return { directory, path };
}

function makeDestination(): ObservatoryStore {
  const store = new ObservatoryStore(":memory:");
  destinationStores.push(store);
  return store;
}

async function optionsFor(
  path: string,
  overrides: Partial<LegacyAgentRouterImportOptions> = {},
): Promise<LegacyAgentRouterImportOptions> {
  return {
    snapshotPath: path,
    expectedSha256: await sha256(path),
    importerVersion: "legacy-importer-test-v1",
    grantIdHmacKey: HMAC_KEY,
    importedAt: IMPORTED_AT,
    ...overrides,
  };
}

function assertNoForbiddenMaterial(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const canary of CANARIES) expect(serialized).not.toContain(canary);
}

afterEach(async () => {
  while (destinationStores.length > 0) destinationStores.pop()!.close();
  while (temporaryDirectories.length > 0) {
    await removePathWithRetry(temporaryDirectories.pop()!, true);
  }
});

describe("legacy AgentRouter history importer", () => {
  test("is explicit, preserves source bytes, and exports only the normalized safe projection", async () => {
    const { path } = await makeLegacySnapshot();
    const store = makeDestination();
    const before = await sha256(path);
    const capturedLogs: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => capturedLogs.push(args.join(" "));
    console.log = (...args: unknown[]) => capturedLogs.push(args.join(" "));
    console.warn = (...args: unknown[]) => capturedLogs.push(args.join(" "));
    try {
      // Loading constructors and preparing arguments alone must not import anything.
      expect(store.listAgentRouterAccounts()).toEqual([]);
      expect(store.listImportBatches()).toEqual([]);

      const result = await importLegacyAgentRouterHistory(store, await optionsFor(path));
      expect(result.outcome).toBe("imported");
      expect(result.sourceSha256).toBe(before);
      expect(result.counts).toEqual({
        accounts: 1,
        runs: 1,
        usagePoints: 2,
        balances: 1,
        grants: 1,
        endpoints: 1,
      });
    } finally {
      console.error = originalError;
      console.log = originalLog;
      console.warn = originalWarn;
    }

    expect(await sha256(path)).toBe(before);
    const exported = store.exportData({ limit: 1000 });
    assertNoForbiddenMaterial(exported);
    assertNoForbiddenMaterial(capturedLogs);
    expect(capturedLogs).toEqual([]);
    expect(JSON.stringify(exported)).not.toContain(path);
    expect(JSON.stringify(exported)).not.toContain(basename(path));

    expect(exported.agentrouterAccounts).toEqual([
      expect.objectContaining({ accountId: "account-safe-1", accountLabel: "Safe Account One" }),
    ]);
    expect(exported.agentrouterRuns).toEqual([
      expect.objectContaining({
        id: 11,
        status: "error",
        loginMs: 1200,
        dashboardMs: 800,
        totalMs: 5000,
        loggedOut: false,
        sessionReused: true,
        errorCategory: "login_required",
        balance: 42.5,
        consumed: 7.25,
        requestCount: 9,
      }),
    ]);
    expect(exported.agentrouterUsagePoints?.map((point) => point.modelName)).toEqual(
      expect.arrayContaining([null, "gpt-4o"]),
    );
    expect(exported.agentrouterBalances).toEqual([
      expect.objectContaining({ balance: 42.5, consumed: 7.25, classification: "credit-increase" }),
    ]);
    expect(exported.agentrouterEndpoints).toEqual([
      expect.objectContaining({ errorCategory: "challenge_required", latencyMs: 55 }),
    ]);
    const grant = exported.agentrouterGrants?.[0];
    expect(grant?.sourceEventId).toMatch(/^[a-f0-9]{64}$/);
    expect(grant?.amount).toBe(2.5);
    expect(store.listLegacyImportItems("legacy-agentrouter-snapshot")).toHaveLength(7);
    expect([...HMAC_KEY].every((value) => value === 0x41)).toBe(true);
  });

  test("makes an exact duplicate a no-op and blocks changed row projections before any write", async () => {
    const { path } = await makeLegacySnapshot();
    const store = makeDestination();
    const firstOptions = await optionsFor(path);
    const first = await importLegacyAgentRouterHistory(store, firstOptions);
    const duplicate = await importLegacyAgentRouterHistory(store, firstOptions);
    expect(first.outcome).toBe("imported");
    expect(duplicate.outcome).toBe("duplicate");
    expect(store.listLegacyImportItems("legacy-agentrouter-snapshot")).toHaveLength(7);
    expect(store.listImportBatches()).toHaveLength(1);

    const mutable = new Database(path, { create: false, strict: true });
    mutable.run("UPDATE runs SET total_ms = ? WHERE id = ?", [6000, 11]);
    mutable.run(
      `INSERT INTO endpoint_observations (
        id, account_id, account_label, observed_at, status,
        balance, consumed, request_count, source_path, latency_ms, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [42, "account-safe-1", "Safe Account One", "2026-08-31T12:00:00.000Z", "ok", 40, 9, 11, null, 20, null],
    );
    mutable.close();
    const changedHash = await sha256(path);

    let thrown: unknown;
    try {
      await importLegacyAgentRouterHistory(store, {
        ...firstOptions,
        expectedSha256: changedHash,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LegacyImportError);
    expect((thrown as LegacyImportError).category).toBe("projection_conflict");
    assertNoForbiddenMaterial(String(thrown));
    expect(store.listAgentRouterRuns({ limit: 100 })[0].totalMs).toBe(5000);
    expect(store.listAgentRouterEndpointObservations({ limit: 100 })).toHaveLength(1);
    expect(store.listLegacyImportItems("legacy-agentrouter-snapshot")).toHaveLength(7);
    expect(store.listImportBatches()).toHaveLength(1);
    expect(await sha256(path)).toBe(changedHash);
  });

  test("rejects invalid typed source data with no destination rows or unsafe diagnostics", async () => {
    const { path } = await makeLegacySnapshot();
    const invalid = new Database(path, { create: false, strict: true });
    invalid.run(
      "UPDATE runs SET metrics = ? WHERE id = ?",
      [JSON.stringify({ balance: "METRICS_TYPE_ERROR_CANARY", consumed: 7 }), 11],
    );
    invalid.close();
    const store = makeDestination();
    const expectedSha256 = await sha256(path);

    let thrown: unknown;
    try {
      await importLegacyAgentRouterHistory(store, await optionsFor(path, { expectedSha256 }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LegacyImportError);
    expect((thrown as LegacyImportError).category).toBe("invalid_source_data");
    expect(String(thrown)).not.toContain("METRICS_TYPE_ERROR_CANARY");
    expect(String(thrown)).not.toContain(path);
    expect((thrown as Error).stack).not.toContain(path);
    expect(store.listAgentRouterAccounts()).toEqual([]);
    expect(store.listImportBatches()).toEqual([]);
    expect(store.listLegacyImportItems("legacy-agentrouter-snapshot")).toEqual([]);
    expect(await sha256(path)).toBe(expectedSha256);
  });

  test("rejects a hash mismatch and schema drift without exposing the snapshot path", async () => {
    const { path } = await makeLegacySnapshot();
    const store = makeDestination();
    const badHash = "0".repeat(64);
    await expect(importLegacyAgentRouterHistory(store, await optionsFor(path, { expectedSha256: badHash })))
      .rejects.toThrow("LEGACY_IMPORT_SOURCE_HASH_MISMATCH");

    const drifted = new Database(path, { create: false, strict: true });
    drifted.exec("CREATE TABLE unexpected_sensitive_material (secret TEXT)");
    drifted.close();
    const driftedHash = await sha256(path);
    let thrown: unknown;
    try {
      await importLegacyAgentRouterHistory(store, await optionsFor(path, { expectedSha256: driftedHash }));
    } catch (error) {
      thrown = error;
    }
    expect((thrown as LegacyImportError).category).toBe("unsupported_schema");
    expect(String(thrown)).not.toContain(path);
    expect((thrown as Error).stack).not.toContain(path);
    expect(store.listImportBatches()).toEqual([]);
    expect(await sha256(path)).toBe(driftedHash);
  });

  test("requires a canonical 32-byte HMAC key before opening the source", async () => {
    const { path } = await makeLegacySnapshot();
    const store = makeDestination();
    const base = await optionsFor(path);

    await expect(importLegacyAgentRouterHistory(store, {
      ...base,
      grantIdHmacKey: new Uint8Array(31),
    })).rejects.toThrow("LEGACY_IMPORT_INVALID_OPTIONS");
    await expect(importLegacyAgentRouterHistory(store, {
      ...base,
      grantIdHmacKey: new Uint8Array(33),
    })).rejects.toThrow("LEGACY_IMPORT_INVALID_OPTIONS");
    expect(store.listImportBatches()).toEqual([]);
  });

  test("rejects SQLite sidecars before projection and leaves no destination state", async () => {
    const { path } = await makeLegacySnapshot();
    const expectedSha256 = await sha256(path);
    await Bun.write(`${path}-wal`, "SIDECAR_CANARY_SECRET");
    const store = makeDestination();

    let thrown: unknown;
    try {
      await importLegacyAgentRouterHistory(store, await optionsFor(path, { expectedSha256 }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LegacyImportError);
    expect((thrown as LegacyImportError).category).toBe("unsupported_schema");
    expect(String((thrown as Error).stack)).not.toContain(path);
    expect(String((thrown as Error).stack)).not.toContain("SIDECAR_CANARY_SECRET");
    expect(store.listImportBatches()).toEqual([]);
    expect(store.listAgentRouterAccounts()).toEqual([]);
    expect(await sha256(path)).toBe(expectedSha256);
  });
});
