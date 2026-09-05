import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubAccount } from "./accounts";
import type { AppConfig } from "./config";
import { DefaultAgentRouterReadSessions } from "./agentrouter-session";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function account(id: string): GitHubAccount {
  return { id, label: id, githubUsername: id, githubPassword: "secret", enabled: true, runOrder: 0 };
}

function config(directory: string): AppConfig {
  return {
    baseUrl: "https://agentrouter.org",
    accountStateDir: join(directory, "states"),
    browserExecutable: "/usr/bin/google-chrome-stable",
    browserPollerCdpPort: 19_223,
    browserStartTimeoutMs: 30_000,
    browserPollerProfileDir: join(directory, "poller-profile"),
    requestTimeoutMs: 5_000,
  } as AppConfig;
}

async function writeState(directory: string, id: string, userId: number): Promise<void> {
  await writeFile(join(directory, "states", `${id}.monitor.json`), JSON.stringify({
    origins: [{
      origin: "https://agentrouter.org",
      localStorage: [{ name: "user", value: JSON.stringify({ id: userId }) }],
    }],
  }));
}

describe("DefaultAgentRouterReadSessions native Chrome lifecycle", () => {
  test("shares one owned browser while isolating account contexts and closes in order", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentrouter-read-session-"));
    directories.push(directory);
    await mkdir(join(directory, "states"), { recursive: true });
    await writeState(directory, "one", 1);
    await writeState(directory, "two", 2);

    const calls: unknown[] = [];
    const contexts = [];
    const browser = {
      isConnected: () => true,
      newContext: async (options: unknown) => {
        calls.push(["new-context", options]);
        const page = {
          isClosed: () => false,
          goto: async () => undefined,
          evaluate: async () => ({
            status: 200,
            ct: "application/json",
            ok: true,
            body: JSON.stringify({ id: 1 }),
            originOk: true,
            path: "https://agentrouter.org/console/",
          }),
        };
        const context = {
          pages: () => [page],
          newPage: async () => page,
          close: async () => calls.push("context-close"),
        };
        contexts.push(context);
        return context;
      },
    };
    const connection = {
      browser,
      close: async () => calls.push("connection-close"),
    };
    const sessions = new DefaultAgentRouterReadSessions(async (received) => {
      calls.push(["connect", received]);
      return connection as never;
    });
    const appConfig = config(directory);

    await sessions.poll(account("one"), appConfig);
    await sessions.poll(account("two"), appConfig);
    expect(calls.filter((entry) => Array.isArray(entry) && entry[0] === "connect")).toEqual([["connect", {
      executablePath: appConfig.browserExecutable,
      userDataDir: appConfig.browserPollerProfileDir,
      port: appConfig.browserPollerCdpPort,
      startupTimeoutMs: appConfig.browserStartTimeoutMs,
    }]]);
    expect(calls.filter((entry) => Array.isArray(entry) && entry[0] === "new-context")).toHaveLength(2);

    await sessions.drop("one");
    expect(calls.filter((entry) => entry === "context-close")).toHaveLength(1);
    expect(calls).not.toContain("connection-close");

    await sessions.close();
    expect(calls.at(-1)).toBe("connection-close");
  });
});
