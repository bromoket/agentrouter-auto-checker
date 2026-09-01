import { chmod, link, lstat, mkdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { acquireMaintenanceLocks, deriveCanonicalPath, prepareTrustedParent } from "./db-maintenance.mjs";

const DISALLOWED_EXTENSIONS = new Set([".json", ".env", ".ts", ".js", ".mjs", ".sh", ".md", ".txt", ".yaml", ".yml"]);
const SIDECARS = ["-wal", "-shm", "-journal"];

export function resolveBackupPaths({ env = process.env, sourceArg, targetArg, dbType, timestamp = new Date().toISOString().replaceAll(":", "-") } = {}) {
  const dataDir = env.DATA_DIR?.trim();
  const isObservatory = dbType === "observatory" || dbType === "normalized";

  if (isObservatory) {
    const observatoryDbPath = env.OBSERVATORY_DB_PATH?.trim();
    const source = resolve(sourceArg || observatoryDbPath || (dataDir ? join(dataDir, "observatory.sqlite") : "data/observatory.sqlite"));
    const defaultBackupDir = resolve(dataDir ? join(dataDir, "backups") : join(dirname(source), "backups"));
    const target = resolve(targetArg || join(defaultBackupDir, `observatory-${timestamp}.sqlite`));
    return { source, defaultBackupDir, target, dbType: "observatory" };
  }

  const legacyDbPath = env.DB_PATH?.trim();
  const source = resolve(sourceArg || legacyDbPath || (dataDir ? join(dataDir, "checks.sqlite") : "data/checks.sqlite"));
  const defaultBackupDir = resolve(dataDir ? join(dataDir, "backups") : join(dirname(source), "backups"));
  const target = resolve(targetArg || join(defaultBackupDir, `checks-${timestamp}.sqlite`));
  return { source, defaultBackupDir, target, dbType: "legacy" };
}

export function assertSafeDatabasePath(filePath, label) {
  const base = basename(filePath).toLowerCase();
  const ext = extname(filePath).toLowerCase();
  if (DISALLOWED_EXTENSIONS.has(ext) || base === ".env" || base.startsWith(".env.") || base === "env" || base.endsWith(".json")) {
    throw new Error(`Refusing operation: ${label} path '${filePath}' is not a SQLite database path.`);
  }
}

export function verifyDatabaseIntegrity(dbPath) {
  const db = new Database(dbPath, { readonly: true, strict: true, create: false });
  try {
    const integrity = db.query("PRAGMA integrity_check").get();
    if (!integrity || Object.values(integrity)[0] !== "ok") throw new Error(`Database integrity check failed: ${JSON.stringify(integrity)}`);
    const foreignKeys = db.query("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) throw new Error(`Database foreign key check failed: ${JSON.stringify(foreignKeys)}`);
    return true;
  } finally {
    db.close();
  }
}

async function lstatMissing(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function assertDestinationClean(target) {
  if (await lstatMissing(target)) throw new Error(`Destination '${target}' already exists. Refusing overwrite.`);
  for (const suffix of SIDECARS) {
    const path = `${target}${suffix}`;
    if (await lstatMissing(path)) throw new Error(`Destination sidecar '${path}' already exists. Destination must be clean.`);
  }
}

function assertIdentity(info, dev, ino, message) {
  if (!info || info.isSymbolicLink() || info.dev !== dev || info.ino !== ino) throw new Error(message);
}

async function cleanStaging(stagingDir, stagingFile, identity) {
  const current = await lstatMissing(stagingFile);
  if (current) {
    assertIdentity(current, identity.dev, identity.ino, `Staged database identity changed: ${stagingFile}`);
    await unlink(stagingFile);
  }
  await rmdir(stagingDir);
}

export async function backupDatabase({ source, target, _testHooks = {}, _lockContext = null } = {}) {
  if (!source || !target) throw new Error("Both source and target paths are required for database backup.");
  assertSafeDatabasePath(source, "Source");
  assertSafeDatabasePath(target, "Target");

  const sourceParent = await prepareTrustedParent(dirname(source), { create: false, label: "Source parent" });
  const targetParent = await prepareTrustedParent(dirname(target), { create: true, label: "Destination parent" });
  const canonicalSource = deriveCanonicalPath(sourceParent, source, "Source");
  const canonicalTarget = deriveCanonicalPath(targetParent, target, "Target");
  assertSafeDatabasePath(canonicalSource, "Source");
  assertSafeDatabasePath(canonicalTarget, "Target");
  const ownLocks = !_lockContext;
  const locks = await acquireMaintenanceLocks([sourceParent, targetParent], _lockContext);
  let operationError = null;
  let result;
  try {
    result = await backupUnderLock({ source: canonicalSource, target: canonicalTarget, targetParent, _testHooks });
  } catch (error) {
    operationError = error;
  }
  let releaseError = null;
  if (ownLocks) {
    try { await locks.release(); } catch (error) { releaseError = error; }
  }
  if (operationError && releaseError) throw new AggregateError([operationError, releaseError], operationError.message);
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result;
}

async function backupUnderLock({ source, target, targetParent, _testHooks }) {
  const sourceInfo = await lstatMissing(source);
  if (!sourceInfo) throw new Error(`Source database file does not exist: ${source}`);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) throw new Error(`Source database path must be a regular non-symlink file: ${source}`);
  const sourceReal = await realpath(source);
  if (sourceReal !== source) throw new Error(`Source database path '${source}' resolved to a different canonical path '${sourceReal}'. Aliases and symlinks are prohibited.`);
  if (sourceReal === target) throw new Error("Backup target must be different from the source database.");
  await assertDestinationClean(target);

  const stagingDir = join(targetParent, `.backup-staging-${randomUUID()}`);
  await mkdir(stagingDir, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(stagingDir, 0o700);
  const stagingFile = join(stagingDir, "backup-staged.sqlite");
  let stagedIdentity = null;
  let published = false;
  let primaryError = null;
  let result;
  try {
    await _testHooks.beforeVacuum?.();
    assertIdentity(await lstatMissing(source), sourceInfo.dev, sourceInfo.ino, `Source database identity changed before snapshot: ${source}`);
    const db = new Database(source, { readonly: true, strict: true, create: false });
    try { db.exec(`VACUUM INTO '${stagingFile.replaceAll("'", "''")}'`); } finally { db.close(); }
    const staged = await lstat(stagingFile);
    stagedIdentity = { dev: staged.dev, ino: staged.ino };
    assertIdentity(await lstatMissing(source), sourceInfo.dev, sourceInfo.ino, `Source database identity changed during snapshot: ${source}`);
    await _testHooks.afterVacuum?.();
    await chmod(stagingFile, 0o600).catch((error) => { if (process.platform !== "win32") throw error; });
    verifyDatabaseIntegrity(stagingFile);
    await assertDestinationClean(target);
    await _testHooks.beforePublish?.();
    try { await link(stagingFile, target); } catch (error) {
      if (error.code === "EEXIST") throw new Error(`Backup destination '${target}' already exists or appeared concurrently. Refusing overwrite.`);
      throw error;
    }
    published = true;
    await _testHooks.afterPublish?.();
    await assertNoSidecars(target, "publication");
    assertIdentity(await lstatMissing(target), stagedIdentity.dev, stagedIdentity.ino, `Published backup target '${target}' does not match staged identity.`);
    await _testHooks.beforeFinalize?.();
    await assertNoSidecars(target, "finalization");
    assertIdentity(await lstatMissing(target), stagedIdentity.dev, stagedIdentity.ino, `Published backup target '${target}' identity changed at finalization.`);
    result = { source, target };
  } catch (error) {
    primaryError = error;
  }
  if (!stagedIdentity) {
    const staged = await lstatMissing(stagingFile);
    if (staged) stagedIdentity = { dev: staged.dev, ino: staged.ino };
  }
  let cleanupError = null;
  try { await cleanStaging(stagingDir, stagingFile, stagedIdentity || { dev: -1, ino: -1 }); } catch (error) { cleanupError = error; }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], primaryError.message);
  if (primaryError) throw primaryError;
  if (cleanupError) throw new Error(`${published ? "Backup published" : "Backup failed before publication"}, and staging cleanup failed: ${cleanupError.message}`, { cause: cleanupError });
  return result;
}

async function assertNoSidecars(target, phase) {
  for (const suffix of SIDECARS) if (await lstatMissing(`${target}${suffix}`)) throw new Error(`Destination sidecar '${target}${suffix}' appeared during ${phase}.`);
}

export function parseBackupCliArgs(argv = process.argv.slice(2)) {
  let targetArg;
  let sourceArg;
  let dbType;
  let showHelp = false;
  let positional = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (positional) {
      if (targetArg) throw new Error(`Unexpected extra argument: '${arg}'`);
      targetArg = arg;
    } else if (arg === "--") {
      positional = true;
    } else if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg === "--observatory" || arg === "--normalized") {
      dbType = "observatory";
    } else if (arg === "--legacy" || arg === "--checks") {
      dbType = "legacy";
    } else if (arg === "--source" || arg === "--target") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) {
        throw new Error(`Option '${arg}' requires a non-empty file path value.`);
      }
      if (arg === "--source") sourceArg = argv[++i];
      else targetArg = argv[++i];
    } else if (arg.startsWith("--source=")) {
      sourceArg = arg.slice(9);
      if (!sourceArg) throw new Error("Option '--source=' requires a non-empty file path value.");
    } else if (arg.startsWith("--target=")) {
      targetArg = arg.slice(9);
      if (!targetArg) throw new Error("Option '--target=' requires a non-empty file path value.");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: '${arg}'`);
    } else if (!targetArg) {
      targetArg = arg;
    } else {
      throw new Error(`Unexpected extra argument: '${arg}'`);
    }
  }

  return { targetArg, sourceArg, dbType, showHelp };
}

const isMain = typeof import.meta.main === "boolean" ? import.meta.main : Boolean(process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
if (isMain) {
  try {
    const args = parseBackupCliArgs();
    if (args.showHelp) {
      console.log("Usage: bun run scripts/db-backup.mjs [--observatory|--legacy] [--source <source-path>] [--target <target-path>] [--] [target-path]");
    } else {
      const paths = resolveBackupPaths(args);
      if (args.sourceArg) paths.source = resolve(args.sourceArg);
      await backupDatabase(paths);
      console.log(paths.target);
    }
  } catch (error) {
    console.error(`Backup failed: ${error.message}`);
    process.exit(1);
  }
}
