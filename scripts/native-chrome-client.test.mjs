import { describe, expect, test } from "bun:test";
import { connectNativeChrome, parseReadinessRecord } from "./native-chrome-client.mjs";

describe("native Chrome host client", () => {
  test("accepts one bounded loopback readiness record", () => {
    expect(parseReadinessRecord(JSON.stringify({
      version: 1,
      status: "ready",
      endpointURL: "http://127.0.0.1:19222",
      product: "Google Chrome 151.0.7922.34",
      pid: 1234,
    }), 19_222)).toEqual({
      version: 1,
      status: "ready",
      endpointURL: "http://127.0.0.1:19222",
      product: "Google Chrome 151.0.7922.34",
      pid: 1234,
    });
  });

  test("rejects unknown endpoints, products, fields, and oversized output", () => {
    expect(() => parseReadinessRecord("[]", 19_222)).toThrow("object");
    expect(() => parseReadinessRecord(JSON.stringify({ version: 1, status: "ready", endpointURL: "http://0.0.0.0:19222", product: "Google Chrome 151.0.0.0", pid: 1 }), 19_222)).toThrow("endpointURL");
    expect(() => parseReadinessRecord(JSON.stringify({ version: 1, status: "ready", endpointURL: "http://127.0.0.1:19222", product: "Chromium 151.0.0.0", pid: 1 }), 19_222)).toThrow("product");
    expect(() => parseReadinessRecord(JSON.stringify({ version: 1, status: "ready", endpointURL: "http://127.0.0.1:19222", product: "Google Chrome 151.0.0.0", pid: 1, extra: true }), 19_222)).toThrow("unknown");
    expect(() => parseReadinessRecord("x".repeat(8193), 19_222)).toThrow("8192");
  });

  test("attaches without Playwright defaults and cleans up in order", async () => {
    const calls = [];
    const context = {};
    const browser = {
      contexts: () => [context],
      close: async () => calls.push("browser-close"),
    };
    const chromium = {
      connectOverCDP: async (options) => {
        calls.push(options);
        return browser;
      },
    };
    const host = {
      endpointURL: "http://127.0.0.1:19222",
      stop: async () => calls.push("host-stop"),
    };
    const connected = await connectNativeChrome(chromium, {}, {
      startHost: async () => host,
    });
    expect(connected.context).toBe(context);
    expect(calls).toEqual([{ endpointURL: host.endpointURL, noDefaults: true }]);
    await connected.close();
    expect(calls).toEqual([
      { endpointURL: host.endpointURL, noDefaults: true },
      "browser-close",
      "host-stop",
    ]);
  });

  test("stops the owned host when attachment fails", async () => {
    const calls = [];
    const host = {
      endpointURL: "http://127.0.0.1:19222",
      stop: async () => calls.push("host-stop"),
    };
    await expect(connectNativeChrome({
      connectOverCDP: async () => {
        throw new Error("attach failed");
      },
    }, {}, {
      startHost: async () => host,
    })).rejects.toThrow("attach failed");
    expect(calls).toEqual(["host-stop"]);
  });
});
