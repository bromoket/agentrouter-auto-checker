import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../config";
import { AntigravityCollector, type AntigravityIngestSink } from "./collector";
import { AntigravityStore } from "./store";
import { ObservatoryCoordinator } from "../observatory/coordinator";
import { ObservatoryStore } from "../observatory/store";
import type { ObservatoryEventCandidate } from "../observatory/types";

const SECRET = "0123456789abcdef0123456789abcdef";
const ACCOUNT_ID = "ag-int-1";

/** Config is consumed for observatory host/retention fields only; cast keeps it terse. */
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
      oauthClientId: "client-id",
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Sequence of IDE bucket responses (one per IDE quota probe). */
const ideResponses = [
  // Probe 1: near-exhausted pools
  { buckets: [
    { tokenType: "WTUS", modelId: "gemini-3.7-flash", remainingFraction: "0.04", resetTime: "2026-09-03T08:00:00Z" },
    { tokenType: "WTUS", modelId: "claude-sonnet-4-6", remainingFraction: "0.02", resetTime: "2026-09-03T08:00:00Z" },
  ] },
  // Probe 2: dramatic reset (remaining jumps well above 0.7)
  { buckets: [
    { tokenType: "WTUS", modelId: "gemini-3.7-flash", remainingFraction: "0.94", resetTime: "2026-09-03T14:00:00Z" },
    { tokenType: "WTUS", modelId: "claude-sonnet-4-6", remainingFraction: "0.90", resetTime: "2026-09-03T14:00:00Z" },
  ] },
];

const cliResponse = { buckets: [
  { tokenType: "REQUESTS", modelId: "gemini-2.5-flash", remainingFraction: "0.55", resetTime: "2026-09-03T14:00:00Z" },
] };

const assistResponses = [
  {
    cloudaicompanionProject: "proj-123",
    currentTier: { id: "free-tier", name: "Antigravity" },
    paidTier: { id: "g1-pro-tier", name: "Google AI Pro", availableCredits: [{ count: 2 }] },
    verificationRequired: false,
    gcpManaged: false,
  },
  {
    cloudaicompanionProject: "proj-123",
    currentTier: { id: "free-tier", name: "Antigravity" },
    paidTier: { id: "g1-pro-tier", name: "Google AI Pro", availableCredits: [{ count: 5 }] },
    verificationRequired: false,
    gcpManaged: false,
  },
];

const modelsResponse = {
  models: {
    "gemini-3.7-flash": {
      displayName: "Gemini 3.7 Flash",
      modelProvider: "google",
      quotaInfo: { remainingFraction: 0.94, resetTime: "2026-09-03T14:00:00Z" },
    },
  },
};

describe("AntigravityCollector end-to-end (mocked HTTP)", () => {
  test("probes, ingests quota windows, detects resets, and emits credit increase", async () => {
    const config = makeConfig();
    const antigravityStore = new AntigravityStore(":memory:", SECRET);
    antigravityStore.upsertAccount({
      id: ACCOUNT_ID,
      label: "int-account@example.com",
      email: "int-account@example.com",
      refreshToken: "1//0refresh-token-int",
      enabled: true,
    });

    const observatoryStore = new ObservatoryStore(":memory:");
    const coordinator = new ObservatoryCoordinator(
      observatoryStore,
      config,
      null,
      () => { throw new Error("omp executor must not run in this test"); },
    );

    const creditEvents: ObservatoryEventCandidate[] = [];
    const sink: AntigravityIngestSink = {
      ingestBatch: (observedAt, identities, quotas) =>
        coordinator.ingestBatch({ observedAt, host: null, identities, quotas }),
      emitEvent: (candidate) => {
        creditEvents.push(candidate);
        coordinator.processEventCandidate(candidate);
      },
    };

    let ideIndex = 0;
    let assistIndex = 0;
    const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
      if (url === "https://oauth2.googleapis.com/token") {
        return jsonResponse({ access_token: "access-1", expires_in: 3600 });
      }
      if (url.includes("/v1internal:loadCodeAssist")) {
        return jsonResponse(assistResponses[Math.min(assistIndex++, assistResponses.length - 1)]!);
      }
      if (url.includes("/v1internal:fetchAvailableModels")) {
        return jsonResponse(modelsResponse);
      }
      if (url.includes("/v1internal:retrieveUserQuota")) {
        const headers = (init.headers ?? {}) as Record<string, string>;
        const userAgent = headers["User-Agent"] ?? "";
        if (userAgent.startsWith("google-api-nodejs-client")) {
          return jsonResponse(cliResponse);
        }
        return jsonResponse(ideResponses[Math.min(ideIndex++, ideResponses.length - 1)]!);
      }
      return new Response("unexpected url", { status: 404 });
    };

    const collector = new AntigravityCollector({
      store: antigravityStore,
      sink,
      oauth: {
        clientId: config.antigravity.oauthClientId,
        clientSecret: config.antigravity.oauthClientSecret,
        redirectUri: config.antigravity.oauthRedirectUri,
      },
      probeIntervalMs: 60_000,
      probeTimeoutMs: 2_000,
      catalogIntervalMs: 3_600_000,
      sourceHostId: "host-x",
      fetcher,
    });

    // Probe 1: fresh state, no credit event yet
    await collector.probeAccountOnce(ACCOUNT_ID);
    expect(creditEvents).toHaveLength(0);

    // Probe 2: credits 2 -> 5, quota dramatically resets
    await collector.probeAccountOnce(ACCOUNT_ID);

    const creditGains = creditEvents.filter((e) => e.eventType === "reset_credit_increased");
    expect(creditGains).toHaveLength(1);
    expect(creditGains[0]!.identityId).toBe(ACCOUNT_ID);

    const snapshot = antigravityStore.getSnapshot(ACCOUNT_ID);
    expect(snapshot?.subscription?.availableCredits).toBe(5);
    expect(snapshot?.subscription?.currentTierId).toBe("free-tier");
    expect(snapshot?.pools.map((p) => p.pool).sort()).toEqual(["claude-gpt", "cli", "gemini"]);
    expect(snapshot?.projectId).toBe("proj-123");

    // Observatory machine: quota windows for all pools
    const windows = observatoryStore.listCurrentQuotaWindows({ provider: "google-antigravity" });
    const byBucket = Object.fromEntries(windows.map((w) => [w.bucketId, w]));
    expect(Object.keys(byBucket).sort()).toEqual(["antigravity-claude-gpt", "antigravity-cli", "antigravity-gemini"]);
    expect(byBucket["antigravity-gemini"]!.remainingFraction).toBeCloseTo(0.94);
    expect(byBucket["antigravity-cli"]!.meter).toBe("REQUESTS");

    // Observatory machine: identities upserted with the direct source label
    const identities = observatoryStore.listIdentities({ provider: "google-antigravity" });
    const direct = identities.find((i) => i.identityId === ACCOUNT_ID);
    expect(direct?.label).toBe("Google Antigravity (ag-int-1)");

    // Quota reset events recorded (dramatic reset after near-exhaustion)
    const resets = observatoryStore
      .listEvents({})
      .filter((e) => e.eventType === "quota_reset");
    expect(resets.length).toBeGreaterThanOrEqual(2);

    antigravityStore.close();
    observatoryStore.close();
  });
});
