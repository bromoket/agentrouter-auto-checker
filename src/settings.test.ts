import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_AUTOMATION_SETTINGS, SettingsStore, validateAutomationSettings } from "./settings";

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
    expect((await store.load()).captureScreenshots).toBe(false);
  });

  test("uses the exported defaults when optional values are invalid", () => {
    expect(validateAutomationSettings({
      intervalMinutes: "invalid",
      endpointPollIntervalMinutes: null,
      accountDelaySeconds: undefined,
      twoFactorTimeoutMinutes: Number.NaN,
      activityLookbackDays: {},
    })).toMatchObject({
      intervalMinutes: DEFAULT_AUTOMATION_SETTINGS.intervalMinutes,
      endpointPollIntervalMinutes: DEFAULT_AUTOMATION_SETTINGS.endpointPollIntervalMinutes,
      accountDelaySeconds: DEFAULT_AUTOMATION_SETTINGS.accountDelaySeconds,
      twoFactorTimeoutMinutes: DEFAULT_AUTOMATION_SETTINGS.twoFactorTimeoutMinutes,
      activityLookbackDays: DEFAULT_AUTOMATION_SETTINGS.activityLookbackDays,
    });
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
    expect("browserHeadless" in saved).toBe(false);
  });

  test("loads the production server settings template", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentrouter-settings-test-"));
    directories.push(directory);
    const settingsPath = join(directory, "settings.json");
    await copyFile(new URL("../deploy/settings.server.example.json", import.meta.url), settingsPath);
    const settings = await new SettingsStore(settingsPath).load();

    expect(settings.schedulerEnabled).toBe(true);
    expect(settings.openDashboardOnStart).toBe(false);
    expect("browserHeadless" in settings).toBe(false);
    expect(settings.activityLookbackDays).toBe(28);
    expect(settings.captureScreenshots).toBe(false);
  });
  test("rejects captureScreenshots enabled on win32", () => {
    if (process.platform === "win32") {
      expect(() => validateAutomationSettings({ captureScreenshots: true })).toThrow(/unsupported on windows/i);
    } else {
      expect(validateAutomationSettings({ captureScreenshots: true }).captureScreenshots).toBe(true);
    }
  });
});
