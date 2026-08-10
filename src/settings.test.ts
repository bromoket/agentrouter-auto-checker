import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTOMATION_SETTINGS, SettingsStore } from "./settings";

const directories: string[] = [];

afterEach(async () => {
  while (directories.length > 0) {
    await rm(directories.pop()!, { recursive: true, force: true });
  }
});

describe("SettingsStore", () => {
  test("uses safe defaults when the settings file is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentrouter-settings-test-"));
    directories.push(directory);
    const store = new SettingsStore(join(directory, "settings.json"));
    expect(await store.load()).toEqual(DEFAULT_AUTOMATION_SETTINGS);
  });

  test("persists bounded automation settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentrouter-settings-test-"));
    directories.push(directory);
    const store = new SettingsStore(join(directory, "settings.json"));
    const saved = await store.save({
      schedulerEnabled: false,
      intervalMinutes: 1,
      accountDelaySeconds: 15,
      runOnStart: false,
      openDashboardOnStart: false,
      browserHeadless: true,
      twoFactorTimeoutMinutes: 60,
      captureScreenshots: false,
      activityLookbackDays: 14,
    });
    expect(saved.intervalMinutes).toBe(5);
    expect(saved.twoFactorTimeoutMinutes).toBe(30);
    expect(saved.activityLookbackDays).toBe(14);
    expect(await store.load()).toEqual(saved);
  });
});
