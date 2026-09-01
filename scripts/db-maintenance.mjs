import { chmod, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

function isMissing(error) {
  return error?.code === "ENOENT";
}

async function validateDirectory(directory, label) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} '${directory}' must be a real directory, not a symlink.`);
  }
  if (process.platform !== "win32") {
    if ((info.mode & 0o022) !== 0) {
      throw new Error(`${label} '${directory}' must not be group- or world-writable.`);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new Error(`${label} '${directory}' must be owned by uid ${process.getuid()}.`);
    }
  }
  return info;
}

/** Validate an existing parent before mutation, or securely create a missing leaf parent. */
export async function prepareTrustedParent(parent, { create = true, label = "Database parent" } = {}) {
  const absolute = resolve(parent);
  let current = absolute;
  const missing = [];
  while (true) {
    try {
      await validateDirectory(current, label);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing.push(current);
      const next = dirname(current);
      if (next === current) throw error;
      current = next;
    }
  }

  if (missing.length > 0 && !create) {
    throw new Error(`${label} '${absolute}' does not exist.`);
  }
  for (const directory of missing.reverse()) {
    await mkdir(directory, { mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    await validateDirectory(directory, label);
  }
  await validateDirectory(absolute, label);
  return realpath(absolute);
}

/** Derive canonical file path within a trusted parent and reject path traversal or path separators in filename */
export function deriveCanonicalPath(trustedParent, filePath, label = "Database") {
  const fileName = basename(filePath);
  if (!fileName || fileName === "." || fileName === ".." || fileName.includes("/") || fileName.includes("\\")) {
    throw new Error(`Invalid ${label.toLowerCase()} filename: '${filePath}'.`);
  }
  return join(trustedParent, fileName);
}

/** Acquire deduplicated maintenance locks in stable canonical directory order. */
export async function acquireMaintenanceLocks(directories, existing = null) {
  const canonical = [];
  for (const directory of directories) canonical.push(await realpath(resolve(directory)));
  const requested = [...new Set(canonical)].sort();
  if (existing && requested.every((directory) => existing.directories.has(directory))) return existing;
  if (existing) throw new Error("Maintenance lock context does not cover every requested directory.");

  const entries = [];
  try {
    for (const directory of requested) {
      const lockPath = join(directory, ".agentrouter-db-maintenance.lock");
      let handle;
      try {
        handle = await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new Error(`Another database maintenance operation is in progress: ${lockPath}`);
        }
        throw error;
      }
      let identity;
      try {
        identity = await handle.stat();
      } catch (error) {
        const cleanupErrors = [];
        try { await handle.close(); } catch (cleanup) { cleanupErrors.push(cleanup); }
        try { await unlink(lockPath); } catch (cleanup) { cleanupErrors.push(cleanup); }
        if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], error.message);
        throw error;
      }
      entries.push({ directory, lockPath, handle, dev: identity.dev, ino: identity.ino });
    }
  } catch (primary) {
    const cleanup = await releaseEntries(entries);
    if (cleanup) throw new AggregateError([primary, cleanup], primary.message);
    throw primary;
  }

  return {
    directories: new Set(requested),
    async release() {
      const cleanup = await releaseEntries(entries);
      if (cleanup) throw cleanup;
    },
  };
}

async function releaseEntries(entries) {
  const errors = [];
  for (const entry of [...entries].reverse()) {
    try {
      const current = await lstat(entry.lockPath);
      if (current.dev !== entry.dev || current.ino !== entry.ino) {
        throw new Error(`Maintenance lock identity changed: ${entry.lockPath}`);
      }
      await entry.handle.close();
      await unlink(entry.lockPath);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) return null;
  return errors.length === 1 ? errors[0] : new AggregateError(errors, "Failed to release maintenance locks.");
}
