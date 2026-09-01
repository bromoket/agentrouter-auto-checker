import {
  REGISTERED_COLLECTOR_ENDPOINT,
  validateCollectorEndpoint,
} from "./client";
import {
  DEFAULT_MAX_MESSAGES_PER_SESSION,
  PINNED_OMP_VERSION,
} from "./session-adapter";
import { MAX_SESSIONS, isCollectorModelIdentifierV1 } from "./protocol";

export const DEFAULT_COLLECTOR_INTERVAL_MS = 60_000;
export const MIN_COLLECTOR_INTERVAL_MS = 10_000;
export const MAX_COLLECTOR_INTERVAL_MS = 60 * 60 * 1_000;
export const DEFAULT_COLLECTOR_CYCLE_TIMEOUT_MS = 30_000;
export const MIN_COLLECTOR_CYCLE_TIMEOUT_MS = 5_000;
export const MAX_COLLECTOR_CYCLE_TIMEOUT_MS = 5 * 60 * 1_000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RuntimeCollectorConfig {
  enabled: boolean;
  endpointUrl: typeof REGISTERED_COLLECTOR_ENDPOINT;
  hostId: string | null;
  keyId: string | null;
  sessionIdentityKeyId: string | null;
  ompStatsDbPath: string | null;
  queueDir: string | null;
  writerVersion: typeof PINNED_OMP_VERSION;
  collectorVersion: string;
  intervalMs: number;
  cycleTimeoutMs: number;
  sessionLimit: number;
  maxMessagesPerSession: number;
  allowedProviders: ReadonlySet<string>;
  allowedModels: ReadonlySet<string>;
}

export class RuntimeCollectorConfigError extends Error {
  readonly code: string;

  constructor(code: string) {
    super("COLLECTOR_CONFIG_INVALID");
    this.name = "RuntimeCollectorConfigError";
    this.code = code;
    this.stack = undefined;
  }
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RuntimeCollectorConfigError("invalid_integer");
  }
  return parsed;
}
function parseCatalog(value: string | undefined, kind: "provider" | "model"): ReadonlySet<string> {
  if (!value) return new Set();
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const catalog = new Set<string>();
  for (const entry of entries) {
    const valid = kind === "provider"
      ? /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(entry)
      : isCollectorModelIdentifierV1(entry);
    if (!valid) throw new RuntimeCollectorConfigError("invalid_catalog");
    catalog.add(kind === "provider" ? entry.toLowerCase() : entry);
  }
  return catalog;
}

function requiredUuid(value: string | undefined, code: string): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !UUID_V4.test(normalized)) {
    throw new RuntimeCollectorConfigError(code);
  }
  return normalized;
}

/**
 * Load the disabled-by-default runtime collector configuration. Secret key
 * material is deliberately absent; production supplies an owner-private key
 * loader directly to the daemon.
 */
export function loadRuntimeCollectorConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeCollectorConfig {
  const enabled = parseBoolean(env.AFO_COLLECTOR_ENABLED);
  const endpoint = env.AFO_COLLECTOR_ENDPOINT?.trim() ?? REGISTERED_COLLECTOR_ENDPOINT;
  try {
    validateCollectorEndpoint(endpoint);
  } catch {
    throw new RuntimeCollectorConfigError("invalid_endpoint");
  }

  const intervalMs = boundedInteger(
    env.AFO_COLLECTOR_INTERVAL_MS,
    DEFAULT_COLLECTOR_INTERVAL_MS,
    MIN_COLLECTOR_INTERVAL_MS,
    MAX_COLLECTOR_INTERVAL_MS,
  );
  const cycleTimeoutMs = boundedInteger(
    env.AFO_COLLECTOR_CYCLE_TIMEOUT_MS,
    DEFAULT_COLLECTOR_CYCLE_TIMEOUT_MS,
    MIN_COLLECTOR_CYCLE_TIMEOUT_MS,
    MAX_COLLECTOR_CYCLE_TIMEOUT_MS,
  );
  const sessionLimit = boundedInteger(env.AFO_COLLECTOR_SESSION_LIMIT, 100, 1, MAX_SESSIONS);
  const maxMessagesPerSession = boundedInteger(
    env.AFO_COLLECTOR_MAX_MESSAGES,
    DEFAULT_MAX_MESSAGES_PER_SESSION,
    1,
    DEFAULT_MAX_MESSAGES_PER_SESSION,
  );
  const writerVersion = env.AFO_OMP_WRITER_VERSION?.trim() ?? PINNED_OMP_VERSION;
  if (writerVersion !== PINNED_OMP_VERSION) {
    throw new RuntimeCollectorConfigError("writer_version_mismatch");
  }

  const allowedProviders = parseCatalog(env.AFO_COLLECTOR_ALLOWED_PROVIDERS, "provider");
  const allowedModels = parseCatalog(env.AFO_COLLECTOR_ALLOWED_MODELS, "model");
  const collectorVersion = env.AFO_COLLECTOR_VERSION?.trim() ?? "1.0.0";
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(collectorVersion)) {
    throw new RuntimeCollectorConfigError("invalid_collector_version");
  }

  if (!enabled) {
    return {
      enabled: false,
      endpointUrl: REGISTERED_COLLECTOR_ENDPOINT,
      hostId: null,
      keyId: null,
      sessionIdentityKeyId: null,
      ompStatsDbPath: null,
      queueDir: null,
      writerVersion: PINNED_OMP_VERSION,
      collectorVersion,
      intervalMs,
      cycleTimeoutMs,
      sessionLimit,
      maxMessagesPerSession,
      allowedProviders,
      allowedModels,
    };
  }

  if (endpoint !== REGISTERED_COLLECTOR_ENDPOINT) {
    throw new RuntimeCollectorConfigError("invalid_endpoint");
  }
  if (allowedProviders.size === 0 || allowedModels.size === 0) {
    throw new RuntimeCollectorConfigError("catalog_required");
  }
  const ompStatsDbPath = env.AFO_OMP_STATS_DB_PATH?.trim();
  const queueDir = env.AFO_COLLECTOR_QUEUE_DIR?.trim();
  if (!ompStatsDbPath || !queueDir) {
    throw new RuntimeCollectorConfigError("local_path_required");
  }

  const hostId = requiredUuid(env.AFO_COLLECTOR_HOST_ID, "host_id_required");
  const keyId = requiredUuid(env.AFO_COLLECTOR_KEY_ID, "key_id_required");
  const sessionIdentityKeyId = requiredUuid(env.AFO_SESSION_IDENTITY_KEY_ID, "session_identity_key_id_required");
  if (sessionIdentityKeyId === keyId) {
    throw new RuntimeCollectorConfigError("identity_auth_key_reuse");
  }
  return {
    enabled: true,
    endpointUrl: REGISTERED_COLLECTOR_ENDPOINT,
    hostId,
    keyId,
    sessionIdentityKeyId,
    ompStatsDbPath,
    queueDir,
    writerVersion: PINNED_OMP_VERSION,
    collectorVersion,
    intervalMs,
    cycleTimeoutMs,
    sessionLimit,
    maxMessagesPerSession,
    allowedProviders,
    allowedModels,
  };
}
