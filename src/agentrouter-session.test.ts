import { describe, expect, test } from "bun:test";
import { readBrowserPortForAccount } from "./agentrouter-session";
import type { GitHubAccount } from "./accounts";
import type { AppConfig } from "./config";
import { DefaultAgentRouterReadSessions } from "./agentrouter-session";

function account(id: string): GitHubAccount {
  return { id, label: id, githubUsername: id, githubPassword: "secret", enabled: true, runOrder: 0 };
}

describe("DefaultAgentRouterReadSessions", () => {
  test("delegates poll, account drop, and shutdown to the persistent Node worker transport", async () => {
    const calls: unknown[] = [];
    const payload = { data: { id: 1, quota: 500_000 } };
    const transport = {
      poll: async (receivedAccount: GitHubAccount, receivedConfig: AppConfig) => {
        calls.push(["poll", receivedAccount.id, receivedConfig.baseUrl]);
        return payload;
      },
      drop: async (accountId: string) => {
        calls.push(["drop", accountId]);
      },
      close: async () => {
        calls.push(["close"]);
      },
    };
    const sessions = new DefaultAgentRouterReadSessions(transport);
    const config = { baseUrl: "https://agentrouter.org" } as AppConfig;

    await expect(sessions.poll(account("acc-1"), config)).resolves.toEqual(payload);
    await sessions.drop("acc-1");
    await sessions.close();

    expect(calls).toEqual([
      ["poll", "acc-1", "https://agentrouter.org"],
      ["drop", "acc-1"],
      ["close"],
    ]);
  });
});

describe("readBrowserPortForAccount", () => {
  test("maps account ids to distinct bounded unprivileged ports", () => {
    const p1 = readBrowserPortForAccount("acc-1", 19223);
    const p2 = readBrowserPortForAccount("acc-2", 19223);
    expect(p1).toBeGreaterThanOrEqual(26000);
    expect(p1).toBeLessThanOrEqual(28499);
    expect(p2).toBeGreaterThanOrEqual(26000);
    expect(p2).toBeLessThanOrEqual(28499);
  });

  test("is deterministic for the same account id", () => {
    expect(readBrowserPortForAccount("acc-1", 19223)).toBe(readBrowserPortForAccount("acc-1", 19223));
  });
});
