import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountStore } from "./accounts";
import { AuthenticationChallengeBroker } from "./challenges";
import type { AppConfig } from "./config";
import { CheckCoordinator } from "./coordinator";
import { createDashboardAuth } from "./dashboard-auth";
import { startDashboard } from "./dashboard";
import { ObservatoryCoordinator } from "./observatory/coordinator";
import { ObservatoryStore } from "./observatory/store";
import { SettingsStore } from "./settings";
import { Store } from "./storage";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dashboard-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const TEST_API_KEY = "test-dashboard-api-key-32-chars-long";

function createTestConfig(
  dataDir: string,
  options?: { auth?: boolean; observatory?: boolean; collector?: boolean; apiKey?: string },
): AppConfig {
  const host = "127.0.0.1";
  const port = 30_000 + Math.floor(Math.random() * 10_000);
  const env: Record<string, string> = {
    DASHBOARD_HOST: host,
    DASHBOARD_PORT: String(port),
  };
  if (options?.apiKey) {
    env.DASHBOARD_API_KEY = options.apiKey;
  } else if (options?.auth || options?.observatory) {
    env.DASHBOARD_API_KEY = TEST_API_KEY;
  }

  const dashboardAuth = createDashboardAuth({
    env,
    host,
    observatoryEnabled: options?.observatory ?? false,
  });

  return {
    baseUrl: "https://agentrouter.org",
    requestTimeoutMs: 1_000,
    loginTimeoutMs: 1_000,
    dashboardPort: port,
    dashboardHost: host,
    dashboardAllowedOrigins: [`http://${host}:${port}`],
    dataDir,
    screenshotDir: join(dataDir, "screenshots"),
    accountStateDir: join(dataDir, "states"),
    browserProfileDir: join(dataDir, "profiles"),
    browserChannel: "chromium",
    accountFilePath: join(dataDir, "accounts.json"),
    settingsFilePath: join(dataDir, "settings.json"),
    dbPath: ":memory:",
    maxRecentRuns: 500,
    disableWebAuthn: true,
    telegram: {
      botToken: null,
      chatId: null,
      allowedUsername: null,
      stateFilePath: join(dataDir, "telegram.json"),
      lowBalanceUsd: 50,
      largeDropUsd: 25,
      repeatedFailureCount: 3,
      graphsEnabled: false,
      dashboardUrl: `http://${host}:${port}`,
    },
    ompQuota: {
      enabled: false,
      executable: "node_modules/.bin/omp",
      brokerUrl: null,
      stateFilePath: join(dataDir, "omp.json"),
      intervalMinutes: 5,
      timeoutMs: 45_000,
      lowRemainingPct: 10,
    },
    observatory: {
      enabled: options?.observatory ?? false,
      dbPath: ":memory:",
      hmacKey: "a".repeat(32),
      ompExecutable: "node_modules/.bin/omp",
      ompVersion: "18.0.11",
      sourceHostId: "test-node",
      pollIntervalMinutes: 5,
      retentionDays: 14,
      retentionPruneIntervalMinutes: 60,
      deliveryLeaseDurationMs: 30_000,
      deliveryMaxRetries: 5,
      maxAccountsPerProvider: 10,
      perAccountTimeoutMs: 10_000,
      ompTimeoutMs: 215_000,
    },
    collector: {
      enabled: options?.collector ?? false,
      host: "127.0.0.1",
      port: 8457,
      publicOrigin: "https://bkserver.tailbbaa91.ts.net:8457",
      registryFilePath: null,
      tailscaleExecutablePath: null,
      proxyTokenFilePath: null,
    },
    dashboardAuth,
  };
}

async function setupDashboardFixture(
  options?: { auth?: boolean; observatory?: boolean; collector?: boolean; apiKey?: string },
) {
  const dir = await makeTempDir();
  const config = createTestConfig(dir, options);
  const store = new Store(config.dbPath);
  const accounts = new AccountStore(config.accountFilePath);
  const settings = new SettingsStore(config.settingsFilePath);
  const challenges = new AuthenticationChallengeBroker();

  let obsStore: ObservatoryStore | null = null;
  let obsCoordinator: ObservatoryCoordinator | null = null;

  if (config.observatory.enabled) {
    obsStore = new ObservatoryStore(config.observatory.dbPath);
    obsCoordinator = new ObservatoryCoordinator(obsStore, config, null, async () => {
      const observedAt = new Date().toISOString();
      return {
        observedAt,
        identities: [{
          identityId: "a".repeat(64),
          kind: "credential",
          provider: "openai-codex",
          sourceHostId: "test-node",
          sourceVersion: "18.0.11",
          label: "OpenAI Codex (aaaaaaaa)",
          observedAt,
          health: "healthy",
        }],
        quotas: [{
          identityId: "a".repeat(64),
          provider: "openai-codex",
          windowId: "5h",
          observedAt,
          usedFraction: 0.25,
          remainingFraction: 0.75,
          source: "omp-usage",
          sourceVersion: "18.0.11",
        }],
        capacity: null,
        stats: { totalReports: 1, totalLimits: 1, totalIdentities: 1, totalDisabled: 0, totalWithoutUsage: 0 },
      };
    });
  }

  const coordinator = new CheckCoordinator(
    store,
    accounts,
    config,
    settings,
    challenges,
    null,
    null,
    obsCoordinator,
  );

  const observatoryContext = obsStore && obsCoordinator ? { store: obsStore, coordinator: obsCoordinator } : null;
  const server = startDashboard(store, accounts, settings, challenges, coordinator, config, observatoryContext);

  const baseUrl = `http://${config.dashboardHost}:${server.port}`;
  expect(server.port).toBe(config.dashboardPort);
  config.dashboardAllowedOrigins = [baseUrl];
  const apiKey = options?.apiKey ?? (options?.auth || options?.observatory ? TEST_API_KEY : undefined);

  const login = async (key: string = apiKey ?? TEST_API_KEY, origin: string = baseUrl) => {
    const res = await fetch(`${baseUrl}/api/auth/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ apiKey: key }),
    });
    const setCookie = res.headers.get("set-cookie");
    const cookie = setCookie ? setCookie.split(";")[0] : null;
    return { res, setCookie, cookie };
  };

  return {
    dir,
    config,
    accounts,
    settings,
    challenges,
    coordinator,
    store,
    obsStore,
    obsCoordinator,
    server,
    baseUrl,
    apiKey,
    login,
    close: () => {
      server.stop(true);
      store.close();
      obsStore?.close();
    },
  };
}

describe("Dashboard authentication and route security", () => {
  test("health endpoint returns 200 without auth, unauthenticated root serves login surface, protected routes return 401", async () => {
    const fixture = await setupDashboardFixture({ auth: true, observatory: true });
    try {
      // Health check is exempt from auth
      const healthRes = await fetch(`${fixture.baseUrl}/api/health`);
      expect(healthRes.status).toBe(200);
      const healthData = (await healthRes.json()) as { status: string };
      expect(healthData.status).toBe("ok");

      fixture.config.dashboardAllowedOrigins.push("https://bkserver.tailbbaa91.ts.net");
      const proxiedHealthRes = await fetch(`${fixture.baseUrl}/api/health`, {
        headers: { host: "bkserver.tailbbaa91.ts.net" },
      });
      expect(proxiedHealthRes.status).toBe(200);

      // Unauthenticated root and index.html serve login surface
      const rootRes = await fetch(`${fixture.baseUrl}/`);
      expect(rootRes.status).toBe(200);
      expect(rootRes.headers.get("content-type")).toContain("text/html");
      const rootHtml = await rootRes.text();
      expect(rootHtml).toContain("Sign In · AI Fleet Observatory");
      expect(rootHtml).toContain('name="apiKey"');

      const indexRes = await fetch(`${fixture.baseUrl}/index.html`);
      expect(indexRes.status).toBe(200);
      const indexHtml = await indexRes.text();
      expect(indexHtml).toContain("Sign In · AI Fleet Observatory");

      const loginHtmlRes = await fetch(`${fixture.baseUrl}/login.html`);
      expect(loginHtmlRes.status).toBe(200);

      // Login assets are accessible without auth
      const loginCssRes = await fetch(`${fixture.baseUrl}/login.css`);
      expect(loginCssRes.status).toBe(200);
      const loginJsRes = await fetch(`${fixture.baseUrl}/login.js`);
      expect(loginJsRes.status).toBe(200);

      // Protected assets and endpoints return 401 without session cookie
      const protectedPaths = [
        "/dashboard.css",
        "/dashboard.js",
        "/vendor/chart.umd.js",
        "/api/bootstrap",
        "/api/overview",
        "/api/runs",
        "/api/coordinator",
        "/api/observatory/overview",
        "/api/observatory/live",
        "/api/observatory/quotas",
        "/api/observatory/identities",
        "/api/observatory/hosts",
        "/api/observatory/sessions",
        "/api/observatory/events",
        "/api/observatory/policies",
        "/api/observatory/health",
        "/api/observatory/stream",
        "/screenshots/nonexistent.png",
      ];

      for (const path of protectedPaths) {
        const res = await fetch(`${fixture.baseUrl}${path}`);
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBeNull();
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe("Unauthorized");
      }
    } finally {
      fixture.close();
    }
  });

  test("obtains Set-Cookie session by POSTing apiKey to /api/auth/session with valid Origin, then accesses protected endpoints using only the returned cookie", async () => {
    const fixture = await setupDashboardFixture({ auth: true, observatory: true });
    try {
      // POST apiKey to /api/auth/session with valid Origin
      const loginRes = await fetch(`${fixture.baseUrl}/api/auth/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: fixture.baseUrl,
        },
        body: JSON.stringify({ apiKey: TEST_API_KEY }),
      });
      expect(loginRes.status).toBe(200);
      const loginData = (await loginRes.json()) as { ok: boolean; status: string };
      expect(loginData.ok).toBe(true);

      const setCookie = loginRes.headers.get("set-cookie");
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain("dashboard_session=");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");

      const sessionCookie = setCookie!.split(";")[0];

      // Access protected root with only session cookie -> serves dashboard.html
      const rootRes = await fetch(`${fixture.baseUrl}/`, {
        headers: { cookie: sessionCookie },
      });
      expect(rootRes.status).toBe(200);
      const rootHtml = await rootRes.text();
      expect(rootHtml).toContain("AI Fleet Observatory");
      expect(rootHtml).not.toContain('name="apiKey"');

      // Access protected assets with only session cookie
      const cssRes = await fetch(`${fixture.baseUrl}/dashboard.css`, {
        headers: { cookie: sessionCookie },
      });
      expect(cssRes.status).toBe(200);

      const jsRes = await fetch(`${fixture.baseUrl}/dashboard.js`, {
        headers: { cookie: sessionCookie },
      });
      expect(jsRes.status).toBe(200);

      // Access protected dashboard APIs with only session cookie
      const bootstrapRes = await fetch(`${fixture.baseUrl}/api/bootstrap`, {
        headers: { cookie: sessionCookie },
      });
      expect(bootstrapRes.status).toBe(200);

      const overviewRes = await fetch(`${fixture.baseUrl}/api/overview`, {
        headers: { cookie: sessionCookie },
      });
      expect(overviewRes.status).toBe(200);

      const obsRes = await fetch(`${fixture.baseUrl}/api/observatory/overview`, {
        headers: { cookie: sessionCookie },
      });
      expect(obsRes.status).toBe(200);
    } finally {
      fixture.close();
    }
  });

  test("login API refuses bad, malformed, or missing keys and invalid origin", async () => {
    const fixture = await setupDashboardFixture({ auth: true });
    try {
      // Bad / wrong API key (>= 32 bytes but incorrect)
      const badKeyRes = await fetch(`${fixture.baseUrl}/api/auth/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: fixture.baseUrl,
        },
        body: JSON.stringify({ apiKey: "wrong-api-key-that-does-not-match-at-all-32-chars" }),
      });
      expect(badKeyRes.status).toBe(401);
      const badKeyData = (await badKeyRes.json()) as { error: string };
      expect(badKeyData.error).toContain("Invalid API key");

      // Missing API key in payload
      const missingKeyRes = await fetch(`${fixture.baseUrl}/api/auth/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: fixture.baseUrl,
        },
        body: JSON.stringify({}),
      });
      expect(missingKeyRes.status).toBe(400);
      const missingKeyData = (await missingKeyRes.json()) as { error: string };
      expect(missingKeyData.error).toContain("API key is required");

      // Empty / whitespace API key
      const emptyKeyRes = await fetch(`${fixture.baseUrl}/api/auth/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: fixture.baseUrl,
        },
        body: JSON.stringify({ apiKey: "   " }),
      });
      expect(emptyKeyRes.status).toBe(400);

      // Malformed API key type (non-string)
      const invalidTypeRes = await fetch(`${fixture.baseUrl}/api/auth/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: fixture.baseUrl,
        },
        body: JSON.stringify({ apiKey: 123456789 }),
      });
      expect(invalidTypeRes.status).toBe(400);

      // Invalid origin
      const invalidOriginRes = await fetch(`${fixture.baseUrl}/api/auth/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://attacker.example.com",
        },
        body: JSON.stringify({ apiKey: TEST_API_KEY }),
      });
      expect(invalidOriginRes.status).toBe(403);
      const originData = (await invalidOriginRes.json()) as { error: string };
      expect(originData.error).toContain("Invalid request origin");
    } finally {
      fixture.close();
    }
  });

  test("logout clears session and revokes access to protected endpoints", async () => {
    const fixture = await setupDashboardFixture({ auth: true });
    try {
      // Login first
      const { res: loginRes, cookie } = await fixture.login();
      expect(loginRes.status).toBe(200);
      expect(cookie).toBeDefined();

      // Verify authenticated access succeeds
      const checkRes = await fetch(`${fixture.baseUrl}/api/bootstrap`, {
        headers: { cookie: cookie! },
      });
      expect(checkRes.status).toBe(200);

      // Logout POST with valid Origin
      const logoutRes = await fetch(`${fixture.baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: fixture.baseUrl,
          cookie: cookie!,
        },
      });
      expect(logoutRes.status).toBe(200);
      const logoutData = (await logoutRes.json()) as { ok: boolean; status: string };
      expect(logoutData.ok).toBe(true);
      expect(logoutData.status).toBe("logged_out");

      // Verify Set-Cookie clears the session cookie with Max-Age=0
      const clearCookie = logoutRes.headers.get("set-cookie");
      expect(clearCookie).toBeDefined();
      expect(clearCookie).toContain("Max-Age=0");
      expect(clearCookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");

      // Using the cleared cookie returns 401 for protected endpoints
      const postLogoutRes = await fetch(`${fixture.baseUrl}/api/bootstrap`, {
        headers: { cookie: clearCookie!.split(";")[0] },
      });
      expect(postLogoutRes.status).toBe(401);

      // Request without cookie returns 401
      const noCookieRes = await fetch(`${fixture.baseUrl}/api/bootstrap`);
      expect(noCookieRes.status).toBe(401);

      // Root access without session returns login surface
      const rootRes = await fetch(`${fixture.baseUrl}/`);
      expect(rootRes.status).toBe(200);
      const rootHtml = await rootRes.text();
      expect(rootHtml).toContain("Sign In · AI Fleet Observatory");
    } finally {
      fixture.close();
    }
  });

  test("bounded body reader rejects oversized JSON request bodies", async () => {
    const fixture = await setupDashboardFixture({ auth: false });
    try {
      const hugePayload = {
        id: "acc-1",
        label: "x".repeat(70_000),
        githubUsername: "testuser",
      };

      const res = await fetch(`${fixture.baseUrl}/api/accounts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixture.baseUrl },
        body: JSON.stringify(hugePayload),
      });
      expect(res.status).toBe(413);
    } finally {
      fixture.close();
    }
  });

  test("rejects an Observatory-enabled dashboard with authentication disabled", async () => {
    const fixture = await setupDashboardFixture({ observatory: true });
    try {
      const unauthenticatedConfig: AppConfig = {
        ...fixture.config,
        dashboardAuth: createDashboardAuth({ env: {}, host: "127.0.0.1" }),
      };

      expect(() =>
        startDashboard(
          fixture.store,
          fixture.accounts,
          fixture.settings,
          fixture.challenges,
          fixture.coordinator,
          unauthenticatedConfig,
          { store: fixture.obsStore!, coordinator: fixture.obsCoordinator! },
        ),
      ).toThrow("Observatory dashboard requires enabled API key session authentication.");
    } finally {
      fixture.close();
    }
  });
});

describe("Observatory disabled default isolation", () => {
  test("returns 404 for /api/observatory/* when observatory is disabled", async () => {
    const fixture = await setupDashboardFixture({ auth: false, observatory: false });
    try {
      const obsPaths = [
        "/api/observatory/overview",
        "/api/observatory/live",
        "/api/observatory/quotas",
        "/api/observatory/identities",
        "/api/observatory/hosts",
        "/api/observatory/sessions",
        "/api/observatory/events",
        "/api/observatory/policies",
        "/api/observatory/health",
        "/api/observatory/stream",
      ];

      for (const path of obsPaths) {
        const res = await fetch(`${fixture.baseUrl}${path}`);
        expect(res.status).toBe(404);
        const data = await res.json() as { error: string };
        expect(data.error).toContain("disabled");
      }

      // Legacy routes work normally
      const bootstrapRes = await fetch(`${fixture.baseUrl}/api/bootstrap`);
      expect(bootstrapRes.status).toBe(200);
    } finally {
      fixture.close();
    }
  });
});

describe("Observatory enabled endpoints and SSE replay", () => {
  test("serves all 9 Observatory REST endpoints and policy updates", async () => {
    const fixture = await setupDashboardFixture({ observatory: true });
    try {
      const { cookie } = await fixture.login();
      expect(cookie).not.toBeNull();
      // Trigger one probe to seed data
      await fixture.obsCoordinator!.pollOnce();
      // 1. Overview
      const overviewRes = await fetch(`${fixture.baseUrl}/api/observatory/overview`, { headers: { cookie: cookie! } });
      expect(overviewRes.status).toBe(200);
      const overview = (await overviewRes.json()) as {
        capabilities: { collectorSessions: boolean };
        totals: { identities: number; activeSessions?: number };
        identities: unknown[];
      };
      expect(overview.capabilities.collectorSessions).toBe(false);
      expect(overview.totals.activeSessions).toBeUndefined();
      expect(overview.totals.identities).toBeGreaterThanOrEqual(1);
      expect(overview.identities.length).toBeGreaterThanOrEqual(1);
      // 1b. Live
      const liveRes = await fetch(`${fixture.baseUrl}/api/observatory/live`, { headers: { cookie: cookie! } });
      expect(liveRes.status).toBe(200);
      const liveData = (await liveRes.json()) as {
        capabilities: { collectorSessions: boolean };
        totals: { identitiesCount: number; activeSessionsCount?: number };
        agentrouter: unknown[];
      };
      expect(liveData.capabilities.collectorSessions).toBe(false);
      expect(liveData.totals.activeSessionsCount).toBeUndefined();
      expect(liveData.totals.identitiesCount).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(liveData.agentrouter)).toBe(true);
      // 2. Quotas
      const quotasRes = await fetch(`${fixture.baseUrl}/api/observatory/quotas`, { headers: { cookie: cookie! } });
      expect(quotasRes.status).toBe(200);
      const quotas = (await quotasRes.json()) as {
        quotas: Array<{
          identityId: string;
          provider: string;
          windowId: string;
          usedFraction: number;
          remainingFraction: number | null;
          status: string;
          source?: string | null;
        }>;
      };
      expect(quotas.quotas.length).toBeGreaterThanOrEqual(1);
      const targetQuota = quotas.quotas.find((q) => q.windowId === "5h" && q.provider === "openai-codex");
      expect(targetQuota).toBeDefined();
      expect(targetQuota!.identityId).toBe("a".repeat(64));
      expect(targetQuota!.provider).toBe("openai-codex");
      expect(targetQuota!.windowId).toBe("5h");
      expect(targetQuota!.usedFraction).toBe(0.25);
      expect(targetQuota!.remainingFraction).toBe(0.75);
      expect(targetQuota!.status).toBe("ok");
      const identitiesRes = await fetch(`${fixture.baseUrl}/api/observatory/identities`, { headers: { cookie: cookie! } });
      expect(identitiesRes.status).toBe(200);
      const identities = (await identitiesRes.json()) as { identities: unknown[] };
      expect(identities.identities.length).toBeGreaterThanOrEqual(1);

      // 4. Hosts
      const hostsRes = await fetch(`${fixture.baseUrl}/api/observatory/hosts`, { headers: { cookie: cookie! } });
      expect(hostsRes.status).toBe(200);
      const hosts = (await hostsRes.json()) as { hosts: unknown[] };
      expect(hosts.hosts.length).toBeGreaterThanOrEqual(1);

      // 5. Sessions
      const sessionsRes = await fetch(`${fixture.baseUrl}/api/observatory/sessions`, { headers: { cookie: cookie! } });
      expect(sessionsRes.status).toBe(200);
      const sessions = (await sessionsRes.json()) as {
        sessions: unknown[];
        capabilities: { collectorSessions: boolean };
      };
      expect(sessions.capabilities.collectorSessions).toBe(false);
      expect(sessions.sessions.length).toBe(0);
      // 6. Events
      const eventsRes = await fetch(`${fixture.baseUrl}/api/observatory/events`, { headers: { cookie: cookie! } });
      expect(eventsRes.status).toBe(200);
      const events = (await eventsRes.json()) as { events: unknown[] };
      expect(Array.isArray(events.events)).toBe(true);

      // 7. Policies GET & PUT
      const policiesRes = await fetch(`${fixture.baseUrl}/api/observatory/policies`, { headers: { cookie: cookie! } });
      expect(policiesRes.status).toBe(200);
      const policiesData = (await policiesRes.json()) as { policies: unknown[] };
      expect(Array.isArray(policiesData.policies)).toBe(true);

      const putPolicyRes = await fetch(`${fixture.baseUrl}/api/observatory/policies`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: fixture.baseUrl, cookie: cookie! },
        body: JSON.stringify({
          policy: {
            target: "global",
            enabled: true,
            silenced: false,
            telegramImmediate: true,
            minSeverity: "warning",
            channels: ["telegram"],
          },
        }),
      });
      expect(putPolicyRes.status).toBe(200);

      // 8. Health
      const healthRes = await fetch(`${fixture.baseUrl}/api/observatory/health`, { headers: { cookie: cookie! } });
      expect(healthRes.status).toBe(200);
      const health = (await healthRes.json()) as {
        status: string;
        services: Array<{ name: string }>;
      };
      expect(health.status).toBe("ok");
      expect(health.services.length).toBeGreaterThanOrEqual(3);

      // 9. Synthetic delivery test hook
      const testDeliveryRes = await fetch(`${fixture.baseUrl}/api/observatory/deliveries/test`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixture.baseUrl, cookie: cookie! },
        body: JSON.stringify({ severity: "info" }),
      });
      expect(testDeliveryRes.status).toBe(201);
      const testDelivery = (await testDeliveryRes.json()) as {
        delivery: { status: string };
      };
      expect(testDelivery.delivery.status).toBeDefined();
    } finally {
      fixture.close();
    }
  });

  test("SSE stream connects, receives heartbeat, and replays missed events", async () => {
    const fixture = await setupDashboardFixture({ observatory: true });
    try {
      const { cookie } = await fixture.login();
      expect(cookie).not.toBeNull();
      // Record a test event to replay
      const candidate = {
        eventType: "quota_reset" as const,
        severity: "info" as const,
        fingerprint: "test-fp-1",
        occurredAt: new Date().toISOString(),
        title: "Quota Reset Test",
        message: "Reset confirmed for testing",
      };
      const { event } = fixture.obsStore!.recordEvent(candidate);

      // Connect to SSE stream with lastEventId replay query
      const sseRes = await fetch(`${fixture.baseUrl}/api/observatory/stream?lastEventId=${event.eventId}`, {
        headers: { cookie: cookie! },
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

      const reader = sseRes.body?.getReader();
      expect(reader).toBeDefined();

      const decoder = new TextDecoder();
      let chunk = "";
      try {
        const { value } = await reader!.read();
        if (value) chunk += decoder.decode(value);
      } finally {
        await reader?.cancel();
      }

      expect(chunk).toContain(": connected");
    } finally {
      fixture.close();
    }
  });
});

describe("Observatory collector-backed sessions capability and privacy", () => {
  test("truthfully exposes collectorSessions capability and omits identityId when collector is enabled", async () => {
    const fixture = await setupDashboardFixture({ observatory: true, collector: true });
    try {
      const { cookie } = await fixture.login();
      expect(cookie).not.toBeNull();

      // Seed a host and session summary
      fixture.obsStore!.upsertHost({
        hostId: "node-collector-1",
        operatorLabel: "workstation-1",
        platform: "linux-x64",
        collectorVersion: "1.0.0",
        lastSeenAt: "2026-09-01T12:00:00.000Z",
        observedAt: "2026-09-01T12:00:00.000Z",
        status: "online",
        activeSessionsCount: 1,
        activeIdentitiesCount: 0,
      });

      fixture.obsStore!.upsertSessionSummary({
        sessionId: "sess-collector-100",
        hostId: "node-collector-1",
        identityId: "secret-should-be-omitted",
        status: "active",
        startedAt: "2026-09-01T12:00:00.000Z",
        model: "claude-3-7-sonnet",
        provider: "anthropic",
        durationMs: 12000,
        totalTokens: 500,
        contextBps: 2000,
        costEstimate: 0.05,
        costTrust: "estimated",
      });

      // Bootstrap check
      const bootstrapRes = await fetch(`${fixture.baseUrl}/api/bootstrap`, { headers: { cookie: cookie! } });
      expect(bootstrapRes.status).toBe(200);
      const bootstrap = (await bootstrapRes.json()) as {
        capabilities: { observatory: boolean; collectorSessions: boolean };
      };
      expect(bootstrap.capabilities.observatory).toBe(true);
      expect(bootstrap.capabilities.collectorSessions).toBe(true);

      // Overview check with collector enabled
      const overviewRes = await fetch(`${fixture.baseUrl}/api/observatory/overview`, { headers: { cookie: cookie! } });
      expect(overviewRes.status).toBe(200);
      const overview = (await overviewRes.json()) as {
        capabilities: { collectorSessions: boolean };
        totals: { activeSessions?: number };
        sessions: Array<Record<string, unknown>>;
        hosts: Array<{ hostId: string; activeSessionsCount: number | null }>;
      };
      expect(overview.capabilities.collectorSessions).toBe(true);
      expect(overview.totals.activeSessions).toBe(1);
      expect(overview.sessions.length).toBe(1);
      expect(overview.sessions[0].sessionId).toBe("sess-collector-100");
      expect(overview.sessions[0].identityId).toBeUndefined();
      const collectorHost = overview.hosts.find((h) => h.hostId === "node-collector-1");
      expect(collectorHost?.activeSessionsCount).toBe(1);

      // Sessions endpoint check
      const sessionsRes = await fetch(`${fixture.baseUrl}/api/observatory/sessions`, { headers: { cookie: cookie! } });
      expect(sessionsRes.status).toBe(200);
      const sessionsData = (await sessionsRes.json()) as {
        capabilities: { collectorSessions: boolean };
        sessions: Array<Record<string, unknown>>;
      };
      expect(sessionsData.capabilities.collectorSessions).toBe(true);
      expect(sessionsData.sessions.length).toBe(1);
      expect(sessionsData.sessions[0].sessionId).toBe("sess-collector-100");
      // Identity attribution must be omitted from public session DTO
      expect(sessionsData.sessions[0].identityId).toBeUndefined();

      // Health endpoint check
      const healthRes = await fetch(`${fixture.baseUrl}/api/observatory/health`, { headers: { cookie: cookie! } });
      expect(healthRes.status).toBe(200);
      const healthData = (await healthRes.json()) as {
        capabilities: { collectorSessions: boolean };
        services: Array<{ name: string; status: string }>;
      };
      expect(healthData.capabilities.collectorSessions).toBe(true);
      expect(healthData.services.some((s) => s.name === "Collector ingestion")).toBe(true);
    } finally {
      fixture.close();
    }
  });
});
describe("Secret exclusion and privacy invariants", () => {
  test("never returns account passwords or secret tokens in public API responses", async () => {
    const fixture = await setupDashboardFixture({ observatory: true });
    try {
      const { cookie } = await fixture.login();
      expect(cookie).not.toBeNull();
      // Create an account with password
      const secretPassword = "super_secret_github_password_999";
      const createRes = await fetch(`${fixture.baseUrl}/api/accounts`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: fixture.baseUrl, cookie: cookie! },
        body: JSON.stringify({
          id: "secret-test-account",
          label: "Secret Test Account",
          githubUsername: "test-user",
          githubPassword: secretPassword,
          enabled: true,
          runOrder: 1,
        }),
      });
      expect(createRes.status).toBe(201);
      const createdData = (await createRes.json()) as {
        account: { githubPassword?: string };
      };
      // Password must not be returned in create response
      expect(createdData.account.githubPassword).toBeUndefined();
      expect(JSON.stringify(createdData)).not.toContain(secretPassword);

      // Password must not be in /api/bootstrap
      const bootstrapRes = await fetch(`${fixture.baseUrl}/api/bootstrap`, { headers: { cookie: cookie! } });
      const bootstrapText = await bootstrapRes.text();
      expect(bootstrapText).not.toContain(secretPassword);

      // Password must not be in /api/overview
      const overviewRes = await fetch(`${fixture.baseUrl}/api/overview`, { headers: { cookie: cookie! } });
      const overviewText = await overviewRes.text();
      expect(overviewText).not.toContain(secretPassword);

      // Password must not be in Observatory overview
      const obsOverviewRes = await fetch(`${fixture.baseUrl}/api/observatory/overview`, { headers: { cookie: cookie! } });
      const obsOverviewText = await obsOverviewRes.text();
      expect(obsOverviewText).not.toContain(secretPassword);
    } finally {
      fixture.close();
    }
  });
});
