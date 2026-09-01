import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import type { GitHubAccount } from "./accounts";
import type { AppConfig } from "./config";
import type { EndpointObservation } from "./storage";

interface StorageStateCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  expires?: unknown;
}

interface StorageStateOrigin {
  origin?: unknown;
  localStorage?: Array<{ name?: unknown; value?: unknown }>;
}

const READ_ONLY_PATHS = ["/api/user/self"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findNumber(value: unknown, names: readonly string[]): number | undefined {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift();
    const record = asRecord(current);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    for (const name of names) {
      const parsed = Number(record[name]);
      if (Number.isFinite(parsed)) return parsed;
    }
    queue.push(...Object.values(record));
  }
  return undefined;
}

async function loadSessionAuth(path: string, baseUrl: string): Promise<{ cookie: string; userId: string }> {
  const state = JSON.parse(await readFile(path, "utf8")) as {
    cookies?: StorageStateCookie[];
    origins?: StorageStateOrigin[];
  };
  const host = new URL(baseUrl).hostname;
  const now = Date.now() / 1_000;
  const cookies = (state.cookies ?? []).filter((cookie) => {
    if (typeof cookie.name !== "string" || typeof cookie.value !== "string") return false;
    if (typeof cookie.domain !== "string") return false;
    const domain = cookie.domain.replace(/^\./, "");
    if (!(host === domain || host.endsWith(`.${domain}`))) return false;
    return typeof cookie.expires !== "number" || cookie.expires < 0 || cookie.expires > now;
  });
  if (cookies.length === 0) throw new Error("No unexpired AgentRouter session cookies are available.");
  const localStorage = state.origins?.find((origin) => origin.origin === baseUrl)?.localStorage ?? [];
  const rawUser = localStorage.find((item) => item.name === "user")?.value;
  let userId = "";
  if (typeof rawUser === "string") {
    try {
      const user = JSON.parse(rawUser) as Record<string, unknown>;
      const parsedId = Number(user.id);
      if (Number.isSafeInteger(parsedId) && parsedId > 0) userId = String(parsedId);
    } catch {
      // Invalid local storage is treated as an unusable session below.
    }
  }
  if (!userId) throw new Error("Saved AgentRouter session does not include a valid user id.");
  return { cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "), userId };
}
type BrowserPayloadLoader = (
  statePath: string,
  config: AppConfig,
  userId: string,
  signal: AbortSignal,
) => Promise<unknown>;

async function loadPayloadWithBrowser(
  statePath: string,
  config: AppConfig,
  userId: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) throw new Error("AgentRouter browser polling was aborted.");
  const browser = await chromium.launch({
    channel: config.browserChannel,
    headless: false,
  });
  let context;
  try {
    context = await browser.newContext({ storageState: statePath });
    const page = await context.newPage();
    page.setDefaultTimeout(config.requestTimeoutMs);
    await page.goto(new URL("/console/", config.baseUrl).toString(), {
      waitUntil: "domcontentloaded",
      timeout: config.requestTimeoutMs,
    });
    if (signal.aborted) throw new Error("AgentRouter browser polling was aborted.");
    const result = await page.evaluate(async (numericUserId) => {
      const response = await fetch("/api/user/self", {
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
          "New-API-User": numericUserId,
        },
      });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      const payload = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : null;
      return { ok: response.ok, contentType, payload };
    }, userId);
    if (!result.ok || !result.contentType.includes("application/json") || !result.payload) {
      throw new Error("AgentRouter browser polling did not return JSON account data.");
    }
    return result.payload;
  } finally {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}


/**
 * A fresh installation deliberately has no read-only polling session until the
 * first verified browser cycle has captured it. Treat that bootstrap state as
 * pending rather than recording an avoidable endpoint failure every minute.
 */
export async function hasMonitorSession(account: GitHubAccount, config: AppConfig): Promise<boolean> {
  try {
    await access(join(config.accountStateDir, `${account.id}.monitor.json`));
    return true;
  } catch {
    return false;
  }
}

export async function pollAccountEndpoints(
  account: GitHubAccount,
  config: AppConfig,
  signal?: AbortSignal,
  browserPayloadLoader: BrowserPayloadLoader = loadPayloadWithBrowser,
): Promise<EndpointObservation> {
  const startedAt = Date.now();
  try {
    const combinedSignal = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(config.requestTimeoutMs),
    ]);
    const statePath = join(config.accountStateDir, `${account.id}.monitor.json`);
    const sessionAuth = await loadSessionAuth(statePath, config.baseUrl);
    let lastError = "No endpoint returned parseable account values.";
    for (const path of READ_ONLY_PATHS) {
      const response = await fetch(new URL(path, config.baseUrl), {
        headers: {
          accept: "application/json",
          cookie: sessionAuth.cookie,
          "new-api-user": sessionAuth.userId,
        },
        redirect: "manual",
        signal: combinedSignal,
      });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      let payload: unknown;
      let sourcePath: string = path;
      if (response.ok && contentType.includes("application/json")) {
        payload = await response.json();
      } else {
        lastError = `${path} returned HTTP ${response.status} (${contentType || "unknown content type"}).`;
        try {
          payload = await browserPayloadLoader(statePath, config, sessionAuth.userId, combinedSignal);
          sourcePath = `${path}:browser`;
        } catch {
          continue;
        }
      }
      let quotaPerUnit = findNumber(payload, ["quota_per_unit", "quotaPerUnit"]);
      if (quotaPerUnit === undefined) {
        const statusResponse = await fetch(new URL("/api/status", config.baseUrl), {
          headers: { accept: "application/json" },
          redirect: "manual",
          signal: combinedSignal,
        });
        const statusType = statusResponse.headers.get("content-type")?.toLowerCase() ?? "";
        if (statusResponse.ok && statusType.includes("application/json")) {
          quotaPerUnit = findNumber(await statusResponse.json(), ["quota_per_unit", "quotaPerUnit"]);
        }
      }
      if (quotaPerUnit === undefined || quotaPerUnit <= 0) {
        lastError = "AgentRouter status did not expose a valid quota_per_unit value.";
        continue;
      }
      const balanceDirect = findNumber(payload, ["balance", "remaining_balance", "remainingBalance"]);
      const consumedDirect = findNumber(payload, ["consumed", "used_balance", "usedBalance"]);
      const quota = findNumber(payload, ["quota", "remaining_quota", "remainingQuota"]);
      const usedQuota = findNumber(payload, ["used_quota", "usedQuota"]);
      const balance = balanceDirect ?? (quota === undefined ? undefined : quota / quotaPerUnit);
      const consumed = consumedDirect ?? (usedQuota === undefined ? undefined : usedQuota / quotaPerUnit);
      if (balance === undefined || consumed === undefined || consumed < 0 || (balance === 0 && consumed === 0)) {
        lastError = `${path} did not expose valid balance and consumption values.`;
        continue;
      }
      return {
        accountId: account.id,
        accountLabel: account.label,
        observedAt: new Date().toISOString(),
        status: "ok",
        balance,
        consumed,
        requestCount: findNumber(payload, ["request_count", "requestCount", "count"]),
        sourcePath,
        latencyMs: Date.now() - startedAt,
      };
    }
    throw new Error(lastError);
  } catch (error) {
    return {
      accountId: account.id,
      accountLabel: account.label,
      observedAt: new Date().toISOString(),
      status: "error",
      latencyMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}
