import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

async function pollDashboardBalance(
  account: GitHubAccount,
  config: AppConfig,
  signal: AbortSignal,
): Promise<{ balance: number; consumed: number; sourcePath: string } | null> {
  if (!account.agentRouterDashboardToken) return null;
  const headers = { accept: "application/json", authorization: `Bearer ${account.agentRouterDashboardToken}` };
  const request = (path: string) => fetch(new URL(path, config.baseUrl), {
    headers,
    redirect: "manual",
    signal,
  });
  const [selfResponse, statusResponse] = await Promise.all([
    request("/api/user/self"),
    request("/api/status"),
  ]);
  for (const response of [selfResponse, statusResponse]) {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!response.ok || !contentType.includes("application/json")) {
      throw new Error(`Dashboard token endpoint returned HTTP ${response.status} (${contentType || "unknown content type"}).`);
    }
  }
  const self: unknown = await selfResponse.json();
  const status: unknown = await statusResponse.json();
  if (asRecord(self)?.success !== true || asRecord(status)?.success !== true) {
    throw new Error("Dashboard token endpoint returned an API error.");
  }
  const quotaPerUnit = findNumber(status, ["quota_per_unit", "quotaPerUnit"]);
  const quota = findNumber(self, ["quota"]);
  const usedQuota = findNumber(self, ["used_quota", "usedQuota"]);
  if (!quotaPerUnit || quota === undefined || usedQuota === undefined || usedQuota < 0) {
    throw new Error("Dashboard token endpoint did not expose valid quota values.");
  }
  return {
    balance: quota / quotaPerUnit,
    consumed: usedQuota / quotaPerUnit,
    sourcePath: "/api/user/self + /api/status (dashboard access token)",
  };
}

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

export async function pollAccountEndpoints(
  account: GitHubAccount,
  config: AppConfig,
  signal?: AbortSignal,
): Promise<EndpointObservation> {
  const startedAt = Date.now();
  try {
    const combinedSignal = AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(config.requestTimeoutMs),
    ]);
    const billing = await pollDashboardBalance(account, config, combinedSignal);
    if (billing) {
      return {
        accountId: account.id,
        accountLabel: account.label,
        observedAt: new Date().toISOString(),
        status: "ok",
        ...billing,
        latencyMs: Date.now() - startedAt,
      };
    }
    const sessionAuth = await loadSessionAuth(
      join(config.accountStateDir, `${account.id}.json`),
      config.baseUrl,
    );
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
      if (!response.ok || !contentType.includes("application/json")) {
        lastError = `${path} returned HTTP ${response.status} (${contentType || "unknown content type"}).`;
        continue;
      }
      const payload: unknown = await response.json();
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
        sourcePath: path,
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
