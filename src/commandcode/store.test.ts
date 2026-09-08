import { describe, expect, test } from "bun:test";
import { CommandCodeStore } from "./store";

describe("CommandCodeStore", () => {
  test("encrypts API key at rest and round-trips it", () => {
    const store = new CommandCodeStore(":memory:", "a".repeat(32));
    const acct = store.upsertAccount({ id: "cc-1", label: "GOAT", email: "a@b.c", apiKey: "sk-commandcode-123" });
    expect(acct.hasKey).toBe(true);
    // Public projection must not expose the key.
    expect("apiKey" in acct).toBe(false);
    expect(store.getApiKey("cc-1")).toBe("sk-commandcode-123");
    store.close();
  });

  test("listAccounts hides the encrypted key", () => {
    const store = new CommandCodeStore(":memory:", "a".repeat(32));
    store.upsertAccount({ id: "cc-2", label: "Second", apiKey: "x".repeat(40) });
    const listed = store.listAccounts();
    expect(listed[0].hasKey).toBe(true);
    expect("apiKey" in listed[0]).toBe(false);
    store.close();
  });

  test("persists snapshots and enables/disables accounts", () => {
    const store = new CommandCodeStore(":memory:", "a".repeat(32));
    store.upsertAccount({ id: "cc-3", label: "Third", apiKey: "key3", enabled: true });
    store.saveSnapshot("cc-3", {
      planId: "goat",
      status: "active",
      remainingCredits: 50,
      monthlyCredits: 70,
      purchasedCredits: 0,
      freeCredits: 0,
      windows: [{ window: "weekly", used: 10, cap: 35, resetAt: "2026-09-15T00:00:00Z" }],
      totalCost: 5,
      totalCount: 10,
      totalTokens: null,
      lastError: null,
      consecutiveFailures: 0,
      probedAt: "2026-09-08T00:00:00Z",
    });
    const snap = store.getSnapshot("cc-3");
    expect(snap?.planId).toBe("goat");
    expect(snap?.windows).toHaveLength(1);
    store.setAccountEnabled("cc-3", false);
    expect(store.listEnabledAccounts()).toHaveLength(0);
    store.close();
  });
});
