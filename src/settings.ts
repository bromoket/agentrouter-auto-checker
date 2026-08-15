import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface AutomationSettings {
  schedulerEnabled: boolean;
  intervalMinutes: number;
  endpointPollingEnabled: boolean;
  endpointPollIntervalMinutes: number;
  accountDelaySeconds: number;
  runOnStart: boolean;
  openDashboardOnStart: boolean;
  browserHeadless: boolean;
  twoFactorTimeoutMinutes: number;
  captureScreenshots: boolean;
  activityLookbackDays: number;
}

interface SettingsFile {
  version: 1;
  automation: AutomationSettings;
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  schedulerEnabled: true,
  intervalMinutes: 60,
  endpointPollingEnabled: true,
  endpointPollIntervalMinutes: 1,
  accountDelaySeconds: 5,
  runOnStart: false,
  openDashboardOnStart: true,
  browserHeadless: false,
  twoFactorTimeoutMinutes: 5,
  captureScreenshots: true,
  activityLookbackDays: 7,
};

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, parsed));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function validateAutomationSettings(value: unknown): AutomationSettings {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  return {
    schedulerEnabled: booleanValue(
      candidate.schedulerEnabled,
      DEFAULT_AUTOMATION_SETTINGS.schedulerEnabled,
    ),
    intervalMinutes: boundedInteger(candidate.intervalMinutes, 60, 5, 10_080),
    endpointPollingEnabled: booleanValue(
      candidate.endpointPollingEnabled,
      DEFAULT_AUTOMATION_SETTINGS.endpointPollingEnabled,
    ),
    endpointPollIntervalMinutes: boundedInteger(
      candidate.endpointPollIntervalMinutes,
      DEFAULT_AUTOMATION_SETTINGS.endpointPollIntervalMinutes,
      1,
      1_440,
    ),
    accountDelaySeconds: boundedInteger(candidate.accountDelaySeconds, 5, 0, 3_600),
    runOnStart: booleanValue(candidate.runOnStart, DEFAULT_AUTOMATION_SETTINGS.runOnStart),
    openDashboardOnStart: booleanValue(
      candidate.openDashboardOnStart,
      DEFAULT_AUTOMATION_SETTINGS.openDashboardOnStart,
    ),
    browserHeadless: booleanValue(
      candidate.browserHeadless,
      DEFAULT_AUTOMATION_SETTINGS.browserHeadless,
    ),
    twoFactorTimeoutMinutes: boundedInteger(candidate.twoFactorTimeoutMinutes, 5, 1, 30),
    captureScreenshots: booleanValue(
      candidate.captureScreenshots,
      DEFAULT_AUTOMATION_SETTINGS.captureScreenshots,
    ),
    activityLookbackDays: boundedInteger(candidate.activityLookbackDays, 7, 1, 28),
  };
}

export class SettingsStore {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<AutomationSettings> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Settings file must contain an object.");
      }
      const file = parsed as Partial<SettingsFile>;
      if (file.version !== 1) {
        throw new Error("Unsupported settings file version.");
      }
      return validateAutomationSettings(file.automation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...DEFAULT_AUTOMATION_SETTINGS };
      }
      throw new Error(
        `Unable to load automation settings from ${this.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async save(value: unknown): Promise<AutomationSettings> {
    const automation = validateAutomationSettings(value);
    const file: SettingsFile = { version: 1, automation };
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8" });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return automation;
  }
}
