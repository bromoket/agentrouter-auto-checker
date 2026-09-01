import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type {
  CollectorKeyLoader,
  RegisteredCollectorHost,
} from "./collector/server";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TAILSCALE_TAG = /^tag:[A-Za-z][A-Za-z0-9-]{0,62}$/;

interface SecretRegistryKeyEntry {
  keyId: string;
  role: "current" | "next";
  keyFile: string;
  notBeforeMs: number;
  expiresAtMs: number;
  revoked?: boolean;
}

interface SecretRegistryHostEntry {
  hostId: string;
  nodeId: string;
  enabled: boolean;
  tags: string[];
  capabilities: ["omp-session"];
  operatorLabel?: string | null;
  platform?: string | null;
  keys: SecretRegistryKeyEntry[];
}

export interface LoadedCollectorRegistry {
  registry: RegisteredCollectorHost[];
  keyLoader: CollectorKeyLoader;
}

export interface LoadedCollectorProxyCredential {
  proxyTokenLoader: () => Uint8Array;
  close(): void;
}

async function verifyServiceOwnedSecretFile(filePath: string): Promise<void> {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw new Error("Collector secret files require enforceable POSIX ownership.");
  }
  if (!isAbsolute(filePath)) {
    throw new Error("Collector secret file paths must be absolute.");
  }
  const serviceUid = process.getuid();
  const directoryStats = await lstat(dirname(filePath));
  if (
    directoryStats.isSymbolicLink() ||
    !directoryStats.isDirectory() ||
    directoryStats.uid !== serviceUid ||
    (directoryStats.mode & 0o777) !== 0o700
  ) {
    throw new Error("Collector secret directories must be service-owned with mode 0700.");
  }
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Collector secret paths must name regular, non-symlink files.");
  }
  if (stats.uid !== serviceUid || (stats.mode & 0o777) !== 0o600) {
    throw new Error("Collector secret files must be service-owned with mode 0600.");
  }
}

function parseRegistryDocument(value: unknown): SecretRegistryHostEntry[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Collector registry must be a JSON object.");
  }
  const document = value as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.hosts) || document.hosts.length === 0) {
    throw new Error("Collector registry must use version 1 and contain at least one host.");
  }

  const hostIds = new Set<string>();
  return document.hosts.map((rawHost): SecretRegistryHostEntry => {
    if (!rawHost || typeof rawHost !== "object" || Array.isArray(rawHost)) {
      throw new Error("Each collector registry host must be an object.");
    }
    const host = rawHost as Record<string, unknown>;
    const hostId = typeof host.hostId === "string" ? host.hostId : "";
    const nodeId = typeof host.nodeId === "string" ? host.nodeId : "";
    if (!UUID_V4.test(hostId) || !NODE_ID.test(nodeId)) {
      throw new Error("Collector host IDs must be UUIDv4 and node IDs must be normalized.");
    }
    if (hostIds.has(hostId)) throw new Error("Collector host identifiers must be unique.");
    hostIds.add(hostId);
    if (typeof host.enabled !== "boolean") {
      throw new Error("Collector host enabled state must be explicit.");
    }
    if (!Array.isArray(host.tags) || host.tags.length === 0 || host.tags.length > 8) {
      throw new Error("Every collector host must declare one to eight Tailscale tags.");
    }
    const tags = host.tags.map((tag) => {
      if (typeof tag !== "string" || !TAILSCALE_TAG.test(tag)) {
        throw new Error("Collector host tags must use canonical tag:name form.");
      }
      return tag;
    });
    if (new Set(tags).size !== tags.length) {
      throw new Error("Collector host tags must be unique per host.");
    }
    if (
      !Array.isArray(host.capabilities) ||
      host.capabilities.length !== 1 ||
      host.capabilities[0] !== "omp-session"
    ) {
      throw new Error("Collector hosts must declare exactly the omp-session capability.");
    }
    if (!Array.isArray(host.keys) || host.keys.length < 1 || host.keys.length > 2) {
      throw new Error("Each collector host must declare one or two key metadata entries.");
    }
    const keyIds = new Set<string>();
    let currentKeyCount = 0;
    const keys = host.keys.map((rawKey): SecretRegistryKeyEntry => {
      if (!rawKey || typeof rawKey !== "object" || Array.isArray(rawKey)) {
        throw new Error("Collector key metadata must be an object.");
      }
      const key = rawKey as Record<string, unknown>;
      const keyId = typeof key.keyId === "string" ? key.keyId : "";
      const role = key.role === "current" || key.role === "next" ? key.role : null;
      const keyFile = typeof key.keyFile === "string" ? key.keyFile : "";
      const notBeforeMs = key.notBeforeMs;
      const expiresAtMs = key.expiresAtMs;
      if (!UUID_V4.test(keyId) || keyIds.has(keyId)) {
        throw new Error("Collector key IDs must be unique UUIDv4 values per host.");
      }
      keyIds.add(keyId);
      if (!role) throw new Error("Every collector key must declare role current or next.");
      if (role === "current") currentKeyCount += 1;
      if (!isAbsolute(keyFile)) {
        throw new Error("Every collector key entry must reference an absolute key file.");
      }
      if (
        typeof notBeforeMs !== "number" ||
        !Number.isSafeInteger(notBeforeMs) ||
        typeof expiresAtMs !== "number" ||
        !Number.isSafeInteger(expiresAtMs) ||
        expiresAtMs <= notBeforeMs
      ) {
        throw new Error("Collector key validity timestamps must be ordered safe epoch milliseconds.");
      }
      if (key.revoked !== undefined && typeof key.revoked !== "boolean") {
        throw new Error("Collector key revoked state must be boolean when present.");
      }
      return { keyId, role, keyFile, notBeforeMs, expiresAtMs, revoked: key.revoked === true };
    });
    if (currentKeyCount !== 1) {
      throw new Error("Each collector host must declare exactly one current key.");
    }
    return {
      hostId,
      nodeId,
      enabled: host.enabled,
      tags,
      capabilities: ["omp-session"],
      operatorLabel: typeof host.operatorLabel === "string" ? host.operatorLabel : null,
      platform: typeof host.platform === "string" ? host.platform : null,
      keys,
    };
  });
}

export async function loadCollectorRegistry(registryFilePath: string): Promise<LoadedCollectorRegistry> {
  await verifyServiceOwnedSecretFile(registryFilePath);
  const registryStats = await lstat(registryFilePath);
  if (registryStats.size < 1 || registryStats.size > 262_144) {
    throw new Error("Collector registry exceeds the bounded secret file size.");
  }
  const serialized = await readFile(registryFilePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("Collector registry is not valid JSON.");
  }
  const hosts = parseRegistryDocument(parsed);
  const registry: RegisteredCollectorHost[] = [];
  const keyFiles = new Map<string, string>();

  for (const host of hosts) {
    for (const key of host.keys) {
      await verifyServiceOwnedSecretFile(key.keyFile);
      keyFiles.set(`${host.hostId}\0${key.keyId}`, key.keyFile);
    }
    registry.push({
      hostId: host.hostId,
      nodeId: host.nodeId,
      enabled: host.enabled,
      operatorLabel: host.operatorLabel,
      platform: host.platform,
      capabilities: ["omp-session"],
      tailscaleTags: [...host.tags].sort(),
      keys: host.keys.map(({ keyId, role, notBeforeMs, expiresAtMs, revoked }) => ({
        keyId,
        role,
        notBeforeMs,
        expiresAtMs,
        revoked,
      })),
    });
  }

  const keyLoader: CollectorKeyLoader = async (hostId, keyId, signal) => {
    if (signal.aborted) throw new Error("Collector key load aborted.");
    const keyFile = keyFiles.get(`${hostId}\0${keyId}`);
    if (!keyFile) throw new Error("Collector key unavailable.");
    await verifyServiceOwnedSecretFile(keyFile);
    const key = await readFile(keyFile);
    if (signal.aborted) {
      key.fill(0);
      throw new Error("Collector key load aborted.");
    }
    if (key.byteLength !== 32) {
      key.fill(0);
      throw new Error("Collector keys must contain exactly 32 raw bytes.");
    }
    return key;
  };

  return { registry, keyLoader };
}

export async function loadCollectorProxyCredential(
  credentialFilePath: string,
): Promise<LoadedCollectorProxyCredential> {
  await verifyServiceOwnedSecretFile(credentialFilePath);
  const stats = await lstat(credentialFilePath);
  if (stats.size < 43 || stats.size > 64) {
    throw new Error("Collector proxy credential must be a bounded regular file.");
  }
  const serialized = await readFile(credentialFilePath);
  try {
    const encoded = serialized.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
      throw new Error("Collector proxy credential must be canonical base64url.");
    }
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.byteLength !== 32) {
      decoded.fill(0);
      throw new Error("Collector proxy credential must decode to exactly 32 bytes.");
    }
    const master = Uint8Array.from(decoded);
    decoded.fill(0);
    return {
      proxyTokenLoader: () => Uint8Array.from(master),
      close: () => master.fill(0),
    };
  } finally {
    serialized.fill(0);
  }
}
