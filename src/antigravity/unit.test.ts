import { describe, expect, test } from "bun:test";
import { decryptToken, deriveEncryptionKey, encryptToken } from "./crypto";
import {
  aggregateCliBuckets,
  aggregatePoolBuckets,
  deriveQuotaStatus,
  normalizeModelBucket,
  normalizeIsoTimestamp,
  parseFraction,
} from "./aggregate";

describe("antigravity crypto", () => {
  test("round-trips a token with a raw 32+ byte secret", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const key = deriveEncryptionKey(secret);
    expect(key.length).toBe(32);
    const token = "1//0fake-refresh-token-value";
    const encrypted = encryptToken(token, key);
    expect(encrypted).toStartWith("v1.");
    expect(encrypted).not.toContain(token);
    expect(decryptToken(encrypted, key)).toBe(token);
  });

  test("supports a base64: prefixed 32-byte key", () => {
    const raw = "k".repeat(32);
    const secret = `base64:${Buffer.from(raw, "utf8").toString("base64")}`;
    const key = deriveEncryptionKey(secret);
    expect(key.toString("utf8")).toBe(raw);
  });

  test("rejects short secrets and wrong-key decryption", () => {
    expect(() => deriveEncryptionKey("short")).toThrow(/at least 32 bytes/);
    expect(() => deriveEncryptionKey("base64:AAAA")).toThrow(/exactly 32 bytes/);
    const keyA = deriveEncryptionKey("a".repeat(32));
    const keyB = deriveEncryptionKey("b".repeat(32));
    const encrypted = encryptToken("secret-token", keyA);
    expect(() => decryptToken(encrypted, keyB)).toThrow();
  });
});

describe("antigravity aggregation", () => {
  const iso = "2026-09-03T12:00:00.000Z";

  test("parseFraction accepts strings and clamps ranges", () => {
    expect(parseFraction("0.9235308")).toBeCloseTo(0.9235308);
    expect(parseFraction(1)).toBe(1);
    expect(parseFraction("1.7")).toBe(1);
    expect(parseFraction("-2")).toBe(0);
    expect(parseFraction("nope")).toBeNull();
    expect(parseFraction(undefined)).toBeNull();
  });

  test("normalizeIsoTimestamp normalizes or returns null", () => {
    expect(normalizeIsoTimestamp("2026-08-27T01:22:44Z")).toBe("2026-08-27T01:22:44.000Z");
    expect(normalizeIsoTimestamp(null)).toBeNull();
    expect(normalizeIsoTimestamp("garbage")).toBeNull();
  });

  test("normalizeModelBucket skips buckets without parseable fractions", () => {
    const good = normalizeModelBucket({
      tokenType: "WTUS",
      modelId: "gemini-3.7-flash",
      remainingFraction: "0.8",
      resetTime: "2026-09-03T17:00:00Z",
    });
    expect(good?.modelId).toBe("gemini-3.7-flash");
    expect(good?.remainingFraction).toBeCloseTo(0.8);
    expect(normalizeModelBucket({ modelId: "gemini-x", remainingFraction: "?" })).toBeNull();
    expect(normalizeModelBucket({ modelId: "", remainingFraction: "1" })).toBeNull();
  });

  test("aggregatePoolBuckets splits gemini vs claude-gpt and skips internals", () => {
    const raw = [
      { modelId: "gemini-3.7-flash", tokenType: "WTUS", remainingFraction: "0.5", resetTime: null },
      { modelId: "gemini-2.5-pro", tokenType: "WTUS", remainingFraction: "0.9", resetTime: "2026-09-03T17:00:00Z" },
      { modelId: "claude-opus-4-6", tokenType: "WTUS", remainingFraction: "0.4", resetTime: null },
      { modelId: "gpt-oss-120b", tokenType: "WTUS", remainingFraction: "0.7", resetTime: "2026-09-03T18:00:00Z" },
      { modelId: "chat_20706", tokenType: "WTUS", remainingFraction: "1", resetTime: null },
      { modelId: "tab_flash_lite", tokenType: "WTUS", remainingFraction: "1", resetTime: null },
    ];
    const buckets = raw.map((item) => normalizeModelBucket(item)!);
    const pools = aggregatePoolBuckets(buckets, iso);
    const byName = Object.fromEntries(pools.map((p) => [p.pool, p]));
    expect(Object.keys(byName).sort()).toEqual(["claude-gpt", "gemini"]);
    // Pool remaining = MAX member; reset = that member's reset
    expect(byName.gemini.remainingFraction).toBeCloseTo(0.9);
    expect(byName.gemini.resetTime).toBe("2026-09-03T17:00:00.000Z");
    expect(byName.gemini.modelCount).toBe(2);
    expect(byName["claude-gpt"].remainingFraction).toBeCloseTo(0.7);
    expect(byName["claude-gpt"].modelCount).toBe(2);
  });

  test("aggregateCliBuckets produces a single REQUESTS pool", () => {
    const summary = aggregateCliBuckets(
      [
        { modelId: "gemini-2.5-flash", tokenType: "REQUESTS", remainingFraction: 0.33, resetTime: "2026-09-03T17:00:00Z" },
        { modelId: "gemini-2.5-flash-lite", tokenType: "REQUESTS", remainingFraction: 0.66, resetTime: null },
      ],
      iso,
    );
    expect(summary?.pool).toBe("cli");
    expect(summary?.remainingFraction).toBeCloseTo(0.66);
    expect(summary?.modelCount).toBe(2);
    expect(aggregateCliBuckets([], iso)).toBeNull();
  });

  test("deriveQuotaStatus boundaries", () => {
    expect(deriveQuotaStatus(0.99)).toBe("ok");
    expect(deriveQuotaStatus(0.2)).toBe("warning");
    expect(deriveQuotaStatus(0.1)).toBe("critical");
    expect(deriveQuotaStatus(0.01)).toBe("exhausted");
  });
});
