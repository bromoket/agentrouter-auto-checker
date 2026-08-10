import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "./config";
import type { RunSnapshot } from "./storage";
import { Store } from "./storage";
import { TelegramNotifier } from "./telegram";

const resources: Array<{ directory: string; store: Store }> = [];

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
    maxRecentRuns: 500,
    disableWebAuthn: true,
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
});
