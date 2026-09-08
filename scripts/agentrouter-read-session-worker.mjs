import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { connectNativeChrome } from "./native-chrome-client.mjs";

const PROTOCOL_VERSION = 1;
const MAX_RECORD_BYTES = 1_048_576;
const MAX_BODY_BYTES = 524_288;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SESSION_DEAD_CODE = "agentrouter_session_dead";

function portableAbsolute(value) {
  return path.isAbsolute(value) || /^\/[^/]/.test(value);
}

function exactKeys(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${name} contains unknown fields: ${unknown.join(", ")}.`);
}

function objectValue(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function browserConfig(value) {
  const config = objectValue(value, "browser");
  exactKeys(config, new Set(["executablePath", "userDataDir", "port", "startupTimeoutMs"]), "browser");
  if (typeof config.executablePath !== "string" || !portableAbsolute(config.executablePath)) {
    throw new Error("browser.executablePath must be absolute.");
  }
  if (typeof config.userDataDir !== "string" || !portableAbsolute(config.userDataDir)) {
    throw new Error("browser.userDataDir must be absolute.");
  }
  return {
    executablePath: config.executablePath,
    userDataDir: config.userDataDir,
    port: boundedInteger(config.port, 1_024, 65_535, "browser.port"),
    startupTimeoutMs: boundedInteger(config.startupTimeoutMs, 1_000, 120_000, "browser.startupTimeoutMs"),
  };
}

function accountConfig(value) {
  const account = objectValue(value, "account");
  exactKeys(account, new Set(["id", "statePath", "baseUrl", "requestTimeoutMs"]), "account");
  if (typeof account.id !== "string" || !ACCOUNT_ID_PATTERN.test(account.id)) {
    throw new Error("account.id is invalid.");
  }
  if (typeof account.statePath !== "string" || !portableAbsolute(account.statePath)) {
    throw new Error("account.statePath must be absolute.");
  }
  let baseUrl;
  try {
    baseUrl = new URL(account.baseUrl);
  } catch {
    throw new Error("account.baseUrl must be a valid URL.");
  }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("account.baseUrl must be an HTTPS origin without credentials, query, or fragment.");
  }
  return {
    id: account.id,
    statePath: account.statePath,
    baseUrl: baseUrl.origin,
    requestTimeoutMs: boundedInteger(account.requestTimeoutMs, 1_000, 300_000, "account.requestTimeoutMs"),
  };
}

export function validateRequest(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
    throw new Error(`Read-session worker record exceeds ${MAX_RECORD_BYTES} bytes.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Read-session worker record must be valid JSON.");
  }
  const request = objectValue(parsed, "Read-session worker record");
  if (request.version !== PROTOCOL_VERSION || typeof request.id !== "string" || !ID_PATTERN.test(request.id)) {
    throw new Error("Read-session worker record has an invalid version or id.");
  }
  if (request.type === "poll") {
    exactKeys(request, new Set(["version", "id", "type", "browser", "account"]), "poll request");
    return {
      version: PROTOCOL_VERSION,
      id: request.id,
      type: "poll",
      browser: browserConfig(request.browser),
      account: accountConfig(request.account),
    };
  }
  if (request.type === "drop") {
    exactKeys(request, new Set(["version", "id", "type", "accountId"]), "drop request");
    if (typeof request.accountId !== "string" || !ACCOUNT_ID_PATTERN.test(request.accountId)) {
      throw new Error("drop request accountId is invalid.");
    }
    return { version: PROTOCOL_VERSION, id: request.id, type: "drop", accountId: request.accountId };
  }
  throw new Error("Read-session worker request type is invalid.");
}

export function parseAgentRouterPayload(observation) {
  if (
    !observation?.originOk ||
    observation.status < 200 ||
    observation.status >= 300 ||
    typeof observation.contentType !== "string" ||
    !observation.contentType.toLowerCase().includes("application/json") ||
    typeof observation.body !== "string"
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(observation.body);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

class SessionDeadError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionDeadError";
    this.code = SESSION_DEAD_CODE;
  }
}

class ReadSessionRuntime {
  constructor() {
    this.connection = null;
    this.browserKey = null;
    this.accounts = new Map();
  }

  async drop(accountId) {
    const runtime = this.accounts.get(accountId);
    if (!runtime) return;
    this.accounts.delete(accountId);
    await runtime.context.close().catch(() => undefined);
  }

  async closeBrowser() {
    await Promise.all([...this.accounts.keys()].map((id) => this.drop(id)));
    const connection = this.connection;
    this.connection = null;
    this.browserKey = null;
    if (connection) await connection.close();
  }

  async browser(config) {
    const key = JSON.stringify(config);
    if (this.connection?.browser.isConnected() && this.browserKey === key) return this.connection.browser;
    await this.closeBrowser();
    this.connection = await connectNativeChrome(chromium, config);
    this.browserKey = key;
    return this.connection.browser;
  }

  async accountRuntime(request) {
    let stateMtimeMs;
    try {
      stateMtimeMs = (await stat(request.account.statePath)).mtimeMs;
    } catch {
      throw new SessionDeadError("No AgentRouter monitor session has been captured for this account yet.");
    }
    const runtimeKey = JSON.stringify({
      browser: request.browser,
      statePath: request.account.statePath,
      baseUrl: request.account.baseUrl,
    });
    const existing = this.accounts.get(request.account.id);
    if (
      existing &&
      existing.runtimeKey === runtimeKey &&
      existing.stateMtimeMs === stateMtimeMs &&
      existing.context &&
      this.connection?.browser.isConnected()
    ) {
      return existing;
    }
    await this.drop(request.account.id);
    const browser = await this.browser(request.browser);
    const context = await browser.newContext({ storageState: request.account.statePath });
    const runtime = { runtimeKey, stateMtimeMs, context, page: null, pageLoaded: false };
    this.accounts.set(request.account.id, runtime);
    return runtime;
  }

  async storedUserId(request) {
    const state = JSON.parse(await readFile(request.account.statePath, "utf8"));
    const rawUser = state.origins?.find((origin) => origin.origin === request.account.baseUrl)
      ?.localStorage?.find((item) => item.name === "user")?.value;
    if (typeof rawUser === "string") {
      try {
        const parsedId = Number(JSON.parse(rawUser)?.id);
        if (Number.isSafeInteger(parsedId) && parsedId > 0) return String(parsedId);
      } catch {
        // Report the consistent dead-session error below.
      }
    }
    throw new SessionDeadError("Saved AgentRouter monitor session does not include a valid user id.");
  }

  async observation(page, request, userId) {
    const expectedOrigin = request.account.baseUrl;
    try {
      return await page.evaluate(async ({ expectedOrigin: origin, numericUserId, maxBodyBytes }) => {
        if (location.origin !== origin) {
          return { status: 0, contentType: "", body: null, originOk: false, error: null };
        }
        const response = await fetch("/api/user/self", {
          credentials: "include",
          headers: {
            Accept: "application/json",
            "Cache-Control": "no-store",
            "New-API-User": String(numericUserId),
          },
        });
        const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
        let body = null;
        let error = null;
        if (contentType.includes("application/json")) {
          const declaredLength = Number(response.headers.get("content-length"));
          if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
            error = `AgentRouter user response exceeds ${maxBodyBytes} bytes.`;
          } else if (response.body) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const chunks = [];
            let received = 0;
            while (true) {
              const result = await reader.read();
              if (result.done) break;
              received += result.value.byteLength;
              if (received > maxBodyBytes) {
                await reader.cancel();
                error = `AgentRouter user response exceeds ${maxBodyBytes} bytes.`;
                break;
              }
              chunks.push(decoder.decode(result.value, { stream: true }));
            }
            if (error === null) body = `${chunks.join("")}${decoder.decode()}`;
          }
        }
        return { status: response.status, contentType, body, originOk: true, error };
      }, { expectedOrigin, numericUserId: userId, maxBodyBytes: MAX_BODY_BYTES });
    } catch {
      return null;
    }
  }

  async poll(request) {
    const runtime = await this.accountRuntime(request);
    const userId = await this.storedUserId(request);
    let page = runtime.page;
    if (page === null || page.isClosed()) {
      page = runtime.context.pages().find((candidate) => !candidate.isClosed()) ?? await runtime.context.newPage();
      runtime.page = page;
    }
    const navigationTimeout = Math.min(request.account.requestTimeoutMs, 30_000);
    if (!runtime.pageLoaded) {
      await page.goto(new URL("/console/", request.account.baseUrl).toString(), {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeout,
      });
      runtime.pageLoaded = true;
    }
    let observation = await this.observation(page, request, userId);
    if (observation?.error) throw new Error(observation.error);
    let payload = parseAgentRouterPayload(observation);
    if (payload === null) {
      try {
        await page.goto(new URL("/console/", request.account.baseUrl).toString(), {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeout,
        });
      } catch {
        // The authoritative read below decides whether the session survived.
      }
      observation = await this.observation(page, request, userId);
      if (observation?.error) throw new Error(observation.error);
      payload = parseAgentRouterPayload(observation);
    }
    if (payload === null) {
      await this.drop(request.account.id);
      throw new SessionDeadError(
        "AgentRouter read session is no longer authenticated after a console reload.",
      );
    }
    return payload;
  }
}

function emit(response) {
  const record = JSON.stringify(response);
  if (Buffer.byteLength(record, "utf8") > MAX_RECORD_BYTES) {
    throw new Error(`Read-session worker response exceeds ${MAX_RECORD_BYTES} bytes.`);
  }
  process.stdout.write(`${record}\n`);
}

async function main() {
  const runtime = new ReadSessionRuntime();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      let request;
      try {
        request = validateRequest(line);
      } catch (error) {
        process.stderr.write(`Read-session worker protocol error: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
        break;
      }
      try {
        const payload = request.type === "poll"
          ? await runtime.poll(request)
          : await runtime.drop(request.accountId).then(() => null);
        emit({ version: PROTOCOL_VERSION, id: request.id, ok: true, payload });
      } catch (error) {
        emit({
          version: PROTOCOL_VERSION,
          id: request.id,
          ok: false,
          error: {
            code: error?.code === SESSION_DEAD_CODE ? SESSION_DEAD_CODE : "browser_read_failed",
            message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          },
        });
      }
    }
  } finally {
    await runtime.closeBrowser().catch((error) => {
      process.stderr.write(`Read-session worker cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Read-session worker failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
