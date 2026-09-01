import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupDatabase } from "./db-backup.mjs";
import { acquireMaintenanceLocks, deriveCanonicalPath, prepareTrustedParent } from "./db-maintenance.mjs";

export function resolveAuditPaths(env = process.env, { dbType } = {}) {
  const dataDir = env.DATA_DIR?.trim();
  const isObservatory = dbType === "observatory" || dbType === "normalized";

  if (isObservatory) {
    const observatoryDb = env.OBSERVATORY_DB_PATH?.trim();
    const databasePath = path.resolve(observatoryDb || (dataDir ? path.join(dataDir, "observatory.sqlite") : "data/observatory.sqlite"));
    const backupDirectory = path.resolve(dataDir ? path.join(dataDir, "backups") : path.join(path.dirname(databasePath), "backups"));
    return { databasePath, backupDirectory, dbType: "observatory" };
  }

  const legacyDb = env.DB_PATH?.trim();
  const databasePath = path.resolve(legacyDb || (dataDir ? path.join(dataDir, "checks.sqlite") : "data/checks.sqlite"));
  const backupDirectory = path.resolve(dataDir ? path.join(dataDir, "backups") : path.join(path.dirname(databasePath), "backups"));
  return { databasePath, backupDirectory, dbType: "legacy" };
}

export function parseAuditCliArgs(argv = process.argv.slice(2)) {
  let dbType;
  let deleteFalseZero = false;
  let showHelp = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg === "--observatory" || arg === "--normalized") {
      dbType = "observatory";
    } else if (arg === "--legacy" || arg === "--checks") {
      dbType = "legacy";
    } else if (arg === "--delete-false-zero") {
      deleteFalseZero = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: '${arg}'`);
    } else {
      throw new Error(`Unexpected extra argument: '${arg}'`);
    }
  }

  return { dbType, deleteFalseZero, showHelp };
}

const falseZeroPredicate = `
  r.status = 'ok'
  AND r.logged_out = 0
  AND COALESCE(json_extract(r.metrics, '$.balance'), 0) = 0
  AND COALESCE(json_extract(r.metrics, '$.consumed'), 0) = 0
  AND EXISTS (
    SELECT 1 FROM runs valid
    WHERE valid.account_id = r.account_id
      AND valid.id > r.id
      AND valid.status = 'ok'
      AND valid.logged_out = 1
      AND (
        COALESCE(json_extract(valid.metrics, '$.balance'), 0) > 0
        OR COALESCE(json_extract(valid.metrics, '$.consumed'), 0) > 0
      )
  )
`;

const OBSERVATORY_APP_VERSION = "ai-fleet-observatory/1";
const INITIAL_SCHEMA_DESCRIPTION =
  "Initial Observatory schema: hosts, identities, quota, trackers, sessions, events, policies, deliveries, nonces, audit, ledger, collector batches, and agentrouter entities";

const EXPECTED_OBSERVATORY_MIGRATIONS = [
  { version: 1, name: "001_foundation", description: INITIAL_SCHEMA_DESCRIPTION },
  { version: 2, name: "002_quota", description: "Reserve immutable quota migration boundary." },
  { version: 3, name: "003_sessions", description: "Reserve immutable session migration boundary." },
  { version: 4, name: "004_agentrouter", description: "Reserve immutable AgentRouter migration boundary." },
  { version: 5, name: "005_policy_events", description: "Reserve immutable policy and event migration boundary." },
  { version: 6, name: "006_import", description: "Reserve immutable legacy import migration boundary." },
].map((m) => ({
  ...m,
  checksum: createHash("sha256").update(`${m.version}\0${m.name}\0${m.description}`).digest("hex"),
}));

const PROHIBITED_LEGACY_TABLES = [
  "runs",
  "usage_points",
  "credit_observations",
  "credit_grant_events",
  "accounts",
  "account_balances",
  "account_grants",
  "endpoints",
  "checks",
];

export async function runAudit({ env = process.env, dbType, deleteFalseZero = process.argv.includes("--delete-false-zero"), _testHooks = {} } = {}) {
  const { databasePath, backupDirectory, dbType: resolvedType } = resolveAuditPaths(env, { dbType });

  const dbParent = await prepareTrustedParent(path.dirname(databasePath), { create: false, label: "Database parent" });
  const canonicalDbPath = deriveCanonicalPath(dbParent, databasePath, "Database");

  if (resolvedType === "observatory") {
    if (deleteFalseZero) {
      throw new Error("The --delete-false-zero option is only supported for legacy AgentRouter checks databases, not normalized Observatory databases.");
    }
    return runObservatoryAudit({ databasePath: canonicalDbPath, backupDirectory });
  }

  return runLegacyAudit({ databasePath: canonicalDbPath, backupDirectory, deleteFalseZero, _testHooks });
}

async function runObservatoryAudit({ databasePath, backupDirectory }) {
  let db = null;
  let primary = null;
  let report;

  try {
    const dbInfo = await lstat(databasePath);
    if (dbInfo.isSymbolicLink() || !dbInfo.isFile()) {
      throw new Error(`Observatory database path must be a regular non-symlink file: ${databasePath}`);
    }
    const realDb = await realpath(databasePath);
    if (realDb !== databasePath) {
      throw new Error(`Observatory database path '${databasePath}' resolved to a different canonical path '${realDb}'. Aliases and symlinks are prohibited.`);
    }

    db = new Database(databasePath, { readonly: true, create: false, strict: true });
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");

    const all = (sql, ...params) => db.query(sql).all(...params);
    const get = (sql, ...params) => db.query(sql).get(...params);

    const integrityRow = get("PRAGMA integrity_check");
    const integrity = integrityRow?.integrity_check ?? Object.values(integrityRow || {})[0];
    if (integrity !== "ok") {
      throw new Error(`Observatory database integrity check failed: ${JSON.stringify(integrityRow)}`);
    }

    const foreignKeyViolations = all("PRAGMA foreign_key_check");
    if (foreignKeyViolations.length > 0) {
      throw new Error(`Observatory database foreign key check failed with ${foreignKeyViolations.length} violation(s): ${JSON.stringify(foreignKeyViolations)}`);
    }

    const tables = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => row.name);

    const colocatedLegacyTables = tables.filter((table) => PROHIBITED_LEGACY_TABLES.includes(table));
    if (colocatedLegacyTables.length > 0) {
      throw new Error(`Observatory database contains prohibited colocated legacy table(s): ${colocatedLegacyTables.join(", ")}`);
    }

    if (!tables.includes("observatory_schema_migrations")) {
      throw new Error("Observatory database is missing the required 'observatory_schema_migrations' ledger table.");
    }

    const userVersionRow = get("PRAGMA user_version");
    const schemaVersion = userVersionRow?.user_version ?? 0;
    if (schemaVersion !== EXPECTED_OBSERVATORY_MIGRATIONS.length) {
      throw new Error(`Observatory database PRAGMA user_version is ${schemaVersion}, expected exactly ${EXPECTED_OBSERVATORY_MIGRATIONS.length}.`);
    }

    const migrations = all("SELECT version, name, checksum, applied_at AS appliedAt, app_version AS appVersion, description FROM observatory_schema_migrations ORDER BY version ASC");
    if (migrations.length !== EXPECTED_OBSERVATORY_MIGRATIONS.length) {
      throw new Error(`Observatory migration ledger has ${migrations.length} entries, expected exactly ${EXPECTED_OBSERVATORY_MIGRATIONS.length}.`);
    }

    for (let i = 0; i < EXPECTED_OBSERVATORY_MIGRATIONS.length; i++) {
      const expected = EXPECTED_OBSERVATORY_MIGRATIONS[i];
      const actual = migrations[i];
      if (!actual) throw new Error(`Observatory migration ledger missing entry at version ${expected.version}.`);
      if (actual.version !== expected.version) {
        throw new Error(`Observatory migration ledger version mismatch at index ${i}: got ${actual.version}, expected ${expected.version}.`);
      }
      if (actual.name !== expected.name) {
        throw new Error(`Observatory migration ledger name mismatch at version ${expected.version}: got '${actual.name}', expected '${expected.name}'.`);
      }
      if (actual.checksum !== expected.checksum) {
        throw new Error(`Observatory migration ledger checksum mismatch at version ${expected.version}: got '${actual.checksum}', expected '${expected.checksum}'.`);
      }
      if (actual.appVersion !== OBSERVATORY_APP_VERSION) {
        throw new Error(`Observatory migration ledger appVersion mismatch at version ${expected.version}: got '${actual.appVersion}', expected '${OBSERVATORY_APP_VERSION}'.`);
      }
      if (actual.description !== expected.description) {
        throw new Error(`Observatory migration ledger description mismatch at version ${expected.version}: got '${actual.description}', expected '${expected.description}'.`);
      }
      if (!actual.appliedAt || typeof actual.appliedAt !== "string" || isNaN(Date.parse(actual.appliedAt))) {
        throw new Error(`Observatory migration ledger appliedAt invalid at version ${expected.version}: '${actual.appliedAt}'.`);
      }
    }

    const counts = {};
    for (const table of tables) {
      try {
        const countRow = get(`SELECT COUNT(*) AS count FROM "${table}"`);
        counts[table] = countRow?.count ?? 0;
      } catch {
        counts[table] = -1;
      }
    }

    report = {
      databaseType: "observatory",
      database: path.resolve(databasePath),
      backup: null,
      integrity,
      foreignKeyViolations,
      schemaVersion,
      migrations,
      colocatedLegacyTables,
      counts,
    };
  } catch (error) {
    primary = error;
  }

  const cleanupErrors = [];
  if (db) try { db.close(); } catch (error) { cleanupErrors.push(error); }
  if (primary && cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], primary.message);
  if (primary) throw primary;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Observatory audit cleanup failed.");
  return report;
}


async function runLegacyAudit({ databasePath, backupDirectory, deleteFalseZero, _testHooks }) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const prospectiveBackup = path.join(backupDirectory, `checks-before-false-zero-cleanup-${stamp}.sqlite`);
  let locks = null;
  let db = null;
  let primary = null;
  let report;

  try {
    const dbInfo = await lstat(databasePath);
    if (dbInfo.isSymbolicLink() || !dbInfo.isFile()) {
      throw new Error(`Legacy database path must be a regular non-symlink file: ${databasePath}`);
    }
    const realDb = await realpath(databasePath);
    if (realDb !== databasePath) {
      throw new Error(`Legacy database path '${databasePath}' resolved to a different canonical path '${realDb}'. Aliases and symlinks are prohibited.`);
    }

    if (deleteFalseZero) {
      const sourceParent = await prepareTrustedParent(path.dirname(databasePath), { create: false, label: "Database parent" });
      const backupParent = await prepareTrustedParent(backupDirectory, { create: true, label: "Backup parent" });
      locks = await acquireMaintenanceLocks([sourceParent, backupParent]);
    }

    db = new Database(databasePath, { readonly: !deleteFalseZero, create: false, strict: true });
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    if (deleteFalseZero) db.exec("PRAGMA journal_mode = WAL;");

    const all = (sql, ...params) => db.query(sql).all(...params);
    const get = (sql, ...params) => db.query(sql).get(...params);
    let falseZeroRows;
    let backupPath = null;
    let deletedRunIds = [];

    if (deleteFalseZero) {
      db.exec("BEGIN IMMEDIATE;");
      try {
        falseZeroRows = selectFalseZeroRows(db);
        if (falseZeroRows.length > 0) {
          backupPath = prospectiveBackup;
          await _testHooks.beforeAuditBackup?.();
          await backupDatabase({ source: databasePath, target: backupPath, _lockContext: locks });
          await _testHooks.afterAuditBackup?.();
          deletedRunIds = db.query(`
            DELETE FROM runs
            WHERE id IN (SELECT r.id FROM runs r WHERE ${falseZeroPredicate})
            RETURNING id
          `).all().map((row) => row.id);
        }
        db.exec("COMMIT;");
      } catch (error) {
        try { db.exec("ROLLBACK;"); } catch (rollbackError) { throw new AggregateError([error, rollbackError], error.message); }
        throw error;
      }
    } else {
      falseZeroRows = selectFalseZeroRows(db);
    }

    report = {
      databaseType: "legacy",
      database: path.resolve(databasePath), backup: backupPath,
      integrity: get("PRAGMA integrity_check").integrity_check,
      foreignKeyViolations: all("PRAGMA foreign_key_check"),
      counts: Object.fromEntries(["runs", "usage_points", "credit_observations", "credit_grant_events"].map((table) => [table, get(`SELECT COUNT(*) AS count FROM ${table}`).count])),
      falseZeroRows,
      invalidMoneyRows: all(`SELECT r.id, r.account_id AS accountId, r.started_at AS startedAt, json_extract(r.metrics, '$.balance') AS balance, json_extract(r.metrics, '$.consumed') AS consumed FROM runs r WHERE r.status = 'ok' AND (json_type(r.metrics, '$.balance') IS NULL OR json_type(r.metrics, '$.balance') NOT IN ('integer', 'real') OR json_type(r.metrics, '$.consumed') IS NULL OR json_type(r.metrics, '$.consumed') NOT IN ('integer', 'real') OR CAST(json_extract(r.metrics, '$.consumed') AS REAL) < 0) ORDER BY r.id`),
      deletedRunIds,
      successfulWithoutLogout: all("SELECT id, account_id AS accountId, started_at AS startedAt FROM runs WHERE status = 'ok' AND logged_out = 0 ORDER BY id"),
      zeroCreditObservations: all("SELECT id, run_id AS runId, account_id AS accountId, observed_at AS observedAt FROM credit_observations WHERE balance = 0 AND consumed = 0 ORDER BY id"),
      grantTotals: all("SELECT account_id AS accountId, COUNT(*) AS count, SUM(amount) AS amount, MIN(occurred_at) AS firstAt, MAX(occurred_at) AS lastAt FROM credit_grant_events GROUP BY account_id ORDER BY account_id"),
      errorGroups: all("SELECT SUBSTR(error_message, 1, 160) AS error, COUNT(*) AS count FROM runs WHERE status = 'error' GROUP BY SUBSTR(error_message, 1, 160) ORDER BY count DESC, error ASC LIMIT 30"),
    };
  } catch (error) {
    primary = error;
  }

  const cleanupErrors = [];
  if (db) try { db.close(); } catch (error) { cleanupErrors.push(error); }
  if (locks) try { await locks.release(); } catch (error) { cleanupErrors.push(error); }
  if (primary && cleanupErrors.length) throw new AggregateError([primary, ...cleanupErrors], primary.message);
  if (primary) throw primary;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Audit cleanup failed.");
  return report;
}

function selectFalseZeroRows(db) {
  return db.query(`SELECT r.id, r.account_id AS accountId, r.started_at AS startedAt, r.logged_out AS loggedOut, json_extract(r.metrics, '$.balance') AS balance, json_extract(r.metrics, '$.consumed') AS consumed, json_extract(r.metrics, '$.requestCount') AS requestCount FROM runs r WHERE ${falseZeroPredicate} ORDER BY r.id`).all();
}

const isMain = typeof import.meta.main === "boolean" ? import.meta.main : Boolean(process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));
if (isMain) {
  try {
    const cliArgs = parseAuditCliArgs();
    if (cliArgs.showHelp) {
      console.log("Usage: bun run scripts/db-audit.mjs [--observatory|--legacy] [--delete-false-zero]");
    } else {
      const report = await runAudit({ dbType: cliArgs.dbType, deleteFalseZero: cliArgs.deleteFalseZero });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
  } catch (error) {
    console.error(`Audit failed: ${error.message}`);
    process.exit(1);
  }
}
