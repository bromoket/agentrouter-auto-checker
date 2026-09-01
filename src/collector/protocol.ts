import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const MAX_BATCH_BYTES = 262_144;
export const MAX_SESSIONS = 128;
export const MAX_HEADER_BYTES = 8_192;
export const MAX_CLOCK_SKEW_SECONDS = 300;
export const MAX_COLLECTION_AGE_MS = 72 * 60 * 60 * 1_000;
export const MAX_FUTURE_OBSERVATION_MS = 120_000;

export const SESSION_BATCH_SCHEMA_ID = "afo.collector.session-batch.v1" as const;

export const COLLECTION_ERROR_CATEGORIES = [
  "timeout",
  "source_unavailable",
  "permission_denied",
  "unsupported_schema",
  "internal",
] as const;

export type CollectionErrorCategory = (typeof COLLECTION_ERROR_CATEGORIES)[number];
export type SessionStateV1 = "active" | "closed";

export interface SessionTokensV1 {
  input?: number;
  output?: number;
  cache?: number;
  reasoning?: number;
}

export interface SessionEstimatedCostV1 {
  currency: "USD";
  micros: number;
}

export interface SessionV1 {
  session_id: string;
  state: SessionStateV1;
  started_at_ms: number;
  last_active_at_ms: number;
  closed_at_ms?: number;
  provider?: string;
  model?: string;
  tokens?: SessionTokensV1;
  estimated_cost?: SessionEstimatedCostV1;
  context_utilization_bps?: number;
}

export interface SessionBatchV1 {
  schema: typeof SESSION_BATCH_SCHEMA_ID;
  batch_id: string;
  collected_at_ms: number;
  collector_version: string;
  omp_version: string;
  collection_status: "ok" | "error";
  error_category?: CollectionErrorCategory;
  queue_dropped_total: number;
  sessions: SessionV1[];
}

export interface CollectorSigningFieldsV1 {
  hostId: string;
  keyId: string;
  signedAt: number;
  batchId: string;
  contentLength: number;
  contentSha256: string;
}

export interface ParsedCollectorHeadersV1 extends CollectorSigningFieldsV1 {
  signature: string;
}

export const ProtocolErrorCode = {
  BATCH_TOO_LARGE: "batch_too_large",
  BATCH_INVALID_UTF8: "batch_invalid_utf8",
  BATCH_INVALID_JSON: "batch_invalid_json",
  BATCH_SCHEMA_REJECTED: "batch_schema_rejected",
  BATCH_TIMESTAMP_REJECTED: "batch_timestamp_rejected",
  HEADERS_TOO_LARGE: "headers_too_large",
  HEADER_REJECTED: "header_rejected",
  CLOCK_SKEW: "clock_skew",
  INVALID_KEY: "invalid_key",
  AUTH_FAILED: "auth_failed",
  METHOD_NOT_ALLOWED: "method_not_allowed",
  ROUTE_NOT_FOUND: "route_not_found",
} as const;
export type ProtocolErrorCode = (typeof ProtocolErrorCode)[keyof typeof ProtocolErrorCode];

/** An intentionally context-free error safe for categorical handling. */
export class CollectorProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode) {
    super(code);
    this.name = "CollectorProtocolError";
    this.code = code;
    this.stack = undefined;
  }
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:+-]*)*$/;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const SIGNING_PREFIX = "AFO-HMAC-SHA256";
const INGESTION_PATH = "/v1/collector/session-batches";
const REQUIRED_HEADER_NAMES = [
  "x-afo-host-id",
  "x-afo-key-id",
  "x-afo-signed-at",
  "x-afo-batch-id",
  "x-afo-content-sha256",
  "authorization",
  "content-length",
] as const;

/** Exact v1 model catalog identifier grammar shared by collectors and adapters. */
export function isCollectorModelIdentifierV1(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 128 && SAFE_MODEL_IDENTIFIER_PATTERN.test(value);
}

const TOKEN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    input: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    output: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    cache: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    reasoning: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  },
} as const;

const SESSION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["session_id", "state", "started_at_ms", "last_active_at_ms"],
  properties: {
    session_id: { type: "string", minLength: 1, maxLength: 128, pattern: SAFE_SESSION_ID_PATTERN.source },
    state: { enum: ["active", "closed"] },
    started_at_ms: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    last_active_at_ms: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    closed_at_ms: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    provider: { type: "string", minLength: 1, maxLength: 64, pattern: SAFE_IDENTIFIER_PATTERN.source },
    model: { type: "string", minLength: 1, maxLength: 128, pattern: SAFE_MODEL_IDENTIFIER_PATTERN.source },
    tokens: TOKEN_SCHEMA,
    estimated_cost: {
      type: "object",
      additionalProperties: false,
      required: ["currency", "micros"],
      properties: {
        currency: { const: "USD" },
        micros: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      },
    },
    context_utilization_bps: { type: "integer", minimum: 0, maximum: 10_000 },
  },
} as const;

/** Closed, descriptive JSON schema for the v1 wire object. Runtime invariants are enforced below. */
export const SESSION_BATCH_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SESSION_BATCH_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "batch_id",
    "collected_at_ms",
    "collector_version",
    "omp_version",
    "collection_status",
    "queue_dropped_total",
    "sessions",
  ],
  properties: {
    schema: { const: SESSION_BATCH_SCHEMA_ID },
    batch_id: { type: "string", pattern: UUID_V4_PATTERN.source },
    collected_at_ms: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    collector_version: { type: "string", minLength: 1, maxLength: 64, pattern: SAFE_VERSION_PATTERN.source },
    omp_version: { type: "string", minLength: 1, maxLength: 64, pattern: SAFE_VERSION_PATTERN.source },
    collection_status: { enum: ["ok", "error"] },
    error_category: { enum: COLLECTION_ERROR_CATEGORIES },
    queue_dropped_total: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    sessions: { type: "array", maxItems: MAX_SESSIONS, items: SESSION_SCHEMA },
  },
  allOf: [
    {
      if: { properties: { collection_status: { const: "error" } }, required: ["collection_status"] },
      then: { required: ["error_category"], properties: { sessions: { maxItems: 0 } } },
      else: { not: { required: ["error_category"] } },
    },
  ],
} as const;

function fail(code: ProtocolErrorCode): never {
  throw new CollectorProtocolError(code);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function requireClosedRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  const actualKeys = Object.keys(value);
  if (actualKeys.some((key) => !keys.includes(key))) {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }
  return value;
}

function requireString(value: unknown, pattern: RegExp, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }
  return value;
}

function requireSafeNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }
  return value as number;
}

function optionalCount(record: Record<string, unknown>, key: string): number | undefined {
  if (!(key in record)) return undefined;
  return requireSafeNonNegativeInteger(record[key]);
}

function parseTokens(value: unknown): SessionTokensV1 {
  const record = requireClosedRecord(value, ["input", "output", "cache", "reasoning"]);
  const result: SessionTokensV1 = {};
  const input = optionalCount(record, "input");
  const output = optionalCount(record, "output");
  const cache = optionalCount(record, "cache");
  const reasoning = optionalCount(record, "reasoning");
  if (input !== undefined) result.input = input;
  if (output !== undefined) result.output = output;
  if (cache !== undefined) result.cache = cache;
  if (reasoning !== undefined) result.reasoning = reasoning;
  return result;
}

function parseEstimatedCost(value: unknown): SessionEstimatedCostV1 {
  const record = requireClosedRecord(value, ["currency", "micros"]);
  if (record.currency !== "USD" || !("micros" in record)) {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }
  return { currency: "USD", micros: requireSafeNonNegativeInteger(record.micros) };
}

function parseSession(value: unknown, collectedAtMs: number): SessionV1 {
  const record = requireClosedRecord(value, [
    "session_id",
    "state",
    "started_at_ms",
    "last_active_at_ms",
    "closed_at_ms",
    "provider",
    "model",
    "tokens",
    "estimated_cost",
    "context_utilization_bps",
  ]);
  if (!("session_id" in record) || !("state" in record) || !("started_at_ms" in record) || !("last_active_at_ms" in record)) {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }

  const sessionId = requireString(record.session_id, SAFE_SESSION_ID_PATTERN, 128);
  if (record.state !== "active" && record.state !== "closed") {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }
  const state = record.state;
  const startedAtMs = requireSafeNonNegativeInteger(record.started_at_ms);
  const lastActiveAtMs = requireSafeNonNegativeInteger(record.last_active_at_ms);
  const observationCeiling = collectedAtMs + MAX_FUTURE_OBSERVATION_MS;
  if (!Number.isSafeInteger(observationCeiling) || lastActiveAtMs < startedAtMs || lastActiveAtMs > observationCeiling) {
    fail(ProtocolErrorCode.BATCH_TIMESTAMP_REJECTED);
  }

  const result: SessionV1 = {
    session_id: sessionId,
    state,
    started_at_ms: startedAtMs,
    last_active_at_ms: lastActiveAtMs,
  };

  if ("closed_at_ms" in record) {
    const closedAtMs = requireSafeNonNegativeInteger(record.closed_at_ms);
    if (state !== "closed" || closedAtMs < lastActiveAtMs || closedAtMs > observationCeiling) {
      fail(ProtocolErrorCode.BATCH_TIMESTAMP_REJECTED);
    }
    result.closed_at_ms = closedAtMs;
  }
  if ("provider" in record) result.provider = requireString(record.provider, SAFE_IDENTIFIER_PATTERN, 64);
  if ("model" in record) {
    if (!isCollectorModelIdentifierV1(record.model)) fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
    result.model = record.model;
  }
  if ("tokens" in record) result.tokens = parseTokens(record.tokens);
  if ("estimated_cost" in record) result.estimated_cost = parseEstimatedCost(record.estimated_cost);
  if ("context_utilization_bps" in record) {
    const bps = requireSafeNonNegativeInteger(record.context_utilization_bps);
    if (bps > 10_000) fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
    result.context_utilization_bps = bps;
  }
  return result;
}

function decodeBatchBytes(body: Uint8Array): unknown {
  if (!(body instanceof Uint8Array) || body.byteLength === 0 || body.byteLength > MAX_BATCH_BYTES) {
    fail(ProtocolErrorCode.BATCH_TOO_LARGE);
  }
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    fail(ProtocolErrorCode.BATCH_INVALID_UTF8);
  }
  try {
    return JSON.parse(json);
  } catch {
    fail(ProtocolErrorCode.BATCH_INVALID_JSON);
  }
}

export function validateDecodedSessionBatchV1(value: unknown, nowMs = Date.now()): SessionBatchV1 {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > Number.MAX_SAFE_INTEGER - MAX_FUTURE_OBSERVATION_MS) {
    fail(ProtocolErrorCode.BATCH_TIMESTAMP_REJECTED);
  }
  const record = requireClosedRecord(value, [
    "schema",
    "batch_id",
    "collected_at_ms",
    "collector_version",
    "omp_version",
    "collection_status",
    "error_category",
    "queue_dropped_total",
    "sessions",
  ]);
  const required = [
    "schema",
    "batch_id",
    "collected_at_ms",
    "collector_version",
    "omp_version",
    "collection_status",
    "queue_dropped_total",
    "sessions",
  ];
  if (required.some((key) => !(key in record))) fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  if (record.schema !== SESSION_BATCH_SCHEMA_ID) fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);

  const batchId = requireString(record.batch_id, UUID_V4_PATTERN, 36);
  const collectedAtMs = requireSafeNonNegativeInteger(record.collected_at_ms);
  if (
    collectedAtMs > nowMs + MAX_FUTURE_OBSERVATION_MS ||
    collectedAtMs < nowMs - MAX_COLLECTION_AGE_MS
  ) {
    fail(ProtocolErrorCode.BATCH_TIMESTAMP_REJECTED);
  }
  const collectorVersion = requireString(record.collector_version, SAFE_VERSION_PATTERN, 64);
  const ompVersion = requireString(record.omp_version, SAFE_VERSION_PATTERN, 64);
  if (record.collection_status !== "ok" && record.collection_status !== "error") {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }
  const collectionStatus = record.collection_status;
  const queueDroppedTotal = requireSafeNonNegativeInteger(record.queue_dropped_total);
  if (!Array.isArray(record.sessions) || record.sessions.length > MAX_SESSIONS) {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }
  if (collectionStatus === "error" && record.sessions.length !== 0) {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }
  if (collectionStatus === "ok" && "error_category" in record) {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }
  if (collectionStatus === "error" && !COLLECTION_ERROR_CATEGORIES.includes(record.error_category as CollectionErrorCategory)) {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }

  const sessions = record.sessions.map((session) => parseSession(session, collectedAtMs));
  const seenSessionIds = new Set<string>();
  for (const session of sessions) {
    if (seenSessionIds.has(session.session_id)) fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
    seenSessionIds.add(session.session_id);
  }

  const result: SessionBatchV1 = {
    schema: SESSION_BATCH_SCHEMA_ID,
    batch_id: batchId,
    collected_at_ms: collectedAtMs,
    collector_version: collectorVersion,
    omp_version: ompVersion,
    collection_status: collectionStatus,
    queue_dropped_total: queueDroppedTotal,
    sessions,
  };
  if (collectionStatus === "error") result.error_category = record.error_category as CollectionErrorCategory;
  return result;
}

/** Parse only capped exact raw UTF-8 body bytes; decoded objects are never a network security boundary. */
export function parseSessionBatchV1(body: Uint8Array, nowMs = Date.now()): SessionBatchV1 {
  return validateDecodedSessionBatchV1(decodeBatchBytes(body), nowMs);
}

function validateSigningFields(fields: CollectorSigningFieldsV1): void {
  if (
    !isPlainRecord(fields) ||
    !UUID_V4_PATTERN.test(fields.hostId) ||
    !UUID_V4_PATTERN.test(fields.keyId) ||
    !UUID_V4_PATTERN.test(fields.batchId) ||
    !Number.isSafeInteger(fields.signedAt) ||
    fields.signedAt < 0 ||
    !Number.isSafeInteger(fields.contentLength) ||
    fields.contentLength < 1 ||
    fields.contentLength > MAX_BATCH_BYTES ||
    !SHA256_PATTERN.test(fields.contentSha256)
  ) {
    fail(ProtocolErrorCode.HEADER_REJECTED);
  }
}

/** Build the exact UTF-8 v1 signing input, including its mandatory trailing newline. */
export function buildSigningInputV1(fields: CollectorSigningFieldsV1): Uint8Array {
  validateSigningFields(fields);
  return new TextEncoder().encode(
    `${SIGNING_PREFIX}\n1\nPOST\n${INGESTION_PATH}\n${fields.hostId}\n${fields.keyId}\n${fields.signedAt}\n${fields.batchId}\n${fields.contentLength}\n${fields.contentSha256}\n`,
  );
}

function validateKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) fail(ProtocolErrorCode.INVALID_KEY);
}

/** SHA-256 over the exact supplied bytes, returned as canonical lowercase hexadecimal. */
export function hashBodySha256(body: Uint8Array): string {
  if (!(body instanceof Uint8Array)) fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  return createHash("sha256").update(body).digest("hex");
}

/** HMAC-SHA-256 with a 32-byte key, returned as 43-character unpadded base64url. */
export function signRequestV1(key: Uint8Array, fields: CollectorSigningFieldsV1): string {
  validateKey(key);
  return createHmac("sha256", key).update(buildSigningInputV1(fields)).digest("base64url");
}

/**
 * Verify body length, body digest, and request signature without data-dependent byte comparison.
 * Malformed inputs are an authentication failure and never expose their value through an error.
 */
export function verifyRequestSignatureV1(
  key: Uint8Array,
  fields: CollectorSigningFieldsV1,
  signature: string,
  body: Uint8Array,
): boolean {
  try {
    validateKey(key);
    validateSigningFields(fields);
    if (!(body instanceof Uint8Array) || body.byteLength !== fields.contentLength) return false;
    const suppliedDigest = Buffer.from(fields.contentSha256, "hex");
    const actualDigest = createHash("sha256").update(body).digest();
    if (suppliedDigest.byteLength !== actualDigest.byteLength || !timingSafeEqual(suppliedDigest, actualDigest)) return false;
    if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) return false;
    const suppliedSignature = Buffer.from(signature, "base64url");
    if (suppliedSignature.byteLength !== 32 || suppliedSignature.toString("base64url") !== signature) return false;
    const expectedSignature = createHmac("sha256", key).update(buildSigningInputV1(fields)).digest();
    return suppliedSignature.byteLength === expectedSignature.byteLength && timingSafeEqual(suppliedSignature, expectedSignature);
  } catch {
    return false;
  }
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function collectHeaders(source: HeaderSource): Map<string, string> {
  const result = new Map<string, string>();
  let totalBytes = 0;
  const entries: [string, string | string[] | undefined][] =
    source instanceof Headers ? [...source.entries()] : Object.entries(source);

  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (result.has(name)) fail(ProtocolErrorCode.HEADER_REJECTED);
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    if (values.length !== 1 || typeof values[0] !== "string" || /[\r\n]/.test(values[0])) {
      fail(ProtocolErrorCode.HEADER_REJECTED);
    }
    const value = values[0];
    totalBytes += Buffer.byteLength(rawName) + Buffer.byteLength(value) + 4;
    if (totalBytes > MAX_HEADER_BYTES) fail(ProtocolErrorCode.HEADERS_TOO_LARGE);
    result.set(name, value);
  }
  return result;
}

function requiredHeader(headers: Map<string, string>, name: (typeof REQUIRED_HEADER_NAMES)[number]): string {
  const value = headers.get(name);
  if (value === undefined || value.includes(",")) fail(ProtocolErrorCode.HEADER_REJECTED);
  return value;
}

function parseCanonicalDecimal(value: string, maximum: number): number {
  if (!DECIMAL_PATTERN.test(value)) fail(ProtocolErrorCode.HEADER_REJECTED);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    fail(ProtocolErrorCode.HEADER_REJECTED);
  }
  return parsed;
}

/** Parse the complete strict v1 authentication/header grammar and enforce the ±300 second window. */
export function parseCollectorHeaders(
  source: HeaderSource,
  nowSeconds = Math.floor(Date.now() / 1_000),
): ParsedCollectorHeadersV1 {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) fail(ProtocolErrorCode.CLOCK_SKEW);
  const headers = collectHeaders(source);
  if (headers.has("transfer-encoding")) fail(ProtocolErrorCode.HEADER_REJECTED);
  const contentEncoding = headers.get("content-encoding");
  if (contentEncoding !== undefined && contentEncoding !== "identity") {
    fail(ProtocolErrorCode.HEADER_REJECTED);
  }
  if (headers.get("content-type") !== "application/json") fail(ProtocolErrorCode.HEADER_REJECTED);
  if (
    headers.has("forwarded") ||
    headers.has("x-forwarded-for") ||
    headers.has("x-real-ip") ||
    [...headers.keys()].some((name) => name.startsWith("tailscale-"))
  ) {
    fail(ProtocolErrorCode.HEADER_REJECTED);
  }

  const hostId = requiredHeader(headers, "x-afo-host-id");
  const keyId = requiredHeader(headers, "x-afo-key-id");
  const signedAtRaw = requiredHeader(headers, "x-afo-signed-at");
  const batchId = requiredHeader(headers, "x-afo-batch-id");
  const contentSha256 = requiredHeader(headers, "x-afo-content-sha256");
  const authorization = requiredHeader(headers, "authorization");
  const contentLengthRaw = requiredHeader(headers, "content-length");
  if (!UUID_V4_PATTERN.test(hostId) || !UUID_V4_PATTERN.test(keyId) || !UUID_V4_PATTERN.test(batchId)) {
    fail(ProtocolErrorCode.HEADER_REJECTED);
  }
  if (!SHA256_PATTERN.test(contentSha256)) fail(ProtocolErrorCode.HEADER_REJECTED);
  const signedAt = parseCanonicalDecimal(signedAtRaw, Number.MAX_SAFE_INTEGER);
  const contentLength = parseCanonicalDecimal(contentLengthRaw, MAX_BATCH_BYTES);
  if (contentLength === 0) fail(ProtocolErrorCode.HEADER_REJECTED);
  if (Math.abs(nowSeconds - signedAt) > MAX_CLOCK_SKEW_SECONDS) fail(ProtocolErrorCode.CLOCK_SKEW);
  const authorizationMatch = /^AFO-HMAC-SHA256 Signature=([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!authorizationMatch) fail(ProtocolErrorCode.HEADER_REJECTED);

  return {
    hostId,
    keyId,
    signedAt,
    batchId,
    contentLength,
    contentSha256,
    signature: authorizationMatch[1],
  };
}

export interface AuthenticatedCollectorRequestV1 {
  headers: ParsedCollectorHeadersV1;
  batch: SessionBatchV1;
}

/**
 * Server-side unified authentication and parsing entry point.
 * Enforces method (POST), exact path (/v1/collector/session-batches, no query),
 * header grammar and ±300s skew, constant-time HMAC and SHA256 digest validation,
 * closed raw-byte batch schema parsing, and equality of header and body batch IDs.
 */
export function authenticateCollectorRequestV1(options: {
  method: string;
  pathname: string;
  search?: string;
  headers: HeaderSource;
  body: Uint8Array;
  key: Uint8Array;
  nowSeconds?: number;
  nowMs?: number;
}): AuthenticatedCollectorRequestV1 {
  if (options.method !== "POST") fail(ProtocolErrorCode.METHOD_NOT_ALLOWED);
  if (options.pathname !== INGESTION_PATH || (options.search !== undefined && options.search !== "")) {
    fail(ProtocolErrorCode.ROUTE_NOT_FOUND);
  }
  const headers = parseCollectorHeaders(options.headers, options.nowSeconds);
  if (!verifyRequestSignatureV1(options.key, headers, headers.signature, options.body)) {
    fail(ProtocolErrorCode.AUTH_FAILED);
  }
  const nowMs = options.nowMs ?? (options.nowSeconds !== undefined ? options.nowSeconds * 1_000 : Date.now());
  const batch = parseSessionBatchV1(options.body, nowMs);
  if (batch.batch_id !== headers.batchId) {
    fail(ProtocolErrorCode.BATCH_SCHEMA_REJECTED);
  }
  return { headers, batch };
}
