import { describe, expect, test } from "bun:test";
import * as money from "./agentrouter-money.mjs";

const { parseLabeledMoney, parseLabeledNumber } = money;

describe("AgentRouter visible money parser", () => {
  test.each([
    ["Current balance $126.4349", 126.4349],
    ["Current balance $-0.12", -0.12],
    ["Current balance -$0.12", -0.12],
    ["Current balance −$0.12", -0.12],
    ["Current balance ($0.12)", -0.12],
    ["Current balance +$1,234.56", 1234.56],
    ["Current balance USD -0.12", -0.12],
    ["Current balance ＄-0.12", -0.12],
  ])("parses %s", (text, expected) => {
    expect(parseLabeledMoney(text, "Current balance")).toBe(expected);
  });

  test("parses signed non-money cards through the same bounded number path", () => {
    expect(parseLabeledNumber("Average RPM -0.037", "Average RPM")).toBe(-0.037);
    expect(parseLabeledNumber("Number of Requests 1,642", "Number of Requests")).toBe(1642);
  });

  test("rejects malformed, ambiguous, or unbounded values", () => {
    expect(parseLabeledMoney("Current balance --0.12", "Current balance")).toBeNaN();
    expect(parseLabeledMoney("Current balance $+-$0.12", "Current balance")).toBeNaN();
    expect(parseLabeledMoney("Current balance $9999999999999", "Current balance")).toBeNaN();
    expect(parseLabeledMoney("Consumption —", "Consumption")).toBeNaN();
  });
});

describe("AgentRouter authoritative user metrics", () => {
  test("converts numeric API quota fields without rejecting a negative balance", () => {
    expect(money.authoritativeMoneyFromUser({
      quota: -60_000,
      used_quota: 1_347_897_019,
      request_count: 8_694,
    }, 500_000)).toEqual({
      balance: -0.12,
      consumed: 2695.794038,
      requestCount: 8_694,
    });
  });

  test("accepts an authoritative all-zero account", () => {
    expect(money.authoritativeMoneyFromUser({
      quota: 0,
      used_quota: 0,
      request_count: 0,
    }, 500_000)).toEqual({
      balance: 0,
      consumed: 0,
      requestCount: 0,
    });
  });

  test.each([
    [{ quota: null, used_quota: 1, request_count: 1 }, 500_000],
    [{ quota: 1, used_quota: undefined, request_count: 1 }, 500_000],
    [{ quota: 1, used_quota: 1, request_count: "1" }, 500_000],
    [{ quota: 1, used_quota: -1, request_count: 1 }, 500_000],
    [{ quota: 1, used_quota: 1, request_count: -1 }, 500_000],
    [{ quota: 1, used_quota: 1, request_count: 1.5 }, 500_000],
    [{ quota: 1, used_quota: 1, request_count: 1 }, 0],
  ])("rejects incomplete or non-numeric API data", (user, quotaPerUnit) => {
    expect(money.authoritativeMoneyFromUser(user, quotaPerUnit)).toBeNull();
  });
});

describe("AgentRouter user identity", () => {
  test.each([
    [296_059, 296_059],
    ["296059", 296_059],
  ])("accepts canonical API user id %p", (value, expected) => {
    expect(money.parseAgentRouterUserId(value)).toBe(expected);
  });

  test.each([
    true,
    false,
    null,
    undefined,
    0,
    -1,
    1.5,
    "0296059",
    "296059.0",
    " 296059",
    "296059 ",
    "2.96059e5",
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects coercible or invalid API user id %p", (value) => {
    expect(money.parseAgentRouterUserId(value)).toBeNull();
  });
});
