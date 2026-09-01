import { describe, expect, test } from "bun:test";
import { REGISTERED_COLLECTOR_ENDPOINT } from "./client";
import { loadRuntimeCollectorConfig, RuntimeCollectorConfigError } from "./config";

describe("runtime collector config", () => {
  test("is disabled by default and retains no secret key material", () => {
    const config = loadRuntimeCollectorConfig({});
    expect(config.enabled).toBe(false);
    expect(config.endpointUrl).toBe(REGISTERED_COLLECTOR_ENDPOINT);
    expect(config.hostId).toBeNull();
    expect(config.keyId).toBeNull();
    expect("key" in config).toBe(false);
  });

  test("accepts only the registered HTTPS FQDN and explicit catalogs when enabled", () => {
    const config = loadRuntimeCollectorConfig({
      AFO_COLLECTOR_ENABLED: "true",
      AFO_COLLECTOR_ENDPOINT: REGISTERED_COLLECTOR_ENDPOINT,
      AFO_COLLECTOR_HOST_ID: "11111111-1111-4111-8111-111111111111",
      AFO_COLLECTOR_KEY_ID: "22222222-2222-4222-8222-222222222222",
      AFO_SESSION_IDENTITY_KEY_ID: "33333333-3333-4333-8333-333333333333",
      AFO_OMP_STATS_DB_PATH: "C:/synthetic/omp-stats.db",
      AFO_COLLECTOR_QUEUE_DIR: "C:/synthetic/queue",
      AFO_COLLECTOR_ALLOWED_PROVIDERS: "anthropic,openai",
      AFO_COLLECTOR_ALLOWED_MODELS: "claude-3-7-sonnet,gpt-4o",
      AFO_OMP_WRITER_VERSION: "18.0.11",
    });
    expect(config.enabled).toBe(true);
    expect(config.allowedProviders.has("anthropic")).toBe(true);
    expect(config.allowedModels.has("gpt-4o")).toBe(true);
  });

  test("rejects alternate endpoints, missing catalogs, and writer version drift", () => {
    const base = {
      AFO_COLLECTOR_ENABLED: "true",
      AFO_COLLECTOR_HOST_ID: "11111111-1111-4111-8111-111111111111",
      AFO_COLLECTOR_KEY_ID: "22222222-2222-4222-8222-222222222222",
      AFO_SESSION_IDENTITY_KEY_ID: "33333333-3333-4333-8333-333333333333",
      AFO_OMP_STATS_DB_PATH: "C:/synthetic/omp-stats.db",
      AFO_COLLECTOR_QUEUE_DIR: "C:/synthetic/queue",
      AFO_COLLECTOR_ALLOWED_PROVIDERS: "anthropic",
      AFO_COLLECTOR_ALLOWED_MODELS: "claude-3-7-sonnet",
    };
    expect(() => loadRuntimeCollectorConfig({ ...base, AFO_SESSION_IDENTITY_KEY_ID: base.AFO_COLLECTOR_KEY_ID })).toThrow(RuntimeCollectorConfigError);
    expect(() => loadRuntimeCollectorConfig({ ...base, AFO_COLLECTOR_ENDPOINT: "https://example.com/" })).toThrow(RuntimeCollectorConfigError);
    expect(() => loadRuntimeCollectorConfig({ ...base, AFO_COLLECTOR_ALLOWED_MODELS: "" })).toThrow(RuntimeCollectorConfigError);
    expect(() => loadRuntimeCollectorConfig({ ...base, AFO_OMP_WRITER_VERSION: "19.0.0" })).toThrow(RuntimeCollectorConfigError);
  });
});
