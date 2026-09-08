import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { GitHubAccount } from "./accounts";
import { buildBrowserWorkerEnv } from "./child-environment";
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



function storageStatePath(config: AppConfig, account: GitHubAccount): string {
  return join(config.accountStateDir, `${account.id}.monitor.json`);
}



interface ReadSessionTransport {
  poll(account: GitHubAccount, config: AppConfig): Promise<unknown>;
  drop(accountId: string): Promise<void>;
  close(): Promise<void>;
}

interface WorkerResponse {
  version: 1;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: {
    code?: string;
    message?: string;
  };
}

const READ_SESSION_WORKER_PATH = fileURLToPath(
  new URL("../scripts/agentrouter-read-session-worker.mjs", import.meta.url),
);
const MAX_RESPONSE_BYTES = 1_048_576;

class NodeReadSessionTransport implements ReadSessionTransport {
  private process: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private iterator: AsyncIterableIterator<string> | null = null;
  private stderr = "";
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.closed) throw new Error("AgentRouter read-session transport is closed.");
    if (this.process && this.process.exitCode === null && !this.process.killed) return this.process;
    this.stderr = "";
    const nodeBinary = process.env.NODE_BINARY?.trim() || "node";
    const child = spawn(nodeBinary, [READ_SESSION_WORKER_PATH], {
      cwd: process.cwd(),
      env: buildBrowserWorkerEnv(),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => undefined);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_096);
    });
    child.on("error", (error) => {
      this.stderr = `${this.stderr}\n${error.message}`.slice(-4_096);
    });
    this.process = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.iterator = this.lines[Symbol.asyncIterator]();
    return child;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async nextResponse(timeoutMs: number): Promise<string> {
    const iterator = this.iterator;
    if (!iterator) throw new Error("AgentRouter read-session worker is unavailable.");
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("AgentRouter read-session worker response timed out.")),
            timeoutMs,
          );
        }),
      ]);
      if (result.done) {
        const detail = this.stderr.trim().replace(/\s+/g, " ").slice(-1_000);
        throw new Error(
          `AgentRouter read-session worker exited before responding${detail ? `: ${detail}` : "."}`,
        );
      }
      if (Buffer.byteLength(result.value, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error(`AgentRouter read-session worker response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
      }
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error("AgentRouter read-session transport is closed.");
      const child = this.ensureProcess();
      const id = randomUUID();
      const record = JSON.stringify({ version: 1, id, ...body });
      if (Buffer.byteLength(record, "utf8") > MAX_RESPONSE_BYTES) {
        throw new Error(`AgentRouter read-session worker request exceeds ${MAX_RESPONSE_BYTES} bytes.`);
      }
      try {
        if (!child.stdin.write(`${record}\n`)) await once(child.stdin, "drain");
        const line = await this.nextResponse(timeoutMs);
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("AgentRouter read-session worker emitted a non-object response.");
        }
        const response = parsed as Partial<WorkerResponse>;
        if (response.version !== 1 || response.id !== id || typeof response.ok !== "boolean") {
          throw new Error("AgentRouter read-session worker emitted a mismatched response.");
        }
        if (response.ok) return response.payload;
        const message =
          typeof response.error?.message === "string"
            ? response.error.message
            : "AgentRouter browser read failed.";
        if (response.error?.code === "agentrouter_session_dead") {
          throw new AgentRouterSessionDeadError(message);
        }
        throw new Error(message);
      } catch (error) {
        await this.stopProcess();
        throw error;
      }
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("AgentRouter read-session transport is closed.");
  }

  async poll(account: GitHubAccount, config: AppConfig): Promise<unknown> {
    this.assertOpen();
    return this.request({
      type: "poll",
      browser: {
        executablePath: config.browserExecutable,
        userDataDir: config.browserPollerProfileDir,
        port: config.browserPollerCdpPort,
        startupTimeoutMs: config.browserStartTimeoutMs,
      },
      account: {
        id: account.id,
        statePath: resolve(storageStatePath(config, account)),
        baseUrl: new URL(config.baseUrl).origin,
        requestTimeoutMs: config.requestTimeoutMs,
      },
    }, Math.max(config.browserStartTimeoutMs + config.requestTimeoutMs * 3, 60_000));
  }

  async drop(accountId: string): Promise<void> {
    this.assertOpen();
    if (!this.process || this.process.exitCode !== null) return;
    await this.request({ type: "drop", accountId }, 30_000);
  }

  private async waitForProcessClose(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
  ): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return Promise.race([
      once(child, "close").then(() => true),
      new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
    ]);
  }

  private async stopProcess(): Promise<void> {
    const child = this.process;
    if (!child) return;
    child.stdin.end();
    let exited = await this.waitForProcessClose(child, 15_000);
    if (!exited) {
      child.kill("SIGTERM");
      exited = await this.waitForProcessClose(child, 5_000);
    }
    if (!exited) {
      child.kill("SIGKILL");
      exited = await this.waitForProcessClose(child, 5_000);
    }
    if (!exited) {
      throw new Error("AgentRouter read-session worker did not exit after SIGKILL.");
    }
    if (this.process === child) {
      this.process = null;
      this.iterator = null;
      this.lines = null;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.enqueue(() => this.stopProcess());
    return this.closePromise;
  }
}

export class DefaultAgentRouterReadSessions implements AgentRouterReadSessions {
  constructor(private readonly transport: ReadSessionTransport = new NodeReadSessionTransport()) {}

  async poll(account: GitHubAccount, config: AppConfig): Promise<unknown> {
    return this.transport.poll(account, config);
  }

  async drop(accountId: string): Promise<void> {
    await this.transport.drop(accountId);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
