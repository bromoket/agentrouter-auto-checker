import { fileURLToPath } from "node:url";
import { buildBrowserWorkerEnv } from "./child-environment";
import type { GitHubAccount } from "./accounts";
import type {
  AuthenticationChallengeBroker,
  AuthenticationChallengeRequest,
} from "./challenges";
import type { AppConfig } from "./config";
import type { AutomationSettings } from "./settings";
import type { RunSnapshot } from "./storage";

const WORKER_PATH = fileURLToPath(
  new URL("../scripts/agentrouter-worker.mjs", import.meta.url),
);

type WorkerPayload = {
  account: GitHubAccount;
  config: {
    baseUrl: string;
    requestTimeoutMs: number;
    loginTimeoutMs: number;
    browserHeadless: boolean;
    screenshotDir: string;
    accountStateDir: string;
    browserProfileDir: string;
    browserChannel: string;
    disableWebAuthn: boolean;
    authChallengeTimeoutMs: number;
    captureScreenshots: boolean;
    activityLookbackDays: number;
  };
};

type WorkerMessage =
  | { type: "challenge"; challenge: AuthenticationChallengeRequest & { workerChallengeId: string } }
  | { type: "challenge-complete"; workerChallengeId: string }
  | { type: "progress"; progress: WorkerProgress }
  | { type: "result"; result: RunSnapshot };

export interface WorkerProgress {
  stage: string;
  message: string;
  percent: number;
  at: string;
}

interface RunSingleAccountOptions {
  signal?: AbortSignal;
  onProgress?: (progress: WorkerProgress) => void;
}

function parseWorkerMessage(line: string): WorkerMessage {
  const parsed: unknown = JSON.parse(line);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Worker emitted a non-object message.");
  }
  const message = parsed as Partial<WorkerMessage>;
  if (
    message.type !== "challenge" &&
    message.type !== "challenge-complete" &&
    message.type !== "progress" &&
    message.type !== "result"
  ) {
    throw new Error("Worker emitted an unknown message type.");
  }
  return message as WorkerMessage;
}

export async function runSingleAccountCheck(
  account: GitHubAccount,
  config: AppConfig,
  settings: AutomationSettings,
  challenges: AuthenticationChallengeBroker,
  options: RunSingleAccountOptions = {},
): Promise<RunSnapshot> {
  if (options.signal?.aborted) {
    throw new Error("Check cancelled before the browser worker started.");
  }
  const payload: WorkerPayload = {
    account,
    config: {
      baseUrl: config.baseUrl,
      requestTimeoutMs: config.requestTimeoutMs,
      loginTimeoutMs: config.loginTimeoutMs,
      browserHeadless: settings.browserHeadless,
      screenshotDir: config.screenshotDir,
      accountStateDir: config.accountStateDir,
      browserProfileDir: config.browserProfileDir,
      browserChannel: config.browserChannel,
      disableWebAuthn: config.disableWebAuthn,
      authChallengeTimeoutMs: settings.twoFactorTimeoutMinutes * 60_000,
      captureScreenshots: settings.captureScreenshots,
      activityLookbackDays: settings.activityLookbackDays,
    },
  };

  const nodeBinary = process.env.NODE_BINARY?.trim() || "node";
  const proc = Bun.spawn({
    cmd: [nodeBinary, WORKER_PATH],
    cwd: process.cwd(),
    env: buildBrowserWorkerEnv(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  if (!proc.stdin) {
    throw new Error("Failed to open stdin for worker process.");
  }

  const timeoutMs = Math.max(
    config.requestTimeoutMs * 3 +
      config.loginTimeoutMs +
      settings.twoFactorTimeoutMinutes * 60_000,
    180_000,
  );
  let timedOut = false;
  let cancelled = false;
  let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
  const requestWorkerStop = () => {
    try {
      proc.stdin?.write(`${JSON.stringify({ type: "cancel" })}\n`);
    } catch {
      proc.kill();
      return;
    }
    hardKillTimer ??= setTimeout(() => proc.kill(), 20_000);
  };
  const abortWorker = () => {
    cancelled = true;
    requestWorkerStop();
  };
  options.signal?.addEventListener("abort", abortWorker, { once: true });
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    requestWorkerStop();
  }, timeoutMs);

  let result: RunSnapshot | undefined;
  const publishedChallenges = new Map<string, string>();
  const stderrPromise = new Response(proc.stderr).text();
  const stdoutPromise = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    let buffered = "";

    const consume = async (line: string): Promise<void> => {
      if (!line.trim()) return;
      const message = parseWorkerMessage(line);
      if (message.type === "result") {
        result = message.result;
        return;
      }
      if (message.type === "challenge-complete") {
        const publishedId = publishedChallenges.get(message.workerChallengeId);
        if (publishedId) {
          challenges.complete(publishedId);
          publishedChallenges.delete(message.workerChallengeId);
        }
        return;
      }
      if (message.type === "progress") {
        options.onProgress?.(message.progress);
        return;
      }

      const challenge = message.challenge;
      const publishedId = challenges.publish({
        accountId: account.id,
        accountLabel: account.label,
        kind: challenge.kind,
        prompt: challenge.prompt,
        verificationCode: challenge.verificationCode,
        expiresInMs: settings.twoFactorTimeoutMinutes * 60_000,
      });
      publishedChallenges.set(challenge.workerChallengeId, publishedId);
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        await consume(line);
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) {
      await consume(buffered);
    }
  })();

  try {
    proc.stdin.write(`${JSON.stringify({ type: "start", payload })}\n`);
    const [exitCode, , stderrText] = await Promise.all([
      proc.exited,
      stdoutPromise,
      stderrPromise,
    ]);
    if (stderrText) {
      console.error(`[worker:${account.label}] ${stderrText.trim()}`);
    }
    if (exitCode !== 0) {
      if (cancelled || options.signal?.aborted) {
        throw new Error(`Check cancelled for ${account.label}.`);
      }
      if (timedOut) {
        throw new Error(`Browser worker timed out for ${account.label}.`);
      }
      throw new Error(
        `Browser worker exited with code ${exitCode} for ${account.label}: ${stderrText.trim()}`,
      );
    }
    if (!result || typeof result !== "object") {
      throw new Error(`Worker did not return a valid result for ${account.label}.`);
    }
    return result;
  } finally {
    clearTimeout(timeoutTimer);
    if (hardKillTimer) clearTimeout(hardKillTimer);
    proc.stdin.end();
    options.signal?.removeEventListener("abort", abortWorker);
    challenges.cancelAccount(account.id);
  }
}
