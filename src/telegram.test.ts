import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { createDashboardAuth } from "./dashboard-auth";
import type { RunSnapshot } from "./storage";
import { Store } from "./storage";
import { ObservatoryStore } from "./observatory/store";
import {
  buildBalancesMessage,
  buildBalancesMessages,
  buildDashboardMessage,
  buildHelpMessage,
  buildQuotasMessages,
  buildStatusMessage,
  buildStatusMessages,
  buildStrangerTaunt,
  commandMenuMarkup,
  COMMAND_MENU,
  isCurrentBudapestDay,
  selectUnifiedAccountSnapshots,
  TelegramNotifier,
  type TelegramUpdate,
} from "./telegram";
const resources: Array<{ directory: string; store: Store }> = [];

interface FakeSendBody {
  text?: string;
  chat_id?: string;
  reply_markup?: { inline_keyboard?: unknown[][] };
}

function sendBody(value: unknown): FakeSendBody {
  const out: FakeSendBody = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") out.text = record.text;
  if (typeof record.chat_id === "string") out.chat_id = record.chat_id;
  const markup = record.reply_markup;
  if (markup && typeof markup === "object" && !Array.isArray(markup)) {
    const markupRecord = markup as Record<string, unknown>;
    if (Array.isArray(markupRecord.inline_keyboard)) {
      out.reply_markup = { inline_keyboard: markupRecord.inline_keyboard };
    }
  }
  return out;
}

function config(stateFilePath: string, overrides: Partial<AppConfig["telegram"]> = {}): AppConfig {
  return {
    baseUrl: "https://agentrouter.org",
    requestTimeoutMs: 45_000,
    loginTimeoutMs: 120_000,
    dashboardPort: 8456,
    dashboardHost: "100.127.29.78",
    dashboardAllowedOrigins: ["http://100.127.29.78:8456"],
    dataDir: "data",
    screenshotDir: "data/screenshots",
    accountStateDir: "data/states",
    browserProfileDir: "data/browser-profiles",
    browserChannel: "chromium",
    accountFilePath: "data/accounts.json",
    settingsFilePath: "data/settings.json",
    dbPath: ":memory:",
    antigravity: {
      enabled: false,
      dbPath: ":memory:",
      encryptionKey: null,
      probeIntervalMinutes: 5,
      probeTimeoutMs: 30_000,
      catalogIntervalMinutes: 60,
      oauthClientId: "test-client-id",
      oauthClientSecret: null,
      oauthRedirectUri: "http://localhost:51121/oauth-callback",
    },
    maxRecentRuns: 500,
    disableWebAuthn: true,
    ompQuota: {
      enabled: false,
      executable: "node_modules/.bin/omp",
      brokerUrl: null,
      stateFilePath: "data/omp-quota-state.json",
      intervalMinutes: 5,
      timeoutMs: 45_000,
      lowRemainingPct: 10,
    },
    telegram: {
      botToken: `12345678:${"A".repeat(40)}`,
      chatId: "123456789",
      allowedUsername: "bromoketone",
      stateFilePath,
      lowBalanceUsd: 50,
      largeDropUsd: 25,
      repeatedFailureCount: 3,
      graphsEnabled: false,
      dashboardUrl: "http://100.127.29.78:8456",
      ...overrides,
    },
    observatory: {
      enabled: false,
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
      enabled: false,
      host: "127.0.0.1",
      port: 8457,
      publicOrigin: "https://bkserver.tailbbaa91.ts.net:8457",
      registryFilePath: null,
      tailscaleExecutablePath: null,
      proxyTokenFilePath: null,
    },
    dashboardAuth: createDashboardAuth({
      env: {
        DASHBOARD_API_KEY: "k".repeat(32),
      },
      host: "100.127.29.78",
    }),
  };
}

function snapshot(
  startedAt: string,
  balance: number,
  overrides: Partial<RunSnapshot> = {},
): RunSnapshot {
  const endedAt = new Date(new Date(startedAt).getTime() + 5_000).toISOString();
  return {
    accountId: "account-1",
    accountLabel: "Primary",
    startedAt,
    endedAt,
    status: "ok",
    loginMs: 2_000,
    dashboardMs: 500,
    totalMs: 5_000,
    summary: {},
    metrics: { balance, consumed: 75 },
    usagePoints: [],
    apiCalls: [],
    loggedOut: true,
    sessionReused: false,
    ...overrides,
  };
}

function fakeTelegram(username = "bromoketone") {
  const calls: Array<{ method: string; body: unknown }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = url.split("/").at(-1)!;
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    calls.push({ method, body });
    const result = method === "getChat"
      ? { id: 123456789, type: "private", username }
      : { message_id: calls.length };
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetcher };
}

async function fixture(overrides: Partial<AppConfig["telegram"]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agentrouter-telegram-test-"));
  const store = new Store(":memory:");
  resources.push({ directory, store });
  const telegram = fakeTelegram();
  const appConfig = config(join(directory, "telegram-state.json"), overrides);
  return { directory, store, telegram, appConfig };
}

afterEach(async () => {
  while (resources.length > 0) {
    const resource = resources.pop()!;
    resource.store.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

describe("TelegramNotifier", () => {
  test("locks delivery to the configured private username", async () => {
    const { store, appConfig } = await fixture();
    const telegram = fakeTelegram("someone_else");
    await expect(TelegramNotifier.create(appConfig, store, telegram.fetcher)).rejects.toThrow(
      "did not match",
    );
    expect(telegram.calls.map((call) => call.method)).toEqual(["getChat"]);
  });

  test("sends each confirmed grant exactly once", async () => {
    const { store, telegram, appConfig } = await fixture();
    store.saveRun(snapshot("2026-08-09T10:00:00.000Z", 100));
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);
    expect(notifier).not.toBeNull();

    const grantRun = snapshot("2026-08-09T11:00:00.000Z", 125, {
      summary: {
        creditGrantEvents: [{
          sourceEventId: "grant-1",
          occurredAt: 1_786_286_400,
          amount: 25,
          classification: "daily-signin",
          description: "daily sign-in",
        }],
      },
    });
    const runId = store.saveRun(grantRun);
    await notifier!.processRun(runId, grantRun);
    await notifier!.processRun(runId, grantRun);

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    const payload = messages[0].body as { text: string };
    expect(payload.text).toContain("Grant evidence and a balance increase");
    expect(payload.text).toContain("Captured grant logs");
    expect(payload.text).toContain("+$25.00");
    expect(payload.text.length).toBeLessThanOrEqual(1_024);
  });

  test("alerts on a positive balance delta without claiming an unconfirmed grant", async () => {
    const { store, telegram, appConfig } = await fixture();
    store.saveRun(snapshot("2026-08-09T10:00:00.000Z", 100.88));
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);

    const increased = snapshot("2026-08-09T11:00:00.000Z", 367.88);
    await notifier!.processRun(store.saveRun(increased), increased);

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    const payload = messages[0].body as { text: string };
    expect(payload.text).toContain("balance increased");
    expect(payload.text).toContain("+$267.00");
    expect(payload.text).toContain(
      "observed balance increase, not a confirmed grant",
    );
    expect(payload.text.length).toBeLessThanOrEqual(1_024);
  });

  test("alerts once for a material endpoint increase without mislabeling it as a grant", async () => {
    const { store, telegram, appConfig } = await fixture();
    store.saveEndpointObservation({
      accountId: "account-1",
      accountLabel: "Primary",
      observedAt: "2026-08-15T00:00:00.000Z",
      status: "ok",
      balance: 100,
      consumed: 75,
      requestCount: 20,
      sourcePath: "/api/user/self",
      latencyMs: 20,
    });
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);
    const id = store.saveEndpointObservation({
      accountId: "account-1",
      accountLabel: "Primary",
      observedAt: "2026-08-15T00:01:00.000Z",
      status: "ok",
      balance: 125,
      consumed: 75,
      requestCount: 23,
      sourcePath: "/api/user/self",
      latencyMs: 20,
    });

    await notifier!.processEndpointObservation(store.getEndpointBalanceObservation(id)!);

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    const payload = messages[0].body as { text: string };
    expect(payload.text).toContain("+$25.00");
    expect(payload.text).toContain("read-only endpoint observation");
    expect(payload.text).not.toContain("grant confirmed");
    expect(payload.text).toContain("Request change:</b> +3");
  });

  test("can replay a previously missed positive balance observation", async () => {
    const { store, telegram, appConfig } = await fixture();
    store.saveRun(snapshot("2026-08-09T10:00:00.000Z", 100));
    const increased = snapshot("2026-08-09T11:00:00.000Z", 125);
    const runId = store.saveRun(increased);
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);

    await notifier!.sendObservationAlert(runId);

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0].body)).toContain("+$25.00");
  });

  test("combines low-balance and large-drop signals without repeated low alerts", async () => {
    const { store, telegram, appConfig } = await fixture();
    store.saveRun(snapshot("2026-08-09T10:00:00.000Z", 100));
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);

    const dropped = snapshot("2026-08-09T11:00:00.000Z", 40);
    await notifier!.processRun(store.saveRun(dropped), dropped);
    const stillLow = snapshot("2026-08-09T12:00:00.000Z", 39);
    await notifier!.processRun(store.saveRun(stillLow), stillLow);

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0].body)).toContain("Low balance after a large decrease");
  });

  test("reports a negative balance as a low-balance decrease with signed money", async () => {
    const { store, telegram, appConfig } = await fixture();
    store.saveRun(snapshot("2026-08-09T10:00:00.000Z", 33.34));
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);

    const negative = snapshot("2026-08-09T11:00:00.000Z", -0.12, {
      metrics: { balance: -0.12, consumed: 275.12 },
    });
    await notifier!.processRun(store.saveRun(negative), negative);

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    const payload = messages[0].body as { text: string };
    expect(payload.text).toContain("Low balance after a large decrease");
    expect(payload.text).toContain("-$0.12");
    expect(payload.text).toContain("-$33.46");
  });

  test("alerts only after repeated failures and once when monitoring recovers", async () => {
    const { store, telegram, appConfig } = await fixture({
      lowBalanceUsd: 0,
      largeDropUsd: 0,
    });
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);

    for (let hour = 10; hour <= 13; hour += 1) {
      const failed = snapshot(`2026-08-09T${hour}:00:00.000Z`, 0, {
        status: "error",
        metrics: {},
        loggedOut: false,
        errorMessage: "OAuth timeout",
      });
      await notifier!.processRun(store.saveRun(failed), failed);
    }
    const recovered = snapshot("2026-08-09T14:00:00.000Z", 100);
    await notifier!.processRun(store.saveRun(recovered), recovered);

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[0].body)).toContain("Repeated AgentRouter checks are failing");
    expect(JSON.stringify(messages[1].body)).toContain("monitoring recovered");
  });

  test("sends OMP quota reset notification", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);

    await notifier!.sendOmpQuotaReset({
      provider: "openai-codex",
      usedFraction: 0.1,
      remainingPct: 90,
      resetAt: "2026-09-07T12:00:00.000Z",
      observedAt: "2026-08-31T12:00:00.000Z",
    });

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    const text = JSON.stringify(messages[0].body);
    expect(text).toContain("OMP ChatGPT quota reset");
    expect(text).toContain("90%");
    expect(text).not.toContain("token");
    expect(text).not.toContain("broker");
  });

  test("sends OMP quota low notification with threshold", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);

    await notifier!.sendOmpQuotaLow(
      {
        provider: "openai-codex",
        usedFraction: 0.95,
        remainingPct: 5,
        resetAt: "2026-09-07T12:00:00.000Z",
        observedAt: "2026-08-31T12:00:00.000Z",
      },
      10,
    );

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    const text = JSON.stringify(messages[0].body);
    expect(text).toContain("OMP ChatGPT quota low");
    expect(text).toContain("5%");
    expect(text).toContain("threshold: 10%");
  });

  test("sends OMP quota failure and recovery notifications", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);

    await notifier!.sendOmpQuotaFailure(3, "Probe timed out");
    await notifier!.sendOmpQuotaRecovery({
      provider: "openai-codex",
      usedFraction: 0.15,
      remainingPct: 85,
      resetAt: "2026-09-07T12:00:00.000Z",
      observedAt: "2026-08-31T12:00:00.000Z",
    });

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[0].body)).toContain("OMP quota monitoring is failing");
    expect(JSON.stringify(messages[0].body)).toContain("Consecutive failures:</b> 3");
    expect(JSON.stringify(messages[0].body)).toContain("Probe timed out");
    expect(JSON.stringify(messages[1].body)).toContain("OMP quota monitoring recovered");
    expect(JSON.stringify(messages[1].body)).toContain("85%");
  });

  test("processOmpQuotaTransition routes all transition types", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = await TelegramNotifier.create(appConfig, store, telegram.fetcher);

    const obs = {
      provider: "openai-codex" as const,
      usedFraction: 0.2,
      remainingPct: 80,
      resetAt: "2026-09-07T12:00:00.000Z",
      observedAt: "2026-08-31T12:00:00.000Z",
    };

    await notifier!.processOmpQuotaTransition({ type: "reset", observation: obs, previousResetAt: "2026-08-31" });
    await notifier!.processOmpQuotaTransition({ type: "low_remaining", observation: obs, thresholdPct: 10 });
    await notifier!.processOmpQuotaTransition({ type: "repeated_failure", consecutiveFailures: 3, errorCategory: "CLI process exited with error" });
    await notifier!.processOmpQuotaTransition({ type: "recovery", observation: obs, previousFailures: 3 });

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(4);
  });
  test("quota command formatter covers a complete broker inventory", () => {
    const quotas = Array.from({ length: 37 }, (_, index) => ({
      provider: index < 3 ? "openai-codex" : "google-antigravity",
      identityLabel: index < 3 ? "ChatGPT" : `Antigravity ${Math.floor((index - 3) / 4) + 1}`,
      windowName: `weekly-window-${index}`,
      usedPct: index % 101,
      resetsAt: "2026-09-07T12:00:00.000Z",
      status: "ok",
    }));
    const pages = buildQuotasMessages({
      quotas,
      dashboardUrl: "https://dashboard.example/observatory/",
    });
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every((page) => page.length <= 4_096)).toBe(true);
    const combined = pages.join("\n");
    expect(combined).toContain("OpenAI Codex / ChatGPT");
    expect(combined).toContain("Google Antigravity");
    expect(combined).toContain("weekly-window-36");
  });
  test("quota formatter hard-bounds one oversized identity and dashboard URL", () => {
    const quotas = Array.from({ length: 200 }, (_, index) => ({
      provider: "google-antigravity",
      identityLabel: "identity-" + "&".repeat(10_000),
      windowName: `window-${index}-` + "&".repeat(10_000),
      usedPct: 50,
      resetsAt: "2026-09-07T12:00:00.000Z",
      status: "ok",
    }));
    const pages = buildQuotasMessages({
      quotas,
      dashboardUrl: `https://dashboard.example/?q=${"&".repeat(450)}`,
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length <= 4_096)).toBe(true);
    expect(pages.join("\n")).toContain("window-199");
  });
  test("quota formatter safely groups prototype-like provider names", () => {
    const pages = buildQuotasMessages({
      quotas: [{
        provider: "__proto__",
        identityLabel: "x",
        windowName: "w",
        usedPct: 0,
        status: "ok",
      }],
      dashboardUrl: "x",
    });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain("__proto__");
    expect(pages[0].length).toBeLessThanOrEqual(4_096);
  });

  test("rejects command updates from unauthorized chat or username", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = (await TelegramNotifier.create(appConfig, store, telegram.fetcher))!;

    const unauthorizedChat: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: "999999999", type: "private" },
        from: { id: 123456789, is_bot: false, first_name: "Owner", username: "bromoketone" },
        date: Math.floor(Date.now() / 1000),
        text: "/status",
      },
    };
    const outcomeChat = await notifier.processCommandUpdate(unauthorizedChat, { store });
    expect(outcomeChat).toBe("ignored");

    const unauthorizedUser: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 102,
        chat: { id: "123456789", type: "private" },
        from: { id: 987654321, is_bot: false, first_name: "Attacker", username: "stranger" },
        date: Math.floor(Date.now() / 1000),
        text: "/status",
      },
    };
    const outcomeUser = await notifier.processCommandUpdate(unauthorizedUser, { store });
    expect(outcomeUser).toBe("ignored");

    // Strangers receive only the taunt, never command data.
    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      const body = sendBody(message.body);
      expect(body.text).toContain("Wrong door");
      expect(body.text).not.toContain("Portfolio");
      expect(body.text).not.toContain("Observatory controls");
      expect(body.text).not.toContain("http");
      expect(body.text).not.toContain("$");
    }
    expect(messages.some((call) => sendBody(call.body).chat_id === "999999999")).toBe(true);
    expect(messages.some((call) => sendBody(call.body).chat_id === "123456789")).toBe(true);
  });

  test("responds to /start and /help commands with authorized username and dashboard link", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = (await TelegramNotifier.create(appConfig, store, telegram.fetcher))!;

    const helpUpdate: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: "123456789", type: "private" },
        from: { id: 123456789, is_bot: false, first_name: "Owner", username: "bromoketone" },
        date: Math.floor(Date.now() / 1000),
        text: "/help",
      },
    };
    const outcome = await notifier.processCommandUpdate(helpUpdate, { store });
    expect(outcome).toBe("acknowledged");

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    const text = (messages[0].body as { text: string }).text;
    expect(text).toContain("AI Fleet Observatory Bot");
    expect(text).toContain("@bromoketone");
    expect(text).toContain("/status");
    expect(text).toContain("/quotas");
    expect(text).toContain("/balance");
  });

  test("responds to /ping and /dashboard commands", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = (await TelegramNotifier.create(appConfig, store, telegram.fetcher))!;

    const pingUpdate: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: "123456789", type: "private" },
        from: { id: 123456789, is_bot: false, first_name: "Owner", username: "bromoketone" },
        date: Math.floor(Date.now() / 1000),
        text: "/ping",
      },
    };
    const pingOutcome = await notifier.processCommandUpdate(pingUpdate, { store });
    expect(pingOutcome).toBe("acknowledged");

    const dashUpdate: TelegramUpdate = {
      update_id: 2,
      message: {
        message_id: 102,
        chat: { id: "123456789", type: "private" },
        from: { id: 123456789, is_bot: false, first_name: "Owner", username: "bromoketone" },
        date: Math.floor(Date.now() / 1000),
        text: "/dashboard",
      },
    };
    const dashOutcome = await notifier.processCommandUpdate(dashUpdate, { store });
    expect(dashOutcome).toBe("acknowledged");

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(2);
    expect((messages[0].body as { text: string }).text).toContain("Pong!");
    expect((messages[1].body as { text: string }).text).toContain("AI Fleet Observatory Dashboard");
  });

  test("selectUnifiedAccountSnapshots unifies Observatory and Store observations coherently", () => {
    const store = new Store(":memory:");
    const obsStore = new ObservatoryStore(":memory:");

    // 1. account-1 has older Observatory endpoint (12:00) and newer Observatory run (12:30)
    obsStore.upsertAgentRouterAccount({ accountId: "account-1", accountLabel: "Primary Obs" });
    obsStore.recordAgentRouterEndpointObservation({
      accountId: "account-1",
      accountLabel: "Primary Obs",
      observedAt: "2026-09-01T12:00:00.000Z",
      status: "ok",
      balance: 100,
      consumed: 10,
      requestCount: 5,
      latencyMs: 15,
    });
    obsStore.recordAgentRouterRun({
      id: 1,
      accountId: "account-1",
      accountLabel: "Primary Obs",
      startedAt: "2026-09-01T12:30:00.000Z",
      endedAt: "2026-09-01T12:30:05.000Z",
      status: "ok",
      loginMs: 1000,
      dashboardMs: 200,
      totalMs: 1200,
      loggedOut: true,
      sessionReused: false,
      balance: 150,
      consumed: 20,
      requestCount: 8,
    });

    // Check Observatory resolution: newer run (150 balance) wins over endpoint (100 balance)
    const snapsObs = selectUnifiedAccountSnapshots({ store, observatoryStore: obsStore });
    expect(snapsObs).toHaveLength(1);
    expect(snapsObs[0].balance).toBe(150);
    expect(snapsObs[0].consumed).toBe(20);

    // 2. Now Store has an even newer endpoint observation for account-1 (13:00)
    store.saveEndpointObservation({
      accountId: "account-1",
      accountLabel: "Primary Store",
      observedAt: "2026-09-01T13:00:00.000Z",
      status: "ok",
      balance: 175,
      consumed: 25,
      requestCount: 12,
      latencyMs: 15,
    });

    // 3. Store also has account-legacy (Store-only)
    store.saveRun(snapshot("2026-09-01T11:00:00.000Z", 50, {
      accountId: "account-legacy",
      accountLabel: "Legacy Account",
    }));

    const snapsUnion = selectUnifiedAccountSnapshots({ store, observatoryStore: obsStore });
    expect(snapsUnion).toHaveLength(2);

    const acct1 = snapsUnion.find((s) => s.accountId === "account-1")!;
    expect(acct1.balance).toBe(175);
    expect(acct1.consumed).toBe(25);
    expect(acct1.requestCount).toBe(12);
    expect(acct1.lastObservedAt).toBe("2026-09-01T13:00:00.000Z");

    const legacy = snapsUnion.find((s) => s.accountId === "account-legacy")!;
    expect(legacy.label).toBe("Legacy Account");
    expect(legacy.balance).toBe(50);

    store.close();
    obsStore.close();
  });

  test("evaluates Budapest product day daily grants with real verified amounts and deduplicates across stores", () => {
    const store = new Store(":memory:");
    const obsStore = new ObservatoryStore(":memory:");

    obsStore.upsertAgentRouterAccount({ accountId: "account-1", accountLabel: "Primary" });
    obsStore.upsertAgentRouterAccount({ accountId: "account-2", accountLabel: "Secondary" });

    // Reference time: 2026-09-01 14:00 UTC = 2026-09-01 16:00 Budapest time
    const now = new Date("2026-09-01T14:00:00.000Z");

    // Same grant event exists in BOTH ObservatoryStore and legacy Store (sourceEventId: "grant-today-dup")
    obsStore.recordAgentRouterGrantEvent({
      runId: 1,
      accountId: "account-1",
      sourceEventId: "grant-today-dup",
      occurredAt: "2026-09-01T08:00:00.000Z",
      amount: 30.0,
      classification: "daily-signin",
    });

    store.saveRun(snapshot("2026-09-01T08:00:00.000Z", 100, {
      accountId: "account-1",
      accountLabel: "Primary",
      summary: {
        creditGrantEvents: [
          {
            sourceEventId: "grant-today-dup",
            occurredAt: 1_788_249_600, // 2026-09-01T08:00:00.000Z
            amount: 30.0,
            classification: "daily-signin",
            description: "daily signin",
          },
        ],
      },
    }));

    // Second distinct grant today without sourceEventId (store-specific fallback)
    obsStore.recordAgentRouterGrantEvent({
      runId: 2,
      accountId: "account-1",
      sourceEventId: "grant-today-extra",
      occurredAt: "2026-09-01T10:00:00.000Z",
      amount: 5.0,
      classification: "daily-signin",
    });

    // Yesterday's grant for account-2 in Budapest (2026-08-31)
    obsStore.recordAgentRouterGrantEvent({
      runId: 3,
      accountId: "account-2",
      sourceEventId: "grant-yesterday",
      occurredAt: "2026-08-31T08:00:00.000Z",
      amount: 25.0,
      classification: "daily-signin",
    });

    const snapshots = selectUnifiedAccountSnapshots({ store, observatoryStore: obsStore }, now);
    const snap1 = snapshots.find((s) => s.accountId === "account-1")!;
    const snap2 = snapshots.find((s) => s.accountId === "account-2")!;

    // account-1 has 30 (deduplicated) + 5 = 35
    expect(snap1.dailyGrantConfirmed).toBe(true);
    expect(snap1.dailyGrantAmount).toBe(35.0);

    // account-2 yesterday grant -> not confirmed today
    expect(snap2.dailyGrantConfirmed).toBe(false);
    expect(snap2.dailyGrantAmount).toBeNull();

    store.close();
    obsStore.close();
  });

  test("handles quota usage percentage calculation when remainingFraction is null", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = (await TelegramNotifier.create(appConfig, store, telegram.fetcher))!;
    const obsStore = new ObservatoryStore(":memory:");

    obsStore.upsertIdentity({
      identityId: "ident-null-rem",
      kind: "credential",
      sourceHostId: "node-1",
      provider: "google-antigravity",
      label: "Antigravity Pro",
      observedAt: "2026-09-01T12:00:00.000Z",
      health: "healthy",
      disabled: false,
      blocked: false,
    });
    obsStore.recordQuotaObservation({
      identityId: "ident-null-rem",
      provider: "google-antigravity",
      bucketId: "daily",
      windowId: "w1",
      usedFraction: 0.65,
      remainingFraction: undefined,
      observedAt: "2026-09-01T12:00:00.000Z",
      status: "ok",
    });

    const quotasUpdate: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: "123456789", type: "private" },
        from: { id: 123456789, is_bot: false, first_name: "Owner", username: "bromoketone" },
        date: Math.floor(Date.now() / 1000),
        text: "/quotas",
      },
    };

    const outcome = await notifier.processCommandUpdate(quotasUpdate, { store, observatoryStore: obsStore });
    expect(outcome).toBe("acknowledged");

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    const text = (messages[0].body as { text: string }).text;
    expect(text).toContain("65%");
    expect(text).toContain("Google Antigravity");
    obsStore.close();
  });

  test("bounds all command outputs to <=4096 chars with HTML-safe pagination", () => {
    // 1. Huge balances inventory with HTML entity expansions
    const accounts = Array.from({ length: 80 }, (_, i) => ({
      label: `Account & Co. ${i + 1} <Tier ${i + 1}> "Special"`,
      balance: 100.5 + i,
      consumed: 20.25,
      requestCount: 1500,
      status: "ok",
      lastObservedAt: "2026-09-01T12:00:00.000Z",
      dailyGrantConfirmed: true,
      dailyGrantAmount: 25.0,
    }));

    const balancePages = buildBalancesMessages({
      accounts,
      totalBalance: 10_000,
      totalConsumed: 1_500,
      dashboardUrl: "https://dashboard.example/observatory/?param=1&param2=2",
    });
    expect(balancePages.length).toBeGreaterThan(1);
    for (const page of balancePages) {
      expect(page.length).toBeLessThanOrEqual(4_096);
      expect(page).not.toContain("<Tier"); // properly escaped
      expect(page).toContain("&amp;");
    }

    // 2. Huge status inventory
    const statusPages = buildStatusMessages({
      agentrouterAccounts: accounts,
      totalBalance: 10_000,
      totalConsumed: 1_500,
      quotasSummary: {
        totalWindows: 12,
        warningCount: 1,
        identitiesCount: 4,
      },
      openAiWindows: [
        {
          name: "OpenAI Codex Main & Secondary",
          usedPct: 40,
          resetsIn: "resets in <1m & 30s>",
        },
      ],
      dashboardUrl: "https://dashboard.example/observatory/",
    });
    expect(statusPages.length).toBeGreaterThan(1);
    for (const page of statusPages) {
      expect(page.length).toBeLessThanOrEqual(4_096);
      expect(page).not.toContain("<1m"); // resetsIn properly escaped
    }
  });

  test("handles error classification, getUpdates errors, and listener teardown", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = (await TelegramNotifier.create(appConfig, store, telegram.fetcher))!;

    // 1. processCommandUpdate returns retryable_failure when sendMessage throws
    const badUpdate: TelegramUpdate = {
      update_id: 50,
      message: {
        message_id: 201,
        chat: { id: "123456789", type: "private" },
        from: { id: 123456789, is_bot: false, first_name: "Owner", username: "bromoketone" },
        date: Math.floor(Date.now() / 1000),
        text: "/ping",
      },
    };

    // Mock fetcher failure on sendMessage
    const failingTelegram = {
      fetcher: async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("sendMessage")) {
          return new Response(JSON.stringify({ ok: false, description: "Internal Telegram server error" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: true, result: { id: 123456789, type: "private", username: "bromoketone" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };

    const failingNotifier = (await TelegramNotifier.create(appConfig, store, failingTelegram.fetcher))!;
    const failureOutcome = await failingNotifier.processCommandUpdate(badUpdate, { store });
    expect(failureOutcome).toBe("retryable_failure");

    // 2. getUpdates throws with description on Telegram API rejection
    const rejectionTelegram = {
      fetcher: async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("getUpdates")) {
          return new Response(
            JSON.stringify({ ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true, result: { id: 123456789, type: "private", username: "bromoketone" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const rejectionNotifier = (await TelegramNotifier.create(appConfig, store, rejectionTelegram.fetcher))!;
    const rejectionTransport = rejectionNotifier["transport"] as unknown as {
      getUpdates: (offset: number, timeoutSeconds?: number) => Promise<TelegramUpdate[]>;
    };
    await expect(rejectionTransport.getUpdates(0, 1)).rejects.toThrow("Conflict: terminated by other getUpdates request");

    // 3. getUpdates throws descriptive error on invalid JSON
    const invalidJsonTelegram = {
      fetcher: async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("getUpdates")) {
          return new Response("<html>502 Bad Gateway</html>", {
            status: 502,
            headers: { "content-type": "text/html" },
          });
        }
        return new Response(JSON.stringify({ ok: true, result: { id: 123456789, type: "private", username: "bromoketone" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const invalidJsonNotifier = (await TelegramNotifier.create(appConfig, store, invalidJsonTelegram.fetcher))!;
    const invalidJsonTransport = invalidJsonNotifier["transport"] as unknown as {
      getUpdates: (offset: number, timeoutSeconds?: number) => Promise<TelegramUpdate[]>;
    };
    await expect(invalidJsonTransport.getUpdates(0, 1)).rejects.toThrow("invalid JSON");

    // 4. startCommandListener teardown aborts cleanly
    const stopListener = notifier.startCommandListener({ store });
    await expect(stopListener()).resolves.toBeUndefined();
  });

  test("responds to unknown commands with capped and escaped text", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = (await TelegramNotifier.create(appConfig, store, telegram.fetcher))!;

    const unknownUpdate: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 101,
        chat: { id: "123456789", type: "private" },
        from: { id: 123456789, is_bot: false, first_name: "Owner", username: "bromoketone" },
        date: Math.floor(Date.now() / 1000),
        text: `/unknown_${"<script>".repeat(50)}`,
      },
    };

    const outcome = await notifier.processCommandUpdate(unknownUpdate, { store });
    expect(outcome).toBe("acknowledged");

    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    const text = (messages[0].body as { text: string }).text;
    expect(text).toContain("Unknown command");
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
    expect(text.length).toBeLessThanOrEqual(4_096);
  });

  test("menu markup exposes exactly the owner command buttons", () => {
    const markup = commandMenuMarkup();
    const labels = markup.inline_keyboard.flat().map((button) => button.callback_data);
    expect(labels.sort()).toEqual(COMMAND_MENU.map(([, data]) => data).sort());
    for (const row of markup.inline_keyboard) {
      expect(row.length).toBeLessThanOrEqual(2);
    }
  });

  test("/menu returns the control buttons to the owner", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = (await TelegramNotifier.create(appConfig, store, telegram.fetcher))!;
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 201,
        chat: { id: "123456789", type: "private" },
        from: { id: 123456789, is_bot: false, first_name: "Owner", username: "bromoketone" },
        date: Math.floor(Date.now() / 1000),
        text: "/menu",
      },
    };
    expect(await notifier.processCommandUpdate(update, { store })).toBe("acknowledged");
    const message = telegram.calls.find((call) => call.method === "sendMessage");
    expect(message).toBeDefined();
    const body = sendBody(message?.body);
    expect(body.text).toContain("Observatory controls");
    expect(body.reply_markup?.inline_keyboard?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  test("/key returns the dashboard API key only to the owner with a provider", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = (await TelegramNotifier.create(appConfig, store, telegram.fetcher))!;
    const update: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 301,
        chat: { id: "123456789", type: "private" },
        from: { id: 123456789, is_bot: false, first_name: "Owner", username: "bromoketone" },
        date: Math.floor(Date.now() / 1000),
        text: "/key",
      },
    };
    await notifier.processCommandUpdate(update, { store, dashboardApiKey: "z".repeat(48) });
    const messages = telegram.calls.filter((call) => call.method === "sendMessage");
    expect(messages).toHaveLength(1);
    expect(sendBody(messages[0]?.body).text).toContain("Dashboard API key");
    expect(sendBody(messages[0]?.body).text).toContain("z".repeat(24));

    const withoutKey = await fixture();
    const bareNotifier = (await TelegramNotifier.create(withoutKey.appConfig, withoutKey.store, withoutKey.telegram.fetcher))!;
    await bareNotifier.processCommandUpdate(update, { store: withoutKey.store });
    const bareMessages = withoutKey.telegram.calls.filter((call) => call.method === "sendMessage");
    expect(bareMessages).toHaveLength(1);
    expect(sendBody(bareMessages[0]?.body).text).toContain("not available");
  });

  test("strangers get a taunt and never command data", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = (await TelegramNotifier.create(appConfig, store, telegram.fetcher))!;
    const intruder: TelegramUpdate = {
      update_id: 1,
      message: {
        message_id: 401,
        chat: { id: "987654321", type: "private" },
        from: { id: 987654321, is_bot: false, first_name: "Hacker", username: "hacker_dude" },
        date: Math.floor(Date.now() / 1000),
        text: "/balance",
      },
    };
    expect(await notifier.processCommandUpdate(intruder, { store })).toBe("ignored");
    const message = telegram.calls.find((call) => call.method === "sendMessage");
    expect(message).toBeDefined();
    const body = sendBody(message?.body);
    expect(body.chat_id).toBe("987654321");
    expect(body.text).toContain("Wrong door");
    expect(body.text).not.toContain("$");
  });

  test("stranger taunt helper is bounded and unhelpful", () => {
    const taunt = buildStrangerTaunt("somebody");
    expect(taunt).toContain("Wrong door");
    expect(taunt).toContain("owner-only");
    expect(taunt.length).toBeLessThanOrEqual(1_024);
  });

  test("owner callbacks dispatch commands; stranger callbacks are denied", async () => {
    const { store, telegram, appConfig } = await fixture();
    const notifier = (await TelegramNotifier.create(appConfig, store, telegram.fetcher))!;

    const ownerCallback: TelegramUpdate = {
      update_id: 5,
      callback_query: {
        id: "cb-owner-1",
        from: { id: 123456789, is_bot: false, first_name: "Owner", username: "bromoketone" },
        chat_instance: "chat-1",
        data: "cmd:ping",
        message: {
          message_id: 501,
          chat: { id: "123456789", type: "private" },
          date: Math.floor(Date.now() / 1000),
        },
      },
    };
    expect(await notifier.processCallbackQuery(ownerCallback, { store })).toBe("acknowledged");
    const ownerMessage = telegram.calls.find((call) => call.method === "sendMessage");
    expect(ownerMessage).toBeDefined();
    expect(sendBody(ownerMessage?.body).text).toContain("Pong!");
    expect(telegram.calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);

    const intruderCallback: TelegramUpdate = {
      update_id: 6,
      callback_query: {
        id: "cb-intruder-1",
        from: { id: 987654321, is_bot: false, first_name: "Hacker", username: "hacker_dude" },
        chat_instance: "chat-2",
        data: "cmd:balance",
        message: {
          message_id: 502,
          chat: { id: "987654321", type: "private" },
          date: Math.floor(Date.now() / 1000),
        },
      },
    };
    expect(await notifier.processCallbackQuery(intruderCallback, { store })).toBe("acknowledged");
    const denial = telegram.calls.filter(
      (call) => call.method === "answerCallbackQuery" && JSON.stringify(call.body).includes("not for you"),
    );
    expect(denial.length).toBeGreaterThanOrEqual(1);
    const strangerMessages = telegram.calls.filter(
      (call) => call.method === "sendMessage" && sendBody(call.body).chat_id === "987654321",
    );
    expect(strangerMessages).toHaveLength(0);
  });
});
