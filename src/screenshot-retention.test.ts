import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  DEFAULT_SCREENSHOT_RETENTION_DAYS,
  DEFAULT_SCREENSHOT_RETENTION_MS,
  deleteAccountScreenshots,
  ensureSecureScreenshotDirectory,
  getScreenshotTimestamp,
  isPathContained,
  isValidScreenshotFilename,
  openSecureScreenshotRoot,
  pruneScreenshots,
  readSecureScreenshotFile,
  ScreenshotRetentionManager,
  validateAncestors,
} from "./screenshot-retention";
import { validateAutomationSettings } from "./settings";

const temporaryDirectories: string[] = [];

async function createTempDirectory(prefix = "agentrouter-retention-test-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  let canonical = directory;
  try {
    canonical = await realpath(directory);
  } catch {
    // ignore
  }
  temporaryDirectories.push(canonical);
  return canonical;
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = resolve(temporaryDirectories.pop()!);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("Screenshot filename & containment validation", () => {
  test("validates screenshot filename format", () => {
    expect(isValidScreenshotFilename("account-failure-1725148800000.png")).toBe(true);
    expect(isValidScreenshotFilename("user_123-1725148800000.png")).toBe(true);
    expect(isValidScreenshotFilename("failure-screenshot.png")).toBe(true);
    expect(isValidScreenshotFilename("simple.png")).toBe(true);
    expect(isValidScreenshotFilename("a.png")).toBe(true);

    expect(isValidScreenshotFilename("")).toBe(false);
    expect(isValidScreenshotFilename("image.jpg")).toBe(false);
    expect(isValidScreenshotFilename("notes.txt")).toBe(false);
    expect(isValidScreenshotFilename(".png")).toBe(false);
    expect(isValidScreenshotFilename("../escape.png")).toBe(false);
    expect(isValidScreenshotFilename("sub/dir.png")).toBe(false);
    expect(isValidScreenshotFilename("bad;name.png")).toBe(false);
    expect(isValidScreenshotFilename("bad name with spaces.png")).toBe(false);
  });

  test("validates directory containment and traversal resistance", async () => {
    const root = await createTempDirectory();
    const sub = join(root, "screenshots");
    await mkdir(sub, { recursive: true });

    expect(isPathContained(sub, join(sub, "test.png"))).toBe(true);
    expect(isPathContained(sub, join(sub, "nested", "test.png"))).toBe(true);
    expect(isPathContained(sub, join(root, "outside.png"))).toBe(false);
    expect(isPathContained(sub, join(sub, "..", "outside.png"))).toBe(false);
    expect(isPathContained(sub, join(tmpdir(), "other.png"))).toBe(false);
  });

  test("extracts timestamps from filenames and falls back to stats mtime", () => {
    const stats = { mtimeMs: 1700000000000 };

    expect(getScreenshotTimestamp("acc-failure-1725148800000.png", stats)).toBe(1725148800000);
    expect(getScreenshotTimestamp("acc-1725148800.png", stats)).toBe(1725148800000);
    expect(getScreenshotTimestamp("no-timestamp.png", stats)).toBe(1700000000000);
  });
});

describe("Windows platform rejection", () => {
  test("rejects enabling screenshot capture on win32", () => {
    if (process.platform === "win32") {
      expect(() => validateAutomationSettings({ captureScreenshots: true })).toThrow(/unsupported on windows/i);
      expect(validateAutomationSettings({ captureScreenshots: false }).captureScreenshots).toBe(false);
      expect(validateAutomationSettings({}).captureScreenshots).toBe(false);
    }
  });

  test("rejects screenshot root operations on win32", async () => {
    if (process.platform === "win32") {
      await expect(validateAncestors("C:\\test")).rejects.toThrow(/unsupported on windows/i);
      await expect(openSecureScreenshotRoot("C:\\test")).rejects.toThrow(/unsupported on windows/i);
      await expect(readSecureScreenshotFile("C:\\test", "test.png")).rejects.toThrow(/unsupported on windows/i);
      await expect(deleteAccountScreenshots("C:\\test", "acc")).resolves.toBe(0);
      const pruneRes = await pruneScreenshots("C:\\test");
      expect(pruneRes.prunedCount).toBe(0);
    }
  });
});

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("POSIX secure root validation & ancestor walking", () => {
  test("validates and walks ancestor directories rejecting symlinks", async () => {
    const root = await createTempDirectory();
    const realDir = join(root, "real");
    const linkDir = join(root, "link");
    const child = join(linkDir, "child");
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, linkDir);

    await expect(validateAncestors(child)).rejects.toThrow(/symbolic link/i);
    await expect(openSecureScreenshotRoot(child)).rejects.toThrow(/symbolic link/i);
  });

  test("requires root directory mode to be strictly 0700", async () => {
    const root = await createTempDirectory();
    const sub = join(root, "screenshots");
    await mkdir(sub, { mode: 0o755 });
    await chmod(sub, 0o755);

    await expect(openSecureScreenshotRoot(sub)).rejects.toThrow(/strictly 0700/i);

    // Correcting mode to 0700 allows opening
    await chmod(sub, 0o700);
    const secureRoot = await openSecureScreenshotRoot(sub);
    expect(secureRoot.rootPath).toBe(resolve(sub));
    await secureRoot.close();
  });

  test("rejects root replacement after opening", async () => {
    const root = await createTempDirectory();
    const sub = join(root, "screenshots");
    const secureRoot = await ensureSecureScreenshotDirectory(sub);

    // Verify identity passes
    await expect(secureRoot.verifyRootIdentity()).resolves.toBeUndefined();

    await secureRoot.close();
  });
});

describePosix("POSIX handle-relative operations & exclusive capture", () => {
  test("saves screenshot via handle-relative exclusive create with mode 0600", async () => {
    const root = await createTempDirectory();
    const sub = join(root, "screenshots");
    const secureRoot = await ensureSecureScreenshotDirectory(sub);

    const filename = "account1-failure-1725148800000.png";
    const buffer = Buffer.from("png-screenshot-bytes");
    const savedPath = await secureRoot.saveScreenshot(filename, buffer);

    expect(savedPath).toBe(resolve(sub, filename));
    const savedBytes = await secureRoot.readScreenshot(filename);
    expect(savedBytes.toString()).toBe("png-screenshot-bytes");

    const stats = await lstat(savedPath);
    expect(stats.mode & 0o777).toBe(0o600);
    if (typeof process.getuid === "function") {
      expect(stats.uid).toBe(process.getuid());
    }

    await secureRoot.close();
  });

  test("fails closed with exclusive write when target file or symlink pre-exists", async () => {
    const root = await createTempDirectory();
    const sub = join(root, "screenshots");
    const secureRoot = await ensureSecureScreenshotDirectory(sub);

    const filename = "account1-failure-1725148800000.png";
    const preplacedPath = join(sub, filename);
    await writeFile(preplacedPath, "preplaced-data");

    await expect(secureRoot.saveScreenshot(filename, Buffer.from("new-data"))).rejects.toThrow();

    // Verify preplaced content was not overwritten
    expect(await readFile(preplacedPath, "utf8")).toBe("preplaced-data");

    await secureRoot.close();
  });

  test("fails closed when target is a preplaced symlink", async () => {
    const root = await createTempDirectory();
    const sub = join(root, "screenshots");
    const secureRoot = await ensureSecureScreenshotDirectory(sub);

    const outsideTarget = join(root, "outside.txt");
    await writeFile(outsideTarget, "outside-secret");

    const filename = "account1-failure-1725148800000.png";
    const linkPath = join(sub, filename);
    await symlink(outsideTarget, linkPath);

    await expect(secureRoot.saveScreenshot(filename, Buffer.from("new-data"))).rejects.toThrow();
    expect(await readFile(outsideTarget, "utf8")).toBe("outside-secret");

    await secureRoot.close();
  });
});

describePosix("Screenshot retention boundary & pruning", () => {
  test("prunes unpinned PNGs older than retention and keeps recent ones at exact boundary", async () => {
    const dir = await createTempDirectory();
    const sub = join(dir, "screenshots");
    const secureRoot = await ensureSecureScreenshotDirectory(sub);

    const now = 1_725_000_000_000;
    const retentionMs = 14 * 24 * 60 * 60 * 1000;
    const cutoff = now - retentionMs;

    // Expired by 1ms
    const expiredTime = cutoff - 1;
    await secureRoot.saveScreenshot(`account-failure-${expiredTime}.png`, Buffer.from("png-data"));

    // Exact cutoff time (should be kept because age == retention)
    await secureRoot.saveScreenshot(`account-failure-${cutoff}.png`, Buffer.from("png-data"));

    // Recent by 1ms
    const recentTime = cutoff + 1;
    await secureRoot.saveScreenshot(`account-failure-${recentTime}.png`, Buffer.from("png-data"));

    // Brand new file
    await secureRoot.saveScreenshot(`account-failure-${now}.png`, Buffer.from("png-data"));

    const result = await secureRoot.prune({ now, retentionMs });

    expect(result.examinedCount).toBe(4);
    expect(result.prunedCount).toBe(1);
    expect(result.skippedRecentCount).toBe(3);

    // Verify filesystem state
    expect(await lstat(join(sub, `account-failure-${expiredTime}.png`)).catch(() => null)).toBeNull();
    expect(await lstat(join(sub, `account-failure-${cutoff}.png`)).catch(() => null)).not.toBeNull();
    expect(await lstat(join(sub, `account-failure-${recentTime}.png`)).catch(() => null)).not.toBeNull();
    expect(await lstat(join(sub, `account-failure-${now}.png`)).catch(() => null)).not.toBeNull();

    await secureRoot.close();
  });

  test("never touches non-PNG files or symlinks during prune", async () => {
    const dir = await createTempDirectory();
    const sub = join(dir, "screenshots");
    const secureRoot = await ensureSecureScreenshotDirectory(sub);

    const textPath = join(sub, "notes-1000000000000.txt");
    await writeFile(textPath, "important");

    const outsidePath = join(dir, "outside.png");
    await writeFile(outsidePath, "outside");
    const linkPath = join(sub, "link-1000000000000.png");
    await symlink(outsidePath, linkPath);

    const result = await secureRoot.prune({ now: 2_000_000_000_000, retentionMs: 1000 });

    expect(result.prunedCount).toBe(0);
    expect(result.skippedNonPngCount).toBe(1);
    expect(result.skippedSymlinkCount).toBe(1);

    expect(await readFile(textPath, "utf8")).toBe("important");
    expect(await readFile(outsidePath, "utf8")).toBe("outside");

    await secureRoot.close();
  });

  test("preserves expired screenshots when pinned", async () => {
    const dir = await createTempDirectory();
    const sub = join(dir, "screenshots");
    const secureRoot = await ensureSecureScreenshotDirectory(sub);

    const now = 1_725_000_000_000;
    const cutoff = now - 14 * 86_400_000;

    const pinnedFilename = `pinned-account-failure-${cutoff - 100_000}.png`;
    await secureRoot.saveScreenshot(pinnedFilename, Buffer.from("pinned-data"));

    const unpinnedFilename = `unpinned-account-failure-${cutoff - 100_000}.png`;
    await secureRoot.saveScreenshot(unpinnedFilename, Buffer.from("unpinned-data"));

    const result = await secureRoot.prune({
      now,
      retentionMs: 14 * 86_400_000,
      pinned: [pinnedFilename],
    });

    expect(result.prunedCount).toBe(1);
    expect(result.skippedPinnedCount).toBe(1);

    expect(await lstat(join(sub, pinnedFilename)).catch(() => null)).not.toBeNull();
    expect(await lstat(join(sub, unpinnedFilename)).catch(() => null)).toBeNull();

    await secureRoot.close();
  });

  test("handles concurrent unlinking race idempotently during prune and delete", async () => {
    const dir = await createTempDirectory();
    const sub = join(dir, "screenshots");
    const secureRoot = await ensureSecureScreenshotDirectory(sub);

    const file1 = "acc1-failure-1000000000000.png";
    const file2 = "acc1-1000000000000.png";
    await secureRoot.saveScreenshot(file1, Buffer.from("data"));
    await secureRoot.saveScreenshot(file2, Buffer.from("data"));

    // First deletion removes them
    const deleted = await secureRoot.deleteAccountScreenshots("acc1");
    expect(deleted).toBe(2);

    // Subsequent call is idempotent and returns 0 without error
    expect(await secureRoot.deleteAccountScreenshots("acc1")).toBe(0);

    // Prune on empty directory completes cleanly
    const pruneRes = await secureRoot.prune();
    expect(pruneRes.prunedCount).toBe(0);

    await secureRoot.close();
  });
});

describePosix("ScreenshotRetentionManager lifecycle", () => {
  test("guards against concurrent execution overlap", async () => {
    const dir = await createTempDirectory();
    const sub = join(dir, "screenshots");
    const manager = new ScreenshotRetentionManager({ screenshotDir: sub });

    const root = await manager.getRoot();
    await root.saveScreenshot("expired-1000000000000.png", Buffer.from("data"));

    const firstPrunePromise = manager.pruneOnce({
      now: 2_000_000_000_000,
      retentionMs: 1000,
    });

    const secondPruneResult = await manager.pruneOnce();

    expect(secondPruneResult.examinedCount).toBe(0);
    expect(secondPruneResult.prunedCount).toBe(0);

    const firstResult = await firstPrunePromise;
    expect(firstResult.prunedCount).toBe(1);

    await manager.close();
  });

  test("starts and stops scheduler cleanly", async () => {
    const dir = await createTempDirectory();
    const sub = join(dir, "screenshots");
    const manager = new ScreenshotRetentionManager({
      screenshotDir: sub,
      intervalMs: 50_000,
    });

    expect(manager.schedulerActive).toBe(false);
    manager.startScheduler();
    expect(manager.schedulerActive).toBe(true);
    manager.stopScheduler();
    expect(manager.schedulerActive).toBe(false);

    await manager.close();
  });
});
