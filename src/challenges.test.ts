import { describe, expect, test } from "bun:test";
import { AuthenticationChallengeBroker } from "./challenges";

describe("AuthenticationChallengeBroker", () => {
  test("publishes GitHub Mobile number and push challenges and clears them", () => {
    const broker = new AuthenticationChallengeBroker();
    const id = broker.publish({
      accountId: "account-1",
      accountLabel: "Account 1",
      kind: "github-mobile",
      prompt: "Approve this sign-in.",
      verificationCode: "42",
      expiresInMs: 60_000,
    });
    expect(broker.list()[0].verificationCode).toBe("42");
    broker.complete(id);
    expect(broker.list()).toEqual([]);
    const pushId = broker.publish({
      accountId: "account-1",
      accountLabel: "Account 1",
      kind: "github-mobile",
      prompt: "Approve this sign-in.",
      verificationCode: null,
      expiresInMs: 60_000,
    });
    expect(broker.list()[0].verificationCode).toBeNull();
    broker.complete(pushId);
    expect(() =>
      broker.publish({
        accountId: "account-1",
        accountLabel: "Account 1",
        kind: "github-mobile",
        prompt: "Approve this sign-in.",
        verificationCode: "123456",
        expiresInMs: 60_000,
      }),
    ).toThrow("two digits");
  });

  test("publishes an AgentRouter access-verification challenge without a code", () => {
    const broker = new AuthenticationChallengeBroker();
    const id = broker.publish({
      accountId: "account-1",
      accountLabel: "Account 1",
      kind: "agentrouter-waf",
      prompt: "Complete the slider in the visible browser.",
      verificationCode: null,
      expiresInMs: 60_000,
    });
    expect(broker.list()[0]).toMatchObject({
      id,
      kind: "agentrouter-waf",
      verificationCode: null,
    });
    broker.complete(id);
  });
});
