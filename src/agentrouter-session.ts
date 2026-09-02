import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { GitHubAccount } from "./accounts";
import type { AppConfig } from "./config";

export const AGENTROUTER_SESSION_DEAD_MARKER =
  "AgentRouter read session is no longer authenticated.";

export class AgentRouterSessionDeadError extends Error {
  readonly code = "agentrouter_session_dead";

  constructor(message: string = AGENTROUTER_SESSION_DEAD_MARKER) {
    super(message);
    this.name = "AgentRouterSessionDeadError";
  }
}

export function isSessionDeadError(error: unknown): boolean {
  return (
    error instanceof AgentRouterSessionDeadError ||
    (error instanceof Error && error.message.includes(AGENTROUTER_SESSION_DEAD_MARKER))
  );
}

export interface AgentRouterReadSessions {
  poll(account: GitHubAccount, config: AppConfig): Promise<unknown>;
  drop(accountId: string): Promise<void>;
  close(): Promise<void>;
}

interface AccountRuntime {
  stateMtimeMs: number;
  context: BrowserContext | null;
  page: Page | null;
  pageLoaded: boolean;
}

interface SelfObservation {
  status: number;
  ct: string;
  ok: boolean;
  body: string | null;
  originOk: boolean;
  path: string;
}

function storageStatePath(config: AppConfig, account: GitHubAccount): string {
  return join(config.accountStateDir, `${account.id}.monitor.json`);
}

async function readStoredUserId(statePath: string, baseUrl: string): Promise<string> {
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    origins?: Array<{
      origin?: string;
      localStorage?: Array<{ name?: string; value?: string }>;
    }>;
  };
  const rawUser = state.origins?.find((origin) => origin.origin === baseUrl)?.localStorage?.find(
    (item) => item.name === "user",
  )?.value;
  if (typeof rawUser === "string") {
    try {
      const user = JSON.parse(rawUser) as { id?: unknown };
      const parsedId = Number(user.id);
      if (Number.isSafeInteger(parsedId) && parsedId > 0) return String(parsedId);
    } catch {
      // Fall through to the dead-session error below.
    }
  }
  throw new AgentRouterSessionDeadError(
    "Saved AgentRouter monitor session does not include a valid user id.",
  );
}

interface LaunchOptions {
  channel: string;
}

export class DefaultAgentRouterReadSessions implements AgentRouterReadSessions {
  private browser: Browser | null = null;
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readonly launch: (options: LaunchOptions) => Promise<Browser>;

  constructor(launch?: (options: LaunchOptions) => Promise<Browser>) {
    this.launch = launch ?? (async (options) => {
      const { chromium } = await import("playwright");
      return chromium.launch({ channel: options.channel, headless: true });
    });
  }

  private async browserInstance(config: AppConfig): Promise<Browser> {
    if (this.browser === null || !this.browser.isConnected()) {
      this.browser = await this.launch({ channel: config.browserChannel });
    }
    return this.browser;
  }

  private async runtime(account: GitHubAccount, config: AppConfig): Promise<AccountRuntime> {
    const statePath = storageStatePath(config, account);
    let stateMtimeMs = 0;
    try {
      stateMtimeMs = (await stat(statePath)).mtimeMs;
    } catch {
      throw new AgentRouterSessionDeadError(
        "No AgentRouter monitor session has been captured for this account yet.",
      );
    }
    const existing = this.runtimes.get(account.id);
    if (existing && existing.stateMtimeMs === stateMtimeMs && existing.context) {
      return existing;
    }
    await this.drop(account.id);
    const browser = await this.browserInstance(config);
    const context = await browser.newContext({ storageState: statePath });
    const runtime: AccountRuntime = {
      stateMtimeMs,
      context,
      page: null,
      pageLoaded: false,
    };
    this.runtimes.set(account.id, runtime);
    return runtime;
  }

  private async evaluateSelf(
    page: Page,
    config: AppConfig,
    userId: string,
  ): Promise<SelfObservation | null> {
    const expectedOrigin = new URL(config.baseUrl).origin;
    try {
      return await page.evaluate(async ({ expectedOrigin, numericUserId }) => {
        if (location.origin !== expectedOrigin) {
          return { status: 0, ct: "", ok: false, body: null, originOk: false, path: location.href };
        }
        const response = await fetch("/api/user/self", {
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Cache-Control": "no-store",
            "New-API-User": String(numericUserId),
          },
        });
        const ct = (response.headers.get("content-type") ?? "").toLowerCase();
        const body = ct.includes("application/json") ? await response.text() : null;
        return {
          status: response.status,
          ct,
          ok: response.ok,
          body,
          originOk: true,
          path: location.href,
        };
      }, { expectedOrigin, numericUserId: userId });
    } catch {
      return null;
    }
  }

  private static parsePayload(observation: SelfObservation): unknown | null {
    if (
      !observation.originOk ||
      !observation.ok ||
      !observation.ct.includes("application/json") ||
      observation.body === null
    ) {
      return null;
    }
    try {
      const payload: unknown = JSON.parse(observation.body);
      return payload && typeof payload === "object" ? payload : null;
    } catch {
      return null;
    }
  }

  async poll(account: GitHubAccount, config: AppConfig): Promise<unknown> {
    const runtime = await this.runtime(account, config);
    const context = runtime.context as BrowserContext;
    const userId = await readStoredUserId(storageStatePath(config, account), config.baseUrl);
    let page = runtime.page;
    if (page === null || page.isClosed()) {
      page = context.pages().find((candidate) => !candidate.isClosed()) ?? (await context.newPage());
      runtime.page = page;
    }
    const navigationTimeout = Math.min(config.requestTimeoutMs, 30_000);
    if (!runtime.pageLoaded) {
      await page.goto(new URL("/console/", config.baseUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeout,
      });
      runtime.pageLoaded = true;
    }

    let observation = await this.evaluateSelf(page, config, userId);
    let payload =
      observation === null ? null : DefaultAgentRouterReadSessions.parsePayload(observation);
    if (payload === null) {
      // A WAF challenge or expired session can reject the first read. Reload
      // the console once so the challenge resolves inside the real browser.
      try {
        await page.goto(new URL("/console/", config.baseUrl).toString(), {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeout,
        });
      } catch {
        // The reload may leave the page closed; evaluate below reports failure.
      }
      observation = await this.evaluateSelf(page, config, userId);
      payload =
        observation === null ? null : DefaultAgentRouterReadSessions.parsePayload(observation);
    }
    if (payload === null) {
      await this.drop(account.id);
      throw new AgentRouterSessionDeadError(
        "AgentRouter read session is no longer authenticated after a console reload.",
      );
    }
    return payload;
  }

  async drop(accountId: string): Promise<void> {
    const runtime = this.runtimes.get(accountId);
    if (runtime) {
      this.runtimes.delete(accountId);
      await runtime.context?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.drop(id)));
    const browser = this.browser;
    this.browser = null;
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
