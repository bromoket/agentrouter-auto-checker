import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTROUTER_SESSION_DEAD_MARKER } from "./agentrouter-session";
import { hasMonitorSession, pollAccountEndpoints } from "./endpoint-poller";
import type { GitHubAccount } from "./accounts";
import type { AppConfig } from "./config";

const originalFetch = globalThis.fetch;
const temporaryDirectories: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const account: GitHubAccount = {
  id: "test",
  label: "test",
  githubUsername: "test-user",
  githubPassword: "secret",
  enabled: true,
  runOrder: 0,
};

async function configWithMonitorState(): Promise<AppConfig> {
  const accountStateDir = await mkdtemp(join(tmpdir(), "agentrouter-endpoint-test-"));
  temporaryDirectories.push(accountStateDir);
  await writeFile(join(accountStateDir, `${account.id}.monitor.json`), JSON.stringify({
    cookies: [{ name: "session", value: "test-cookie", domain: "agentrouter.org", expires: -1 }],
    origins: [{ origin: "https://agentrouter.org", localStorage: [{ name: "user", value: "{\"id\":1}" }] }],
  }));
  return { baseUrl: "https://agentrouter.org", requestTimeoutMs: 1_000, accountStateDir } as AppConfig;
}

describe("pollAccountEndpoints", () => {
  it("waits quietly for the first browser cycle to capture a monitor session", async () => {
    const accountStateDir = await mkdtemp(join(tmpdir(), "agentrouter-endpoint-test-"));
    temporaryDirectories.push(accountStateDir);
    const config = { accountStateDir } as AppConfig;

    expect(await hasMonitorSession(account, config)).toBe(false);
    await writeFile(join(accountStateDir, `${account.id}.monitor.json`), "{}");
    expect(await hasMonitorSession(account, config)).toBe(true);
  });

  it("derives signed balance and consumption from AgentRouter session quota responses", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith("/api/user/self")
        ? Response.json({ success: true, data: { quota: -115_000, used_quota: 69_975_000 } })
        : Response.json({ success: true, data: { quota_per_unit: 500_000 } });
    }) as unknown as typeof fetch;
    const result = await pollAccountEndpoints(account, await configWithMonitorState());
    expect(result.status).toBe("ok");
    expect(result.balance).toBe(-0.23);
    expect(result.consumed).toBe(139.95);
  });

  it("rejects HTML/WAF responses without parsing them as account data", async () => {
    globalThis.fetch = (async () => new Response("<html>blocked</html>", {
      status: 403,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
    const result = await pollAccountEndpoints(account, await configWithMonitorState());
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("HTTP 403");
  });

  it("falls back to a browser read session when direct polling hits WAF HTML", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith("/api/user/self")
        ? new Response("<html>challenge</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          })
        : Response.json({ success: true, data: { quota_per_unit: 500_000 } });
    }) as unknown as typeof fetch;
    const readSession = async () => ({
      success: true,
      data: { quota: -115_000, used_quota: 69_975_000 },
    });
    const result = await pollAccountEndpoints(account, await configWithMonitorState(), undefined, readSession);
    expect(result.status).toBe("ok");
    expect(result.balance).toBe(-0.23);
    expect(result.consumed).toBe(139.95);
    expect(result.sourcePath).toContain(":browser");
  });

  it("classifies an unauthenticated browser session with the session-dead marker", async () => {
    globalThis.fetch = (async () => new Response("<html>challenge</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })) as unknown as typeof fetch;
    const readSession = async () => {
      throw new Error(AGENTROUTER_SESSION_DEAD_MARKER);
    };
    const result = await pollAccountEndpoints(account, await configWithMonitorState(), undefined, readSession);
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain(AGENTROUTER_SESSION_DEAD_MARKER);
  });
});
