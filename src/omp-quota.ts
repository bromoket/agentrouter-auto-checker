import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { OmpQuotaConfig } from "./config";
import type { TelegramNotifier } from "./telegram";

export interface OmpUsageReportLimitAmount {
  used?: number;
  limit?: number;
  remaining?: number;
  usedFraction?: number;
  remainingFraction?: number;
  unit?: string;
}

export interface OmpUsageReportLimitWindow {
  id?: string;
  label?: string;
  durationMs?: number;
  resetsAt?: number | string;
}

export interface OmpUsageReportLimitScope {
  provider?: string;
  windowId?: string;
  shared?: boolean;
  accountId?: string;
  tier?: string;
  modelId?: string;
}

export interface OmpUsageReportLimit {
  id?: string;
  label?: string;
  scope?: OmpUsageReportLimitScope;
  window?: OmpUsageReportLimitWindow;
  amount?: OmpUsageReportLimitAmount;
  status?: string;
}

export interface OmpUsageReport {
  provider: string;
  fetchedAt?: number | string;
  limits?: OmpUsageReportLimit[];
  resetCredits?: {
    availableCount?: number;
  };
  metadata?: Record<string, unknown>;
}

export interface OmpUsageResponse {
  generatedAt?: number | string;
  reports?: OmpUsageReport[];
  accountsWithoutUsage?: unknown[];
  disabledCredentials?: unknown[];
  capacity?: Record<string, unknown>;
}

export interface OmpQuotaObservation {
  provider: "openai-codex";
  usedFraction: number;
  remainingPct: number;
  resetAt: string;
  observedAt: string;
  resetCredits?: number;
}

export interface OmpQuotaState {
  lastResetAt: string | null;
  lastNotifiedResetAt: string | null;
  lowQuotaActive: boolean;
  consecutiveFailures: number;
  failureAlertSent: boolean;
  lastObservedAt: string | null;
  lastRemainingPct: number | null;
  lastUsedFraction: number | null;
  lastResetCredits?: number | null;
  updatedAt: string;
}

export type OmpQuotaTransitionEvent =
  | {
      type: "reset";
      observation: OmpQuotaObservation;
      previousResetAt: string;
    }
  | {
      type: "low_remaining";
      observation: OmpQuotaObservation;
      thresholdPct: number;
    }
  | {
      type: "repeated_failure";
      consecutiveFailures: number;
      errorCategory: string;
    }
  | {
      type: "recovery";
      observation: OmpQuotaObservation;
      previousFailures: number;
    };

export function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

export function parseTimestamp(val: unknown): number {
  if (typeof val === "number" && Number.isFinite(val)) {
    return val < 10_000_000_000 ? val * 1_000 : val;
  }
  if (typeof val === "string" && val.trim().length > 0) {
    const trimmed = val.trim();
    if (/^\d+$/.test(trimmed)) {
      const num = Number(trimmed);
      return num < 10_000_000_000 ? num * 1_000 : num;
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return NaN;
}

export function parseOmpUsageResponse(
  raw: unknown,
  options: { now?: number; maxStaleMs?: number } = {},
): OmpQuotaObservation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid OMP usage payload: root is not an object.");
  }

  const response = raw as OmpUsageResponse;
  const reports = response.reports;
  if (!Array.isArray(reports)) {
    throw new Error("Invalid OMP usage payload: reports array is missing.");
  }

  const codexReport = reports.find((r) => r && r.provider === "openai-codex");
  if (!codexReport) {
    throw new Error("No openai-codex report found in OMP usage output.");
  }

  const now = options.now ?? Date.now();
  const maxStaleMs = options.maxStaleMs ?? 15 * 60 * 1_000;
  const rawObserved = response.generatedAt ?? codexReport.fetchedAt;
  const observedMs = parseTimestamp(rawObserved);

  if (Number.isNaN(observedMs)) {
    throw new Error("Missing or malformed observation timestamp.");
  }
  if (observedMs > now + 60_000) {
    throw new Error("Observation timestamp is in the future.");
  }
  if (observedMs < now - maxStaleMs) {
    throw new Error("Observation timestamp is stale.");
  }

  const limits = codexReport.limits;
  if (!Array.isArray(limits) || limits.length === 0) {
    throw new Error("No limits found in openai-codex report.");
  }

  const weeklyLimit = limits.find((limit) => {
    if (!limit) return false;
    if (limit.id === "openai-codex:primary") return true;
    const windowId = limit.window?.id || limit.scope?.windowId;
    const isWeekly = windowId === "7d" || limit.label?.toLowerCase().includes("7 day");
    const isSpark = limit.scope?.tier === "spark" || limit.id?.includes("spark");
    return isWeekly && !isSpark;
  });

  if (!weeklyLimit) {
    throw new Error("Weekly openai-codex limit window not found in report.");
  }

  const rawResetsAt = weeklyLimit.window?.resetsAt;
  const resetsAtMs = parseTimestamp(rawResetsAt);
  if (Number.isNaN(resetsAtMs)) {
    throw new Error("Missing or malformed reset timestamp.");
  }
  if (resetsAtMs < observedMs - 60_000) {
    throw new Error("Reset timestamp is in the past relative to observation.");
  }
  if (resetsAtMs > observedMs + 14 * 24 * 60 * 60 * 1_000) {
    throw new Error("Reset timestamp is unreasonably far in the future.");
  }

  const amount = weeklyLimit.amount;
  if (!amount || typeof amount !== "object") {
    throw new Error("Missing amount in weekly limit.");
  }

  let usedFraction: number;
  if (typeof amount.usedFraction === "number" && Number.isFinite(amount.usedFraction)) {
    usedFraction = amount.usedFraction;
  } else if (typeof amount.used === "number" && typeof amount.limit === "number" && amount.limit > 0) {
    usedFraction = amount.used / amount.limit;
  } else {
    throw new Error("Missing or malformed usedFraction in weekly limit amount.");
  }

  if (usedFraction < 0 || usedFraction > 1) {
    throw new Error("usedFraction out of range [0, 1].");
  }

  let remainingPct: number;
  if (typeof amount.remainingFraction === "number" && Number.isFinite(amount.remainingFraction)) {
    remainingPct = Math.round(amount.remainingFraction * 10_000) / 100;
  } else if (typeof amount.remaining === "number" && Number.isFinite(amount.remaining)) {
    remainingPct = amount.remaining;
  } else {
    remainingPct = Math.round((1 - usedFraction) * 10_000) / 100;
  }

  if (remainingPct < 0 || remainingPct > 100) {
    throw new Error("remainingPct out of range [0, 100].");
  }

  const resetCredits = typeof codexReport.resetCredits?.availableCount === "number"
    ? codexReport.resetCredits.availableCount
    : undefined;

  return {
    provider: "openai-codex",
    usedFraction,
    remainingPct,
    resetAt: new Date(resetsAtMs).toISOString(),
    observedAt: new Date(observedMs).toISOString(),
    resetCredits,
  };
}

export function sanitizeOmpError(error: unknown): string {
  if (!error) return "Quota probe failure";
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("Timeout")) {
    return "Probe timed out";
  }
  if (msg.includes("exited with code") || msg.includes("exit code")) {
    return "CLI process exited with error";
  }
  if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("executable")) {
    return "CLI executable not found";
  }
  if (
    msg.includes("JSON") ||
    msg.includes("Invalid OMP usage payload") ||
    msg.includes("Missing or malformed") ||
    msg.includes("Weekly openai-codex limit") ||
    msg.includes("No openai-codex report") ||
    msg.includes("stale") ||
    msg.includes("future")
  ) {
    return "Invalid usage response payload";
  }
  return "Quota probe failure";
}

export function evaluateObservation(
  state: OmpQuotaState,
  observation: OmpQuotaObservation,
  options: { lowRemainingPct: number },
): { nextState: OmpQuotaState; events: OmpQuotaTransitionEvent[] } {
  const events: OmpQuotaTransitionEvent[] = [];
  const nextState: OmpQuotaState = {
    ...state,
    lastObservedAt: observation.observedAt,
    lastRemainingPct: observation.remainingPct,
    lastUsedFraction: observation.usedFraction,
    lastResetCredits: observation.resetCredits ?? null,
    updatedAt: new Date().toISOString(),
  };

  if (state.failureAlertSent) {
    events.push({
      type: "recovery",
      observation,
      previousFailures: state.consecutiveFailures,
    });
    nextState.failureAlertSent = false;
    nextState.consecutiveFailures = 0;
  } else {
    nextState.consecutiveFailures = 0;
  }

  if (state.lastResetAt === null) {
    nextState.lastResetAt = observation.resetAt;
    nextState.lastNotifiedResetAt = observation.resetAt;
    nextState.lowQuotaActive = observation.remainingPct <= options.lowRemainingPct;
  } else if (observation.resetAt !== state.lastResetAt) {
    const previousResetAt = state.lastResetAt;
    nextState.lastResetAt = observation.resetAt;
    nextState.lastNotifiedResetAt = observation.resetAt;
    nextState.lowQuotaActive = false;
    events.push({
      type: "reset",
      observation,
      previousResetAt,
    });

    if (observation.remainingPct <= options.lowRemainingPct) {
      nextState.lowQuotaActive = true;
      events.push({
        type: "low_remaining",
        observation,
        thresholdPct: options.lowRemainingPct,
      });
    }
  } else {
    if (observation.remainingPct <= options.lowRemainingPct) {
      if (!state.lowQuotaActive) {
        nextState.lowQuotaActive = true;
        events.push({
          type: "low_remaining",
          observation,
          thresholdPct: options.lowRemainingPct,
        });
      }
    } else {
      nextState.lowQuotaActive = false;
    }
  }

  return { nextState, events };
}

export function evaluateFailure(
  state: OmpQuotaState,
  errorCategory: string,
  options: { repeatedFailureCount: number },
): { nextState: OmpQuotaState; events: OmpQuotaTransitionEvent[] } {
  const events: OmpQuotaTransitionEvent[] = [];
  const consecutiveFailures = state.consecutiveFailures + 1;
  const nextState: OmpQuotaState = {
    ...state,
    consecutiveFailures,
    updatedAt: new Date().toISOString(),
  };

  if (consecutiveFailures >= options.repeatedFailureCount && !state.failureAlertSent) {
    nextState.failureAlertSent = true;
    events.push({
      type: "repeated_failure",
      consecutiveFailures,
      errorCategory,
    });
  }

  return { nextState, events };
}

export class OmpQuotaStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<OmpQuotaState> {
    try {
      const content = await readFile(this.path, "utf8");
      const parsed = JSON.parse(content) as Partial<OmpQuotaState>;
      return {
        lastResetAt: typeof parsed.lastResetAt === "string" ? parsed.lastResetAt : null,
        lastNotifiedResetAt: typeof parsed.lastNotifiedResetAt === "string" ? parsed.lastNotifiedResetAt : null,
        lowQuotaActive: Boolean(parsed.lowQuotaActive),
        consecutiveFailures: typeof parsed.consecutiveFailures === "number" ? parsed.consecutiveFailures : 0,
        failureAlertSent: Boolean(parsed.failureAlertSent),
        lastObservedAt: typeof parsed.lastObservedAt === "string" ? parsed.lastObservedAt : null,
        lastRemainingPct: typeof parsed.lastRemainingPct === "number" ? parsed.lastRemainingPct : null,
        lastUsedFraction: typeof parsed.lastUsedFraction === "number" ? parsed.lastUsedFraction : null,
        lastResetCredits: typeof parsed.lastResetCredits === "number" ? parsed.lastResetCredits : null,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      };
    } catch {
      return {
        lastResetAt: null,
        lastNotifiedResetAt: null,
        lowQuotaActive: false,
        consecutiveFailures: 0,
        failureAlertSent: false,
        lastObservedAt: null,
        lastRemainingPct: null,
        lastUsedFraction: null,
        lastResetCredits: null,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  async save(state: OmpQuotaState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => {});
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

export type OmpUsageExecutor = (params: {
  executable: string;
  brokerUrl: string;
  brokerToken: string;
  timeoutMs: number;
}) => Promise<unknown>;

export const defaultOmpUsageExecutor: OmpUsageExecutor = async ({
  executable,
  brokerUrl,
  brokerToken,
  timeoutMs,
}) => {
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME || "/var/lib/agentrouter-monitor",
  };
  if (process.env.XDG_CACHE_HOME) env.XDG_CACHE_HOME = process.env.XDG_CACHE_HOME;
  if (process.env.NODE_ENV) env.NODE_ENV = process.env.NODE_ENV;
  if (brokerUrl) env.OMP_AUTH_BROKER_URL = brokerUrl;
  if (brokerToken) env.OMP_AUTH_BROKER_TOKEN = brokerToken;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const proc = Bun.spawn(
      [executable, "usage", "--json", "--redact", "--provider", "openai-codex"],
      {
        env,
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      },
    );

    const [stdoutText, _stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`CLI process exited with code ${exitCode}`);
    }

    const cleaned = stripAnsi(stdoutText).trim();
    if (!cleaned) {
      throw new Error("Empty output from OMP usage probe");
    }

    return JSON.parse(cleaned);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Probe timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export class OmpQuotaPoller {
  private readonly stateStore: OmpQuotaStateStore;
  private readonly executor: OmpUsageExecutor;

  constructor(
    private readonly config: OmpQuotaConfig,
    private readonly telegram: TelegramNotifier | null = null,
    private readonly repeatedFailureCount: number = 3,
    executor: OmpUsageExecutor = defaultOmpUsageExecutor,
  ) {
    this.stateStore = new OmpQuotaStateStore(config.stateFilePath);
    this.executor = executor;
  }

  async getState(): Promise<OmpQuotaState> {
    return this.stateStore.load();
  }

  async pollOnce(): Promise<OmpQuotaObservation | null> {
    const state = await this.stateStore.load();
    try {
      const raw = await this.executor({
        executable: this.config.executable,
        brokerUrl: this.config.brokerUrl ?? "",
        brokerToken: process.env.OMP_AUTH_BROKER_TOKEN ?? "",
        timeoutMs: this.config.timeoutMs,
      });

      const observation = parseOmpUsageResponse(raw);
      const { nextState, events } = evaluateObservation(state, observation, {
        lowRemainingPct: this.config.lowRemainingPct,
      });

      await this.stateStore.save(nextState);

      for (const event of events) {
        if (this.telegram) {
          await this.telegram.processOmpQuotaTransition(event).catch((error) => {
            console.error(`Telegram OMP notification skipped: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }

      return observation;
    } catch (error) {
      const errorCategory = sanitizeOmpError(error);
      const { nextState, events } = evaluateFailure(state, errorCategory, {
        repeatedFailureCount: this.repeatedFailureCount,
      });

      await this.stateStore.save(nextState).catch(() => {});

      for (const event of events) {
        if (this.telegram) {
          await this.telegram.processOmpQuotaTransition(event).catch((err) => {
            console.error(`Telegram OMP failure notification skipped: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }

      console.warn(`[omp-quota] ${errorCategory}`);
      return null;
    }
  }
}
