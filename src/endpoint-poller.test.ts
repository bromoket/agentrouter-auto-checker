import { afterEach, describe, expect, it } from "bun:test";
import { pollAccountEndpoints } from "./endpoint-poller";
import type { GitHubAccount } from "./accounts";
import type { AppConfig } from "./config";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const account: GitHubAccount = {
  id: "test",
  label: "test",
  githubUsername: "test-user",
  githubPassword: "secret",
  agentRouterDashboardToken: "a".repeat(32),
  enabled: true,
  runOrder: 0,
};

const config = {
  baseUrl: "https://agentrouter.org",
  requestTimeoutMs: 1_000,
  accountStateDir: "unused",
} as AppConfig;

describe("pollAccountEndpoints", () => {
  it("derives signed balance and consumption from dashboard-token quota responses", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith("/api/user/self")
        ? Response.json({ success: true, data: { quota: -115_000, used_quota: 69_975_000 } })
        : Response.json({ success: true, data: { quota_per_unit: 500_000 } });
    }) as unknown as typeof fetch;
    const result = await pollAccountEndpoints(account, config);
    expect(result.status).toBe("ok");
    expect(result.balance).toBe(-0.23);
    expect(result.consumed).toBe(139.95);
  });

  it("rejects HTML/WAF responses without parsing them as account data", async () => {
    globalThis.fetch = (async () => new Response("<html>blocked</html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
    const result = await pollAccountEndpoints(account, config);
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("HTTP 403");
  });
});
