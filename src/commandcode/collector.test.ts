import { describe, expect, test } from "bun:test";
import { CommandCodeCollector, type CommandCodeIngestSink } from "./collector";
import { CommandCodeStore } from "./store";
import type { ProviderIdentityObservation, QuotaObservationInput } from "../observatory/types";

describe("CommandCodeCollector", () => {
  test("persists a categorized failure snapshot and emits an identity observation", async () => {
    const store = new CommandCodeStore(":memory:", "a".repeat(32));
    const created = store.upsertAccount({ id: "cc-1", label: "GOAT", apiKey: "sk-test", enabled: true });
    let identities: ProviderIdentityObservation[] = [];
    const sink: CommandCodeIngestSink = {
      ingestBatch(_t, ids) {
        identities = ids;
      },
      emitEvent() {},
    };
    const collector = new CommandCodeCollector({
      store,
      sink,
      probeIntervalMs: 60_000,
      probeTimeoutMs: 10_000,
      sourceHostId: "xeon",
    });
    // Public failure path: simulates a probe rejection (401) for the enabled account.
    const attemptAt = new Date().toISOString();
    await collector.persistFailure("cc-1", "401 Unauthorized: Command Code rejected the API key", attemptAt);

    const snap = store.getSnapshot("cc-1");
    expect(snap?.lastError).toContain("401");
    expect(snap?.consecutiveFailures).toBe(1);
    expect(snap?.probedAt).toBe(attemptAt);
    expect(store.getSnapshot("cc-1")).toBeTruthy();
    // A rejected-key failure is categorized auth -> identity health rate_limited.
    expect(identities.length).toBe(1);
    expect(identities[0].provider).toBe("commandcode");
    expect(identities[0].health).toBe("rate_limited");
    expect(created.id).toBe("cc-1");
    store.close();
  });
});
