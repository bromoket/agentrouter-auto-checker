import { describe, expect, test } from "bun:test";
import { fetchCommandCodeQuota } from "./client";

function makeFetcher(routes: Record<string, unknown>) {
  return async (url: string) => {
    const u = new URL(url);
    const path = u.pathname;
    const body = routes[path] ?? {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("CommandCode client", () => {
  test("parses 5-hour and weekly windows with reset times", async () => {
    const now = Date.now();
    const fetcher = makeFetcher({
      "/alpha/whoami": { org: { id: "org-1", login: "bromoket" } },
      "/alpha/billing/credits": {
        credits: { monthlyCredits: 70, purchasedCredits: 20, freeCredits: 0 },
        windowLimits: {
          fiveHour: { used: 6, cap: 14, resetAt: Math.floor(now / 1000) + 3600 },
          weekly: { used: 20, cap: 35, resetAt: new Date(now + 7 * 24 * 3600_000).toISOString() },
        },
      },
      "/alpha/billing/subscriptions": { data: { planId: "goat", status: "active" } },
      "/alpha/usage/summary": { totalCost: 0, totalCount: 0 },
    });
    const result = await fetchCommandCodeQuota({ apiKey: "sk-test", fetcher });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quota.credits?.remainingCredits).toBe(90);
    expect(result.quota.credits?.windowLimits).toHaveLength(2);
    const five = result.quota.credits?.windowLimits.find((w) => w.window === "fiveHour");
    expect(five?.used).toBe(6);
    expect(five?.cap).toBe(14);
    expect(five?.resetAt).toBeTruthy();
    const weekly = result.quota.credits?.windowLimits.find((w) => w.window === "weekly");
    expect(weekly?.cap).toBe(35);
  });

  test("parses subscription and usage summary", async () => {
    const fetcher = makeFetcher({
      "/alpha/whoami": { org: { id: "org-1", login: "bromoket" } },
      "/alpha/billing/credits": { credits: { monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0, windowLimits: {} } },
      "/alpha/billing/subscriptions": {
        data: { planId: "goat", status: "active", currentPeriodStart: "2026-09-01T00:00:00Z", currentPeriodEnd: "2026-10-01T00:00:00Z" },
      },
      "/alpha/usage/summary": { totalCost: 12.5, totalCount: 41, totalTokens: 123456 },
    });
    const result = await fetchCommandCodeQuota({ apiKey: "sk-test", fetcher });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quota.subscription?.planId).toBe("goat");
    expect(result.quota.summary?.totalCount).toBe(41);
  });

  test("categorizes auth rejection without leaking", async () => {
    const fetcher = async () =>
      new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
    const result = await fetchCommandCodeQuota({ apiKey: "bad", fetcher });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("auth");
    expect(result.error.message).not.toContain("bad");
  });

  test("fails safe with no api key", async () => {
    const result = await fetchCommandCodeQuota({ apiKey: "", fetcher: makeFetcher({}) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("payload");
  });
});
