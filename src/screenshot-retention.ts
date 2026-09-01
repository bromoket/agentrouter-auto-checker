import { chmod, lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { open, type FileHandle } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

export const DEFAULT_SCREENSHOT_RETENTION_DAYS = 14;
export const DEFAULT_SCREENSHOT_RETENTION_MS = DEFAULT_SCREENSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const DEFAULT_SCREENSHOT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const SCREENSHOT_FILENAME_PATTERN = /^[A-Za-z0-9._-]+\.png$/;

export function isValidScreenshotFilename(filename: string): boolean {
  if (typeof filename !== "string" || filename.length === 0 || filename.length > 255) {
    return false;
  }
  if (basename(filename) !== filename) {
    return false;
  }
  if (!filename.endsWith(".png") || filename === ".png") {
    return false;
  }
  return SCREENSHOT_FILENAME_PATTERN.test(filename);
}

export function isPathContained(baseDir: string, targetPath: string): boolean {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  const baseWithSep = resolvedBase.endsWith(sep) ? resolvedBase : `${resolvedBase}${sep}`;
  if (process.platform === "win32") {
    return resolvedTarget.toLowerCase().startsWith(baseWithSep.toLowerCase());
  }
  return resolvedTarget.startsWith(baseWithSep);
}

export function getScreenshotTimestamp(filename: string, stats: { mtimeMs: number }): number {
  const match = filename.match(/(?:^|[-_])(\d{9,15})\.png$/);
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      const inMs = parsed < 1e11 ? parsed * 1000 : parsed;
      return inMs;
    }
  }
  return stats.mtimeMs;
}

export async function validateAncestors(targetPath: string): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("Screenshot operations are unsupported on Windows.");
  }

  const resolved = resolve(targetPath);
  const segments: string[] = [];
  let current = resolved;
  while (current && current !== "/" && current !== dirname(current)) {
    segments.unshift(current);
    current = dirname(current);
  }
  segments.unshift("/");

  for (const segment of segments) {
    try {
      const stats = await lstat(segment);
      if (stats.isSymbolicLink()) {
        throw new Error(`Screenshot path ancestor is a symbolic link: ${segment}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Screenshot path ancestor is not a directory: ${segment}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
}

export interface PruneScreenshotsOptions {
  retentionMs?: number;
  retentionDays?: number;
  now?: number;
  pinned?: Iterable<string>;
  dryRun?: boolean;
}

export interface PruneScreenshotsResult {
  examinedCount: number;
  prunedCount: number;
  skippedPinnedCount: number;
  skippedSymlinkCount: number;
  skippedInvalidCount: number;
  skippedNonPngCount: number;
  skippedRecentCount: number;
  prunedFiles: string[];
}

export class SecureScreenshotRoot {
  constructor(
    readonly handle: FileHandle,
    readonly rootPath: string,
    readonly dev: number,
    readonly ino: number,
  ) {}

  private leafFdPath(filename: string): string {
    const procPath = `/proc/self/fd/${this.handle.fd}/${filename}`;
    if (existsSync("/proc/self/fd")) {
      return procPath;
    }
    return resolve(this.rootPath, filename);
  }

  async verifyRootIdentity(): Promise<void> {
    const stats = await this.handle.stat();
    if (stats.dev !== this.dev || stats.ino !== this.ino) {
      throw new Error(`Screenshot root directory identity changed: ${this.rootPath}`);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Screenshot root path is not a directory or is a symbolic link: ${this.rootPath}`);
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error(`Screenshot root owner UID (${stats.uid}) does not match process UID (${process.getuid()}).`);
    }
    if ((stats.mode & 0o777) !== 0o700) {
      throw new Error(`Screenshot root directory mode must be strictly 0700; got ${(stats.mode & 0o777).toString(8)}.`);
    }
  }

  async saveScreenshot(filename: string, buffer: Uint8Array | Buffer): Promise<string> {
    if (!isValidScreenshotFilename(filename)) {
      throw new Error(`Invalid screenshot filename: ${filename}`);
    }
    await this.verifyRootIdentity();

    const targetFdPath = this.leafFdPath(filename);
    const finalPublishedPath = resolve(this.rootPath, filename);

    const fileHandle = await open(
      targetFdPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );

    try {
      const stats = await fileHandle.stat();
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`Target is not a regular file: ${finalPublishedPath}`);
      }
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
        throw new Error(`Target owner does not match process UID: ${finalPublishedPath}`);
      }
      if (stats.dev !== this.dev) {
        throw new Error(`Target resides on unexpected filesystem device: ${finalPublishedPath}`);
      }
      if ((stats.mode & 0o777) !== 0o600) {
        throw new Error(`Target file mode must be strictly 0600; got ${(stats.mode & 0o777).toString(8)}.`);
      }

      await fileHandle.writeFile(buffer);
      return finalPublishedPath;
    } catch (error) {
      try {
        await unlink(targetFdPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw unlinkError;
        }
      }
      throw error;
    } finally {
      await fileHandle.close();
    }
  }

  async openScreenshot(filename: string): Promise<FileHandle> {
    if (!isValidScreenshotFilename(filename)) {
      throw new Error(`Invalid screenshot filename: ${filename}`);
    }
    await this.verifyRootIdentity();

    const targetFdPath = this.leafFdPath(filename);
    const fileHandle = await open(targetFdPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);

    try {
      const stats = await fileHandle.stat();
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`Target is not a regular file: ${filename}`);
      }
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
        throw new Error(`Target file owner does not match process UID: ${filename}`);
      }
      if (stats.dev !== this.dev) {
        throw new Error(`Target resides on unexpected device: ${filename}`);
      }
      return fileHandle;
    } catch (error) {
      await fileHandle.close();
      throw error;
    }
  }

  async readScreenshot(filename: string): Promise<Buffer> {
    const fileHandle = await this.openScreenshot(filename);
    try {
      return await fileHandle.readFile();
    } finally {
      await fileHandle.close();
    }
  }

  async deleteAccountScreenshots(accountId: string): Promise<number> {
    await this.verifyRootIdentity();
    const prefix = `${accountId}-`;
    let entries;
    try {
      entries = await readdir(this.rootPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }

    let deleted = 0;
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(".png")) {
        continue;
      }
      const targetFdPath = this.leafFdPath(entry.name);
      try {
        await unlink(targetFdPath);
        deleted++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return deleted;
  }

  async prune(options?: PruneScreenshotsOptions): Promise<PruneScreenshotsResult> {
    const result: PruneScreenshotsResult = {
      examinedCount: 0,
      prunedCount: 0,
      skippedPinnedCount: 0,
      skippedSymlinkCount: 0,
      skippedInvalidCount: 0,
      skippedNonPngCount: 0,
      skippedRecentCount: 0,
      prunedFiles: [],
    };

    await this.verifyRootIdentity();

    const retentionMs = options?.retentionMs ?? (
      options?.retentionDays !== undefined
        ? options.retentionDays * 86_400_000
        : DEFAULT_SCREENSHOT_RETENTION_MS
    );
    const now = options?.now ?? Date.now();
    const cutoff = now - retentionMs;

    const pinnedSet = new Set<string>();
    if (options?.pinned) {
      for (const item of options.pinned) {
        if (typeof item === "string" && item.trim()) {
          const trimmed = item.trim();
          pinnedSet.add(trimmed);
          pinnedSet.add(basename(trimmed));
          pinnedSet.add(trimmed.replace(/\.png$/i, ""));
        }
      }
    }

    let entries;
    try {
      entries = await readdir(this.rootPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return result;
      }
      throw error;
    }

    for (const entry of entries) {
      result.examinedCount++;

      if (entry.isSymbolicLink()) {
        result.skippedSymlinkCount++;
        continue;
      }

      if (!isValidScreenshotFilename(entry.name)) {
        if (entry.name.endsWith(".png")) {
          result.skippedInvalidCount++;
        } else {
          result.skippedNonPngCount++;
        }
        continue;
      }

      if (pinnedSet.has(entry.name) || pinnedSet.has(resolve(this.rootPath, entry.name)) || pinnedSet.has(entry.name.replace(/\.png$/i, ""))) {
        result.skippedPinnedCount++;
        continue;
      }

      const targetFdPath = this.leafFdPath(entry.name);
      let stats;
      try {
        stats = await lstat(targetFdPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw error;
      }

      if (stats.isSymbolicLink()) {
        result.skippedSymlinkCount++;
        continue;
      }
      if (!stats.isFile() || stats.dev !== this.dev) {
        result.skippedInvalidCount++;
        continue;
      }
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
        result.skippedInvalidCount++;
        continue;
      }

      const timestamp = getScreenshotTimestamp(entry.name, stats);
      if (timestamp >= cutoff) {
        result.skippedRecentCount++;
        continue;
      }

      if (!options?.dryRun) {
        try {
          await unlink(targetFdPath);
          result.prunedCount++;
          result.prunedFiles.push(resolve(this.rootPath, entry.name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
      } else {
        result.prunedCount++;
        result.prunedFiles.push(resolve(this.rootPath, entry.name));
      }
    }

    return result;
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

export async function openSecureScreenshotRoot(
  directoryPath: string,
  options?: { createIfMissing?: boolean },
): Promise<SecureScreenshotRoot> {
  if (process.platform === "win32") {
    throw new Error("Screenshot operations are unsupported on Windows.");
  }

  const resolved = resolve(directoryPath);
  await validateAncestors(resolved);

  if (options?.createIfMissing) {
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    await chmod(resolved, 0o700);
  }

  const rootStatsBefore = await lstat(resolved);
  if (rootStatsBefore.isSymbolicLink()) {
    throw new Error(`Screenshot root directory must not be a symbolic link: ${resolved}`);
  }
  if (!rootStatsBefore.isDirectory()) {
    throw new Error(`Screenshot root path is not a directory: ${resolved}`);
  }

  const handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  const handleStats = await handle.stat();

  if (handleStats.dev !== rootStatsBefore.dev || handleStats.ino !== rootStatsBefore.ino) {
    await handle.close();
    throw new Error(`Screenshot root identity changed during open: ${resolved}`);
  }
  if (handleStats.isSymbolicLink() || !handleStats.isDirectory()) {
    await handle.close();
    throw new Error(`Screenshot root is not a directory: ${resolved}`);
  }
  if (typeof process.getuid === "function" && handleStats.uid !== process.getuid()) {
    await handle.close();
    throw new Error(`Screenshot root owner UID (${handleStats.uid}) does not match process UID (${process.getuid()}).`);
  }
  if ((handleStats.mode & 0o777) !== 0o700) {
    await handle.close();
    throw new Error(`Screenshot root directory mode must be strictly 0700; got ${(handleStats.mode & 0o777).toString(8)}.`);
  }

  return new SecureScreenshotRoot(handle, resolved, handleStats.dev, handleStats.ino);
}

export async function ensureSecureScreenshotDirectory(directoryPath: string): Promise<SecureScreenshotRoot> {
  return await openSecureScreenshotRoot(directoryPath, { createIfMissing: true });
}

export async function deleteAccountScreenshots(
  screenshotDir: string,
  accountId: string,
): Promise<number> {
  if (process.platform === "win32") {
    return 0;
  }
  let root: SecureScreenshotRoot;
  try {
    root = await openSecureScreenshotRoot(screenshotDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  try {
    return await root.deleteAccountScreenshots(accountId);
  } finally {
    await root.close();
  }
}

export async function readSecureScreenshotFile(
  screenshotDir: string,
  filename: string,
): Promise<Buffer> {
  if (process.platform === "win32") {
    throw new Error("Screenshot serving is unsupported on Windows.");
  }
  const root = await openSecureScreenshotRoot(screenshotDir);
  try {
    return await root.readScreenshot(filename);
  } finally {
    await root.close();
  }
}

export async function pruneScreenshots(
  screenshotDir: string,
  options?: PruneScreenshotsOptions,
): Promise<PruneScreenshotsResult> {
  if (process.platform === "win32") {
    return {
      examinedCount: 0,
      prunedCount: 0,
      skippedPinnedCount: 0,
      skippedSymlinkCount: 0,
      skippedInvalidCount: 0,
      skippedNonPngCount: 0,
      skippedRecentCount: 0,
      prunedFiles: [],
    };
  }
  let root: SecureScreenshotRoot;
  try {
    root = await openSecureScreenshotRoot(screenshotDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        examinedCount: 0,
        prunedCount: 0,
        skippedPinnedCount: 0,
        skippedSymlinkCount: 0,
        skippedInvalidCount: 0,
        skippedNonPngCount: 0,
        skippedRecentCount: 0,
        prunedFiles: [],
      };
    }
    throw error;
  }
  try {
    return await root.prune(options);
  } finally {
    await root.close();
  }
}

export interface ScreenshotRetentionConfig {
  screenshotDir: string;
  retentionDays?: number;
  retentionMs?: number;
  intervalMs?: number;
  getPinnedScreenshots?: () => Promise<Iterable<string>> | Iterable<string>;
}

export class ScreenshotRetentionManager {
  private isPruning = false;
  private timer: NodeJS.Timeout | number | null = null;
  private root: SecureScreenshotRoot | null = null;
  private readonly screenshotDir: string;
  private readonly retentionMs: number;
  private readonly intervalMs: number;
  private readonly getPinnedScreenshots?: () => Promise<Iterable<string>> | Iterable<string>;

  constructor(config: ScreenshotRetentionConfig) {
    this.screenshotDir = config.screenshotDir;
    this.retentionMs = config.retentionMs ?? (
      config.retentionDays !== undefined
        ? config.retentionDays * 86_400_000
        : DEFAULT_SCREENSHOT_RETENTION_MS
    );
    this.intervalMs = config.intervalMs ?? DEFAULT_SCREENSHOT_PRUNE_INTERVAL_MS;
    this.getPinnedScreenshots = config.getPinnedScreenshots;
  }

  get running(): boolean {
    return this.isPruning;
  }

  get schedulerActive(): boolean {
    return this.timer !== null;
  }

  async getRoot(): Promise<SecureScreenshotRoot> {
    if (!this.root) {
      this.root = await openSecureScreenshotRoot(this.screenshotDir, { createIfMissing: true });
    }
    return this.root;
  }

  async pruneOnce(options?: Partial<PruneScreenshotsOptions>): Promise<PruneScreenshotsResult> {
    if (process.platform === "win32") {
      return {
        examinedCount: 0,
        prunedCount: 0,
        skippedPinnedCount: 0,
        skippedSymlinkCount: 0,
        skippedInvalidCount: 0,
        skippedNonPngCount: 0,
        skippedRecentCount: 0,
        prunedFiles: [],
      };
    }
    if (this.isPruning) {
      return {
        examinedCount: 0,
        prunedCount: 0,
        skippedPinnedCount: 0,
        skippedSymlinkCount: 0,
        skippedInvalidCount: 0,
        skippedNonPngCount: 0,
        skippedRecentCount: 0,
        prunedFiles: [],
      };
    }
    this.isPruning = true;
    try {
      const root = await this.getRoot();
      const pinned = options?.pinned ?? (this.getPinnedScreenshots ? await this.getPinnedScreenshots() : undefined);
      return await root.prune({
        retentionMs: this.retentionMs,
        pinned,
        ...options,
      });
    } finally {
      this.isPruning = false;
    }
  }

  startScheduler(): void {
    if (process.platform === "win32") return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pruneOnce().catch((error) => {
        console.error(`Screenshot retention prune error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async close(): Promise<void> {
    this.stopScheduler();
    if (this.root) {
      await this.root.close();
      this.root = null;
    }
  }
}
