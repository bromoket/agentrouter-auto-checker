import { isIP } from "node:net";
import type {
  QueuedBatch,
  UploadDisposition,
  UploadResult as QueueUploadResult,
} from "./queue";
import {
  MAX_BATCH_BYTES,
  hashBodySha256,
  signRequestV1,
} from "./protocol";

export const COLLECTOR_HTTPS_PORT = 8457;
export const COLLECTOR_SESSION_BATCH_PATH = "/v1/collector/session-batches";
export const REGISTERED_COLLECTOR_MAGICDNS_HOSTNAME = "bkserver.tailbbaa91.ts.net";
export const REGISTERED_COLLECTOR_ENDPOINT =
  `https://${REGISTERED_COLLECTOR_MAGICDNS_HOSTNAME}:${COLLECTOR_HTTPS_PORT}${COLLECTOR_SESSION_BATCH_PATH}`;
export const COLLECTOR_CONNECT_TIMEOUT_MS = 5_000;
export const COLLECTOR_TOTAL_TIMEOUT_MS = 15_000;
export const MAX_COLLECTOR_RESPONSE_BYTES = 2_048;
export const MAX_RETRY_AFTER_SECONDS = 300;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type { UploadDisposition } from "./queue";

export type UploadCategory =
  | "accepted"
  | "duplicate"
  | "auth_failed"
  | "bad_request"
  | "payload_too_large"
  | "schema_rejected"
  | "batch_conflict"
  | "rate_limited"
  | "server_unavailable"
  | "redirect_rejected"
  | "unexpected_status"
  | "invalid_response"
  | "response_too_large"
  | "connect_timeout"
  | "total_timeout"
  | "transport_failed"
  | "key_unavailable"
  | "signing_failed";

export interface UploadResult extends QueueUploadResult {
  disposition: UploadDisposition;
  category: UploadCategory;
}

export interface CollectorKeyIdentity {
  readonly hostId: string;
  readonly keyId: string;
}

export type CollectorKeyLoader = (
  identity: CollectorKeyIdentity,
  signal: AbortSignal
) => Uint8Array | Promise<Uint8Array>;

export type CollectorFetcher = (
  input: string,
  init: BunFetchRequestInit
) => Promise<Response>;

export type CollectorTimeoutHandle = NodeJS.Timeout | number;

export type TimeoutScheduler = (
  callback: () => void,
  delayMs: number
) => CollectorTimeoutHandle;

export interface CollectorUploadOptions {
  endpointUrl: string;
  hostId: string;
  keyId: string;
  loadKey: CollectorKeyLoader;
  fetcher?: CollectorFetcher;
  nowSeconds?: () => number;
  scheduleTimeout?: TimeoutScheduler;
  clearTimeout?: (handle: CollectorTimeoutHandle) => void;
}

interface CollectorUploadSnapshot {
  readonly hostId: string;
  readonly keyId: string;
  readonly loadKey: CollectorKeyLoader;
  readonly fetcher?: CollectorFetcher;
  readonly nowSeconds?: () => number;
}

export type CollectorClientErrorCode =
  | "invalid_endpoint"
  | "invalid_identity"
  | "invalid_batch"
  | "unsafe_runtime";

/** A deliberately categorical error that cannot disclose request material. */
export class CollectorClientError extends Error {
  readonly code: CollectorClientErrorCode;

  constructor(code: CollectorClientErrorCode) {
    super(code);
    this.name = "CollectorClientError";
    this.code = code;
    this.stack = undefined;
  }
}

interface Deadline {
  promise: Promise<never>;
  cancel(): void;
}

const CONNECT_TIMEOUT = Symbol("collector-connect-timeout");
const TOTAL_TIMEOUT = Symbol("collector-total-timeout");

function deadline(
  marker: symbol,
  delayMs: number,
  abortController: AbortController,
  schedule: TimeoutScheduler,
  clear: (handle: CollectorTimeoutHandle) => void
): Deadline {
  let rejectPromise: (reason: symbol) => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  const handle = schedule(() => {
    rejectPromise(marker);
    abortController.abort();
  }, delayMs);
  return {
    promise,
    cancel: () => clear(handle),
  };
}

/**
 * Accept only the one registered collector surface. The canonical comparison
 * also excludes credentials, alternate ports, query strings, fragments, and
 * URL spelling tricks. The request also forces normal CA and hostname verification.
 */
export function validateCollectorEndpoint(endpointUrl: string): string {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    throw new CollectorClientError("invalid_endpoint");
  }

  const hostname = url.hostname;
  const labels = hostname.split(".");
  const canonical = REGISTERED_COLLECTOR_ENDPOINT;
  if (
    url.protocol !== "https:" ||
    url.port !== String(COLLECTOR_HTTPS_PORT) ||
    url.pathname !== COLLECTOR_SESSION_BATCH_PATH ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    isIP(hostname) !== 0 ||
    hostname !== REGISTERED_COLLECTOR_MAGICDNS_HOSTNAME ||
    labels.length !== 4 ||
    labels.some((label) => !DNS_LABEL.test(label)) ||
    endpointUrl !== canonical
  ) {
    throw new CollectorClientError("invalid_endpoint");
  }
  return canonical;
}

function validateIdentity(hostId: string, keyId: string): void {
  if (!UUID_V4.test(hostId) || !UUID_V4.test(keyId)) {
    throw new CollectorClientError("invalid_identity");
  }
}
function assertSafeRuntime(): void {
  const verboseFetch = process.env.BUN_CONFIG_VERBOSE_FETCH;
  const proxyConfigured = Object.getOwnPropertyNames(process.env).some((name) => {
    const value = process.env[name];
    return /^(?:http|https|all)_proxy$/i.test(name) && value !== undefined && value !== "";
  });
  if (
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    proxyConfigured ||
    (verboseFetch !== undefined &&
      verboseFetch !== "" &&
      verboseFetch !== "0" &&
      verboseFetch !== "false")
  ) {
    throw new CollectorClientError("unsafe_runtime");
  }
}


interface QueuedUploadSnapshot {
  readonly batchId: string;
  readonly body: ArrayBuffer;
  readonly contentLength: number;
  readonly bodySha256: string;
}

function snapshotQueuedBatch(batch: QueuedBatch): QueuedUploadSnapshot {
  const batchId = batch.batchId;
  const contentLength = batch.contentLength;
  const bodySha256 = batch.bodySha256;
  if (
    !(batch.bodyBytes instanceof Uint8Array) ||
    !UUID_V4.test(batchId) ||
    !Number.isSafeInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_BATCH_BYTES ||
    contentLength !== batch.bodyBytes.byteLength ||
    !SHA256_HEX.test(bodySha256)
  ) {
    throw new CollectorClientError("invalid_batch");
  }

  const body = new ArrayBuffer(contentLength);
  const bodyBytes = new Uint8Array(body);
  bodyBytes.set(batch.bodyBytes);
  if (hashBodySha256(bodyBytes) !== bodySha256) {
    throw new CollectorClientError("invalid_batch");
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
    const value: unknown = JSON.parse(text);
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value as Record<string, unknown>).batch_id !== batchId
    ) {
      throw new CollectorClientError("invalid_batch");
    }
  } catch (error) {
    if (error instanceof CollectorClientError) throw error;
    throw new CollectorClientError("invalid_batch");
  }

  return { batchId, body, contentLength, bodySha256 };
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal
): Promise<Uint8Array | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_COLLECTOR_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
  }

  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_COLLECTOR_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function classifySuccess(
  status: number,
  bytes: Uint8Array,
  batchId: string
): UploadResult | null {
  const value = parseJsonObject(bytes);
  if (value === null || value.batch_id !== batchId) return null;

  if (
    status === 202 &&
    hasExactKeys(value, ["batch_id", "accepted", "ignored_stale"]) &&
    safeCount(value.accepted) &&
    safeCount(value.ignored_stale)
  ) {
    return {
      disposition: "accepted",
      category: "accepted",
      status,
      accepted: value.accepted,
      ignoredStale: value.ignored_stale,
    };
  }

  if (
    status === 200 &&
    hasExactKeys(value, ["status", "batch_id"]) &&
    value.status === "duplicate"
  ) {
    return { disposition: "duplicate", category: "duplicate", status };
  }
  return null;
}

function parseRetryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return undefined;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

async function classifyResponse(
  response: Response,
  batchId: string,
  signal: AbortSignal
): Promise<UploadResult> {
  let result: UploadResult | undefined;
  if (response.status >= 300 && response.status <= 399) {
    result = { disposition: "retry", category: "redirect_rejected", status: response.status };
  } else if (response.status === 401) {
    result = { disposition: "auth", category: "auth_failed", status: response.status };
  } else if (response.status === 400) {
    result = { disposition: "poison", category: "bad_request", status: response.status };
  } else if (response.status === 413) {
    result = { disposition: "poison", category: "payload_too_large", status: response.status };
  } else if (response.status === 422) {
    result = { disposition: "poison", category: "schema_rejected", status: response.status };
  } else if (response.status === 409) {
    result = { disposition: "conflict-halt", category: "batch_conflict", status: response.status };
  } else if (response.status === 429) {
    result = {
      disposition: "retry",
      category: "rate_limited",
      status: response.status,
      retryAfterSeconds: parseRetryAfter(response),
    };
  } else if (response.status >= 500 && response.status <= 599) {
    result = {
      disposition: "retry",
      category: "server_unavailable",
      status: response.status,
      retryAfterSeconds: parseRetryAfter(response),
    };
  } else if (response.status !== 200 && response.status !== 202) {
    result = { disposition: "retry", category: "unexpected_status", status: response.status };
  }

  if (result !== undefined) {
    void response.body?.cancel().catch(() => {});
    return result;
  }

  const bytes = await readBoundedResponse(response, signal);
  if (bytes === null) {
    return {
      disposition: "retry",
      category: "response_too_large",
      status: response.status,
    };
  }
  return (
    classifySuccess(response.status, bytes, batchId) ?? {
      disposition: "retry",
      category: "invalid_response",
      status: response.status,
    }
  );
}

async function performUpload(
  endpointUrl: string,
  options: CollectorUploadSnapshot,
  batch: QueuedUploadSnapshot,
  controller: AbortController,
  schedule: TimeoutScheduler,
  clear: (handle: CollectorTimeoutHandle) => void
): Promise<UploadResult> {
  const signedAt = Math.floor((options.nowSeconds ?? (() => Date.now() / 1_000))());
  if (!Number.isSafeInteger(signedAt) || signedAt < 0) {
    return { disposition: "retry", category: "signing_failed" };
  }

  let loadedKey: Uint8Array;
  try {
    loadedKey = await options.loadKey(
      Object.freeze({ hostId: options.hostId, keyId: options.keyId }),
      controller.signal
    );
  } catch {
    return controller.signal.aborted
      ? { disposition: "retry", category: "total_timeout" }
      : { disposition: "retry", category: "key_unavailable" };
  }
  if (!(loadedKey instanceof Uint8Array) || loadedKey.byteLength !== 32) {
    return { disposition: "retry", category: "key_unavailable" };
  }
  if (controller.signal.aborted) {
    return { disposition: "retry", category: "total_timeout" };
  }

  const workingKey = loadedKey.slice();
  let signature: string;
  try {
    signature = signRequestV1(workingKey, {
      hostId: options.hostId,
      keyId: options.keyId,
      signedAt,
      batchId: batch.batchId,
      contentLength: batch.contentLength,
      contentSha256: batch.bodySha256,
    });
  } catch {
    return { disposition: "retry", category: "signing_failed" };
  } finally {
    workingKey.fill(0);
  }

  const headers = new Headers({
    "Content-Type": "application/json",
    "Content-Length": String(batch.contentLength),
    "X-AFO-Host-ID": options.hostId,
    "X-AFO-Key-ID": options.keyId,
    "X-AFO-Signed-At": String(signedAt),
    "X-AFO-Batch-ID": batch.batchId,
    "X-AFO-Content-SHA256": batch.bodySha256,
    Authorization: `AFO-HMAC-SHA256 Signature=${signature}`,
  });

  const connect = deadline(CONNECT_TIMEOUT, COLLECTOR_CONNECT_TIMEOUT_MS, controller, schedule, clear);
  let response: Response;
  try {
    response = await Promise.race([
      (options.fetcher ?? fetch)(endpointUrl, {
        method: "POST",
        headers,
        body: batch.body,
        redirect: "manual",
        signal: controller.signal,
        tls: { rejectUnauthorized: true },
        verbose: false,
      }),
      connect.promise,
    ]);
  } finally {
    connect.cancel();
  }
  return classifyResponse(response, batch.batchId, controller.signal);
}

/**
 * Make exactly one upload attempt. This function never retries, redirects,
 * rewrites the queued body, probes another endpoint, or relaxes TLS.
 */
export async function uploadQueuedBatch(
  options: CollectorUploadOptions,
  batch: QueuedBatch
): Promise<UploadResult> {
  const endpointInput = options.endpointUrl;
  const hostId = options.hostId;
  const keyId = options.keyId;
  const loadKey = options.loadKey;
  const fetcher = options.fetcher;
  const nowSeconds = options.nowSeconds;
  const schedule = options.scheduleTimeout ?? setTimeout;
  const clear = options.clearTimeout ?? clearTimeout;

  assertSafeRuntime();
  const endpointUrl = validateCollectorEndpoint(endpointInput);
  validateIdentity(hostId, keyId);
  const batchSnapshot = snapshotQueuedBatch(batch);
  const uploadSnapshot: CollectorUploadSnapshot = Object.freeze({
    hostId,
    keyId,
    loadKey,
    fetcher,
    nowSeconds,
  });

  const controller = new AbortController();
  const total = deadline(TOTAL_TIMEOUT, COLLECTOR_TOTAL_TIMEOUT_MS, controller, schedule, clear);
  try {
    return await Promise.race([
      performUpload(endpointUrl, uploadSnapshot, batchSnapshot, controller, schedule, clear),
      total.promise,
    ]);
  } catch (error) {
    if (error === CONNECT_TIMEOUT) {
      return { disposition: "retry", category: "connect_timeout" };
    }
    if (error === TOTAL_TIMEOUT) {
      return { disposition: "retry", category: "total_timeout" };
    }
    return { disposition: "retry", category: "transport_failed" };
  } finally {
    total.cancel();
    controller.abort();
  }
}
