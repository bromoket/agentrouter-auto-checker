import { describe, expect, test } from "bun:test";
import { shouldLogout } from "./agentrouter-worker-mode.mjs";

describe("AgentRouter worker logout mode", () => {
  test("grant-mode always logs out (to claim grants)", () => {
    expect(shouldLogout({ grantMode: true, reusePersistentSession: true })).toBe(true);
    expect(shouldLogout({ grantMode: true, reusePersistentSession: false })).toBe(true);
  });

  test("read-mode with persistent session reuse never logs out", () => {
    expect(shouldLogout({ grantMode: false, reusePersistentSession: true })).toBe(false);
  });

  test("legacy mode (no session reuse) logs out every cycle", () => {
    expect(shouldLogout({ grantMode: false, reusePersistentSession: false })).toBe(true);
  });
});
