import { timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  CollectorProtocolError,
  MAX_BATCH_BYTES,
  MAX_SESSIONS,
  ProtocolErrorCode,
  parseCollectorHeaders,
  parseSessionBatchV1,
  verifyRequestSignatureV1,
  type ParsedCollectorHeadersV1,
  type SessionBatchV1,
} from "./protocol";
import {
  PINNED_TAILSCALE_CLI_VERSION,
  PINNED_TAILSCALE_WHOIS_SCHEMA,
  TAILSCALE_WHOIS_MAX_STDOUT_BYTES,
  TAILSCALE_WHOIS_TIMEOUT_MS,
  TailscaleIdentityAdapter,
  TailscaleIdentityError,
  TailscaleIdentityErrorCategory,
  type TailscaleNodeIdentity,
  type TailscaleWhoisExecutionRequest,
  type TailscaleWhoisExecutionResult,
  type TailscaleWhoisExecutor,
} from "./tailscale-identity";
import type { ObservatoryStore } from "../observatory/store";
export const COLLECTOR_PORT = 8457;
export const COLLECTOR_PATHNAME = "/v1/collector/session-batches";
export const COLLECTOR_MAGICDNS_HOST = "bkserver.tailbbaa91.ts.net";
export const DEFAULT_MAX_BATCH_BYTES = MAX_BATCH_BYTES; // 262_144
export const DEFAULT_MAX_SESSIONS = MAX_SESSIONS; // 128
export const DEFAULT_CLOCK_SKEW_SECONDS = 300;

export {
  PINNED_TAILSCALE_CLI_VERSION,
  PINNED_TAILSCALE_WHOIS_SCHEMA,
  TAILSCALE_WHOIS_MAX_STDOUT_BYTES,
  TAILSCALE_WHOIS_TIMEOUT_MS,
};

export const COLLECTOR_SESSION_CAPABILITY = "omp-session" as const;
export const DEFAULT_REQUEST_DEADLINE_MS = 10_000;
export const COLLECTOR_PROXY_SOURCE_IP_HEADER = "x-afo-source-ip";
export const COLLECTOR_PROXY_TOKEN_HEADER = "x-afo-proxy-token";
const COLLECTOR_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COLLECTOR_TAG_PATTERN = /^tag:[A-Za-z][A-Za-z0-9-]{0,62}$/;

export interface RegisteredCollectorKey {
  readonly keyId: string;
  readonly role: "current" | "next";
  readonly notBeforeMs: number;
  readonly expiresAtMs: number;
  readonly revoked?: boolean;
}

export interface RegisteredCollectorHost {
  readonly hostId: string;
  readonly keys: readonly RegisteredCollectorKey[];
  readonly nodeId: string;
  readonly enabled: boolean;
  readonly operatorLabel?: string | null;
  readonly platform?: string | null;
  readonly capabilities: readonly [typeof COLLECTOR_SESSION_CAPABILITY];
  readonly tailscaleTags: readonly string[];
}

export type CollectorHostRegistryLookup = (hostId: string) => RegisteredCollectorHost | undefined;

export type CollectorHostRegistry =
  | Map<string, RegisteredCollectorHost>
  | readonly RegisteredCollectorHost[]
  | { get(hostId: string): RegisteredCollectorHost | undefined }
  | CollectorHostRegistryLookup;

export interface TailscaleWhoisVerifier {
  lookup(
    peerIp: string,
    expectedTags?: readonly string[],
  ): Promise<TailscaleNodeIdentity | { nodeId: string } | null | undefined>;
}

export type TailscaleWhoisLookupFn = (
  peerIp: string,
  expectedTags?: readonly string[],
) => Promise<TailscaleNodeIdentity | { nodeId: string } | null | undefined>;

export type TailscaleWhoisSource =
  | TailscaleWhoisVerifier
  | TailscaleWhoisLookupFn
  | TailscaleIdentityAdapter;

export type TransportBodyReader = (
  request: Request,
  maxBytes: number,
  signal: AbortSignal,
) => Promise<Uint8Array>;
/**
 * Returns a fresh, owned 32-byte key buffer for this request. The handler always
 * zeroes the returned buffer; loaders must never expose keyring backing storage.
 */

export type CollectorKeyLoader = (
  hostId: string,
  keyId: string,
  signal: AbortSignal,
) => Promise<Uint8Array>;

export interface CollectorAdmissionLease {
  release(): void;
}

interface HostAdmissionBucket {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
  inFlight: number;
}

export interface CollectorAdmissionOptions {
  readonly globalMaxInFlight?: number;
  readonly perHostRequestsPerMinute?: number;
  readonly perHostBurst?: number;
  readonly maxTrackedHosts?: number;
}

export class CollectorAdmissionController {
  readonly #maxTrackedHosts: number;
  readonly #hosts = new Map<string, HostAdmissionBucket>();
  #globalInFlight = 0;

  constructor(options: CollectorAdmissionOptions = {}) {
    const values = Object.values(options);
    if (values.some((value) => !Number.isFinite(value) || value! < 0)) {
      throw new Error("collector_admission_invalid");
    }
    if (
      (options.globalMaxInFlight !== undefined && options.globalMaxInFlight !== 8) ||
      (options.perHostRequestsPerMinute !== undefined && options.perHostRequestsPerMinute !== 30) ||
      (options.perHostBurst !== undefined && options.perHostBurst !== 2)
    ) {
      throw new Error("collector_admission_invalid");
    }
    this.#maxTrackedHosts = options.maxTrackedHosts ?? 1_024;
    if (!Number.isSafeInteger(this.#maxTrackedHosts) || this.#maxTrackedHosts < 1) {
      throw new Error("collector_admission_invalid");
    }
  }

  acquireGlobal(_nowMs: number): CollectorAdmissionLease | null {
    if (this.#globalInFlight >= 8) return null;
    this.#globalInFlight++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#globalInFlight--;
      },
    };
  }

  acquireHost(hostId: string, nowMs: number): CollectorAdmissionLease | null {
    if (!Number.isFinite(nowMs) || nowMs < 0) return null;
    for (const [trackedHostId, bucket] of this.#hosts) {
      if (bucket.inFlight === 0 && nowMs - bucket.lastSeenMs >= 120_000) {
        this.#hosts.delete(trackedHostId);
      }
    }
    let host = this.#hosts.get(hostId);
    if (!host) {
      if (this.#hosts.size >= this.#maxTrackedHosts) return null;
      host = { tokens: 2, lastRefillMs: nowMs, lastSeenMs: nowMs, inFlight: 0 };
      this.#hosts.set(hostId, host);
    }
    const elapsedMs = Math.max(0, nowMs - host.lastRefillMs);
    host.tokens = Math.min(2, host.tokens + elapsedMs * (30 / 60_000));
    host.lastRefillMs = nowMs;
    host.lastSeenMs = nowMs;
    if (host.tokens < 1 || host.inFlight >= 1) return null;
    host.tokens--;
    host.inFlight++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        host!.inFlight--;
      },
    };
  }
}

export interface CollectorServerOptions {
  readonly registry: CollectorHostRegistry;
  readonly keyLoader: CollectorKeyLoader;
  readonly tailscaleWhois: TailscaleWhoisSource;
  readonly admission: CollectorAdmissionController;
  readonly store: ObservatoryStore;
  readonly bodyReader?: TransportBodyReader;
  readonly nowMs?: () => number;
  readonly nowSeconds?: () => number;
  readonly maxBatchBytes?: number;
  readonly requestDeadlineMs?: number;
}

export type BatchPersistResult =
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "conflict" }
  | {
      readonly outcome: "new";
      readonly accepted: number;
      readonly ignoredStale: number;
    };

export interface CollectorRequestContext {
  readonly peerIp?: string;
  readonly actualMethod?: string;
  readonly actualPathname?: string;
  readonly actualSearch?: string;
}

export interface CollectorAcceptedResponse {
  readonly batch_id: string;
  readonly accepted: number;
  readonly ignored_stale: number;
}

export interface CollectorDuplicateResponse {
  readonly status: "duplicate";
  readonly batch_id: string;
}

/**
 * Creates a categorical JSON error response without echoing untrusted values,
 * canary tokens, internal error messages, or cryptographic material.
 */
function createErrorResponse(
  status: number,
  category: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      error: category,
      status,
    }),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...extraHeaders,
      },
    },
  );
}

/**
 * Transport-capped request body reader.
 * Enforces raw body size limits before full buffer allocation and aborts
 * streaming if payload exceeds the maximum byte limit.
 */
export async function readBoundedRequestBody(
  request: Request,
  maxBytes: number = DEFAULT_MAX_BATCH_BYTES,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
      throw new CollectorProtocolError(ProtocolErrorCode.BATCH_TOO_LARGE);
    }
  }

  if (!request.body) {
    return new Uint8Array(0);
  }

  if (typeof request.body.getReader === "function") {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const cancelForDeadline = () => {
      void reader.cancel().catch(() => {});
    };
    if (signal?.aborted) {
      cancelForDeadline();
      throw new Error("collector_deadline");
    }
    signal?.addEventListener("abort", cancelForDeadline, { once: true });

    try {
      while (true) {
        if (signal?.aborted) throw new Error("collector_deadline");
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (value.byteLength > maxBytes - totalBytes) {
            try {
              await reader.cancel();
            } catch {}
            throw new CollectorProtocolError(ProtocolErrorCode.BATCH_TOO_LARGE);
          }
          totalBytes += value.byteLength;
          chunks.push(value);
        }
      }

      const result = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return result;
    } catch (error) {
      if (error instanceof CollectorProtocolError) throw error;
      throw new Error("collector_deadline");
    } finally {
      signal?.removeEventListener("abort", cancelForDeadline);
    }
  }

  if (typeof request.arrayBuffer === "function") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new CollectorProtocolError(ProtocolErrorCode.BATCH_TOO_LARGE);
    }
    return new Uint8Array(buf);
  }

  return new Uint8Array(0);
}

/** Resolve a host from bounded, synchronous registration metadata. */
export function resolveHostRegistration(
  registry: CollectorHostRegistry,
  hostId: string,
): RegisteredCollectorHost | undefined {
  if (!registry || typeof hostId !== "string") return undefined;
  if (registry instanceof Map) return registry.get(hostId);
  if (Array.isArray(registry)) return registry.find((host) => host.hostId === hostId);
  if (typeof registry === "function") return registry(hostId);
  if (typeof (registry as { get?: unknown }).get === "function") {
    return (registry as { get: (id: string) => RegisteredCollectorHost | undefined }).get(hostId);
  }
  return undefined;
}

/**
 * Production process executor for Tailscale CLI whois commands.
 * Spawns child process directly with empty environment, caps stdout at 32 KiB,
 * discards stderr, enforces 1-second timeout with TERM -> KILL escalation, and reaps process.
 */
export function createProductionTailscaleWhoisExecutor(options?: {
  termGracePeriodMs?: number;
}): TailscaleWhoisExecutor {
  const termGracePeriodMs = options?.termGracePeriodMs ?? 200;

  return async (
    request: TailscaleWhoisExecutionRequest,
  ): Promise<TailscaleWhoisExecutionResult> => {
    let timedOut = false;
    let stdoutOverflow = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
      try {
        const proc = Bun.spawn([...request.argv], {
          env: {},
          stdin: "ignore",
          stderr: "ignore",
          stdout: "pipe",
        });
        const reader = proc.stdout ? proc.stdout.getReader() : null;
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        let terminating = false;
        const abortHandler = () => {
          if (terminating) return;
          terminating = true;
          try {
            proc.kill("SIGTERM");
          } catch {}
          killTimer = setTimeout(() => {
            try {
              proc.kill("SIGKILL");
            } catch {}
          }, termGracePeriodMs);
        };
        if (request.signal.aborted) abortHandler();
        else request.signal.addEventListener("abort", abortHandler, { once: true });
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          abortHandler();
        }, request.timeoutMs);

        try {
          if (reader) {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                if (value.byteLength > request.maxStdoutBytes - totalBytes) {
                  stdoutOverflow = true;
                  try {
                    await reader.cancel();
                  } catch {}
                  abortHandler();
                  break;
                }
                totalBytes += value.byteLength;
                chunks.push(value);
              }
            }
          }
          const exitCode = await proc.exited;
          const stdout = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            stdout.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return {
            exitCode: typeof exitCode === "number" ? exitCode : timedOut ? 1 : 0,
            stdout,
            timedOut,
            stdoutOverflow,
          };
        } catch {
          abortHandler();
          await proc.exited.catch(() => 1);
          return {
            exitCode: 1,
            stdout: new Uint8Array(0),
            timedOut,
            stdoutOverflow,
          };
        } finally {
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          request.signal.removeEventListener("abort", abortHandler);
        }
      } catch {
        return {
          exitCode: 1,
          stdout: new Uint8Array(0),
          timedOut,
          stdoutOverflow,
        };
      }
    } else {
      // Fallback executor via static node:child_process spawn
      return new Promise<TailscaleWhoisExecutionResult>((resolve) => {
        const [cmd, ...args] = request.argv;
        const child = spawn(cmd, args, {
          env: {},
          stdio: ["ignore", "pipe", "ignore"],
        });

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        const cleanupTimers = () => {
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
          if (killTimer !== undefined) clearTimeout(killTimer);
        };

        const terminateChild = () => {
          try {
            child.kill("SIGTERM");
          } catch {}
          killTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, termGracePeriodMs);
        };

        const onAbort = () => {
          terminateChild();
        };

        if (request.signal.aborted) {
          onAbort();
        } else {
          request.signal.addEventListener("abort", onAbort, { once: true });
        }

        timeoutTimer = setTimeout(() => {
          timedOut = true;
          terminateChild();
        }, request.timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
          if (chunk.byteLength > request.maxStdoutBytes - totalBytes) {
            stdoutOverflow = true;
            child.stdout?.destroy();
            terminateChild();
            return;
          }
          totalBytes += chunk.byteLength;
          chunks.push(chunk);
        });

        child.on("close", (code) => {
          cleanupTimers();
          request.signal.removeEventListener("abort", onAbort);
          resolve({
            exitCode: code ?? (timedOut ? 1 : 0),
            stdout: Buffer.concat(chunks),
            timedOut,
            stdoutOverflow,
          });
        });

        child.on("error", () => {
          cleanupTimers();
          request.signal.removeEventListener("abort", onAbort);
          resolve({
            exitCode: 1,
            stdout: new Uint8Array(0),
            timedOut,
            stdoutOverflow,
          });
        });
      });
    }
  };
}

/**
 * Verify that the local Tailscale CLI binary at executablePath exists,
 * is executable, and outputs the exact pinned version string.
 */
export async function verifyTailscaleCliVersion(
  executablePath: string,
  executor?: TailscaleWhoisExecutor,
): Promise<string> {
  if (typeof executablePath !== "string") {
    throw new TailscaleIdentityError(TailscaleIdentityErrorCategory.INVALID_CONFIGURATION);
  }
  const networkPath = executablePath.startsWith("\\\\") || executablePath.startsWith("//");
  if (!path.isAbsolute(executablePath) || networkPath) {
    throw new TailscaleIdentityError(TailscaleIdentityErrorCategory.INVALID_CONFIGURATION);
  }

  const exec = executor ?? createProductionTailscaleWhoisExecutor();
  const abortController = new AbortController();
  const request: TailscaleWhoisExecutionRequest = {
    argv: [executablePath, "version"],
    env: {},
    timeoutMs: TAILSCALE_WHOIS_TIMEOUT_MS,
    maxStdoutBytes: TAILSCALE_WHOIS_MAX_STDOUT_BYTES,
    signal: abortController.signal,
  };

  const result = await exec(request);
  if (result.timedOut || result.stdoutOverflow || result.exitCode !== 0) {
    throw new TailscaleIdentityError(TailscaleIdentityErrorCategory.INVALID_CONFIGURATION);
  }

  const stdoutText =
    typeof result.stdout === "string"
      ? result.stdout
      : new TextDecoder("utf-8").decode(result.stdout);

  const firstLine = stdoutText.trim().split("\n")[0].trim();
  if (firstLine !== PINNED_TAILSCALE_CLI_VERSION) {
    throw new TailscaleIdentityError(TailscaleIdentityErrorCategory.INVALID_CONFIGURATION);
  }

  return PINNED_TAILSCALE_CLI_VERSION;
}

/**
 * Creates a production TailscaleIdentityAdapter verified at startup.
 */
export async function createProductionTailscaleIdentityAdapter(options: {
  executablePath: string;
  allowedTags: readonly string[];
  executor?: TailscaleWhoisExecutor;
}): Promise<TailscaleIdentityAdapter> {
  const executor = options.executor ?? createProductionTailscaleWhoisExecutor();
  await verifyTailscaleCliVersion(options.executablePath, executor);

  return new TailscaleIdentityAdapter({
    executablePath: options.executablePath,
    cliVersion: PINNED_TAILSCALE_CLI_VERSION,
    allowedTags: options.allowedTags,
    executor,
  });
}

/** Returns a fresh owned 32-byte proxy credential snapshot; the resolver zeroes it. */
export type CollectorProxyTokenLoader = () => Uint8Array;

function canonicalTailnetIp(value: string): string | null {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255) || octets.join(".") !== value) return null;
    return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127 ? value : null;
  }
  if (value !== value.toLowerCase() || !value.includes(":")) return null;
  try {
    const hostname = new URL(`http://[${value}]/`).hostname;
    const canonical = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
    return canonical === value && canonical.startsWith("fd7a:115c:a1e0:") ? value : null;
  } catch {
    return null;
  }
}

export function resolveCollectorPeerIp(
  request: Request,
  socketPeerIp: string | undefined,
  proxyTokenLoader: CollectorProxyTokenLoader,
): string | null {
  const directPeer = socketPeerIp === undefined ? null : canonicalTailnetIp(socketPeerIp);
  const sourceHeader = request.headers.get(COLLECTOR_PROXY_SOURCE_IP_HEADER);
  const tokenHeader = request.headers.get(COLLECTOR_PROXY_TOKEN_HEADER);
  if (sourceHeader === null && tokenHeader === null) return directPeer;
  if (
    sourceHeader === null ||
    tokenHeader === null ||
    (socketPeerIp !== "127.0.0.1" && socketPeerIp !== "::1") ||
    !/^[A-Za-z0-9_-]{43}$/.test(tokenHeader)
  ) {
    return directPeer;
  }
  const sourceIp = canonicalTailnetIp(sourceHeader);
  if (sourceIp === null) return directPeer;
  let expected: Uint8Array | undefined;
  let supplied: Buffer | undefined;
  try {
    expected = proxyTokenLoader();
    supplied = Buffer.from(tokenHeader, "base64url");
    if (
      !(expected instanceof Uint8Array) ||
      expected.byteLength !== 32 ||
      supplied.byteLength !== 32 ||
      supplied.toString("base64url") !== tokenHeader
    ) {
      return directPeer;
    }
    return timingSafeEqual(expected, supplied) ? sourceIp : directPeer;
  } finally {
    expected?.fill(0);
    supplied?.fill(0);
  }
}

export interface CollectorRequestIpSource {
  requestIP(request: Request): { readonly address: string } | null;
}

export interface ProductionCollectorHandlerOptions {
  readonly executablePath: string;
  readonly registry: CollectorHostRegistry;
  readonly keyLoader: CollectorKeyLoader;
  readonly proxyTokenLoader: CollectorProxyTokenLoader;
  readonly admission: CollectorAdmissionController;
  readonly store: ObservatoryStore;
  readonly bodyReader?: TransportBodyReader;
  readonly maxBatchBytes?: number;
  readonly requestDeadlineMs?: number;
  readonly executor?: TailscaleWhoisExecutor;
}

export async function createProductionCollectorHandler(
  options: ProductionCollectorHandlerOptions,
): Promise<(request: Request, server: CollectorRequestIpSource) => Promise<Response>> {
  const executor = options.executor ?? createProductionTailscaleWhoisExecutor();
  await verifyTailscaleCliVersion(options.executablePath, executor);
  const adapters = new Map<string, TailscaleIdentityAdapter>();
  const tailscaleWhois: TailscaleWhoisVerifier = {
    lookup: (peerIp, expectedTags = []) => {
      const tagKey = JSON.stringify([...expectedTags].sort());
      let adapter = adapters.get(tagKey);
      if (!adapter) {
        adapter = new TailscaleIdentityAdapter({
          executablePath: options.executablePath,
          cliVersion: PINNED_TAILSCALE_CLI_VERSION,
          allowedTags: expectedTags,
          executor,
        });
        adapters.set(tagKey, adapter);
      }
      return adapter.lookup(peerIp);
    },
  };
  const handlerOptions: CollectorServerOptions = {
    registry: options.registry,
    keyLoader: options.keyLoader,
    tailscaleWhois,
    admission: options.admission,
    store: options.store,
    bodyReader: options.bodyReader,
    maxBatchBytes: options.maxBatchBytes,
    requestDeadlineMs: options.requestDeadlineMs,
  };
  return (request, server) => {
    const socketPeer = server.requestIP(request)?.address;
    let peerIp: string | null;
    try {
      peerIp = resolveCollectorPeerIp(request, socketPeer, options.proxyTokenLoader);
    } catch {
      return Promise.resolve(createErrorResponse(503, "proxy_credential_unavailable", { "Retry-After": "5" }));
    }
    if (peerIp === null) {
      return Promise.resolve(createErrorResponse(401, "unauthorized"));
    }
    const url = new URL(request.url);
    return handleCollectorRequest(request, handlerOptions, {
      peerIp,
      actualMethod: request.method,
      actualPathname: url.pathname,
      actualSearch: url.search,
    });
  };
}

/**
 * Main HTTP request handler for the AI Fleet Observatory Collector Ingestion Server.
 *
 * Sequence of enforcement:
 * 1. HTTP method check (POST only -> 405 Method Not Allowed)
 * 2. URL path and query check (exact /v1/collector/session-batches, no query -> 404 Route Not Found)
 * 3. Cheap header validation BEFORE body allocation (±300s clock skew, Content-Length bounds, proxy header rejection -> 400/401/413)
 * 4. Exact host registration and key matching BEFORE body allocation (unknown/disabled -> 401)
 * 5. Peer IP Tailscale whois identity verification BEFORE body allocation (nodeId mismatch -> 401)
 * 6. Mandatory global/per-host rate and in-flight admission (-> 429 Too Many Requests)
 * 7. Transport-capped body reading (stream capped at 256 KiB -> 413 Payload Too Large)
 * 8. Zero-copy cryptographic verification (SHA-256 digest + constant-time HMAC-SHA-256 -> 401)
 * 9. JSON parsing & closed schema validation (Auth before JSON -> 400/422)
 * 10. Atomic durable batch claim and newer-only session upsert via ObservatoryStore
 *     (Duplicate -> 200, Conflict -> 409, New -> 202)
 */
interface RequestAdmissionState {
  global: CollectorAdmissionLease | null;
  host: CollectorAdmissionLease | null;
  released: boolean;
}

function releaseAdmissionState(state: RequestAdmissionState): void {
  if (state.released) return;
  state.released = true;
  state.host?.release();
  state.global?.release();
}

async function handleCollectorRequestCore(
  request: Request,
  options: CollectorServerOptions,
  context: CollectorRequestContext | undefined,
  signal: AbortSignal,
  admissionState: RequestAdmissionState,
): Promise<Response> {
  try {
  const method = context?.actualMethod ?? request.method;
  if (method !== "POST") {
    return createErrorResponse(405, "method_not_allowed", { Allow: "POST" });
  }

  let pathname = context?.actualPathname;
  let search = context?.actualSearch;
  if (pathname === undefined || search === undefined) {
    try {
      const url = new URL(request.url, "https://localhost");
      pathname = pathname ?? url.pathname;
      search = search ?? url.search;
    } catch {
      return createErrorResponse(400, "invalid_url");
    }
  }

  if (pathname !== COLLECTOR_PATHNAME || (search !== "" && search !== undefined)) {
    return createErrorResponse(404, "route_not_found");
  }

  const nowMs = options.nowMs ? options.nowMs() : Date.now();
  const nowSeconds = options.nowSeconds ? options.nowSeconds() : Math.floor(nowMs / 1_000);

  const maxBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
  const rawContentLength = request.headers.get("content-length");
  if (rawContentLength !== null && /^(?:0|[1-9][0-9]*)$/.test(rawContentLength)) {
    const cl = Number(rawContentLength);
    if (Number.isSafeInteger(cl) && cl > maxBytes) {
      return createErrorResponse(413, "payload_too_large");
    }
  }

  // 1. Cheap header validation BEFORE body allocation
  let headers: ParsedCollectorHeadersV1;
  try {
    headers = parseCollectorHeaders(request.headers, nowSeconds);
  } catch (error) {
    if (error instanceof CollectorProtocolError) {
      if (error.code === ProtocolErrorCode.CLOCK_SKEW) {
        return createErrorResponse(401, "clock_skew");
      }
      if (error.code === ProtocolErrorCode.BATCH_TOO_LARGE) {
        return createErrorResponse(413, "payload_too_large");
      }
      return createErrorResponse(400, error.code);
    }
    return createErrorResponse(400, "invalid_headers");
  }
  admissionState.global = options.admission.acquireGlobal(nowMs);
  if (!admissionState.global) {
    return createErrorResponse(429, "rate_limited", { "Retry-After": "2" });
  }

  // 2. Exact host registration, session-only capability, and active current/next key metadata.
  const host = await resolveHostRegistration(options.registry, headers.hostId);
  if (
    !host ||
    !host.enabled ||
    host.capabilities.length !== 1 ||
    host.capabilities[0] !== COLLECTOR_SESSION_CAPABILITY ||
    host.keys.length < 1 ||
    host.tailscaleTags.length < 1 ||
    host.tailscaleTags.length > 8 ||
    !host.tailscaleTags.every((tag) => COLLECTOR_TAG_PATTERN.test(tag)) ||
    new Set(host.tailscaleTags).size !== host.tailscaleTags.length ||
    host.keys.length > 2 ||
    new Set(host.keys.map((candidate) => candidate.keyId)).size !== host.keys.length
  ) {
    return createErrorResponse(401, "unauthorized");
  }
  const validKeyMetadata = host.keys.every((candidate) =>
    COLLECTOR_UUID_V4_PATTERN.test(candidate.keyId) &&
    (candidate.role === "current" || candidate.role === "next") &&
    Number.isSafeInteger(candidate.notBeforeMs) &&
    candidate.notBeforeMs >= 0 &&
    Number.isSafeInteger(candidate.expiresAtMs) &&
    candidate.expiresAtMs > candidate.notBeforeMs &&
    (candidate.revoked === undefined || typeof candidate.revoked === "boolean")
  );
  if (!validKeyMetadata) return createErrorResponse(401, "unauthorized");
  if (signal.aborted) return createErrorResponse(503, "request_timeout", { "Retry-After": "5" });
  admissionState.host = options.admission.acquireHost(headers.hostId, nowMs);
  if (!admissionState.host) {
    return createErrorResponse(429, "rate_limited", { "Retry-After": "2" });
  }
  const currentKey = host.keys.find((candidate) => candidate.role === "current");
  const nextKey = host.keys.find((candidate) => candidate.role === "next");
  if (
    !currentKey ||
    host.keys.filter((candidate) => candidate.role === "current").length !== 1 ||
    host.keys.filter((candidate) => candidate.role === "next").length > 1 ||
    (nextKey !== undefined &&
      (nextKey.notBeforeMs > currentKey.expiresAtMs ||
        currentKey.expiresAtMs - nextKey.notBeforeMs > 86_400_000))
  ) {
    return createErrorResponse(401, "unauthorized");
  }
  const registeredKey = host.keys.find((candidate) => candidate.keyId === headers.keyId);
  if (
    !registeredKey ||
    registeredKey.revoked === true ||
    !Number.isSafeInteger(registeredKey.notBeforeMs) ||
    !Number.isSafeInteger(registeredKey.expiresAtMs) ||
    registeredKey.notBeforeMs > nowMs ||
    registeredKey.expiresAtMs <= nowMs
  ) {
    return createErrorResponse(401, "unauthorized");
  }

  // 3. Tailscale whois identity verification BEFORE body allocation.
  const peerIp = context?.peerIp;
  if (!peerIp) return createErrorResponse(401, "unauthorized");
  let whoisNodeId: string | undefined;
  try {
    let result: { nodeId: string } | null | undefined;
    if (typeof (options.tailscaleWhois as TailscaleWhoisVerifier).lookup === "function") {
      result = await (options.tailscaleWhois as TailscaleWhoisVerifier).lookup(peerIp, host.tailscaleTags);
    } else if (typeof options.tailscaleWhois === "function") {
      result = await (options.tailscaleWhois as TailscaleWhoisLookupFn)(peerIp, host.tailscaleTags);
    }
    whoisNodeId = result?.nodeId;
  } catch (error) {
    if (
      error instanceof TailscaleIdentityError &&
      (error.category === TailscaleIdentityErrorCategory.INVALID_PEER ||
        error.category === TailscaleIdentityErrorCategory.TAG_REJECTED)
    ) {
      return createErrorResponse(401, "unauthorized");
    }
    return createErrorResponse(503, "identity_unavailable", { "Retry-After": "5" });
  }
  if (!whoisNodeId || whoisNodeId !== host.nodeId) {
    return createErrorResponse(401, "unauthorized");
  }


  // 5. Transport-capped body reading
  if (headers.contentLength > maxBytes) {
    return createErrorResponse(413, "payload_too_large");
  }

  if (signal.aborted) {
    return createErrorResponse(503, "request_timeout", { "Retry-After": "5" });
  }
  let body: Uint8Array;
  try {
    if (options.bodyReader) {
      body = await options.bodyReader(request, maxBytes, signal);
    } else {
      body = await readBoundedRequestBody(request, maxBytes, signal);
    }
  } catch (error) {
    if (signal.aborted) {
      return createErrorResponse(503, "request_timeout", { "Retry-After": "5" });
    }
    if (error instanceof CollectorProtocolError && error.code === ProtocolErrorCode.BATCH_TOO_LARGE) {
      return createErrorResponse(413, "payload_too_large");
    }
    return createErrorResponse(400, "invalid_body");
  }

  if (body.byteLength > maxBytes) {
    return createErrorResponse(413, "payload_too_large");
  }
  if (body.byteLength !== headers.contentLength) {
    return createErrorResponse(400, "content_length_mismatch");
  }

  let key: Uint8Array;
  try {
    key = await options.keyLoader(headers.hostId, headers.keyId, signal);
  } catch {
    return createErrorResponse(503, "key_unavailable", { "Retry-After": "5" });
  }
  if (signal.aborted) {
    if (key instanceof Uint8Array) key.fill(0);
    return createErrorResponse(503, "request_timeout", { "Retry-After": "5" });
  }
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    if (key instanceof Uint8Array) key.fill(0);
    return createErrorResponse(503, "key_unavailable", { "Retry-After": "5" });
  }
  // 6. Cryptographic signature and digest verification, then zero the ephemeral key.
  const validSignature = verifyRequestSignatureV1(key, headers, headers.signature, body);
  key.fill(0);
  if (!validSignature) {
    return createErrorResponse(401, "unauthorized");
  }

  // 7. JSON parsing & closed schema validation (Auth before JSON)
  let batch: SessionBatchV1;
  try {
    batch = parseSessionBatchV1(body, nowMs);
  } catch (error) {
    if (error instanceof CollectorProtocolError) {
      if (
        error.code === ProtocolErrorCode.BATCH_INVALID_JSON ||
        error.code === ProtocolErrorCode.BATCH_INVALID_UTF8
      ) {
        return createErrorResponse(400, "invalid_json");
      }
      if (
        error.code === ProtocolErrorCode.BATCH_SCHEMA_REJECTED ||
        error.code === ProtocolErrorCode.BATCH_TIMESTAMP_REJECTED
      ) {
        return createErrorResponse(422, "schema_rejected");
      }
      if (error.code === ProtocolErrorCode.BATCH_TOO_LARGE) {
        return createErrorResponse(413, "payload_too_large");
      }
    }
    return createErrorResponse(422, "schema_rejected");
  }

  if (batch.batch_id !== headers.batchId) {
    return createErrorResponse(422, "batch_id_mismatch");
  }

  // 8. Atomic persistence in ObservatoryStore
  const persistBatch = () => {
    const existingHost = options.store.getHost(headers.hostId);
    // A. Claim collector batch in ledger
    const claimResult = options.store.claimCollectorBatch({
      hostId: headers.hostId,
      batchId: headers.batchId,
      bodySha256: headers.contentSha256,
      keyId: headers.keyId,
      receivedAt: new Date(nowMs).toISOString(),
      status: "accepted",
    });

    if (claimResult.outcome === "duplicate") {
      return { outcome: "duplicate" as const };
    }
    if (claimResult.outcome === "conflict") {
      return { outcome: "conflict" as const };
    }

    // B. Upsert host observation without regressing a newer host watermark.
    if (!existingHost || batch.collected_at_ms > Date.parse(existingHost.observedAt)) {
      options.store.upsertHost({
        hostId: headers.hostId,
        operatorLabel: host.operatorLabel ?? null,
        platform: host.platform ?? null,
        collectorVersion: batch.collector_version,
        lastSeenAt: new Date(nowMs).toISOString(),
        observedAt: new Date(batch.collected_at_ms).toISOString(),
        status: "online",
        activeSessionsCount: batch.sessions.filter((s) => s.state === "active").length,
      });
    }

    // C. Upsert newer-only sessions
    let accepted = 0;
    let ignoredStale = 0;

    for (const session of batch.sessions) {
      const existing = options.store.getSessionSummary(session.session_id, headers.hostId);
      let shouldUpsert = false;

      if (!existing) {
        shouldUpsert = true;
      } else {
        const existingActiveMs = existing.lastActiveAt
          ? Date.parse(existing.lastActiveAt)
          : Date.parse(existing.startedAt);
        const incomingActiveMs = session.last_active_at_ms;

        const existingClosed = existing.status === "closed" || existing.closedAt !== null;
        const incomingClosed = session.state === "closed";

        if (
          (incomingActiveMs > existingActiveMs && (!existingClosed || incomingClosed)) ||
          (incomingActiveMs === existingActiveMs && !existingClosed && incomingClosed)
        ) {
          shouldUpsert = true;
        }
      }

      if (shouldUpsert) {
        const tokens = session.tokens;

        const costMicros = session.estimated_cost?.micros ?? null;
        const costEstimate = costMicros !== null ? costMicros / 1_000_000 : null;

        const closedAtMs = session.closed_at_ms ?? (session.state === "closed" ? session.last_active_at_ms : undefined);
        const durationMs =
          closedAtMs !== undefined
            ? Math.max(0, closedAtMs - session.started_at_ms)
            : Math.max(0, session.last_active_at_ms - session.started_at_ms);

        options.store.upsertSessionSummary({
          sessionId: session.session_id,
          hostId: headers.hostId,
          status: session.state,
          startedAt: new Date(session.started_at_ms).toISOString(),
          lastActiveAt: new Date(session.last_active_at_ms).toISOString(),
          closedAt: closedAtMs !== undefined ? new Date(closedAtMs).toISOString() : null,
          durationMs,
          model: session.model ?? null,
          provider: session.provider ?? null,
          inputTokens: tokens?.input ?? null,
          outputTokens: tokens?.output ?? null,
          cacheReadTokens: tokens?.cache ?? null,
          reasoningTokens: tokens?.reasoning ?? null,
          totalTokens: null,
          costMicros,
          costEstimate,
          costTrust: costMicros !== null ? "estimated" : null,
          contextBps: session.context_utilization_bps ?? null,
          collectedAt: new Date(batch.collected_at_ms).toISOString(),
          source: "collector",
          sourceVersion: batch.collector_version,
        });
        accepted++;
      } else {
        ignoredStale++;
      }
    }

    return {
      outcome: "new" as const,
      accepted,
      ignoredStale,
    };
  };

  if (signal.aborted) {
    return createErrorResponse(503, "request_timeout", { "Retry-After": "5" });
  }
  let persistResult: BatchPersistResult;
  try {
    persistResult = options.store.withTransaction(persistBatch);
  } catch {
    return createErrorResponse(500, "database_error");
  }

  if (persistResult.outcome === "duplicate") {
    return new Response(
      JSON.stringify({
        status: "duplicate",
        batch_id: headers.batchId,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  }

  if (persistResult.outcome === "conflict") {
    return new Response(
      JSON.stringify({
        error: "batch_conflict",
        status: 409,
      }),
      {
        status: 409,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
      },
    );
  }

  return new Response(
    JSON.stringify({
      batch_id: headers.batchId,
      accepted: persistResult.accepted,
      ignored_stale: persistResult.ignoredStale,
    }),
    {
      status: 202,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
  } finally {
    releaseAdmissionState(admissionState);
  }
}

export async function handleCollectorRequest(
  request: Request,
  options: CollectorServerOptions,
  context?: CollectorRequestContext,
): Promise<Response> {
  const controller = new AbortController();
  const configuredDeadlineMs = options.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;
  const deadlineMs = Number.isFinite(configuredDeadlineMs)
    ? Math.max(1, Math.min(DEFAULT_REQUEST_DEADLINE_MS, configuredDeadlineMs))
    : DEFAULT_REQUEST_DEADLINE_MS;
  const admissionState: RequestAdmissionState = { global: null, host: null, released: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Response>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      releaseAdmissionState(admissionState);
      resolve(createErrorResponse(503, "request_timeout", { "Retry-After": "5" }));
    }, deadlineMs);
  });
  try {
    return await Promise.race([
      handleCollectorRequestCore(request, options, context, controller.signal, admissionState),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Creates a reusable collector request handler bound to the provided server options.
 */
export function createCollectorHandler(
  options: CollectorServerOptions,
): (request: Request, context?: CollectorRequestContext) => Promise<Response> {
  return (request: Request, context?: CollectorRequestContext) =>
    handleCollectorRequest(request, options, context);
}
