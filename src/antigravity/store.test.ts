import { describe, expect, test } from "bun:test";
import { AntigravityStore } from "./store";

const SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = "1//0real-looking-refresh-token";

function makeStore(): AntigravityStore {
  return new AntigravityStore(":memory:", SECRET);
}

describe("AntigravityStore", () => {
  test("upsert + list + decrypt round-trip", () => {
    const store = makeStore();
    const created = store.upsertAccount({
      id: "ag-acc-1",
      label: "pelleabel28@gmail.com",
      email: "pelleabel28@gmail.com",
      refreshToken: TOKEN,
      fingerprintJson: JSON.stringify({ deviceId: "dev-1", userAgent: "antigravity/2.8.1" }),
      projectId: "proj-1",
      enabled: true,
    });
    expect(created.id).toBe("ag-acc-1");
    expect(created.hasToken).toBe(true);
    expect(created.hasFingerprint).toBe(true);
    expect(created.snapshot).toBeNull();

    const list = store.listAccounts();
    expect(list).toHaveLength(1);
    expect(list[0]!.email).toBe("pelleabel28@gmail.com");
    expect(list[0]!.enabled).toBe(true);

    expect(store.getRefreshToken("ag-acc-1")).toBe(TOKEN);
    const record = store.getAccount("ag-acc-1");
    expect(record!.refreshTokenEnc).not.toContain(TOKEN);
    store.close();
  });

  test("snapshot lifecycle", () => {
    const store = makeStore();
    store.upsertAccount({ id: "ag-acc-snap", label: "acc", refreshToken: TOKEN });
    expect(store.getSnapshot("ag-acc-snap")).toBeNull();
    const snapshot = {
      pools: [],
      subscription: { currentTierId: "free-tier", currentTierName: "Antigravity", paidTierId: null, availableCredits: 0, gcpManaged: false, observedAt: "2026-09-03T12:00:00.000Z" },
      verificationRequired: false,
      projectId: "proj-x",
      probedAt: "2026-09-03T12:00:00.000Z",
      lastError: null,
      consecutiveFailures: 0,
    };
    store.saveSnapshot("ag-acc-snap", snapshot);
    expect(store.getSnapshot("ag-acc-snap")?.projectId).toBe("proj-x");
    expect(store.getSnapshot("ag-acc-snap")?.subscription?.currentTierId).toBe("free-tier");
    store.close();
  });

  test("token rotation updates ciphertext only", () => {
    const store = makeStore();
    store.upsertAccount({ id: "ag-rot", label: "rot", refreshToken: "old-token" });
    store.updateAccountRefreshToken("ag-rot", "new-token");
    expect(store.getRefreshToken("ag-rot")).toBe("new-token");
    expect(store.getAccount("ag-rot")!.refreshTokenEnc).not.toContain("new-token");
    store.close();
  });

  test("enable/disable and remove", () => {
    const store = makeStore();
    store.upsertAccount({ id: "ag-tog", label: "tog", refreshToken: TOKEN, enabled: true });
    expect(store.listEnabledAccounts()).toHaveLength(1);
    const disabled = store.setAccountEnabled("ag-tog", false);
    expect(disabled?.enabled).toBe(false);
    expect(store.listEnabledAccounts()).toHaveLength(0);
    expect(store.removeAccount("ag-tog")).toBe(true);
    expect(store.listAccounts()).toHaveLength(0);
    expect(store.setAccountEnabled("missing", true)).toBeNull();
    store.close();
  });

  test("invalid ids and empty labels are rejected", () => {
    const store = makeStore();
    expect(() => store.upsertAccount({ id: "BAD ID!", label: "x", refreshToken: TOKEN })).toThrow(/Invalid/);
    expect(() => store.upsertAccount({ id: "ok-id", label: "   ", refreshToken: TOKEN })).toThrow(/label/);
    expect(() => store.getAccount("../evil")).toThrow(/Invalid/);
    store.close();
  });
});
