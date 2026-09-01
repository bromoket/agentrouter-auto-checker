import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectOmpUsage,
  createOmpUsageExecutor,
  deriveProviderHealth,
  formatSafeIdentityLabel,
  generateOpaqueIdentityId,
  normalizeOmpUsage,
  resolveUsedFraction,
  sanitizeOmpUsageError,
  stripAnsi,
  validateHmacKey,
} from "./omp-usage";
import type { OmpUsageResponse } from "./omp-usage";

// 32-byte cryptographically secure test key
const TEST_HMAC_KEY = "test-secret-hmac-key-observatory-2026-32b!!";
const FIXED_NOW = 1772500800000; // 2026-03-03T01:20:00.000Z

describe("HMAC Key Validation and Domain Separation", () => {
  test("validateHmacKey enforces at least 32 bytes", () => {
    expect(() => validateHmacKey("short-key")).toThrow("at least 32 bytes");
    expect(() => validateHmacKey(Buffer.alloc(16))).toThrow("at least 32 bytes");
    expect(() => validateHmacKey(new Uint8Array(0))).toThrow("at least 32 bytes");
    expect(validateHmacKey(TEST_HMAC_KEY).length).toBeGreaterThanOrEqual(32);
    expect(validateHmacKey(Buffer.alloc(32)).length).toBe(32);
  });

  test("generateOpaqueIdentityId provides length-delimited domain separation", () => {
    // Cross-provider collision resistance: ('a', 'b:c') vs ('a:b', 'c')
    const idA = generateOpaqueIdentityId("a", { type: "accountId", value: "b:c" }, TEST_HMAC_KEY);
    const idB = generateOpaqueIdentityId("a:b", { type: "accountId", value: "c" }, TEST_HMAC_KEY);
    expect(idA).not.toBe(idB);

    // Pool vs credential separation
    const poolId = generateOpaqueIdentityId("openai-codex", null, TEST_HMAC_KEY);
    const credId = generateOpaqueIdentityId("openai-codex", { type: "accountId", value: "pool" }, TEST_HMAC_KEY);
    expect(poolId).not.toBe(credId);
    expect(poolId).toHaveLength(64);
    expect(credId).toHaveLength(64);
  });

  test("identity stability across inventory additions and peer set changes", () => {
    const cred1 = { type: "accountId", value: "user-alpha@corp.internal" };
    const id1Initial = generateOpaqueIdentityId("openai-codex", cred1, TEST_HMAC_KEY);

    // Adding a colliding account to the inventory does NOT change the HMAC of cred1
    const cred2 = { type: "accountId", value: "user-alpha-2@corp.internal" };
    const id2 = generateOpaqueIdentityId("openai-codex", cred2, TEST_HMAC_KEY);
    const id1After = generateOpaqueIdentityId("openai-codex", cred1, TEST_HMAC_KEY);

    expect(id1Initial).toBe(id1After);
    expect(id1Initial).not.toBe(id2);
  });
});

describe("Safe Formatting and Health Derivation", () => {
  test("stripAnsi removes ANSI escape codes", () => {
    expect(stripAnsi("\u001B[31mError\u001B[0m")).toBe("Error");
  });

  test("formatSafeIdentityLabel produces PII-free labels", () => {
    const id = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    expect(formatSafeIdentityLabel("openai-codex", id, false, "spark")).toBe("OpenAI Codex [spark] (a1b2c3d4)");
    expect(formatSafeIdentityLabel("openai-codex", id, true)).toBe("OpenAI Codex (Shared Pool)");
    expect(formatSafeIdentityLabel("google-antigravity", id, false)).toBe("Google Antigravity (a1b2c3d4)");
  });

  test("deriveProviderHealth and resolveUsedFraction", () => {
    expect(deriveProviderHealth("ok", 0.2)).toBe("healthy");
    expect(deriveProviderHealth("warning", 0.2)).toBe("degraded");
    expect(deriveProviderHealth("ok", 0.9)).toBe("degraded");
    expect(deriveProviderHealth("ok", 1.0)).toBe("exhausted");
    expect(deriveProviderHealth("exhausted", 0.1)).toBe("exhausted");
    expect(deriveProviderHealth("rate_limited", 0.1)).toBe("rate_limited");
    expect(deriveProviderHealth("ok", undefined, true, false)).toBe("unhealthy");
    expect(deriveProviderHealth("ok", undefined, false, true)).toBe("unknown");

    // Precedence: explicit > used/limit > percent > inverted remaining
    expect(resolveUsedFraction({ unit: "percent", usedFraction: 0.4, used: 10, limit: 100 })).toBe(0.4);
    expect(resolveUsedFraction({ unit: "tokens", used: 25, limit: 100 })).toBe(0.25);
    expect(resolveUsedFraction({ unit: "percent", used: 35 })).toBe(0.35);
    expect(resolveUsedFraction({ unit: "unknown", remainingFraction: 0.8 })).toBeCloseTo(0.2);
    expect(resolveUsedFraction({ unit: "percent" })).toBeUndefined();
  });
});

describe("OMP 18.0.11 Usage Normalizer Fixture Scenarios", () => {
  test("1. OpenAI Codex report with 4 distinct limit buckets (chat 5h/7d, spark 5h/7d) and shared scope", () => {
    const raw: OmpUsageResponse = {
      generatedAt: FIXED_NOW,
      accountsWithoutUsage: [],
      disabledCredentials: [],
      capacity: {},
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: FIXED_NOW - 1000,
          metadata: {
            accountId: "acc-codex-prod-1",
            email: "codex-admin@company.com",
            planType: "enterprise",
          },
          resetCredits: {
            availableCount: 2,
          },
          limits: [
            {
              id: "openai-codex:primary",
              label: "7 Day Chat",
              scope: {
                provider: "openai-codex",
                windowId: "7d",
                shared: true,
              },
              window: {
                id: "7d",
                label: "7 Day",
                durationMs: 604_800_000,
                resetsAt: FIXED_NOW + 400_000_000,
              },
              amount: {
                used: 20,
                limit: 100,
                remaining: 80,
                usedFraction: 0.2,
                remainingFraction: 0.8,
                unit: "percent",
              },
              status: "ok",
            },
            {
              id: "openai-codex:secondary",
              label: "5 Hour Chat",
              scope: {
                provider: "openai-codex",
                windowId: "5h",
                shared: true,
              },
              window: {
                id: "5h",
                label: "5 Hour",
                durationMs: 18_000_000,
                resetsAt: FIXED_NOW + 10_000_000,
              },
              amount: {
                used: 40,
                limit: 100,
                remaining: 60,
                usedFraction: 0.4,
                remainingFraction: 0.6,
                unit: "percent",
              },
              status: "ok",
            },
            {
              id: "openai-codex:spark:primary",
              label: "7 Day Spark",
              scope: {
                provider: "openai-codex",
                windowId: "7d",
                tier: "spark",
              },
              window: {
                id: "7d",
                label: "7 Day",
                durationMs: 604_800_000,
                resetsAt: FIXED_NOW + 400_000_000,
              },
              amount: {
                usedFraction: 0.1,
                remainingFraction: 0.9,
                unit: "percent",
              },
              status: "ok",
            },
            {
              id: "openai-codex:spark:secondary",
              label: "5 Hour Spark",
              scope: {
                provider: "openai-codex",
                windowId: "5h",
                tier: "spark",
              },
              window: {
                id: "5h",
                label: "5 Hour",
                durationMs: 18_000_000,
                resetsAt: FIXED_NOW + 10_000_000,
              },
              amount: {
                usedFraction: 0.15,
                remainingFraction: 0.85,
                unit: "percent",
              },
              status: "ok",
            },
            {
              id: "openai-codex:canary-secret-account-id-998811:primary",
              label: "7 Day (Provider Display Must Not Persist)",
              scope: {
                provider: "openai-codex",
                accountId: "acc-codex-prod-1",
                tier: "canary-secret-account-id-998811",
                modelId: "Customer Org Display Must Not Persist",
                windowId: "7d",
                shared: true,
              },
              window: {
                id: "7d",
                label: "Provider Window Display Must Not Persist",
                durationMs: 604_800_000,
                resetsAt: FIXED_NOW + 400_000_000,
              },
              amount: {
                usedFraction: 0.35,
                remainingFraction: 0.65,
                unit: "percent",
              },
              status: "ok",
            },
          ],
        },
      ],
    };

    const normalized = normalizeOmpUsage(raw, {
      hmacKey: TEST_HMAC_KEY,
      now: FIXED_NOW,
      hostId: "node-us-east-1",
    });

    expect(normalized.identities).toHaveLength(1);
    expect(normalized.identities[0].kind).toBe("credential");
    expect(normalized.identities[0].sourceHostId).toBe("node-us-east-1");
    expect(normalized.quotas).toHaveLength(5);

    // Provider-derived meters retain their distinction without persisting the
    // source slug or display label.
    const bucketIds = normalized.quotas.map(q => q.bucketId);
    expect(bucketIds.slice(0, 4)).toEqual([
      "openai-codex:primary",
      "openai-codex:secondary",
      "openai-codex:spark:primary",
      "openai-codex:spark:secondary",
    ]);
    expect(bucketIds.at(-1)).toMatch(/^openai-codex:opaque-[a-f0-9]{24}:primary$/);
    expect(normalized.quotas.at(-1)?.meter).toMatch(/^opaque-[a-f0-9]{24}$/);
    expect(JSON.stringify(normalized)).not.toContain("canary-secret-account-id-998811");
    expect(JSON.stringify(normalized)).not.toContain("Customer Org Display Must Not Persist");
    // Check reset credits and first-class window provenance.
    expect(normalized.quotas[0].resetCredits).toBe(2);
    expect(normalized.quotas[0].windowDurationMs).toBe(604_800_000);
    expect(normalized.quotas[0].resetLabel).toBeNull();
  });

  test("2. Multiple Google Antigravity reports with projectId attribution and shared-window counters", () => {
    const raw: OmpUsageResponse = {
      generatedAt: FIXED_NOW,
      accountsWithoutUsage: [],
      disabledCredentials: [],
      capacity: {},
      reports: [
        {
          provider: "google-antigravity",
          fetchedAt: FIXED_NOW - 500,
          metadata: {
            projectId: "gcp-project-alpha",
            email: "developer-alpha@google.com",
          },
          limits: [
            {
              id: "google-antigravity:google:pro:daily",
              label: "Usage (Google)",
              scope: {
                provider: "google-antigravity",
                projectId: "gcp-project-alpha",
                tier: "pro",
                windowId: "daily",
              },
              window: {
                id: "daily",
                label: "Daily",
                durationMs: 86_400_000,
                resetsAt: FIXED_NOW + 15_000_000,
              },
              amount: {
                usedFraction: 0.1,
                remainingFraction: 0.9,
                unit: "percent",
              },
              status: "ok",
            },
            {
              id: "google-antigravity:anthropic:pro:daily",
              label: "Usage (Anthropic)",
              scope: {
                provider: "google-antigravity",
                projectId: "gcp-project-alpha",
                tier: "pro",
                windowId: "daily",
              },
              window: {
                id: "daily",
                label: "Daily",
                durationMs: 86_400_000,
                resetsAt: FIXED_NOW + 15_000_000,
              },
              amount: {
                usedFraction: 0.88,
                remainingFraction: 0.12,
                unit: "percent",
              },
              status: "ok",
            },
          ],
        },
        {
          provider: "google-antigravity",
          fetchedAt: FIXED_NOW - 400,
          metadata: {
            projectId: "gcp-project-beta",
            email: "developer-beta@google.com",
          },
          limits: [
            {
              id: "google-antigravity:openai:canary_tier_998811:canary_window_998811",
              label: "Usage (Provider Display Must Not Persist)",
              scope: {
                provider: "google-antigravity",
                projectId: "gcp-project-beta",
                tier: "canary_tier_998811",
                windowId: "canary_window_998811",
              },
              window: {
                id: "canary_window_998811",
                label: "Provider Window Display Must Not Persist",
                durationMs: 86_400_000,
                resetsAt: FIXED_NOW + 12_000_000,
              },
              amount: {
                usedFraction: 0.05,
                remainingFraction: 0.95,
                unit: "percent",
              },
              status: "ok",
            },
          ],
        },
      ],
    };

    const normalized = normalizeOmpUsage(raw, {
      hmacKey: TEST_HMAC_KEY,
      now: FIXED_NOW,
    });

    expect(normalized.identities).toHaveLength(2);
    const [idAlpha, idBeta] = normalized.identities;
    expect(idAlpha.identityId).not.toBe(idBeta.identityId);
    expect(idAlpha.health).toBe("degraded");
    expect(normalized.quotas).toHaveLength(3);
    const bucketKeys = normalized.quotas.map(q => q.bucketId);
    expect(new Set(bucketKeys).size).toBe(3);
    expect(normalized.quotas.at(-1)?.meter).toBe("openai");
    expect(normalized.quotas.at(-1)?.tier).toMatch(/^opaque-[a-f0-9]{24}$/);
    expect(normalized.quotas.at(-1)?.windowId).toMatch(/^opaque-[a-f0-9]{24}$/);
    expect(JSON.stringify(normalized)).not.toContain("canary_tier_998811");
    expect(JSON.stringify(normalized)).not.toContain("canary_window_998811");
    expect(JSON.stringify(normalized)).not.toContain("Provider Display Must Not Persist");
  });

  test("3. Identityless per-credential report is rejected instead of misattributed to a pool", () => {
    const raw: OmpUsageResponse = {
      generatedAt: FIXED_NOW,
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: FIXED_NOW,
          limits: [
            {
              id: "openai-codex:primary",
              label: "Ambiguous Window",
              scope: { provider: "openai-codex", shared: true, windowId: "5h" },
              window: { id: "5h", label: "5 Hour", durationMs: 18_000_000 },
              amount: { usedFraction: 0.5, unit: "percent" },
            },
          ],
        },
      ],
      accountsWithoutUsage: [],
      disabledCredentials: [],
      capacity: {},
    };

    expect(() => normalizeOmpUsage(raw, {
      hmacKey: TEST_HMAC_KEY,
      now: FIXED_NOW,
    })).toThrow("OMP_USAGE_SCHEMA_ERROR");
  });
  test("4. Unknown amount is accepted without fabricating quota or provider health", () => {
    const raw: OmpUsageResponse = {
      generatedAt: FIXED_NOW,
      accountsWithoutUsage: [],
      disabledCredentials: [],
      capacity: {},
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: FIXED_NOW,
          metadata: { accountId: "acc-unknown-amt" },
          limits: [
            {
              id: "openai-codex:primary",
              label: "Unknown Limit",
              scope: { provider: "openai-codex", shared: true, windowId: "5h" },
              window: { id: "5h", label: "5 Hour", durationMs: 18_000_000 },
              amount: { unit: "percent" },
              status: "unknown",
            },
          ],
        },
      ],
    };

    const normalized = normalizeOmpUsage(raw, {
      hmacKey: TEST_HMAC_KEY,
      now: FIXED_NOW,
    });

    expect(normalized.identities).toHaveLength(1);
    expect(normalized.identities[0].health).toBe("unknown");
    expect(normalized.identities[0].lastSuccessAt).toBe(new Date(FIXED_NOW).toISOString());
    expect(normalized.identities[0].sourceVersion).toBe("18.0.11");
    expect(normalized.quotas).toHaveLength(0);
  });

  test("5. Accounts without usage, disabled credentials, and ProviderWindowStat[] capacity", () => {
    const raw: OmpUsageResponse = {
      generatedAt: FIXED_NOW,
      reports: [],
      accountsWithoutUsage: [
        {
          provider: "google-antigravity",
          type: "oauth",
          email: "idle@corp.com",
          projectId: "proj-idle",
        },
      ],
      disabledCredentials: [
        {
          id: 42,
          provider: "google-antigravity",
          type: "oauth",
          email: "revoked@corp.com",
          cause: "token_revoked",
          disabledAtMs: FIXED_NOW - 100_000,
        },
      ],
      capacity: {
        "google-antigravity": [
          {
            window: "5h",
            durationMs: 18_000_000,
            accounts: 5,
            usedAccounts: 1.5,
            remainingAccounts: 3.5,
          },
          {
            window: "Provider Custom Window 998811",
            accounts: 2,
            usedAccounts: 1,
            remainingAccounts: 1,
          },
        ],
        "openai-codex": [
          {
            window: "7d",
            durationMs: 604_800_000,
            meter: "canary-secret-account-id-998811",
            accounts: 3,
            usedAccounts: 1,
            remainingAccounts: 2,
          },
        ],
      },
    };

    const normalized = normalizeOmpUsage(raw, {
      hmacKey: TEST_HMAC_KEY,
      now: FIXED_NOW,
    });

    expect(normalized.stats.totalWithoutUsage).toBe(1);
    expect(normalized.stats.totalDisabled).toBe(1);
    expect(normalized.identities).toHaveLength(2);

    const idleIdent = normalized.identities.find(i => !i.disabled);
    const disabledIdent = normalized.identities.find(i => i.disabled);

    expect(idleIdent?.health).toBe("unknown");
    expect(disabledIdent?.health).toBe("unhealthy");
    expect(disabledIdent?.statusMessage).toBe("revoked");

    expect(normalized.capacity?.["google-antigravity"]).toHaveLength(2);
    expect(normalized.capacity?.["google-antigravity"][0].usedAccounts).toBe(1.5);
    expect(normalized.capacity?.["openai-codex"][0].meter).toMatch(/^opaque-[a-f0-9]{24}$/);
    expect(normalized.capacity?.["google-antigravity"][1].window).toMatch(/^opaque-[a-f0-9]{24}$/);
    expect(JSON.stringify(normalized)).not.toContain("Provider Custom Window 998811");
  });
  test("accepts OMP Codex fallback primary windows without inventing a stored duration", () => {
    const raw: OmpUsageResponse = {
      generatedAt: FIXED_NOW,
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: FIXED_NOW,
          metadata: { accountId: "fallback-codex-account" },
          limits: [
            {
              id: "openai-codex:primary",
              label: "Primary window",
              scope: { provider: "openai-codex", windowId: "primary" },
              window: {
                id: "primary",
                label: "Primary window",
                resetsAt: FIXED_NOW + 26 * 24 * 60 * 60 * 1_000,
              },
              amount: { unit: "percent", usedFraction: 0.2, remainingFraction: 0.8 },
            },
          ],
        },
      ],
      accountsWithoutUsage: [],
      disabledCredentials: [],
      capacity: {
        "openai-codex": [
          {
            window: "Primary window",
            accounts: 3,
            usedAccounts: 1,
            remainingAccounts: 2,
          },
        ],
      },
    };

    const normalized = normalizeOmpUsage(raw, { hmacKey: TEST_HMAC_KEY, now: FIXED_NOW });
    expect(normalized.quotas[0].bucketId).toBe("openai-codex:primary");
    expect(normalized.quotas[0].windowId).toBe("primary");
    expect(normalized.quotas[0].windowDurationMs).toBeNull();
    expect(normalized.capacity?.["openai-codex"][0].window).toBe("primary");
  });


  test("6. Duration-aware reset timestamp validation and moving reset progression", () => {
    // 6a. Reset in the past relative to report fetch time
    expect(() =>
      normalizeOmpUsage(
        {
          generatedAt: FIXED_NOW,
          accountsWithoutUsage: [],
          disabledCredentials: [],
          capacity: {},
          reports: [
            {
              provider: "openai-codex",
              metadata: { accountId: "reset-account" },
              fetchedAt: FIXED_NOW,
              limits: [
                {
                  id: "openai-codex:primary",
                  label: "5 Hour",
                  scope: { provider: "openai-codex", shared: true, windowId: "5h" },
                  window: { id: "5h", label: "5h", resetsAt: FIXED_NOW - 70_000 },
                  amount: { unit: "percent", usedFraction: 0.1 },
                },
              ],
            },
          ],
        },
        { hmacKey: TEST_HMAC_KEY, now: FIXED_NOW },
      ),
    ).toThrow("OMP_USAGE_INVALID_RESET");

    // 6b. Reset far beyond duration horizon (e.g. 6h reset on a 5h window)
    expect(() =>
      normalizeOmpUsage(
        {
          generatedAt: FIXED_NOW,
          accountsWithoutUsage: [],
          disabledCredentials: [],
          capacity: {},
          reports: [
            {
              provider: "openai-codex",
              metadata: { accountId: "reset-account" },
              fetchedAt: FIXED_NOW,
              limits: [
                {
                  id: "openai-codex:primary",
                  label: "5 Hour",
                  scope: { provider: "openai-codex", shared: true, windowId: "5h" },
                  window: { id: "5h", label: "5h", durationMs: 18_000_000, resetsAt: FIXED_NOW + 6 * 3600 * 1000 },
                  amount: { unit: "percent", usedFraction: 0.1 },
                },
              ],
            },
          ],
        },
        { hmacKey: TEST_HMAC_KEY, now: FIXED_NOW },
      ),
    ).toThrow("OMP_USAGE_INVALID_RESET");
    // 6c. Advancing reset progression across observation ticks
    const t0 = FIXED_NOW;
    const t1 = FIXED_NOW + 5 * 60 * 1000;
    const r0 = t0 + 10_000_000;
    const r1 = t1 + 10_000_000;

    const norm0 = normalizeOmpUsage(
      {
        generatedAt: t0,
        accountsWithoutUsage: [],
        disabledCredentials: [],
        capacity: {},
        reports: [{ provider: "openai-codex", fetchedAt: t0, metadata: { accountId: "moving-reset-account" }, limits: [{ id: "openai-codex:primary", label: "5 Hour", scope: { provider: "openai-codex", shared: true, windowId: "5h" }, window: { id: "5h", label: "5 Hour", resetsAt: r0 }, amount: { unit: "percent", usedFraction: 0.1 } }] }],
      },
      { hmacKey: TEST_HMAC_KEY, now: t0 },
    );

    const norm1 = normalizeOmpUsage(
      {
        generatedAt: t1,
        accountsWithoutUsage: [],
        disabledCredentials: [],
        capacity: {},
        reports: [{ provider: "openai-codex", fetchedAt: t1, metadata: { accountId: "moving-reset-account" }, limits: [{ id: "openai-codex:primary", label: "5 Hour", scope: { provider: "openai-codex", shared: true, windowId: "5h" }, window: { id: "5h", label: "5 Hour", resetsAt: r1 }, amount: { unit: "percent", usedFraction: 0.2 } }] }],
      },
      { hmacKey: TEST_HMAC_KEY, now: t1 },
    );

    expect(Date.parse(norm1.quotas[0].resetsAt!)).toBeGreaterThan(Date.parse(norm0.quotas[0].resetsAt!));
  });

  test("7. Canary secrets in all fields are never leaked in normalized output or errors", () => {
    const CANARY_SECRETS = [
      "canary-secret-account-id-998811",
      "canary-secret-email-dev@corp.internal",
      "canary-secret-project-id-gcp-5544",
      "canary-secret-org-id-org-3322",
      "canary-secret-enterprise-url-corp.com",
      "canary-token-broker-key-do-not-leak",
    ];

    const raw: OmpUsageResponse = {
      generatedAt: FIXED_NOW,
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: FIXED_NOW,
          metadata: {
            accountId: CANARY_SECRETS[0],
            email: CANARY_SECRETS[1],
          },
          notes: [CANARY_SECRETS[5]],
          limits: [
            {
              id: "openai-codex:primary",
              label: "7 Day Chat",
              scope: {
                provider: "openai-codex",
                accountId: CANARY_SECRETS[0],
                projectId: CANARY_SECRETS[2],
                orgId: CANARY_SECRETS[3],
              },
              window: {
                id: "7d",
                label: "7 Day",
                durationMs: 604_800_000,
                resetsAt: FIXED_NOW + 100_000_000,
              },
              amount: {
                usedFraction: 0.1,
                remainingFraction: 0.9,
                unit: "percent",
              },
            },
          ],
        },
      ],
      accountsWithoutUsage: [
        {
          provider: "google-antigravity",
          type: "oauth",
          enterpriseUrl: CANARY_SECRETS[4],
          accountId: CANARY_SECRETS[0],
        },
      ],
      disabledCredentials: [],
      capacity: {},
    };

    const normalized = normalizeOmpUsage(raw, {
      hmacKey: TEST_HMAC_KEY,
      now: FIXED_NOW,
    });

    const serialized = JSON.stringify(normalized);
    for (const secret of CANARY_SECRETS) {
      expect(serialized.includes(secret)).toBe(false);
    }

    // Verify sanitizeOmpUsageError never reflects arbitrary error strings
    const canaryErr = new Error(`Connection to ${CANARY_SECRETS[0]} failed: timed out`);
    const sanitized = sanitizeOmpUsageError(canaryErr);
    expect(sanitized.includes(CANARY_SECRETS[0])).toBe(false);
    expect(sanitized).toBe("OMP_USAGE_TIMEOUT: Probe execution timed out");
  });
});

describe("OMP usage normalized collector with controlled process", () => {
  test("global overlap lock rejects a different executable configuration", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "omp-overlap-"));
    const slowPath = join(tempDir, "slow.js");
    const peerPath = join(tempDir, "peer.js");
    const envelope = JSON.stringify({ generatedAt: FIXED_NOW, reports: [], accountsWithoutUsage: [], disabledCredentials: [], capacity: {} });
    await writeFile(slowPath, `setTimeout(() => process.stdout.write(${JSON.stringify(envelope)}), 250);`, "utf8");
    await writeFile(peerPath, `process.stdout.write(${JSON.stringify(envelope)});`, "utf8");
    const base = {
      hmacKey: TEST_HMAC_KEY,
      hostId: "collector-host",
      sourceVersion: "18.0.11" as const,
      executable: process.execPath,
      maxAccountsPerProvider: 0,
      perAccountTimeoutMs: 1_000,
      timeoutMs: 7_000,
      now: FIXED_NOW,
    };
    const first = collectOmpUsage({ ...base, executablePrefixArgs: [slowPath] });
    await expect(collectOmpUsage({ ...base, executablePrefixArgs: [peerPath] })).rejects.toThrow("OMP_USAGE_ALREADY_RUNNING");
    await first;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("collects, pseudonymizes, and attaches trusted provenance before returning", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "omp-collector-"));
    const scriptPath = join(tempDir, "mock-omp.js");
    const rawIdentity = "member@example.invalid";
    const scriptCode = `
      const argv = process.argv.slice(2);
      if (argv.includes("secret-broker-token-12345")) process.exit(11);
      if (process.env.OMP_AUTH_BROKER_TOKEN !== "secret-broker-token-12345") process.exit(12);
      if (argv[0] !== "usage" || argv[1] !== "--json") process.exit(13);
      process.stdout.write(JSON.stringify({
        generatedAt: ${FIXED_NOW},
        reports: [{
          provider: "openai-codex",
          fetchedAt: ${FIXED_NOW},
          metadata: { email: ${JSON.stringify(rawIdentity)}, accountId: "shared-workspace" },
          limits: [{
            id: "openai-codex:primary",
            label: "7 Day",
            scope: { provider: "openai-codex", shared: true, windowId: "7d" },
            window: { id: "7d", label: "7 Day", durationMs: 604800000, resetsAt: ${FIXED_NOW + 100_000} },
            amount: { unit: "percent", usedFraction: 0.2, remainingFraction: 0.8 },
            status: "ok"
          }]
        }],
        accountsWithoutUsage: [],
        disabledCredentials: [],
        capacity: {}
      }));
    `;
    await writeFile(scriptPath, scriptCode, "utf8");
    const executor = createOmpUsageExecutor({
      hmacKey: TEST_HMAC_KEY,
      hostId: "collector-host",
      sourceVersion: "18.0.11",
      executable: process.execPath,
      executablePrefixArgs: [scriptPath],
      brokerToken: "secret-broker-token-12345",
      maxAccountsPerProvider: 0,
      perAccountTimeoutMs: 1_000,
      timeoutMs: 10_000,
      now: FIXED_NOW,
    });
    const result = await executor();
    expect(JSON.stringify(result)).not.toContain(rawIdentity);
    expect(result.identities[0].sourceVersion).toBe("18.0.11");
    expect(result.quotas[0].source).toBe("omp_usage_cli");
    expect(result.quotas[0].sourceVersion).toBe("18.0.11");
    await rm(tempDir, { recursive: true, force: true });
  });

  test("terminates bounded-output failures without returning raw output", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "omp-buffer-"));
    const scriptPath = join(tempDir, "huge-out.js");
    await writeFile(scriptPath, `process.stdout.write("x".repeat(10000)); setInterval(() => {}, 1000);`, "utf8");
    await expect(collectOmpUsage({
      hmacKey: TEST_HMAC_KEY,
      hostId: "collector-host",
      sourceVersion: "18.0.11",
      executable: process.execPath,
      executablePrefixArgs: [scriptPath],
      maxOutputBytes: 100,
      maxAccountsPerProvider: 0,
      perAccountTimeoutMs: 100,
      timeoutMs: 6_000,
      now: FIXED_NOW,
    })).rejects.toThrow("OMP_USAGE_PAYLOAD_TOO_LARGE");
    await rm(tempDir, { recursive: true, force: true });
  });
  test("resolves an env-bun launcher using only the scrubbed runtime search path", async () => {
    if (process.platform === "win32") return;
    const tempDir = await mkdtemp(join(tmpdir(), "omp-launcher-"));
    const launcherPath = join(tempDir, "omp-launcher");
    const envelope = JSON.stringify({
      generatedAt: FIXED_NOW,
      reports: [],
      accountsWithoutUsage: [],
      disabledCredentials: [],
      capacity: {},
    });
    await writeFile(
      launcherPath,
      `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(envelope)});\n`,
      "utf8",
    );
    await chmod(launcherPath, 0o700);
    try {
      const normalized = await collectOmpUsage({
        hmacKey: TEST_HMAC_KEY,
        hostId: "collector-host",
        sourceVersion: "18.0.11",
        executable: launcherPath,
        maxAccountsPerProvider: 0,
        perAccountTimeoutMs: 1_000,
        timeoutMs: 6_000,
        now: FIXED_NOW,
      });
      expect(normalized.stats.totalReports).toBe(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
