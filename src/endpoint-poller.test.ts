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
  agentRouterApiToken: `sk-${"a".repeat(32)}`,
  enabled: true,
  runOrder: 0,
};

const config = {
  baseUrl: "https://agentrouter.org",
  requestTimeoutMs: 1_000,
  accountStateDir: "unused",
} as AppConfig;

describe("pollAccountEndpoints", () => {
  it("derives remaining balance from the bearer billing responses", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith("subscription")
        ? Response.json({ hard_limit_usd: 400 })
        : Response.json({ total_usage: 13_250 });
    }) as unknown as typeof fetch;
    const result = await pollAccountEndpoints(account, config);
    expect(result.status).toBe("ok");
    expect(result.balance).toBe(267.5);
    expect(result.consumed).toBe(132.5);
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
