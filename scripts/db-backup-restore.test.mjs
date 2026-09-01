import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { backupDatabase, parseBackupCliArgs, resolveBackupPaths } from "./db-backup.mjs";
import { parseAuditCliArgs, resolveAuditPaths, runAudit } from "./db-audit.mjs";
import {
  parseRestoreCliArgs,
  resolveRestorePaths,
  restoreDatabase,
  verifyDatabaseIntegrity,
} from "./db-restore.mjs";

describe("Database scripts path resolution & CLI parsing", () => {
  test("resolveBackupPaths defaults to checkout data when env is empty", () => {
    const paths = resolveBackupPaths({ env: {}, targetArg: undefined, timestamp: "2026-08-31T00-00-00.000Z" });
    expect(paths.source).toBe(resolve("data/checks.sqlite"));
    expect(paths.defaultBackupDir).toBe(resolve("data/backups"));
    expect(paths.target).toBe(resolve("data/backups/checks-2026-08-31T00-00-00.000Z.sqlite"));
  });

  test("resolveBackupPaths uses DATA_DIR when DB_PATH is not set", () => {
    const dataDir = "/var/lib/agentrouter-monitor/data";
    const paths = resolveBackupPaths({
      env: { DATA_DIR: dataDir },
      targetArg: undefined,
      timestamp: "2026-08-31T00-00-00.000Z",
    });
    expect(paths.source).toBe(resolve(dataDir, "checks.sqlite"));
    expect(paths.defaultBackupDir).toBe(resolve(dataDir, "backups"));
    expect(paths.target).toBe(resolve(dataDir, "backups/checks-2026-08-31T00-00-00.000Z.sqlite"));
  });

  test("resolveBackupPaths prioritizes explicit DB_PATH over DATA_DIR for source and uses DATA_DIR for backups dir", () => {
    const explicitDb = "/custom/path/custom-checks.sqlite";
    const dataDir = "/var/lib/agentrouter-monitor/data";
    const paths = resolveBackupPaths({
      env: { DB_PATH: explicitDb, DATA_DIR: dataDir },
      targetArg: undefined,
      timestamp: "2026-08-31T00-00-00.000Z",
    });
    expect(paths.source).toBe(resolve(explicitDb));
    expect(paths.defaultBackupDir).toBe(resolve(dataDir, "backups"));
    expect(paths.target).toBe(resolve(dataDir, "backups/checks-2026-08-31T00-00-00.000Z.sqlite"));
  });

  test("resolveBackupPaths respects explicit CLI target argument", () => {
    const customTarget = "/tmp/my-backup.sqlite";
    const paths = resolveBackupPaths({
      env: { DATA_DIR: "/var/lib/agentrouter-monitor/data" },
      targetArg: customTarget,
    });
    expect(paths.target).toBe(resolve(customTarget));
  });

  test("parseBackupCliArgs handles flags, legacy positional targets, and -- delimiter", () => {
    expect(parseBackupCliArgs([])).toEqual({ targetArg: undefined, sourceArg: undefined, dbType: undefined, showHelp: false });
    expect(parseBackupCliArgs(["--help"])).toEqual({ targetArg: undefined, sourceArg: undefined, dbType: undefined, showHelp: true });
    expect(parseBackupCliArgs(["/tmp/custom.sqlite"])).toEqual({ targetArg: "/tmp/custom.sqlite", sourceArg: undefined, dbType: undefined, showHelp: false });
    expect(parseBackupCliArgs(["--observatory", "/tmp/custom.sqlite"])).toEqual({
      targetArg: "/tmp/custom.sqlite",
      sourceArg: undefined,
      dbType: "observatory",
      showHelp: false,
    });
    expect(parseBackupCliArgs(["--legacy", "--target=/tmp/legacy.sqlite"])).toEqual({
      targetArg: "/tmp/legacy.sqlite",
      sourceArg: undefined,
      dbType: "legacy",
      showHelp: false,
    });
    expect(parseBackupCliArgs(["--", "-custom-target.sqlite"])).toEqual({
      targetArg: "-custom-target.sqlite",
      sourceArg: undefined,
      dbType: undefined,
      showHelp: false,
    });

    expect(() => parseBackupCliArgs(["--unknown-flag"])).toThrow("Unknown option: '--unknown-flag'");
    expect(() => parseBackupCliArgs(["/first.sqlite", "/second.sqlite"])).toThrow("Unexpected extra argument");
  });

  test("resolveBackupPaths handles normalized observatory db explicitly and distinct artifacts", () => {
    const paths = resolveBackupPaths({
      env: { DATA_DIR: "/var/lib/ai-fleet-observatory/data", OBSERVATORY_DB_PATH: "/var/lib/ai-fleet-observatory/data/observatory.sqlite" },
      dbType: "observatory",
      timestamp: "2026-09-01T00-00-00.000Z",
    });
    expect(paths.source).toBe(resolve("/var/lib/ai-fleet-observatory/data/observatory.sqlite"));
    expect(paths.defaultBackupDir).toBe(resolve("/var/lib/ai-fleet-observatory/data/backups"));
    expect(paths.target).toBe(resolve("/var/lib/ai-fleet-observatory/data/backups/observatory-2026-09-01T00-00-00.000Z.sqlite"));
    expect(paths.dbType).toBe("observatory");
  });

  test("resolveBackupPaths defaults deterministically to legacy even when only OBSERVATORY_DB_PATH is in env", () => {
    const paths = resolveBackupPaths({
      env: { OBSERVATORY_DB_PATH: "/custom/observatory.sqlite" },
      timestamp: "2026-09-01T00-00-00.000Z",
    });
    expect(paths.source).toBe(resolve("data/checks.sqlite"));
    expect(paths.target).toBe(resolve("data/backups/checks-2026-09-01T00-00-00.000Z.sqlite"));
    expect(paths.dbType).toBe("legacy");
  });
  test("resolveAuditPaths mirrors exact DB_PATH and DATA_DIR precedence", () => {
    const defaultPaths = resolveAuditPaths({});
    expect(defaultPaths.databasePath).toBe(resolve("data/checks.sqlite"));
    expect(defaultPaths.backupDirectory).toBe(resolve("data/backups"));

    const dataDirPaths = resolveAuditPaths({ DATA_DIR: "/var/lib/agentrouter-monitor/data" });
    expect(dataDirPaths.databasePath).toBe(resolve("/var/lib/agentrouter-monitor/data/checks.sqlite"));
    expect(dataDirPaths.backupDirectory).toBe(resolve("/var/lib/agentrouter-monitor/data/backups"));

    const customDbPaths = resolveAuditPaths({
      DB_PATH: "/opt/db/live.sqlite",
      DATA_DIR: "/var/lib/agentrouter-monitor/data",
    });
    expect(customDbPaths.databasePath).toBe(resolve("/opt/db/live.sqlite"));
    expect(customDbPaths.backupDirectory).toBe(resolve("/var/lib/agentrouter-monitor/data/backups"));
  });

  test("resolveAuditPaths selects normalized observatory db only when explicit dbType is specified", () => {
    const obsPaths = resolveAuditPaths({
      OBSERVATORY_DB_PATH: "/var/lib/ai-fleet-observatory/data/observatory.sqlite",
      DATA_DIR: "/var/lib/ai-fleet-observatory/data",
    }, { dbType: "observatory" });
    expect(obsPaths.databasePath).toBe(resolve("/var/lib/ai-fleet-observatory/data/observatory.sqlite"));
    expect(obsPaths.backupDirectory).toBe(resolve("/var/lib/ai-fleet-observatory/data/backups"));
    expect(obsPaths.dbType).toBe("observatory");

    const legacyDefault = resolveAuditPaths({
      OBSERVATORY_DB_PATH: "/var/lib/ai-fleet-observatory/data/observatory.sqlite",
      DATA_DIR: "/var/lib/ai-fleet-observatory/data",
    });
    expect(legacyDefault.databasePath).toBe(resolve("/var/lib/ai-fleet-observatory/data/checks.sqlite"));
    expect(legacyDefault.backupDirectory).toBe(resolve("/var/lib/ai-fleet-observatory/data/backups"));
    expect(legacyDefault.dbType).toBe("legacy");
  });

  test("parseAuditCliArgs parses options strictly", () => {
    expect(parseAuditCliArgs([])).toEqual({ dbType: undefined, deleteFalseZero: false, showHelp: false });
    expect(parseAuditCliArgs(["--observatory"])).toEqual({ dbType: "observatory", deleteFalseZero: false, showHelp: false });
    expect(parseAuditCliArgs(["--legacy", "--delete-false-zero"])).toEqual({ dbType: "legacy", deleteFalseZero: true, showHelp: false });
    expect(() => parseAuditCliArgs(["--invalid"])).toThrow("Unknown option");
  });

  test("resolveRestorePaths defaults to timestamped new path and respects target overrides", () => {
    const defaultPaths = resolveRestorePaths({ env: {}, timestamp: "2026-08-31T00-00-00.000Z" });
    expect(defaultPaths.target).toBe(resolve("data/checks-restored-2026-08-31T00-00-00.000Z.sqlite"));

    const dataDirPaths = resolveRestorePaths({
      env: { DATA_DIR: "/var/lib/agentrouter-monitor/data" },
      timestamp: "2026-08-31T00-00-00.000Z",
    });
    expect(dataDirPaths.target).toBe(
      resolve("/var/lib/agentrouter-monitor/data/checks-restored-2026-08-31T00-00-00.000Z.sqlite")
    );

    const targetArgPaths = resolveRestorePaths({
      targetArg: "/opt/db/new-restore.sqlite",
      env: { DATA_DIR: "/var/lib/agentrouter-monitor/data" },
    });
    expect(targetArgPaths.target).toBe(resolve("/opt/db/new-restore.sqlite"));
  });

  test("parseRestoreCliArgs validates options, values, and delimiters strictly", () => {
    const parsed = parseRestoreCliArgs([
      "/backups/snapshot.sqlite",
      "/data/checks-restored.sqlite",
      "--dry-run",
    ]);
    expect(parsed.sourceArg).toBe("/backups/snapshot.sqlite");
    expect(parsed.targetArg).toBe("/data/checks-restored.sqlite");
    expect(parsed.dryRun).toBe(true);

    const parsedWithFlags = parseRestoreCliArgs([
      "--observatory",
      "--source=/backups/snap.sqlite",
      "--target=/data/snap-new.sqlite",
    ]);
    expect(parsedWithFlags.dbType).toBe("observatory");
    expect(parsedWithFlags.sourceArg).toBe("/backups/snap.sqlite");
    expect(parsedWithFlags.targetArg).toBe("/data/snap-new.sqlite");

    const parsedWithDash = parseRestoreCliArgs([
      "--",
      "-source-file.sqlite",
      "-new-target-file.sqlite",
    ]);
    expect(parsedWithDash.sourceArg).toBe("-source-file.sqlite");
    expect(parsedWithDash.targetArg).toBe("-new-target-file.sqlite");

    expect(() => parseRestoreCliArgs(["--source", "--target"])).toThrow(
      "requires a non-empty file path value"
    );
    expect(() => parseRestoreCliArgs(["--target"])).toThrow(
      "requires a non-empty file path value"
    );
    expect(() => parseRestoreCliArgs(["--invalid-flag"])).toThrow(
      "Unknown option: '--invalid-flag'"
    );
    expect(() => parseRestoreCliArgs(["a.sqlite", "b.sqlite", "c.sqlite"])).toThrow(
      "Unexpected extra argument"
    );
  });

  test("resolveRestorePaths does not classify by filename and defaults to legacy unless explicit dbType is set", () => {
    const defaultPaths = resolveRestorePaths({
      sourceArg: "/var/lib/ai-fleet-observatory/data/backups/observatory-2026-09-01.sqlite",
      env: { DATA_DIR: "/var/lib/ai-fleet-observatory/data", OBSERVATORY_DB_PATH: "/var/lib/ai-fleet-observatory/data/observatory.sqlite" },
      timestamp: "2026-09-01T00-00-00.000Z",
    });
    expect(defaultPaths.target).toBe(
      resolve("/var/lib/ai-fleet-observatory/data/checks-restored-2026-09-01T00-00-00.000Z.sqlite")
    );
    expect(defaultPaths.dbType).toBe("legacy");

    const explicitObsPaths = resolveRestorePaths({
      sourceArg: "/var/lib/ai-fleet-observatory/data/backups/observatory-2026-09-01.sqlite",
      dbType: "observatory",
      env: { DATA_DIR: "/var/lib/ai-fleet-observatory/data" },
      timestamp: "2026-09-01T00-00-00.000Z",
    });
    expect(explicitObsPaths.target).toBe(
      resolve("/var/lib/ai-fleet-observatory/data/observatory-restored-2026-09-01T00-00-00.000Z.sqlite")
    );
    expect(explicitObsPaths.dbType).toBe("observatory");
  });
});

describe("Database backup, restore, and audit end-to-end operations", () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "db-test-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  function createTestDb(filePath, { accountId = "acc-1", balance = 100 } = {}) {
    const db = new Database(filePath);
    db.exec(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        logged_out INTEGER DEFAULT 0,
        metrics TEXT NOT NULL
      );
      INSERT INTO runs (account_id, status, started_at, logged_out, metrics)
      VALUES ('${accountId}', 'ok', datetime('now'), 1, '{"balance": ${balance}, "consumed": 10}');
    `);
    db.close();
  }

  function createWalDbWithPendingTransaction(
    filePath,
    { baseAccountId = "acc-base", baseBalance = 100, walAccountId = "acc-wal", walBalance = 888 } = {}
  ) {
    const writer = new Database(filePath);
    writer.exec("PRAGMA journal_mode = WAL;");
    writer.exec("PRAGMA wal_autocheckpoint = 0;");
    writer.exec(`
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        logged_out INTEGER DEFAULT 0,
        metrics TEXT NOT NULL
      );
      INSERT INTO runs (account_id, status, started_at, logged_out, metrics)
      VALUES ('${baseAccountId}', 'ok', datetime('now'), 1, '{"balance": ${baseBalance}, "consumed": 10}');
    `);
    writer.exec("BEGIN IMMEDIATE;");
    writer.exec(`
      INSERT INTO runs (account_id, status, started_at, logged_out, metrics)
      VALUES ('${walAccountId}', 'ok', datetime('now'), 1, '{"balance": ${walBalance}, "consumed": 10}');
    `);
    writer.exec("COMMIT;");
    return writer;
  }

  test("backupDatabase captures uncheckpointed WAL data safely into snapshot", async () => {
    const sourceDbPath = join(tempDir, "source-wal.sqlite");
    const targetBackupPath = join(tempDir, "backups", "backup.sqlite");

    const sourceWriter = createWalDbWithPendingTransaction(sourceDbPath, {
      baseAccountId: "acc-base",
      baseBalance: 100,
      walAccountId: "acc-uncheckpointed-wal",
      walBalance: 888,
    });

    try {
      const walStat = await stat(`${sourceDbPath}-wal`).catch(() => null);
      expect(walStat).not.toBeNull();
      expect(walStat?.size).toBeGreaterThan(0);

      const result = await backupDatabase({ source: sourceDbPath, target: targetBackupPath });
      expect(result.target).toBe(join(await realpath(dirname(targetBackupPath)), basename(targetBackupPath)));
      expect(verifyDatabaseIntegrity(targetBackupPath)).toBe(true);

      const backupDb = new Database(targetBackupPath, { readonly: true });
      const rows = backupDb.query("SELECT * FROM runs ORDER BY id").all();
      backupDb.close();

      expect(rows.length).toBe(2);
      expect(rows[0].account_id).toBe("acc-base");
      expect(rows[1].account_id).toBe("acc-uncheckpointed-wal");
      expect(JSON.parse(rows[1].metrics).balance).toBe(888);
    } finally {
      sourceWriter.close();
    }
  });

  test("backupDatabase rejects if target destination already exists (no overwrite)", async () => {
    const sourceDb = join(tempDir, "source.sqlite");
    const targetBackup = join(tempDir, "existing-backup.sqlite");

    createTestDb(sourceDb);
    createTestDb(targetBackup, { accountId: "preexisting", balance: 99 });

    await expect(backupDatabase({ source: sourceDb, target: targetBackup })).rejects.toThrow(
      "already exists. Refusing overwrite"
    );

    const db = new Database(targetBackup, { readonly: true });
    const row = db.query("SELECT * FROM runs").get();
    db.close();
    expect(row.account_id).toBe("preexisting");
  });

  test("backupDatabase detects destination created right before publish (atomic link EEXIST)", async () => {
    const sourceDb = join(tempDir, "source.sqlite");
    const targetBackup = join(tempDir, "race-target.sqlite");
    createTestDb(sourceDb);

    await expect(
      backupDatabase({
        source: sourceDb,
        target: targetBackup,
        _testHooks: {
          beforePublish: async () => {
            createTestDb(targetBackup, { accountId: "raced-in", balance: 123 });
          },
        },
      })
    ).rejects.toThrow("already exists or appeared concurrently");

    const db = new Database(targetBackup, { readonly: true });
    const row = db.query("SELECT * FROM runs").get();
    db.close();
    expect(row.account_id).toBe("raced-in");
  });

  test("backupDatabase aborts if source database is swapped during operation (no inode reuse)", async () => {
    const sourceDb = join(tempDir, "source.sqlite");
    const targetBackup = join(tempDir, "target.sqlite");
    createTestDb(sourceDb);

    await expect(
      backupDatabase({
        source: sourceDb,
        target: targetBackup,
        _testHooks: {
          beforeVacuum: async () => {
            // Rename original aside to keep its inode live and occupied
            const keptInodePath = join(tempDir, "source-kept-inode.sqlite");
            await rename(sourceDb, keptInodePath);
            // Create a completely new file with a distinct inode
            createTestDb(sourceDb, { accountId: "swapped-source" });
          },
        },
      })
    ).rejects.toThrow("identity changed before snapshot");
  });

  test("restoreDatabase restores uncheckpointed WAL data from source to new clean target", async () => {
    const sourceBackup = join(tempDir, "source-wal.sqlite");
    const newTargetDb = join(tempDir, "new-restored.sqlite");

    const sourceWriter = createWalDbWithPendingTransaction(sourceBackup, {
      baseAccountId: "acc-initial",
      baseBalance: 50,
      walAccountId: "acc-wal-committed",
      walBalance: 750,
    });

    try {
      const walStat = await stat(`${sourceBackup}-wal`).catch(() => null);
      expect(walStat).not.toBeNull();
      expect(walStat?.size).toBeGreaterThan(0);

      const res = await restoreDatabase({
        source: sourceBackup,
        target: newTargetDb,
      });

      expect(res.success).toBe(true);
      expect(verifyDatabaseIntegrity(newTargetDb)).toBe(true);

      const db = new Database(newTargetDb, { readonly: true });
      const rows = db.query("SELECT * FROM runs ORDER BY id").all();
      db.close();

      expect(rows.length).toBe(2);
      expect(rows[0].account_id).toBe("acc-initial");
      expect(rows[1].account_id).toBe("acc-wal-committed");
      expect(JSON.parse(rows[1].metrics).balance).toBe(750);
    } finally {
      sourceWriter.close();
    }
  });

  test("restoreDatabase refuses if target database or sidecars (-wal, -shm, -journal) already exist", async () => {
    const sourceBackup = join(tempDir, "backup.sqlite");
    createTestDb(sourceBackup);

    const existingTargetDb = join(tempDir, "existing-target.sqlite");
    createTestDb(existingTargetDb, { accountId: "existing-acc", balance: 100 });
    await expect(
      restoreDatabase({ source: sourceBackup, target: existingTargetDb })
    ).rejects.toThrow("already exists");

    const targetWithWal = join(tempDir, "wal-dest.sqlite");
    await writeFile(`${targetWithWal}-wal`, "stale-wal");
    await expect(
      restoreDatabase({ source: sourceBackup, target: targetWithWal })
    ).rejects.toThrow("Target sidecar");

    const targetWithShm = join(tempDir, "shm-dest.sqlite");
    await writeFile(`${targetWithShm}-shm`, "stale-shm");
    await expect(
      restoreDatabase({ source: sourceBackup, target: targetWithShm })
    ).rejects.toThrow("Target sidecar");

    const targetWithJournal = join(tempDir, "journal-dest.sqlite");
    await writeFile(`${targetWithJournal}-journal`, "stale-journal");
    await expect(
      restoreDatabase({ source: sourceBackup, target: targetWithJournal })
    ).rejects.toThrow("Target sidecar");
  });

  test("restoreDatabase detects concurrent target creation before publication (atomic link EEXIST)", async () => {
    const sourceBackup = join(tempDir, "backup.sqlite");
    const targetDb = join(tempDir, "race-restore-target.sqlite");
    createTestDb(sourceBackup);

    await expect(
      restoreDatabase({
        source: sourceBackup,
        target: targetDb,
        _testHooks: {
          beforePublish: async () => {
            createTestDb(targetDb, { accountId: "raced-target", balance: 555 });
          },
        },
      })
    ).rejects.toThrow("already exists or appeared concurrently");

    const db = new Database(targetDb, { readonly: true });
    const row = db.query("SELECT * FROM runs").get();
    db.close();
    expect(row.account_id).toBe("raced-target");
  });

  test("restoreDatabase does not unlink foreign target on post-publish verification mismatch", async () => {
    const sourceBackup = join(tempDir, "backup.sqlite");
    const targetDb = join(tempDir, "post-publish-target.sqlite");
    createTestDb(sourceBackup);

    await expect(
      restoreDatabase({
        source: sourceBackup,
        target: targetDb,
        _testHooks: {
          afterPublish: async () => {
            // Replace target with a valid foreign database to test non-reopening identity mismatch
            await unlink(targetDb);
            createTestDb(targetDb, { accountId: "alien-process-db", balance: 1234 });
          },
        },
      })
    ).rejects.toThrow("does not match staged identity");

    // CRITICAL: Foreign file at target MUST NOT be deleted
    const foreignDb = new Database(targetDb, { readonly: true });
    const row = foreignDb.query("SELECT * FROM runs").get();
    foreignDb.close();
    expect(row.account_id).toBe("alien-process-db");
  });

  test("restoreDatabase dryRun is read-only when destination parent is missing", async () => {
    const sourceBackup = join(tempDir, "backup.sqlite");
    const missingParent = join(tempDir, "missing-parent");
    const targetDb = join(missingParent, "target.sqlite");
    createTestDb(sourceBackup, { accountId: "dry-run-acc", balance: 300 });

    await expect(restoreDatabase({ source: sourceBackup, target: targetDb, dryRun: true }))
      .rejects.toThrow("does not exist");
    expect(await stat(missingParent).catch(() => null)).toBeNull();
  });

  test("restoreDatabase dryRun validates an existing trusted parent without files", async () => {
    const sourceBackup = join(tempDir, "backup.sqlite");
    const targetDb = join(tempDir, "nonexistent-target.sqlite");
    createTestDb(sourceBackup, { accountId: "dry-run-acc", balance: 300 });
    const result = await restoreDatabase({ source: sourceBackup, target: targetDb, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(await stat(targetDb).catch(() => null)).toBeNull();
  });
  test("restoreDatabase rejects a source inode swap while retaining the old inode", async () => {
    const sourceBackup = join(tempDir, "swap-source.sqlite");
    const targetDb = join(tempDir, "swap-target.sqlite");
    createTestDb(sourceBackup);
    await expect(restoreDatabase({
      source: sourceBackup,
      target: targetDb,
      _testHooks: {
        beforeVacuum: async () => {
          await rename(sourceBackup, join(tempDir, "retained-source.sqlite"));
          createTestDb(sourceBackup, { accountId: "replacement" });
        },
      },
    })).rejects.toThrow("identity changed");
  });

  test("restoreDatabase fails closed when a sidecar appears after publication", async () => {
    const sourceBackup = join(tempDir, "sidecar-source.sqlite");
    const targetDb = join(tempDir, "sidecar-target.sqlite");
    createTestDb(sourceBackup);
    await expect(restoreDatabase({
      source: sourceBackup,
      target: targetDb,
      _testHooks: { afterPublish: async () => writeFile(`${targetDb}-journal`, "race") },
    })).rejects.toThrow("appeared during publication");
    expect(await stat(targetDb).catch(() => null)).not.toBeNull();
  });


  test("restoreDatabase rejects corrupted source backup", async () => {
    const corruptedBackup = join(tempDir, "corrupted.sqlite");
    const targetDb = join(tempDir, "target.sqlite");

    await writeFile(corruptedBackup, "NOT AN SQLITE DATABASE FILE - INVALID BYTES");

    await expect(
      restoreDatabase({ source: corruptedBackup, target: targetDb })
    ).rejects.toThrow("failed integrity verification");

    const targetStat = await stat(targetDb).catch(() => null);
    expect(targetStat).toBeNull();
  });

  test("restoreDatabase refuses operation on non-sqlite / secret file extensions", async () => {
    const secretFile = join(tempDir, "accounts.json");
    const targetDb = join(tempDir, "checks-new.sqlite");

    await writeFile(secretFile, '{"secret": "token"}');

    await expect(
      restoreDatabase({ source: secretFile, target: targetDb })
    ).rejects.toThrow("Refusing operation");

    createTestDb(targetDb);
    await expect(
      restoreDatabase({ source: targetDb, target: join(tempDir, ".env") })
    ).rejects.toThrow("Refusing operation");
  });

  test("runAudit with deleteFalseZero creates verified backup and deletes rows atomically via RETURNING", async () => {
    const auditDirectory = join(tempDir, "backups");
    await mkdir(auditDirectory, { mode: 0o700 });
    const auditDbPath = join(auditDirectory, "live.sqlite");

    const db = new Database(auditDbPath);
    db.exec(`
      CREATE TABLE runs (
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
        screenshot_path TEXT,
        metrics TEXT NOT NULL DEFAULT '{}',
        logged_out INTEGER NOT NULL DEFAULT 0,
        session_reused INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE usage_points (
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
      CREATE TABLE credit_observations (
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
      CREATE TABLE credit_grant_events (
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

      -- Run 1: false-zero candidate (id=1)
      INSERT INTO runs (
        id, account_id, account_label, started_at, ended_at, status,
        login_ms, dashboard_ms, total_ms, summary, api_calls,
        error_message, screenshot_path, metrics, logged_out, session_reused
      ) VALUES (
        1, 'acc-1', 'Account 1', '2026-08-01 10:00:00', '2026-08-01 10:00:05', 'ok',
        1000, 500, 5000, '{}', '[]', NULL, NULL,
        '{"balance": 0, "consumed": 0}', 0, 0
      );

      -- Run 2: valid follow-up with balance (id=2)
      INSERT INTO runs (
        id, account_id, account_label, started_at, ended_at, status,
        login_ms, dashboard_ms, total_ms, summary, api_calls,
        error_message, screenshot_path, metrics, logged_out, session_reused
      ) VALUES (
        2, 'acc-1', 'Account 1', '2026-08-01 11:00:00', '2026-08-01 11:00:05', 'ok',
        1000, 500, 5000, '{}', '[]', NULL, NULL,
        '{"balance": 50, "consumed": 10}', 1, 0
      );
    `);
    db.close();

    let concurrentWriteRejected = false;
    const report = await runAudit({
      env: { DB_PATH: auditDbPath, DATA_DIR: tempDir },
      deleteFalseZero: true,
      _testHooks: {
        afterAuditBackup: async () => {
          const writer = new Database(auditDbPath);
          try {
            writer.exec("PRAGMA busy_timeout = 0;");
            writer.exec("BEGIN IMMEDIATE;");
          } catch {
            concurrentWriteRejected = true;
          } finally {
            writer.close();
          }
        },
      },
    });

    expect(report.falseZeroRows.length).toBe(1);
    expect(report.deletedRunIds).toEqual([1]);
    expect(report.backup).not.toBeNull();
    expect(verifyDatabaseIntegrity(report.backup)).toBe(true);
    expect(concurrentWriteRejected).toBe(true);

    // Verify row 1 was deleted from database
    const verifyDb = new Database(auditDbPath, { readonly: true });
    const remainingRows = verifyDb.query("SELECT id FROM runs").all();
    verifyDb.close();
    expect(remainingRows.map((r) => r.id)).toEqual([2]);
  });
  test("runAudit releases maintenance locks when database construction fails", async () => {
    const missingDatabase = join(tempDir, "missing.sqlite");
    await expect(runAudit({
      env: { DB_PATH: missingDatabase, DATA_DIR: tempDir },
      deleteFalseZero: true,
    })).rejects.toThrow();
    expect(await stat(join(tempDir, ".agentrouter-db-maintenance.lock")).catch(() => null)).toBeNull();
    expect(await stat(join(tempDir, "backups", ".agentrouter-db-maintenance.lock")).catch(() => null)).toBeNull();
  });

  function createValidObservatoryDb(filePath) {
    const db = new Database(filePath);
    db.exec(`
      CREATE TABLE observatory_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        app_version TEXT NOT NULL,
        description TEXT NOT NULL
      );
    `);

    const defs = [
      { version: 1, name: "001_foundation", description: "Initial Observatory schema: hosts, identities, quota, trackers, sessions, events, policies, deliveries, nonces, audit, ledger, collector batches, and agentrouter entities" },
      { version: 2, name: "002_quota", description: "Reserve immutable quota migration boundary." },
      { version: 3, name: "003_sessions", description: "Reserve immutable session migration boundary." },
      { version: 4, name: "004_agentrouter", description: "Reserve immutable AgentRouter migration boundary." },
      { version: 5, name: "005_policy_events", description: "Reserve immutable policy and event migration boundary." },
      { version: 6, name: "006_import", description: "Reserve immutable legacy import migration boundary." },
    ];

    for (const d of defs) {
      const checksum = createHash("sha256").update(`${d.version}\0${d.name}\0${d.description}`).digest("hex");
      db.run(
        "INSERT INTO observatory_schema_migrations (version, name, checksum, applied_at, app_version, description) VALUES (?, ?, ?, ?, ?, ?)",
        [d.version, d.name, checksum, new Date().toISOString(), "ai-fleet-observatory/1", d.description]
      );
    }

    db.exec("PRAGMA user_version = 6;");

    db.exec(`
      CREATE TABLE observatory_hosts (
        host_id TEXT PRIMARY KEY,
        operator_label TEXT NOT NULL,
        platform TEXT NOT NULL,
        collector_version TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO observatory_hosts (host_id, operator_label, platform, collector_version, last_seen_at, observed_at, status, created_at, updated_at)
      VALUES ('host-1', 'Xeon-Staging', 'linux', '18.0.11', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'healthy', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `);
    db.close();
  }

  test("Observatory database backup, verified out-of-place restore, and audit lifecycle", async () => {
    const obsDbPath = join(tempDir, "observatory.sqlite");
    const backupsDir = join(tempDir, "backups");
    await mkdir(backupsDir, { mode: 0o700 });

    createValidObservatoryDb(obsDbPath);

    // 1. Backup Observatory DB
    const backupTarget = join(backupsDir, "observatory-2026-09-01.sqlite");
    const backupResult = await backupDatabase({ source: obsDbPath, target: backupTarget });
    expect(backupResult.target).toBe(join(await realpath(dirname(backupTarget)), basename(backupTarget)));
    expect(verifyDatabaseIntegrity(backupTarget)).toBe(true);

    // 2. Out-of-place restore of Observatory DB
    const restoreTarget = join(tempDir, "observatory-restored-2026-09-01.sqlite");
    const restoreResult = await restoreDatabase({ source: backupTarget, target: restoreTarget });
    expect(restoreResult.success).toBe(true);
    expect(verifyDatabaseIntegrity(restoreTarget)).toBe(true);

    // 3. Audit restored Observatory DB
    const auditReport = await runAudit({
      env: { OBSERVATORY_DB_PATH: restoreTarget, DATA_DIR: tempDir },
      dbType: "observatory",
    });
    expect(auditReport.databaseType).toBe("observatory");
    expect(auditReport.integrity).toBe("ok");
    expect(auditReport.foreignKeyViolations).toEqual([]);
    expect(auditReport.schemaVersion).toBe(6);
    expect(auditReport.migrations.length).toBe(6);
    expect(auditReport.counts.observatory_hosts).toBe(1);
    expect(auditReport.colocatedLegacyTables).toEqual([]);

    // 4. Reject --delete-false-zero on Observatory DB
    await expect(runAudit({
      env: { OBSERVATORY_DB_PATH: restoreTarget, DATA_DIR: tempDir },
      dbType: "observatory",
      deleteFalseZero: true,
    })).rejects.toThrow("The --delete-false-zero option is only supported for legacy AgentRouter checks databases");
  });

  test("Observatory audit fails closed on integrity failure, foreign key violations, or colocated legacy tables", async () => {
    const obsDbPath = join(tempDir, "observatory-invalid.sqlite");
    createValidObservatoryDb(obsDbPath);

    // Test colocated legacy table rejection
    const db = new Database(obsDbPath);
    db.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY);");
    db.close();

    await expect(runAudit({
      env: { OBSERVATORY_DB_PATH: obsDbPath, DATA_DIR: tempDir },
      dbType: "observatory",
    })).rejects.toThrow("prohibited colocated legacy table");

    // Test foreign key violation failure
    const fkDbPath = join(tempDir, "observatory-fk-fail.sqlite");
    createValidObservatoryDb(fkDbPath);
    const fkDb = new Database(fkDbPath);
    fkDb.exec("PRAGMA foreign_keys = OFF;");
    fkDb.exec(`
      CREATE TABLE observatory_child (
        id INTEGER PRIMARY KEY,
        host_id TEXT REFERENCES observatory_hosts(host_id)
      );
      INSERT INTO observatory_child (id, host_id) VALUES (1, 'non-existent-host');
    `);
    fkDb.close();

    await expect(runAudit({
      env: { OBSERVATORY_DB_PATH: fkDbPath, DATA_DIR: tempDir },
      dbType: "observatory",
    })).rejects.toThrow("foreign key check failed");
  });

  test("Observatory audit fails closed on missing ledger, incomplete ledger, or ledger drift", async () => {
    // Missing migration ledger table
    const missingLedgerPath = join(tempDir, "observatory-no-ledger.sqlite");
    const noLedgerDb = new Database(missingLedgerPath);
    noLedgerDb.exec("CREATE TABLE observatory_hosts (host_id TEXT PRIMARY KEY);");
    noLedgerDb.close();

    await expect(runAudit({
      env: { OBSERVATORY_DB_PATH: missingLedgerPath, DATA_DIR: tempDir },
      dbType: "observatory",
    })).rejects.toThrow("missing the required 'observatory_schema_migrations' ledger table");

    // Incomplete ledger (only 5 entries)
    const incompleteLedgerPath = join(tempDir, "observatory-incomplete.sqlite");
    createValidObservatoryDb(incompleteLedgerPath);
    const incDb = new Database(incompleteLedgerPath);
    incDb.exec("DELETE FROM observatory_schema_migrations WHERE version = 6;");
    incDb.exec("PRAGMA user_version = 5;");
    incDb.close();

    await expect(runAudit({
      env: { OBSERVATORY_DB_PATH: incompleteLedgerPath, DATA_DIR: tempDir },
      dbType: "observatory",
    })).rejects.toThrow("PRAGMA user_version is 5, expected exactly 6");

    // Tampered checksum
    const tamperedLedgerPath = join(tempDir, "observatory-tampered.sqlite");
    createValidObservatoryDb(tamperedLedgerPath);
    const tampDb = new Database(tamperedLedgerPath);
    tampDb.exec("UPDATE observatory_schema_migrations SET checksum = 'tampered-hash' WHERE version = 1;");
    tampDb.close();

    await expect(runAudit({
      env: { OBSERVATORY_DB_PATH: tamperedLedgerPath, DATA_DIR: tempDir },
      dbType: "observatory",
    })).rejects.toThrow("checksum mismatch");
  });

  test("Backup, restore, and audit reject symlink database paths", async () => {
    if (process.platform === "win32") {
      // Symlinks on Windows may require developer mode or admin privileges; test path validation if symlink creation succeeds
      const realDb = join(tempDir, "real-source.sqlite");
      createTestDb(realDb);
      const symlinkDb = join(tempDir, "symlink-source.sqlite");
      let symlinkCreated = false;
      try {
        await symlink(realDb, symlinkDb);
        symlinkCreated = true;
      } catch {
        symlinkCreated = false;
      }

      if (symlinkCreated) {
        await expect(backupDatabase({ source: symlinkDb, target: join(tempDir, "target.sqlite") })).rejects.toThrow("must be a regular non-symlink file");
        await expect(restoreDatabase({ source: symlinkDb, target: join(tempDir, "target.sqlite") })).rejects.toThrow("must be a regular non-symlink file");
        await expect(runAudit({ env: { DB_PATH: symlinkDb, DATA_DIR: tempDir } })).rejects.toThrow("must be a regular non-symlink file");
      }
    } else {
      const realDb = join(tempDir, "real-source.sqlite");
      createTestDb(realDb);
      const symlinkDb = join(tempDir, "symlink-source.sqlite");
      await symlink(realDb, symlinkDb);

      await expect(backupDatabase({ source: symlinkDb, target: join(tempDir, "target.sqlite") })).rejects.toThrow("must be a regular non-symlink file");
      await expect(restoreDatabase({ source: symlinkDb, target: join(tempDir, "target.sqlite") })).rejects.toThrow("must be a regular non-symlink file");
      await expect(runAudit({ env: { DB_PATH: symlinkDb, DATA_DIR: tempDir } })).rejects.toThrow("must be a regular non-symlink file");
    }
  });
});
