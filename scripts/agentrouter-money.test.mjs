import { describe, expect, test } from "bun:test";
import { parseLabeledMoney, parseLabeledNumber } from "./agentrouter-money.mjs";

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
