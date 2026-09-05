import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_RECORD_BYTES = 8_192;
const HOST_PATH = fileURLToPath(new URL("./native-chrome-host.mjs", import.meta.url));

export function parseReadinessRecord(line, expectedPort) {
  if (Buffer.byteLength(line, "utf8") > MAX_RECORD_BYTES) {
    throw new Error(`Native Chrome readiness record exceeds ${MAX_RECORD_BYTES} bytes.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("Native Chrome readiness record must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native Chrome readiness record must be an object.");
  }
  const allowed = new Set(["version", "status", "endpointURL", "product", "pid"]);
  const unknown = Object.keys(parsed).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Native Chrome readiness record contains unknown fields: ${unknown.join(", ")}.`);
  }
  if (parsed.version !== 1 || parsed.status !== "ready") {
    throw new Error("Native Chrome host did not report protocol version 1 readiness.");
  }
  if (parsed.endpointURL !== `http://127.0.0.1:${expectedPort}`) {
    throw new Error("Native Chrome readiness endpointURL does not match the requested loopback port.");
  }
  if (
    typeof parsed.product !== "string" ||
    !/^Google Chrome (?!for Testing\b)\d+(?:\.\d+){2,3}$/.test(parsed.product)
  ) {
    throw new Error("Native Chrome readiness product is not Google Chrome Stable.");
  }
  if (!Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
    throw new Error("Native Chrome readiness pid is invalid.");
  }
  return {
    version: 1,
    status: "ready",
    endpointURL: parsed.endpointURL,
    product: parsed.product,
    pid: parsed.pid,
  };
}

function readBoundedLine(stream, child, stderrText) {
  stream.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      child.off("exit", onExit);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RECORD_BYTES + 1) {
        fail(new Error(`Native Chrome readiness record exceeds ${MAX_RECORD_BYTES} bytes.`));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolve(buffer.slice(0, newline).replace(/\r$/, ""));
    };
    const onEnd = () => fail(new Error(`Native Chrome host closed stdout before readiness${stderrText()}.`));
    const onError = (error) => fail(error);
    const onExit = (code, signal) => fail(new Error(
      `Native Chrome host exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"})${stderrText()}.`,
    ));
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export async function startNativeChromeHost(config, options = {}) {
  const nodeBinary = options.nodeBinary || process.env.NODE_BINARY?.trim() || process.execPath;
  const hostPath = options.hostPath || HOST_PATH;
  if (!path.isAbsolute(hostPath)) throw new Error("Native Chrome host path must be absolute.");
  const child = (options.spawnFn || spawn)(nodeBinary, [hostPath], {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  const stderrSuffix = () => {
    const concise = stderr.trim().replace(/\s+/g, " ");
    return concise ? `: ${concise.slice(-1_000)}` : "";
  };
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.stdin.end();
    if (await waitForChildExit(child, 12_000)) return;
    child.kill("SIGTERM");
    if (await waitForChildExit(child, 5_000)) return;
    child.kill("SIGKILL");
    await waitForChildExit(child, 5_000);
  };

  try {
    const readinessPromise = readBoundedLine(child.stdout, child, stderrSuffix);
    child.stdin.write(`${JSON.stringify({
      version: 1,
      executablePath: config.executablePath,
      userDataDir: config.userDataDir,
      port: config.port,
      startupTimeoutMs: config.startupTimeoutMs,
    })}\n`);
    const readiness = parseReadinessRecord(await readinessPromise, config.port);
    return { ...readiness, stop, process: child };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function connectNativeChrome(chromium, hostConfig, options = {}) {
  const startHost = options.startHost || startNativeChromeHost;
  const host = await startHost(hostConfig, options.hostOptions);
  let browser = null;
  try {
    browser = await chromium.connectOverCDP({
      endpointURL: host.endpointURL,
      noDefaults: true,
    });
    const contexts = browser.contexts();
    if (contexts.length !== 1) {
      throw new Error(`Native Chrome must expose exactly one default context; received ${contexts.length}.`);
    }
    let closed = false;
    return {
      browser,
      context: contexts[0],
      host,
      close: async () => {
        if (closed) return;
        closed = true;
        await browser.close().catch(() => undefined);
        await host.stop();
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await host.stop();
    throw error;
  }
}
