import { describe, expect, test } from "bun:test";
import { grantFingerprint, isGrant } from "./grant-detect";

describe("Grant detection", () => {
  test("detects a grant as a balance increase, not a consumption drop", () => {
    expect(isGrant({ before: 100, after: 125 })).toBe(true);      // +25 grant
    expect(isGrant({ before: 100, after: 1100 })).toBe(true);     // random large grant
    expect(isGrant({ before: 125, after: 99 })).toBe(false);      // consumption drop
    expect(isGrant({ before: 100, after: 100 })).toBe(false);     // no change
    expect(isGrant({ before: 100, after: 100.004 })).toBe(false); // below epsilon
  });

  test("rejects non-finite balance values", () => {
    expect(isGrant({ before: NaN, after: 125 })).toBe(false);
    expect(isGrant({ before: 100, after: Infinity })).toBe(false);
  });
});

describe("Grant fingerprint dedupe", () => {
  test("same grant re-polls produce the same fingerprint", () => {
    const a = grantFingerprint({ accountId: "acc-1", balanceAfter: 125, amount: 25, day: "2026-09-07" });
    const b = grantFingerprint({ accountId: "acc-1", balanceAfter: 125, amount: 25, day: "2026-09-07" });
    expect(a).toBe(b);
  });

  test("a different amount or day produces a distinct fingerprint", () => {
    const a = grantFingerprint({ accountId: "acc-1", balanceAfter: 125, amount: 25, day: "2026-09-07" });
    const c = grantFingerprint({ accountId: "acc-1", balanceAfter: 1100, amount: 1000, day: "2026-09-07" });
    const d = grantFingerprint({ accountId: "acc-1", balanceAfter: 125, amount: 25, day: "2026-09-08" });
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});
