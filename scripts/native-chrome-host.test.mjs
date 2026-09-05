import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  buildChromeArguments,
  ensurePortAvailable,
  parseStartupRecord,
  validateExecutableProduct,
  validateVersionPayload,
} from "./native-chrome-host.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("native Chrome host protocol", () => {
  test("accepts one bounded absolute startup record", () => {
    expect(parseStartupRecord(JSON.stringify({
      version: 1,
      executablePath: "/usr/bin/google-chrome-stable",
      userDataDir: "/var/lib/observatory/profile",
      port: 19_222,
      startupTimeoutMs: 30_000,
    }))).toEqual({
      version: 1,
      executablePath: "/usr/bin/google-chrome-stable",
      userDataDir: "/var/lib/observatory/profile",
      port: 19_222,
      startupTimeoutMs: 30_000,
    });
  });

  test("rejects malformed, extra, relative, oversized, and out-of-range input", () => {
    expect(() => parseStartupRecord("[]")).toThrow("object");
    expect(() => parseStartupRecord(JSON.stringify({ version: 1, executablePath: "chrome", userDataDir: "/tmp/p", port: 19222, startupTimeoutMs: 30000 }))).toThrow("absolute");
    expect(() => parseStartupRecord(JSON.stringify({ version: 1, executablePath: "/chrome", userDataDir: "/tmp/p", port: 1023, startupTimeoutMs: 30000 }))).toThrow("port");
    expect(() => parseStartupRecord(JSON.stringify({ version: 1, executablePath: "/chrome", userDataDir: "/tmp/p", port: 19222, startupTimeoutMs: 999 }))).toThrow("startupTimeoutMs");
    expect(() => parseStartupRecord(JSON.stringify({ version: 1, executablePath: "/chrome", userDataDir: "/tmp/p", port: 19222, startupTimeoutMs: 30000, surprise: true }))).toThrow("unknown");
    expect(() => parseStartupRecord("x".repeat(8193))).toThrow("8192");
  });

  test("constructs only the approved Chrome switches", () => {
    const args = buildChromeArguments({ userDataDir: "/tmp/profile", port: 19_222 });
    expect(args).toEqual([
      "--user-data-dir=/tmp/profile",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=19222",
      "--no-first-run",
      "--no-default-browser-check",
    ]);
    expect(args.join(" ")).not.toMatch(/headless|no-sandbox|enable-automation|AutomationControlled|swiftshader|user-agent|proxy/i);
  });

  test("requires the official Google Chrome executable product", () => {
    expect(validateExecutableProduct("Google Chrome 151.0.7922.34\n")).toBe(
      "Google Chrome 151.0.7922.34",
    );
    expect(() => validateExecutableProduct("Chromium 151.0.0.0")).toThrow("Google Chrome Stable");
    expect(() => validateExecutableProduct("Google Chrome for Testing 151.0.0.0")).toThrow(
      "Google Chrome Stable",
    );
  });

  test("accepts Google Chrome and rejects other CDP products", () => {
    expect(validateVersionPayload({ Browser: "Chrome/151.0.7922.34", webSocketDebuggerUrl: "ws://127.0.0.1:19222/devtools/browser/id" })).toEqual({
      product: "Chrome/151.0.7922.34",
      webSocketDebuggerUrl: "ws://127.0.0.1:19222/devtools/browser/id",
    });
    expect(() => validateVersionPayload({ Browser: "Chromium/151.0.0.0", webSocketDebuggerUrl: "ws://127.0.0.1:19222/devtools/browser/id" })).toThrow("Google Chrome");
    expect(() => validateVersionPayload({ Browser: "HeadlessChrome/151.0.0.0", webSocketDebuggerUrl: "ws://127.0.0.1:19222/devtools/browser/id" })).toThrow("Google Chrome");
  });

  test("rejects an occupied loopback endpoint", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
    const address = server.address();
    expect(typeof address).toBe("object");
    await expect(ensurePortAvailable(address.port)).rejects.toThrow("already occupied");
  });
});
