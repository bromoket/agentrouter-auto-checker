import { describe, expect, test } from "bun:test";
import { shouldLogout } from "./agentrouter-worker-mode.mjs";

describe("AgentRouter worker end-of-cycle logout mode", () => {
  test("persistent-session reuse keeps the session alive (no end logout)", () => {
    // The 1-minute read loop needs the live session; end logout would kill it.
    expect(shouldLogout({ reusePersistentSession: true })).toBe(false);
  });

  test("legacy mode (no session reuse) logs out every cycle", () => {
    expect(shouldLogout({ reusePersistentSession: false })).toBe(true);
  });
});
