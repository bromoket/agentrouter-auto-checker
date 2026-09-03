import { unlink } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountStore } from "./accounts";
import { isBoundedJsonError, readBoundedJsonObject } from "./bounded-json";
import { AuthenticationChallengeBroker } from "./challenges";
import type { AppConfig } from "./config";
import { CheckCoordinator } from "./coordinator";
import { handleObservatoryApi } from "./observatory/api";
import type { ObservatoryCoordinator } from "./observatory/coordinator";
import type { ObservatoryStore } from "./observatory/store";
import {
  deleteAccountScreenshots,
  isValidScreenshotFilename,
  readSecureScreenshotFile,
} from "./screenshot-retention";
import { SettingsStore } from "./settings";
import { Store } from "./storage";
const WEB_ROOT = fileURLToPath(new URL("./web", import.meta.url));
const CHART_BUNDLE = resolve("node_modules", "chart.js", "dist", "chart.umd.js");
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "no-store",
};

function response(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(body, { ...init, headers });
}

function json(data: unknown, status = 200): Response {
  return response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}


function isAllowedOrigin(request: Request, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && allowedOrigins.includes(origin);
}

function isAllowedRequestHost(request: Request, allowedOrigins: readonly string[]): boolean {
  const rawHost = request.headers.get("host");
  if (
    !rawHost ||
    rawHost !== rawHost.trim() ||
    /[\u0000-\u001f\u007f\s@/\\?#]/.test(rawHost)
  ) {
    return false;
  }

  const ipv6Match = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(rawHost);
  const hostMatch = /^([A-Za-z0-9][A-Za-z0-9.-]*)(?::(\d{1,5}))?$/.exec(rawHost);
  const match = ipv6Match ?? hostMatch;
  if (!match) {
    return false;
  }
  const rawHostname = match[1];
  const rawPort = match[2];
  if (rawPort && (Number(rawPort) < 1 || Number(rawPort) > 65_535)) {
    return false;
  }
  try {
    new URL(`http://${rawHost}`);
  } catch {
    return false;
  }

  const hostname = rawHostname.toLowerCase();
  const port = rawPort ? Number(rawPort) : null;
  return allowedOrigins.some((origin) => {
    const url = new URL(origin);
    const configuredHostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname !== configuredHostname) {
      return false;
    }
    if (port === null) {
      return url.port === "";
    }
    const configuredPort = url.port
      ? Number(url.port)
      : url.protocol === "https:"
        ? 443
        : 80;
    return port === configuredPort;
  });
}

function boundedInteger(raw: string | null, fallback: number, max: number): number {
  const value = Number.parseInt(raw ?? "", 10);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

function contentType(pathname: string): string {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  if (pathname.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function serveFile(pathname: string): Promise<Response> {
  const file = Bun.file(pathname);
  if (!(await file.exists())) {
    return errorResponse("Not found", 404);
  }
  return response(file, { headers: { "content-type": contentType(pathname) } });
}

function parseAccountId(pathname: string, prefix: string): string | null {
  const encoded = pathname.slice(prefix.length);
  let id: string;
  try {
    id = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return ACCOUNT_ID_PATTERN.test(id) ? id : null;
}

export function startDashboard(
  store: Store,
  accountStore: AccountStore,
  settingsStore: SettingsStore,
  challenges: AuthenticationChallengeBroker,
  coordinator: CheckCoordinator,
  config: AppConfig,
  observatoryContext?: {
    store: ObservatoryStore;
    coordinator: ObservatoryCoordinator;
  } | null,
) {
  if (config.observatory.enabled && !config.dashboardAuth.enabled) {
    throw new Error("Observatory dashboard requires enabled API key session authentication.");
  }

  const server = Bun.serve({
    hostname: config.dashboardHost,
    port: config.dashboardPort,
    async fetch(request, server) {
      try {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        if (!isAllowedRequestHost(request, config.dashboardAllowedOrigins)) {
          return errorResponse("Invalid host.", 421);
        }

        if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          if (!isAllowedOrigin(request, config.dashboardAllowedOrigins)) {
            return errorResponse("Invalid request origin.", 403);
          }
        }

        if (method === "GET" && url.pathname === "/api/health") {
          const coordinatorStatus = coordinator.getStatus();
          return json({
            status: "ok",
            generatedAt: new Date().toISOString(),
            uptimeSeconds: Math.floor(process.uptime()),
            schedulerActive: coordinatorStatus.schedulerActive,
            schedulerEnabled: coordinatorStatus.schedulerEnabled,
            checkRunning: coordinatorStatus.running,
          });
        }
        if (method === "POST" && url.pathname === "/api/auth/session") {
          const body = await readBoundedJsonObject(request);
          const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : null;
          if (!apiKey) {
            return errorResponse("API key is required.", 400);
          }
          if (!config.dashboardAuth.verifyApiKey(apiKey)) {
            return config.dashboardAuth.createUnauthorizedResponse("Invalid API key.");
          }
          return config.dashboardAuth.createSessionResponse();
        }

        if (method === "POST" && url.pathname === "/api/auth/logout") {
          return config.dashboardAuth.createClearSessionResponse();
        }

        if (method === "GET" && url.pathname === "/login.css") {
          return serveFile(join(WEB_ROOT, "login.css"));
        }
        if (method === "GET" && url.pathname === "/login.js") {
          return serveFile(join(WEB_ROOT, "login.js"));
        }
        if (method === "GET" && url.pathname === "/canonical.js") {
          return serveFile(join(WEB_ROOT, "canonical.js"));
        }
        if (method === "GET" && url.pathname === "/favicon.svg") {
          return serveFile(join(WEB_ROOT, "eye.svg"));
        }
        if (method === "GET" && url.pathname === "/eye.svg") {
          return serveFile(join(WEB_ROOT, "eye.svg"));
        }

        const isAuthenticated = config.dashboardAuth.verifyRequest(request);

        if (method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          if (isAuthenticated) {
            return serveFile(join(WEB_ROOT, "dashboard.html"));
          }
          return serveFile(join(WEB_ROOT, "login.html"));
        }

        if (method === "GET" && url.pathname === "/login.html") {
          return serveFile(join(WEB_ROOT, "login.html"));
        }

        const unauthorized = config.dashboardAuth.authenticate(request);
        if (unauthorized) {
          return unauthorized;
        }

        if (url.pathname.startsWith("/api/observatory/")) {
          if (!config.observatory.enabled || !observatoryContext) {
            return errorResponse("Observatory is disabled.", 404);
          }
          if (method === "GET" && url.pathname === "/api/observatory/stream") {
            server.timeout(request, 0);
          }
          const observatoryResponse = await handleObservatoryApi(request, url, method, {
            store: observatoryContext.store,
            coordinator: observatoryContext.coordinator,
            config,
          });
          if (observatoryResponse) {
            return observatoryResponse;
          }
          return errorResponse("Observatory API route not found.", 404);
        }
        if (method === "GET" && url.pathname === "/dashboard.css") {
          return serveFile(join(WEB_ROOT, "dashboard.css"));
        }
        if (method === "GET" && url.pathname === "/dashboard.js") {
          return serveFile(join(WEB_ROOT, "dashboard.js"));
        }
        if (method === "GET" && url.pathname === "/vendor/chart.umd.js") {
          return serveFile(CHART_BUNDLE);
        }

        if (method === "GET" && url.pathname === "/api/bootstrap") {
          const accounts = await accountStore.listPublic();
          const automation = await settingsStore.load();
          return json({
            accounts,
            historicalAccounts: store.listHistoricalAccounts(),
            coordinator: coordinator.getStatus(),
            settings: {
              baseUrl: config.baseUrl,
              automation,
            },
            challenges: challenges.list(),
            capabilities: {
              observatory: config.observatory.enabled,
              collectorSessions: Boolean(config.collector?.enabled),
            },
          });
        }

        if (method === "GET" && url.pathname === "/api/challenges") {
          return json(challenges.list());
        }

        if (method === "GET" && url.pathname === "/api/overview") {
          const accounts = await accountStore.listPublic();
          const accountData = accounts.map((account) => {
            const history = store.listMetricHistory(account.id, 120);
            const successfulHistory = history.filter((item) => item.status === "ok");
            const browserLatest = successfulHistory.at(-1) ?? null;
            const credits = store.listCreditObservations(account.id, 120);
            const grants = store.listCreditGrantEvents(account.id, 120);
            // The overview only needs chart-resolution samples. Full observations
            // remain available through the account endpoint and exports.
            const endpointObservations = store.listEndpointObservations(account.id, 180);
            const latestEndpoint = endpointObservations.find((item) => item.status === "ok") ?? null;
            const latest = latestEndpoint && (
              !browserLatest || Date.parse(latestEndpoint.observedAt) > Date.parse(browserLatest.startedAt)
            ) ? {
              startedAt: latestEndpoint.observedAt,
              status: "ok" as const,
              loginMs: 0,
              dashboardMs: 0,
              totalMs: latestEndpoint.latencyMs,
              loggedOut: undefined,
              metrics: {
                balance: latestEndpoint.balance,
                consumed: latestEndpoint.consumed,
                requestCount: latestEndpoint.requestCount,
                statisticalTokens: undefined,
              },
              source: "endpoint" as const,
            } : browserLatest;
            const observedEarnings = credits.reduce(
              (total, item) => total + Math.max(0, Number(item.balanceDelta) || 0),
              0,
            );
            return {
              account,
              latest,
              history,
              credits,
              grants,
              endpointObservations,
              usage: store.listUsagePoints(account.id, "day"),
              observedEarnings,
              confirmedEarnings: grants.reduce((total, item) => total + item.amount, 0),
            };
          });
          const latestMetrics = accountData
            .map((item) => item.latest?.metrics)
            .filter((metrics) => metrics !== undefined);
          const sum = (key: "balance" | "consumed" | "requestCount" | "statisticalTokens") =>
            latestMetrics.reduce((total, metrics) => total + (Number(metrics[key]) || 0), 0);
          const runCounts = store.getRunStatusCounts();
          const recentRuns = store.listRuns(100);
          return json({
            generatedAt: new Date().toISOString(),
            materialBalanceEventUsd: config.telegram.largeDropUsd,
            accounts: accountData,
            totals: {
              configuredAccounts: accounts.length,
              enabledAccounts: accounts.filter((account) => account.enabled).length,
              balance: sum("balance"),
              consumed: sum("consumed"),
              requests: sum("requestCount"),
              tokens: sum("statisticalTokens"),
              observedEarnings: accountData.reduce((total, item) => total + item.observedEarnings, 0),
              confirmedEarnings: accountData.reduce((total, item) => total + item.confirmedEarnings, 0),
              successfulRuns: runCounts.successful,
              failedRuns: runCounts.failed,
            },
            recentRuns: recentRuns.slice(0, 100).map(
              ({ summary: _summary, usagePoints: _points, ...run }) => run,
            ),
          });
        }

        if (method === "GET" && url.pathname === "/api/runs") {
          const limit = boundedInteger(url.searchParams.get("limit"), 200, 5_000);
          const accountId = url.searchParams.get("accountId")?.trim() || undefined;
          if (accountId && !ACCOUNT_ID_PATTERN.test(accountId)) {
            return errorResponse("Invalid account id.", 400);
          }
          return json(
            store.listRuns(limit, accountId).map(({ summary: _summary, usagePoints: _points, ...run }) => run),
          );
        }

        if (method === "GET" && url.pathname.startsWith("/api/activity/")) {
          const id = parseAccountId(url.pathname, "/api/activity/");
          if (!id) return errorResponse("Invalid account id.", 400);
          const latest = store
            .listRuns(100, id)
            .find(
              (run) =>
                Array.isArray(run.summary.recentUsage) && run.summary.recentUsage.length > 0,
            );
          return json(latest?.summary.recentUsage ?? []);
        }

        if (method === "GET" && url.pathname.startsWith("/api/history/")) {
          const id = parseAccountId(url.pathname, "/api/history/");
          if (!id) return errorResponse("Invalid account id.", 400);
          const limit = boundedInteger(url.searchParams.get("limit"), 500, 5_000);
          return json(store.listMetricHistory(id, limit));
        }

        if (method === "GET" && url.pathname.startsWith("/api/credits/")) {
          const id = parseAccountId(url.pathname, "/api/credits/");
          if (!id) return errorResponse("Invalid account id.", 400);
          const limit = boundedInteger(url.searchParams.get("limit"), 500, 5_000);
          return json(store.listCreditObservations(id, limit));
        }

        if (method === "GET" && url.pathname.startsWith("/api/grants/")) {
          const id = parseAccountId(url.pathname, "/api/grants/");
          if (!id) return errorResponse("Invalid account id.", 400);
          const limit = boundedInteger(url.searchParams.get("limit"), 500, 5_000);
          return json(store.listCreditGrantEvents(id, limit));
        }

        if (method === "GET" && url.pathname.startsWith("/api/endpoint-observations/")) {
          const id = parseAccountId(url.pathname, "/api/endpoint-observations/");
          if (!id) return errorResponse("Invalid account id.", 400);
          const limit = boundedInteger(url.searchParams.get("limit"), 2_000, 10_000);
          return json(store.listEndpointObservations(id, limit));
        }

        if (method === "GET" && url.pathname.startsWith("/api/account-token/")) {
          const id = parseAccountId(url.pathname, "/api/account-token/");
          if (!id) return errorResponse("Invalid account id.", 400);
          const token = await accountStore.getApiToken(id);
          if (!token) return errorResponse("No captured AgentRouter API token is available yet.", 404);
          return json({ token });
        }

        if (method === "GET" && url.pathname.startsWith("/api/export/")) {
          const id = parseAccountId(url.pathname, "/api/export/");
          if (!id) return errorResponse("Invalid account id.", 400);
          const accounts = await accountStore.listPublic();
          const account = accounts.find((candidate) => candidate.id === id) ?? null;
          const automation = await settingsStore.load();
          return json({
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            account,
            automation,
            creditObservations: store.listCreditObservations(id, 5_000),
            creditGrantEvents: store.listCreditGrantEvents(id, 5_000),
            endpointObservations: store.listEndpointObservations(id, 10_000),
            metricHistory: store.listMetricHistory(id, 5_000),
            usage: {
              hour: store.listUsagePoints(id, "hour"),
              day: store.listUsagePoints(id, "day"),
              week: store.listUsagePoints(id, "week"),
            },
            runs: store.listRuns(5_000, id),
          });
        }

        if (method === "GET" && url.pathname.startsWith("/api/usage/")) {
          const id = parseAccountId(url.pathname, "/api/usage/");
          if (!id) return errorResponse("Invalid account id.", 400);
          const requestedGranularity = url.searchParams.get("granularity") || "day";
          if (!["hour", "day", "week"].includes(requestedGranularity)) {
            return errorResponse("Invalid granularity.", 400);
          }
          const from = Math.max(0, Number.parseInt(url.searchParams.get("from") ?? "0", 10) || 0);
          return json(
            store.listUsagePoints(
              id,
              requestedGranularity as "hour" | "day" | "week",
              from,
            ),
          );
        }

        if (method === "GET" && url.pathname === "/api/coordinator") {
          return json(coordinator.getStatus());
        }

        if (method === "POST" && url.pathname === "/api/accounts") {
          const body = await readBoundedJsonObject(request);
          const account = await accountStore.upsert(body);
          return json({ account }, 201);
        }

        if (method === "PUT" && url.pathname === "/api/settings") {
          const body = await readBoundedJsonObject(request);
          const automation = await settingsStore.save(body);
          return json({ automation });
        }

        if (method === "DELETE" && url.pathname.startsWith("/api/accounts/")) {
          if (coordinator.getStatus().running) {
            return errorResponse("Cannot remove an account while a check is running.", 409);
          }
          const id = parseAccountId(url.pathname, "/api/accounts/");
          if (!id) return errorResponse("Invalid account id.", 400);
          const removed = await accountStore.remove(id);
          if (!removed) return errorResponse("Account not found.", 404);
          challenges.cancelAccount(id);
          const stateRoot = `${resolve(config.accountStateDir)}${sep}`;
          const statePaths = [`${id}.json`, `${id}.monitor.json`].map((name) =>
            resolve(config.accountStateDir, name)
          );
          for (const statePath of statePaths) {
            if (statePath.startsWith(stateRoot)) {
              await unlink(statePath).catch((error) => {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              });
            }
          }
          const profilePath = resolve(config.browserProfileDir, id);
          const profileRoot = `${resolve(config.browserProfileDir)}${sep}`;
          if (profilePath.startsWith(profileRoot)) {
            await rm(profilePath, { recursive: true, force: true });
          }
          // Hardened screenshot deletion via validated directory pinning
          await deleteAccountScreenshots(config.screenshotDir, id).catch(() => 0);
          return json({ removed: true });
        }

        if (method === "POST" && url.pathname === "/api/checks/run") {
          const body = await readBoundedJsonObject(request);
          const accountId = typeof body.accountId === "string" && body.accountId
            ? body.accountId.trim()
            : undefined;
          if (accountId && !ACCOUNT_ID_PATTERN.test(accountId)) {
            return errorResponse("Invalid account id.", 400);
          }
          if (coordinator.getStatus().running) {
            return errorResponse("A check cycle is already running.", 409);
          }
          void coordinator
            .runCycle(accountId)
            .catch((error) => {
            console.error(`Manual check failed: ${error instanceof Error ? error.message : error}`);
          });
          return json({ accepted: true }, 202);
        }

        if (method === "POST" && url.pathname === "/api/checks/stop") {
          const stopped = coordinator.stopCycle();
          if (!stopped) {
            return errorResponse("There is no active check cycle to stop.", 409);
          }
          return json({ accepted: true }, 202);
        }

        if (method === "GET" && url.pathname.startsWith("/screenshots/")) {
          const requestedName = url.pathname.slice("/screenshots/".length);
          if (!isValidScreenshotFilename(requestedName)) {
            return errorResponse("Invalid screenshot name.", 400);
          }
          try {
            const buffer = await readSecureScreenshotFile(config.screenshotDir, requestedName);
            return response(Uint8Array.from(buffer), { headers: { "content-type": "image/png" } });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("ENOENT") || message.includes("not found")) {
              return errorResponse("Screenshot not found.", 404);
            }
            if (message.includes("unsupported")) {
              return errorResponse(message, 501);
            }
            return errorResponse("Screenshot access forbidden.", 403);
          }
        }

        if (url.pathname.startsWith("/api/")) {
          return errorResponse("API route not found.", 404);
        }
        return errorResponse("Not found", 404);
      } catch (error) {
        if (isBoundedJsonError(error)) {
          return json(
            { error: "Request body rejected.", category: error.category },
            error.status,
          );
        }
        const message = error instanceof SyntaxError
          ? "Request body is not valid JSON."
          : error instanceof Error
            ? error.message
            : "Unexpected request failure.";
        const status = /invalid|must|too large|configured|duplicate/i.test(message) ? 400 : 500;
        return errorResponse(status === 500 ? "Internal server error." : message, status);
      }
    },
  });

  return server;
}
