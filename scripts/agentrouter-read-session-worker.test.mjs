import { describe, expect, test } from "bun:test";
import { parseAgentRouterPayload, validateRequest } from "./agentrouter-read-session-worker.mjs";

const validPoll = {
  version: 1,
  id: "request-1",
  type: "poll",
  browser: {
    executablePath: "/usr/bin/google-chrome-stable",
    userDataDir: "/var/lib/observatory/data/poller-browser-profile",
    port: 19_223,
    startupTimeoutMs: 30_000,
  },
  account: {
    id: "acc-1",
    statePath: "/var/lib/observatory/data/states/acc-1.monitor.json",
    baseUrl: "https://agentrouter.org",
    requestTimeoutMs: 45_000,
  },
};

describe("AgentRouter read-session worker protocol", () => {
  test("accepts bounded metadata-only poll requests", () => {
    expect(validateRequest(JSON.stringify(validPoll))).toEqual(validPoll);
  });

  test("rejects unknown records, credentials, and oversized input", () => {
    expect(() => validateRequest("[]")).toThrow("object");
    expect(() => validateRequest(JSON.stringify({ ...validPoll, password: "secret" }))).toThrow("unknown");
    expect(() => validateRequest(JSON.stringify({ ...validPoll, account: { ...validPoll.account, cookie: "secret" } }))).toThrow("unknown");
    expect(() => validateRequest("x".repeat(1_048_577))).toThrow("1048576");
  });

  test("accepts only successful JSON observations", () => {
    expect(parseAgentRouterPayload({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: "{\"data\":{\"id\":1}}",
      originOk: true,
    })).toEqual({ data: { id: 1 } });
    expect(parseAgentRouterPayload({ status: 403, contentType: "text/html", body: null, originOk: true })).toBeNull();
    expect(parseAgentRouterPayload({ status: 200, contentType: "application/json", body: "null", originOk: true })).toBeNull();
  });
});
