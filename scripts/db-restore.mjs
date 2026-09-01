import { chmod, link, lstat, mkdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { acquireMaintenanceLocks, deriveCanonicalPath, prepareTrustedParent } from "./db-maintenance.mjs";

const DISALLOWED_EXTENSIONS = new Set([".json", ".env", ".ts", ".js", ".mjs", ".sh", ".md", ".txt", ".yaml", ".yml"]);
const SIDECARS = ["-wal", "-shm", "-journal"];

export function resolveRestorePaths({ sourceArg, targetArg, dbType, env = process.env, timestamp = new Date().toISOString().replaceAll(":", "-") } = {}) {
  const baseDataDir = resolve(env.DATA_DIR?.trim() || "data");
  const isObservatory = dbType === "observatory" || dbType === "normalized";
  const resolvedType = isObservatory ? "observatory" : "legacy";

  const defaultTarget = isObservatory
    ? join(baseDataDir, `observatory-restored-${timestamp}.sqlite`)
    : join(baseDataDir, `checks-restored-${timestamp}.sqlite`);

  return {
    source: sourceArg ? resolve(sourceArg) : undefined,
    target: resolve(targetArg || defaultTarget),
    baseDataDir,
    dbType: resolvedType,
  };
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
  } finally { db.close(); }
}

function verifySourceDatabase(source) {
  try {
    verifyDatabaseIntegrity(source);
  } catch (cause) {
    throw new Error("Source backup failed integrity verification.", { cause });
  }
}

function vacuumSourceInto(source, stagingFile) {
  let db = null;
  let primary = null;
  try {
    db = new Database(source, { readonly: true, strict: true, create: false });
    db.exec(`VACUUM INTO '${stagingFile.replaceAll("'", "''")}'`);
  } catch (cause) {
    primary = cause;
  }
  let closeFailure = null;
  if (db) {
    try { db.close(); } catch (cause) { closeFailure = cause; }
  }
  if (primary || closeFailure) {
    const cause = primary && closeFailure
      ? new AggregateError([primary, closeFailure], "Source snapshot failed.")
      : primary || closeFailure;
    throw new Error("Source backup failed integrity verification.", { cause });
  }
}

async function lstatMissing(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export async function assertDestinationClean(target) {
  if (await lstatMissing(target)) throw new Error(`Target database destination '${target}' already exists.`);
  for (const suffix of SIDECARS) if (await lstatMissing(`${target}${suffix}`)) throw new Error(`Target sidecar '${target}${suffix}' already exists.`);
}

function assertIdentity(info, dev, ino, message) {
  if (!info || info.isSymbolicLink() || info.dev !== dev || info.ino !== ino) throw new Error(message);
}

async function assertNoSidecars(target, phase) {
  for (const suffix of SIDECARS) if (await lstatMissing(`${target}${suffix}`)) throw new Error(`Destination sidecar '${target}${suffix}' appeared during ${phase}.`);
}

async function cleanupStaging(directory, file, identity) {
  const current = await lstatMissing(file);
  if (current) {
    assertIdentity(current, identity.dev, identity.ino, `Staged database identity changed: ${file}`);
    await unlink(file);
  }
  await rmdir(directory);
}

async function sourceIdentity(source) {
  const info = await lstatMissing(source);
  if (!info) throw new Error(`Source backup file does not exist: ${source}`);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Source backup must be a regular non-symlink file: ${source}`);
  return info;
}

export async function restoreDatabase({ source, target, dryRun = false, _testHooks = {}, _lockContext = null } = {}) {
  if (!source || !target) throw new Error("Source and target paths are required for restore.");
  assertSafeDatabasePath(source, "Source");
  assertSafeDatabasePath(target, "Target");

  const sourceParent = await prepareTrustedParent(dirname(source), { create: false, label: "Source parent" });
  const canonicalSource = deriveCanonicalPath(sourceParent, source, "Source");

  if (dryRun) {
    const targetParent = await prepareTrustedParent(dirname(target), { create: false, label: "Destination parent" });
    const canonicalTarget = deriveCanonicalPath(targetParent, target, "Target");
    assertSafeDatabasePath(canonicalSource, "Source");
    assertSafeDatabasePath(canonicalTarget, "Target");
    const initial = await sourceIdentity(canonicalSource);
    const sourceReal = await realpath(canonicalSource);
    if (sourceReal !== canonicalSource) {
      throw new Error(`Source database path '${canonicalSource}' resolved to a different canonical path '${sourceReal}'. Aliases and symlinks are prohibited.`);
    }
    if (sourceReal === canonicalTarget) throw new Error("Restore source and target must differ.");
    await assertDestinationClean(canonicalTarget);
    verifySourceDatabase(canonicalSource);
    assertIdentity(await lstatMissing(canonicalSource), initial.dev, initial.ino, `Source backup identity changed during dry-run: ${canonicalSource}`);
    return { success: true, dryRun: true, source: canonicalSource, target: canonicalTarget };
  }

  const targetParent = await prepareTrustedParent(dirname(target), { create: true, label: "Destination parent" });
  const canonicalTarget = deriveCanonicalPath(targetParent, target, "Target");
  assertSafeDatabasePath(canonicalSource, "Source");
  assertSafeDatabasePath(canonicalTarget, "Target");

  const ownLocks = !_lockContext;
  const locks = await acquireMaintenanceLocks([sourceParent, targetParent], _lockContext);
  let primary = null;
  let result;
  try { result = await restoreUnderLock({ source: canonicalSource, target: canonicalTarget, targetParent, _testHooks }); } catch (error) { primary = error; }
  let release = null;
  if (ownLocks) try { await locks.release(); } catch (error) { release = error; }
  if (primary && release) throw new AggregateError([primary, release], primary.message);
  if (primary) throw primary;
  if (release) throw release;
  return result;
}

async function restoreUnderLock({ source, target, targetParent, _testHooks }) {
  const sourceInfo = await sourceIdentity(source);
  const sourceReal = await realpath(source);
  if (sourceReal !== source) {
    throw new Error(`Source database path '${source}' resolved to a different canonical path '${sourceReal}'. Aliases and symlinks are prohibited.`);
  }
  if (sourceReal === target) throw new Error("Restore source and target must differ.");
  await assertDestinationClean(target);
  verifySourceDatabase(source);
  assertIdentity(await lstatMissing(source), sourceInfo.dev, sourceInfo.ino, `Source backup identity changed during verification: ${source}`);

  const stagingDir = join(targetParent, `.restore-staging-${randomUUID()}`);
  await mkdir(stagingDir, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(stagingDir, 0o700);
  const stagingFile = join(stagingDir, "restore-staged.sqlite");
  let stagedIdentity = null;
  let published = false;
  let primary = null;
  let result;
  try {
    await _testHooks.beforeVacuum?.();
    assertIdentity(await lstatMissing(source), sourceInfo.dev, sourceInfo.ino, `Source backup identity changed before snapshot: ${source}`);
    vacuumSourceInto(source, stagingFile);
    const staged = await lstat(stagingFile);
    stagedIdentity = { dev: staged.dev, ino: staged.ino };
    assertIdentity(await lstatMissing(source), sourceInfo.dev, sourceInfo.ino, `Source backup identity changed during snapshot: ${source}`);
    await _testHooks.afterVacuum?.();
    await chmod(stagingFile, 0o600).catch((error) => { if (process.platform !== "win32") throw error; });
    verifyDatabaseIntegrity(stagingFile);
    await assertDestinationClean(target);
    await _testHooks.beforePublish?.();
    try { await link(stagingFile, target); } catch (error) {
      if (error.code === "EEXIST") throw new Error(`Target '${target}' already exists or appeared concurrently.`);
      throw error;
    }
    published = true;
    await _testHooks.afterPublish?.();
    await assertNoSidecars(target, "publication");
    assertIdentity(await lstatMissing(target), stagedIdentity.dev, stagedIdentity.ino, `Published restore target '${target}' does not match staged identity.`);
    await _testHooks.beforeFinalize?.();
    await assertNoSidecars(target, "finalization");
    assertIdentity(await lstatMissing(target), stagedIdentity.dev, stagedIdentity.ino, `Published restore target '${target}' identity changed at finalization.`);
    result = { success: true, dryRun: false, source, target };
  } catch (error) { primary = error; }
  if (!stagedIdentity) {
    const staged = await lstatMissing(stagingFile);
    if (staged) stagedIdentity = { dev: staged.dev, ino: staged.ino };
  }
  let cleanup = null;
  try { await cleanupStaging(stagingDir, stagingFile, stagedIdentity || { dev: -1, ino: -1 }); } catch (error) { cleanup = error; }
  if (primary && cleanup) throw new AggregateError([primary, cleanup], primary.message);
  if (primary) throw primary;
  if (cleanup) throw new Error(`${published ? "Restore published" : "Restore failed before publication"}, and staging cleanup failed: ${cleanup.message}`, { cause: cleanup });
  return result;
}

export function parseRestoreCliArgs(argv = process.argv.slice(2)) {
  let sourceArg, targetArg, dbType, dryRun = false, showHelp = false, positional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (positional) {
      if (!sourceArg) sourceArg = arg;
      else if (!targetArg) targetArg = arg;
      else throw new Error(`Unexpected extra argument: '${arg}'`);
    } else if (arg === "--") {
      positional = true;
    } else if (arg === "--help" || arg === "-h") {
      showHelp = true;
    } else if (arg === "--observatory" || arg === "--normalized") {
      dbType = "observatory";
    } else if (arg === "--legacy" || arg === "--checks") {
      dbType = "legacy";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--source" || arg === "--target") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("-")) throw new Error(`Option '${arg}' requires a non-empty file path value.`);
      if (arg === "--source") sourceArg = argv[++i]; else targetArg = argv[++i];
    } else if (arg.startsWith("--source=")) {
      sourceArg = arg.slice(9);
      if (!sourceArg) throw new Error("Option '--source=' requires a non-empty file path value.");
    } else if (arg.startsWith("--target=")) {
      targetArg = arg.slice(9);
      if (!targetArg) throw new Error("Option '--target=' requires a non-empty file path value.");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: '${arg}'`);
    } else if (!sourceArg) {
      sourceArg = arg;
    } else if (!targetArg) {
      targetArg = arg;
    } else {
      throw new Error(`Unexpected extra argument: '${arg}'`);
    }
  }
  return { sourceArg, targetArg, dbType, dryRun, showHelp };
}

const isMain = typeof import.meta.main === "boolean" ? import.meta.main : Boolean(process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
if (isMain) {
  try {
    const args = parseRestoreCliArgs();
    if (args.showHelp) {
      console.log("Usage: bun run scripts/db-restore.mjs [--observatory|--legacy] <backup-file> [--dry-run] [new-target]");
    } else {
      const paths = resolveRestorePaths(args);
      if (!paths.source) throw new Error("Missing backup source path.");
      const result = await restoreDatabase({ ...paths, dryRun: args.dryRun });
      console.log(result.dryRun ? `[DRY RUN] ${result.target}` : `Successfully restored database to new path: ${result.target}`);
    }
  } catch (error) {
    console.error(`Restore failed: ${error.message}`);
    process.exit(1);
  }
}
