import { describe, expect, test } from "bun:test";
import { fetchChatgptUsage, parseChatgptUsage } from "./client";

const sample = {
  user_id: "user-x",
  email: "a@b.c",
  plan_type: "prolite",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 2, limit_window_seconds: 604800, reset_after_seconds: 571560, reset_at: 1789438842 },
    secondary_window: null,
  },
  additional_rate_limits: [
    {
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_after_seconds: 18000, reset_at: 1788885282 },
        secondary_window: { used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 604800, reset_at: 1789472082 },
      },
      normal_model_slug: null,
    },
  ],
  credits: 0,
  rate_limit_reset_credits: 3,
};

describe("ChattGPT client", () => {
  test("parses primary weekly window + per-model windows", () => {
    const usage = parseChatgptUsage(sample);
    expect(usage.planType).toBe("prolite");
    expect(usage.email).toBe("a@b.c");
    // primary (weekly)
    expect(usage.windows.some((w) => w.windowId === "weekly" && w.bucketId === "chatgpt-weekly")).toBe(true);
    // additional primary (5h) and secondary (weekly) from GPT-5.3-Codex-Spark
    expect(usage.windows.some((w) => w.windowId === "5h" && w.meter === "GPT-5.3-Codex-Spark")).toBe(true);
    expect(usage.resetCredits).toBe(3);
  });

  test("derives remaining fraction from used percent", () => {
    const payload = { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 604800, reset_at: 1789438842 } } };
    // 25% used -> 0.75 remaining
    const w = parseChatgptUsage(payload).windows[0];
    expect(w.usedPercent).toBe(25);
    expect(w.resetAt).toBeTruthy();
  });

  test("fails safe on empty token", async () => {
    const result = await fetchChatgptUsage({ accessToken: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("payload");
  });

  test("categorizes auth rejection", async () => {
    const fetcher = async () => new Response("unauthorized", { status: 401 });
    const result = await fetchChatgptUsage({ accessToken: "bad", fetcher });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("auth");
  });
});
