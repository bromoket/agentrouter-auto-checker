import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config";
import { handleAntigravityApi } from "./api";
import { AntigravityStore } from "./store";

const SECRET = "0123456789abcdef0123456789abcdef";

function makeConfig(): AppConfig {
  return {
    observatory: {
      enabled: true,
      dbPath: ":memory:",
      hmacKey: "h".repeat(64),
      ompExecutable: "/usr/bin/omp",
      ompVersion: "18.0.11",
      sourceHostId: "host-x",
      pollIntervalMinutes: 1,
      retentionDays: 14,
      retentionPruneIntervalMinutes: 60,
      deliveryLeaseDurationMs: 30_000,
      deliveryMaxRetries: 5,
      maxAccountsPerProvider: 10,
      perAccountTimeoutMs: 5_000,
      ompTimeoutMs: 15_000,
    },
    antigravity: {
      enabled: true,
      dbPath: ":memory:",
      encryptionKey: SECRET,
      probeIntervalMinutes: 5,
      probeTimeoutMs: 2_000,
      catalogIntervalMinutes: 60,
      oauthClientId: "client-id.apps.googleusercontent.com",
      oauthClientSecret: "client-secret",
      oauthRedirectUri: "http://localhost:51121/oauth-callback",
    },
    telegram: {
      botToken: null,
      chatId: null,
      allowedUsername: null,
      stateFilePath: "data/telegram.json",
      lowBalanceUsd: 50,
      largeDropUsd: 25,
      repeatedFailureCount: 3,
      graphsEnabled: false,
      dashboardUrl: "http://127.0.0.1:3100",
    },
  } as unknown as AppConfig;
}

async function call(
  method: string,
  pathname: string,
  store: AntigravityStore,
  body?: unknown,
): Promise<Response> {
  const request = new Request(`http://127.0.0.1/api/antigravity${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const url = new URL(request.url);
  const response = await handleAntigravityApi(request, url, method, {
    store,
    collector: null,
    config: makeConfig(),
  });
  if (!response) throw new Error(`unhandled route ${method} ${pathname}`);
  return response;
}

describe("Antigravity dashboard API", () => {
  test("overview reports enabled state and account list without secrets", async () => {
    const store = new AntigravityStore(":memory:", SECRET);
    store.upsertAccount({
      id: "ag-api-1",
      label: "api-account@example.com",
      email: "api-account@example.com",
      refreshToken: "1//0secret-token",
      enabled: true,
    });
    const response = await call("GET", "/overview", store);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.enabled).toBe(true);
    expect(data.oauthConfigured).toBe(true);
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]).toMatchObject({ id: "ag-api-1", enabled: true });
    expect(JSON.stringify(data)).not.toContain("1//0secret-token");
    store.close();
  });

  test("enable toggle and delete lifecycle", async () => {
    const store = new AntigravityStore(":memory:", SECRET);
    store.upsertAccount({ id: "ag-api-2", label: "two@example.com", refreshToken: "tok-2", enabled: true });

    const putResponse = await call("PUT", "/accounts/ag-api-2", store, { enabled: false });
    expect(putResponse.status).toBe(200);
    expect((await putResponse.json()).account.enabled).toBe(false);

    const badPut = await call("PUT", "/accounts/ag-API-2!", store, { enabled: true });
    expect(badPut.status).toBe(400);

    const missing = await call("PUT", "/accounts/nope", store, { enabled: true });
    expect(missing.status).toBe(404);

    const delResponse = await call("DELETE", "/accounts/ag-api-2", store);
    expect(delResponse.status).toBe(200);
    const delMissing = await call("DELETE", "/accounts/ag-api-2", store);
    expect(delMissing.status).toBe(404);
    store.close();
  });

  test("oauth start yields consent URL; exchange validates input", async () => {
    const store = new AntigravityStore(":memory:", SECRET);
    const startResponse = await call("POST", "/oauth/start", store, {});
    expect(startResponse.status).toBe(200);
    const started = await startResponse.json();
    expect(new URL(started.url).hostname).toBe("accounts.google.com");
    expect(started.state).toBeTruthy();

    const emptyExchange = await call("POST", "/oauth/exchange", store, { code: "", state: "" });
    expect(emptyExchange.status).toBe(400);
    const badUrl = await call("POST", "/oauth/exchange", store, { redirectUrl: "not-a-url" });
    expect(badUrl.status).toBe(400);
    store.close();
  });

  test("probe is rejected when the collector is not running", async () => {
    const store = new AntigravityStore(":memory:", SECRET);
    const response = await call("POST", "/probe", store, {});
    expect(response.status).toBe(409);
    store.close();
  });
});
