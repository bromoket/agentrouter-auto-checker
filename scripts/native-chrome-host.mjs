import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_VERSION = 1;
const MAX_RECORD_BYTES = 8_192;
const MIN_PORT = 1_024;
const MAX_PORT = 65_535;
const MIN_STARTUP_TIMEOUT_MS = 1_000;
const MAX_STARTUP_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 5_000;

function portableAbsolute(value) {
  return path.isAbsolute(value) || /^\/[^/]/.test(value);
}

export function parseStartupRecord(line) {
  if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
    throw new Error(`Native Chrome startup record exceeds ${MAX_RECORD_BYTES} bytes.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Native Chrome startup record must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native Chrome startup record must be an object.");
  }
  const allowed = new Set([
    "version",
    "executablePath",
    "userDataDir",
    "port",
    "startupTimeoutMs",
  ]);
  const unknown = Object.keys(parsed).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Native Chrome startup record contains unknown fields: ${unknown.join(", ")}.`);
  }
  if (parsed.version !== PROTOCOL_VERSION) {
    throw new Error(`Native Chrome startup record version must be ${PROTOCOL_VERSION}.`);
  }
  if (typeof parsed.executablePath !== "string" || !portableAbsolute(parsed.executablePath)) {
    throw new Error("Native Chrome executablePath must be an absolute path.");
  }
  if (typeof parsed.userDataDir !== "string" || !portableAbsolute(parsed.userDataDir)) {
    throw new Error("Native Chrome userDataDir must be an absolute path.");
  }
  if (!Number.isSafeInteger(parsed.port) || parsed.port < MIN_PORT || parsed.port > MAX_PORT) {
    throw new Error(`Native Chrome port must be an integer between ${MIN_PORT} and ${MAX_PORT}.`);
  }
  if (
    !Number.isSafeInteger(parsed.startupTimeoutMs) ||
    parsed.startupTimeoutMs < MIN_STARTUP_TIMEOUT_MS ||
    parsed.startupTimeoutMs > MAX_STARTUP_TIMEOUT_MS
  ) {
    throw new Error(
      `Native Chrome startupTimeoutMs must be an integer between ${MIN_STARTUP_TIMEOUT_MS} and ${MAX_STARTUP_TIMEOUT_MS}.`,
    );
  }
  return {
    version: PROTOCOL_VERSION,
    executablePath: parsed.executablePath,
    userDataDir: parsed.userDataDir,
    port: parsed.port,
    startupTimeoutMs: parsed.startupTimeoutMs,
  };
}

export function buildChromeArguments({ userDataDir, port }) {
  return [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

export function validateExecutableProduct(output) {
  const product = String(output).trim();
  if (!/^Google Chrome (?!for Testing\b)\d+(?:\.\d+){2,3}$/.test(product)) {
    throw new Error("BROWSER_EXECUTABLE must identify as Google Chrome Stable.");
  }
  return product;
}

export function validateVersionPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Native Chrome CDP version response must be an object.");
  }
  const product = typeof payload.Browser === "string" ? payload.Browser : "";
  const webSocketDebuggerUrl =
    typeof payload.webSocketDebuggerUrl === "string" ? payload.webSocketDebuggerUrl : "";
  if (!/^Chrome\/\d/.test(product)) {
    throw new Error("Native browser CDP endpoint is not Google Chrome.");
  }
  if (!webSocketDebuggerUrl.startsWith("ws://127.0.0.1:")) {
    throw new Error("Native Chrome CDP endpoint did not advertise a loopback debugger URL.");
  }
  return { product, webSocketDebuggerUrl };
}

export async function ensurePortAvailable(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error && error.code === "EADDRINUSE") {
        reject(new Error(`Native Chrome CDP port ${port} is already occupied.`));
      } else {
        reject(error);
      }
    });
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function readExecutableProduct(executablePath) {
  const child = spawn(executablePath, ["--version"], {
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-1_024);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-1_024);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const [code] = await once(child, "close");
    if (code !== 0) {
      throw new Error(`Unable to identify BROWSER_EXECUTABLE: ${stderr.trim() || `exit ${code}`}.`);
    }
    return validateExecutableProduct(stdout);
  } finally {
    clearTimeout(timer);
  }
}

function readStartupLine(input) {
  input.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("Native Chrome host stdin closed before startup configuration."));
    };
    const onData = (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RECORD_BYTES + 1) {
        cleanup();
        reject(new Error(`Native Chrome startup record exceeds ${MAX_RECORD_BYTES} bytes.`));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      if (buffer.slice(newline + 1).trim().length > 0) {
        cleanup();
        reject(new Error("Native Chrome host accepts exactly one startup record."));
        return;
      }
      cleanup();
      resolve(line);
    };
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
  });
}

async function waitForVersion(port, timeoutMs, stopped) {
  const endpointURL = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline && !stopped()) {
    try {
      const response = await fetch(`${endpointURL}/json/version`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(2_000, Math.max(250, deadline - Date.now()))),
      });
      if (response.ok) {
        const version = validateVersionPayload(await response.json());
        return { endpointURL, ...version };
      }
      lastError = new Error(`CDP version endpoint returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (stopped()) throw new Error("Native Chrome host stopped during startup.");
  throw new Error(
    `Native Chrome did not expose a valid CDP endpoint before timeout${
      lastError instanceof Error ? `: ${lastError.message}` : "."
    }`,
  );
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function signalOwnedProcess(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!error || error.code !== "ESRCH") throw error;
  }
}

async function terminateOwnedProcess(child) {
  if (!child) return;
  signalOwnedProcess(child, "SIGTERM");
  if (await waitForExit(child, SHUTDOWN_GRACE_MS)) return;
  signalOwnedProcess(child, "SIGKILL");
  await waitForExit(child, SHUTDOWN_GRACE_MS);
}

export async function runNativeChromeHost({ input = process.stdin, output = process.stdout } = {}) {
  const config = parseStartupRecord(await readStartupLine(input));
  let child = null;
  let stopRequested = false;
  let releaseLease;
  const lease = new Promise((resolve) => {
    releaseLease = resolve;
  });
  const requestStop = () => {
    stopRequested = true;
    releaseLease();
  };
  input.once("end", requestStop);
  input.once("close", requestStop);
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  process.once("SIGHUP", requestStop);

  try {
    await access(config.executablePath);
    const executableProduct = await readExecutableProduct(config.executablePath);
    await mkdir(config.userDataDir, { recursive: true, mode: 0o700 });
    await ensurePortAvailable(config.port);
    child = spawn(config.executablePath, buildChromeArguments(config), {
      detached: process.platform !== "win32",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", () => undefined);
    await Promise.race([
      once(child, "spawn"),
      once(child, "error").then(([error]) => Promise.reject(error)),
    ]);
    child.once("exit", requestStop);
    const version = await waitForVersion(config.port, config.startupTimeoutMs, () => stopRequested);
    const readiness = {
      version: PROTOCOL_VERSION,
      status: "ready",
      endpointURL: version.endpointURL,
      product: executableProduct,
      pid: child.pid,
    };
    const record = JSON.stringify(readiness);
    if (Buffer.byteLength(record, "utf8") > MAX_RECORD_BYTES) {
      throw new Error("Native Chrome readiness record exceeds its protocol bound.");
    }
    output.write(`${record}\n`);
    await lease;
  } finally {
    input.off("end", requestStop);
    input.off("close", requestStop);
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    process.off("SIGHUP", requestStop);
    await terminateOwnedProcess(child);
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath === fileURLToPath(import.meta.url)) {
  runNativeChromeHost().catch((error) => {
    process.stderr.write(`Native Chrome host failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
