import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  CollectorProtocolError,
  MAX_BATCH_BYTES,
  MAX_COLLECTION_AGE_MS,
  MAX_FUTURE_OBSERVATION_MS,
  MAX_SESSIONS,
  ProtocolErrorCode,
  SESSION_BATCH_SCHEMA,
  SESSION_BATCH_SCHEMA_ID,
  authenticateCollectorRequestV1,
  buildSigningInputV1,
  isCollectorModelIdentifierV1,
  hashBodySha256,
  parseCollectorHeaders,
  parseSessionBatchV1,
  signRequestV1,
  validateDecodedSessionBatchV1,
  verifyRequestSignatureV1,
  type CollectorSigningFieldsV1,
  type SessionBatchV1,
  type SessionV1,
} from "./protocol";

const NOW_MS = 1_700_000_000_000;
const HOST_ID = "01234567-89ab-4def-8abc-0123456789ab";
const KEY_ID = "12345678-9abc-4def-8abc-123456789abc";
const BATCH_ID = "abcdef01-2345-4abc-8def-abcdef012345";
const OTHER_HOST_ID = "11234567-89ab-4def-8abc-0123456789ab";
const OTHER_KEY_ID = "22345678-9abc-4def-8abc-123456789abc";
const OTHER_BATCH_ID = "bbcdef01-2345-4abc-8def-abcdef012345";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const KNOWN_BODY = new TextEncoder().encode('{"schema":"afo.collector.session-batch.v1"}');
const KNOWN_DIGEST = "2eca563a141eda98750fca45ccbb38b6191eee796941623f067a2eb1b091e67e";
const KNOWN_SIGNATURE = "9Gh9sKLLmcg0AeefU3Tgv18en7YZ17e5ifc_65atS8U";

function session(index = 0): SessionV1 {
  return {
    session_id: `sess_${index}`,
    state: "active",
    started_at_ms: NOW_MS - 10_000,
    last_active_at_ms: NOW_MS - 1_000,
  };
}

function batch(overrides: Partial<SessionBatchV1> = {}): SessionBatchV1 {
  return {
    schema: SESSION_BATCH_SCHEMA_ID,
    batch_id: BATCH_ID,
    collected_at_ms: NOW_MS,
    collector_version: "1.0.0",
    omp_version: "18.0.11",
    collection_status: "ok",
    queue_dropped_total: 0,
    sessions: [],
    ...overrides,
  };
}

function batchBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function expectProtocolError(fn: () => unknown, code: ProtocolErrorCode): CollectorProtocolError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CollectorProtocolError);
    expect((error as CollectorProtocolError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    expect((error as CollectorProtocolError).stack).toBeUndefined();
    return error as CollectorProtocolError;
  }
  throw new Error("expected CollectorProtocolError");
}

function knownFields(overrides: Partial<CollectorSigningFieldsV1> = {}): CollectorSigningFieldsV1 {
  return {
    hostId: HOST_ID,
    keyId: KEY_ID,
    signedAt: 1_700_000_000,
    batchId: BATCH_ID,
    contentLength: KNOWN_BODY.byteLength,
    contentSha256: KNOWN_DIGEST,
    ...overrides,
  };
}

function headerRecord(
  fields: CollectorSigningFieldsV1 = knownFields(),
  signature = signRequestV1(KEY, fields),
): Record<string, string | string[]> {
  return {
    "content-type": "application/json",
    "content-length": String(fields.contentLength),
    "x-afo-host-id": fields.hostId,
    "x-afo-key-id": fields.keyId,
    "x-afo-signed-at": String(fields.signedAt),
    "x-afo-batch-id": fields.batchId,
    "x-afo-content-sha256": fields.contentSha256,
    authorization: `AFO-HMAC-SHA256 Signature=${signature}`,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("collector protocol v1 schema and raw parser", () => {
  it("publishes a recursively closed descriptive schema", () => {
    expect(SESSION_BATCH_SCHEMA.additionalProperties).toBe(false);
    expect(SESSION_BATCH_SCHEMA.properties.sessions.maxItems).toBe(MAX_SESSIONS);
    expect(SESSION_BATCH_SCHEMA.properties.sessions.items.additionalProperties).toBe(false);
    expect(SESSION_BATCH_SCHEMA.properties.sessions.items.properties.tokens.additionalProperties).toBe(false);
    expect(SESSION_BATCH_SCHEMA.properties.sessions.items.properties.estimated_cost.additionalProperties).toBe(false);
  });

  it("accepts an empty ok heartbeat and returns a detached closed object from raw bytes", () => {
    const input = batch();
    const raw = batchBytes(input);
    const parsed = parseSessionBatchV1(raw, NOW_MS);
    expect(parsed).toEqual(input);
    expect(validateDecodedSessionBatchV1(input, NOW_MS)).toEqual(input);
  });

  it("accepts every allowed session field at its numeric boundaries", () => {
    const input = batch({
      queue_dropped_total: Number.MAX_SAFE_INTEGER,
      sessions: [
        {
          session_id: `sess:afo-worker_0.1:${"a".repeat(100)}`,
          state: "closed",
          started_at_ms: 0,
          last_active_at_ms: NOW_MS + MAX_FUTURE_OBSERVATION_MS - 10,
          closed_at_ms: NOW_MS + MAX_FUTURE_OBSERVATION_MS,
          provider: `provider:agentrouter_default.v1-${"a".repeat(30)}`,
          model: `model:claude-3.7-sonnet:${"b".repeat(80)}`,
          tokens: {
            input: 0,
            output: Number.MAX_SAFE_INTEGER,
            cache: 1,
            reasoning: 2,
          },
          estimated_cost: { currency: "USD", micros: Number.MAX_SAFE_INTEGER },
          context_utilization_bps: 10_000,
        },
      ],
    });
    expect(parseSessionBatchV1(batchBytes(input), NOW_MS)).toEqual(input);
  });

  it("accepts exactly 128 distinct sessions and rejects 129", () => {
    const atLimit = batch({ sessions: Array.from({ length: 128 }, (_, index) => session(index)) });
    expect(parseSessionBatchV1(batchBytes(atLimit), NOW_MS).sessions).toHaveLength(128);
    const aboveLimit = batch({ sessions: Array.from({ length: 129 }, (_, index) => session(index)) });
    expectProtocolError(
      () => parseSessionBatchV1(batchBytes(aboveLimit), NOW_MS),
      ProtocolErrorCode.BATCH_SCHEMA_REJECTED,
    );
  });

  it("rejects duplicate opaque session IDs", () => {
    expectProtocolError(
      () => parseSessionBatchV1(batchBytes(batch({ sessions: [session(1), session(1)] })), NOW_MS),
      ProtocolErrorCode.BATCH_SCHEMA_REJECTED,
    );
  });

  it("enforces error versus ok batch invariants", () => {
    const errorBatch = batch({
      collection_status: "error",
      error_category: "source_unavailable",
      sessions: [],
    });
    expect(parseSessionBatchV1(batchBytes(errorBatch), NOW_MS)).toEqual(errorBatch);

    const missingCategory = clone(errorBatch) as unknown as Record<string, unknown>;
    delete missingCategory.error_category;
    expectProtocolError(
      () => parseSessionBatchV1(batchBytes(missingCategory), NOW_MS),
      ProtocolErrorCode.BATCH_SCHEMA_REJECTED,
    );
    expectProtocolError(
      () => parseSessionBatchV1(batchBytes({ ...errorBatch, sessions: [session()] }), NOW_MS),
      ProtocolErrorCode.BATCH_SCHEMA_REJECTED,
    );
    expectProtocolError(
      () => parseSessionBatchV1(batchBytes({ ...batch(), error_category: "internal" }), NOW_MS),
      ProtocolErrorCode.BATCH_SCHEMA_REJECTED,
    );
    expectProtocolError(
      () => parseSessionBatchV1(batchBytes({ ...errorBatch, error_category: "arbitrary text" }), NOW_MS),
      ProtocolErrorCode.BATCH_SCHEMA_REJECTED,
    );
  });

  it("accepts collection-age and future boundaries and rejects one millisecond beyond", () => {
    expect(parseSessionBatchV1(batchBytes(batch({ collected_at_ms: NOW_MS - MAX_COLLECTION_AGE_MS })), NOW_MS)).toBeTruthy();
    expect(parseSessionBatchV1(batchBytes(batch({ collected_at_ms: NOW_MS + MAX_FUTURE_OBSERVATION_MS })), NOW_MS)).toBeTruthy();
    expectProtocolError(
      () => parseSessionBatchV1(batchBytes(batch({ collected_at_ms: NOW_MS - MAX_COLLECTION_AGE_MS - 1 })), NOW_MS),
      ProtocolErrorCode.BATCH_TIMESTAMP_REJECTED,
    );
    expectProtocolError(
      () => parseSessionBatchV1(batchBytes(batch({ collected_at_ms: NOW_MS + MAX_FUTURE_OBSERVATION_MS + 1 })), NOW_MS),
      ProtocolErrorCode.BATCH_TIMESTAMP_REJECTED,
    );
  });

  it("rejects invalid timestamp and state ordering including closed_at_ms < last_active_at_ms", () => {
    const cases: SessionV1[] = [
      { ...session(), started_at_ms: NOW_MS, last_active_at_ms: NOW_MS - 1 },
      { ...session(), last_active_at_ms: NOW_MS + MAX_FUTURE_OBSERVATION_MS + 1 },
      { ...session(), state: "active", closed_at_ms: NOW_MS },
      { ...session(), state: "closed", started_at_ms: NOW_MS - 5_000, last_active_at_ms: NOW_MS - 1_000, closed_at_ms: NOW_MS - 2_000 },
      { ...session(), state: "closed", started_at_ms: NOW_MS - 5_000, last_active_at_ms: NOW_MS - 1_000, closed_at_ms: NOW_MS - 6_000 },
      { ...session(), state: "closed", closed_at_ms: NOW_MS + MAX_FUTURE_OBSERVATION_MS + 1 },
    ];
    for (const invalidSession of cases) {
      expectProtocolError(
        () => parseSessionBatchV1(batchBytes(batch({ sessions: [invalidSession] })), NOW_MS),
        ProtocolErrorCode.BATCH_TIMESTAMP_REJECTED,
      );
    }
  });

  it("rejects unsafe, negative, noninteger, and over-cap numeric values", () => {
    const inputs: unknown[] = [
      { ...batch(), queue_dropped_total: -1 },
      { ...batch(), queue_dropped_total: 1.5 },
      { ...batch(), queue_dropped_total: Number.MAX_SAFE_INTEGER + 1 },
      batch({ sessions: [{ ...session(), tokens: { input: -1 } }] }),
      batch({ sessions: [{ ...session(), tokens: { output: 1.5 } }] }),
      batch({ sessions: [{ ...session(), estimated_cost: { currency: "USD", micros: -1 } }] }),
      batch({ sessions: [{ ...session(), context_utilization_bps: 10_001 }] }),
    ];
    for (const input of inputs) {
      expectProtocolError(
        () => parseSessionBatchV1(batchBytes(input), NOW_MS),
        ProtocolErrorCode.BATCH_SCHEMA_REJECTED,
      );
    }
  });

  it("enforces canonical UUIDv4, versions, identifiers, state, and currency", () => {
    expect(parseSessionBatchV1(batchBytes(batch({ collector_version: `v${"1".repeat(63)}` })), NOW_MS)).toBeTruthy();
    const catalogModel = "hf/meta-llama/Llama-3.1+Instruct";
    expect(isCollectorModelIdentifierV1(catalogModel)).toBe(true);
    expect(
      parseSessionBatchV1(
        batchBytes(batch({ sessions: [{ ...session(), model: catalogModel }] })),
        NOW_MS,
      ).sessions[0]?.model,
    ).toBe(catalogModel);
    for (const invalidModel of ["meta-llama/../private", "/meta-llama/model", "meta-llama//model"]) {
      expect(isCollectorModelIdentifierV1(invalidModel)).toBe(false);
    }
    const invalid: unknown[] = [
      batch({ batch_id: BATCH_ID.toUpperCase() }),
      batch({ batch_id: "abcdef01-2345-1abc-8def-abcdef012345" }),
      batch({ collector_version: "v 1" }),
      batch({ collector_version: `v${"1".repeat(64)}` }),
      batch({ omp_version: "" }),
      batch({ sessions: [{ ...session(), session_id: "" }] }),
      batch({ sessions: [{ ...session(), provider: "" }] }),
      batch({ sessions: [{ ...session(), model: `m${"a".repeat(128)}` }] }),
      batch({ sessions: [{ ...session(), model: "meta-llama/../private" }] }),
      batch({ sessions: [{ ...session(), model: "/meta-llama/model" }] }),
      batch({ sessions: [{ ...session(), model: "meta-llama//model" }] }),
      batch({ sessions: [{ ...session(), model: "meta-llama\\model" }] }),
      batch({ sessions: [{ ...session(), model: "meta-llama/%2e%2e/private" }] }),
      batch({ sessions: [{ ...session(), model: "meta-llama/model\ncanary" }] }),
      batch({ sessions: [{ ...session(), state: "idle" as "active" }] }),
      batch({ sessions: [{ ...session(), estimated_cost: { currency: "EUR" as "USD", micros: 1 } }] }),
    ];
    for (const input of invalid) {
      expectProtocolError(
        () => parseSessionBatchV1(batchBytes(input), NOW_MS),
        ProtocolErrorCode.BATCH_SCHEMA_REJECTED,
      );
    }
  });

  it("rejects unknown and forbidden canary fields at every object level without leaking error text", () => {
    const canary = "CANARY-secret-body-must-not-leak";
    const cases: unknown[] = [
      { ...batch(), prompt: canary },
      batch({ sessions: [{ ...session(), messages: canary } as SessionV1] }),
      batch({ sessions: [{ ...session(), tokens: { input: 1, tool_result: canary } as never }] }),
      batch({
        sessions: [{ ...session(), estimated_cost: { currency: "USD", micros: 1, password: canary } as never }],
      }),
      { ...batch(), raw_session_json: { nested: { cwd: canary } } },
    ];
    for (const input of cases) {
      const error = expectProtocolError(
        () => parseSessionBatchV1(batchBytes(input), NOW_MS),
        ProtocolErrorCode.BATCH_SCHEMA_REJECTED,
      );
      expect(error.message).not.toContain(canary);
      expect(error.code).not.toContain(canary);
      expect(error.stack).toBeUndefined();
    }
  });

  it("enforces exact raw UTF-8 byte size and rejects malformed UTF-8/JSON categorically", () => {
    const exactlyLimit = new Uint8Array(MAX_BATCH_BYTES).fill(0x20);
    expectProtocolError(
      () => parseSessionBatchV1(exactlyLimit, NOW_MS),
      ProtocolErrorCode.BATCH_INVALID_JSON,
    );
    const aboveLimit = new Uint8Array(MAX_BATCH_BYTES + 1);
    expectProtocolError(
      () => parseSessionBatchV1(aboveLimit, NOW_MS),
      ProtocolErrorCode.BATCH_TOO_LARGE,
    );
    expectProtocolError(
      () => parseSessionBatchV1(Uint8Array.of(0xc3, 0x28), NOW_MS),
      ProtocolErrorCode.BATCH_INVALID_UTF8,
    );
    expectProtocolError(
      () => parseSessionBatchV1(new TextEncoder().encode("{"), NOW_MS),
      ProtocolErrorCode.BATCH_INVALID_JSON,
    );
  });
});

describe("collector protocol v1 signing and verification", () => {
  it("matches the cross-platform known answer for body hash, signing bytes, and HMAC", () => {
    expect(hashBodySha256(KNOWN_BODY)).toBe(KNOWN_DIGEST);
    const expectedInput =
      "AFO-HMAC-SHA256\n" +
      "1\n" +
      "POST\n" +
      "/v1/collector/session-batches\n" +
      `${HOST_ID}\n` +
      `${KEY_ID}\n` +
      "1700000000\n" +
      `${BATCH_ID}\n` +
      "43\n" +
      `${KNOWN_DIGEST}\n`;
    expect(new TextDecoder().decode(buildSigningInputV1(knownFields()))).toBe(expectedInput);
    expect(signRequestV1(KEY, knownFields())).toBe(KNOWN_SIGNATURE);
    expect(verifyRequestSignatureV1(KEY, knownFields(), KNOWN_SIGNATURE, KNOWN_BODY)).toBe(true);
  });

  it("rejects tampering of every caller-supplied signed field", () => {
    const tamperedFields: CollectorSigningFieldsV1[] = [
      knownFields({ hostId: OTHER_HOST_ID }),
      knownFields({ keyId: OTHER_KEY_ID }),
      knownFields({ signedAt: 1_700_000_001 }),
      knownFields({ batchId: OTHER_BATCH_ID }),
      knownFields({ contentLength: 44 }),
      knownFields({ contentSha256: `${"0".repeat(63)}1` }),
    ];
    for (const fields of tamperedFields) {
      expect(verifyRequestSignatureV1(KEY, fields, KNOWN_SIGNATURE, KNOWN_BODY)).toBe(false);
    }
    const changedBody = KNOWN_BODY.slice();
    changedBody[0] ^= 1;
    expect(verifyRequestSignatureV1(KEY, knownFields(), KNOWN_SIGNATURE, changedBody)).toBe(false);
  });

  it("rejects HMACs made with tampered prefix, version, method, path, separator, or trailing newline", () => {
    const canonical = new TextDecoder().decode(buildSigningInputV1(knownFields()));
    const mutations = [
      canonical.replace("AFO-HMAC-SHA256", "AFO-HMAC-SHA255"),
      canonical.replace("\n1\n", "\n2\n"),
      canonical.replace("\nPOST\n", "\nGET\n"),
      canonical.replace("/v1/collector/session-batches", "/v1/collector/session-batch"),
      canonical.replace(`${HOST_ID}\n${KEY_ID}`, `${HOST_ID} ${KEY_ID}`),
      canonical.slice(0, -1),
      `${canonical}\n`,
    ];
    for (const input of mutations) {
      const forged = createHmac("sha256", KEY).update(new TextEncoder().encode(input)).digest("base64url");
      expect(verifyRequestSignatureV1(KEY, knownFields(), forged, KNOWN_BODY)).toBe(false);
    }
  });

  it("accepts exactly 262144 signed body bytes and rejects 262145", () => {
    const atLimit = new Uint8Array(MAX_BATCH_BYTES);
    const fields = knownFields({
      contentLength: atLimit.byteLength,
      contentSha256: hashBodySha256(atLimit),
    });
    const signature = signRequestV1(KEY, fields);
    expect(verifyRequestSignatureV1(KEY, fields, signature, atLimit)).toBe(true);

    const aboveLimit = new Uint8Array(MAX_BATCH_BYTES + 1);
    const rejected = knownFields({
      contentLength: aboveLimit.byteLength,
      contentSha256: hashBodySha256(aboveLimit),
    });
    expectProtocolError(() => signRequestV1(KEY, rejected), ProtocolErrorCode.HEADER_REJECTED);
    expect(verifyRequestSignatureV1(KEY, rejected, signature, aboveLimit)).toBe(false);
  });

  it("requires exactly 32 key bytes and never coerces or serializes a key", () => {
    expectProtocolError(
      () => signRequestV1(new Uint8Array(31), knownFields()),
      ProtocolErrorCode.INVALID_KEY,
    );
    expectProtocolError(
      () => signRequestV1("secret-key" as unknown as Uint8Array, knownFields()),
      ProtocolErrorCode.INVALID_KEY,
    );
    const error = expectProtocolError(
      () => signRequestV1(new Uint8Array(33).fill(0x53), knownFields()),
      ProtocolErrorCode.INVALID_KEY,
    );
    expect(error.message).not.toContain("SSSS");
    expect(error.stack).toBeUndefined();
  });

  it("rejects noncanonical base64url padding bits and malformed signatures", () => {
    const canary = "CANARY_SIGNATURE_SECRET";
    for (const signature of ["", `${KNOWN_SIGNATURE}=`, canary, "a".repeat(43), "a".repeat(44)]) {
      expect(verifyRequestSignatureV1(KEY, knownFields(), signature, KNOWN_BODY)).toBe(false);
    }
    // Test non-canonical base64url padding bit variation
    const rawSig = Buffer.from(KNOWN_SIGNATURE, "base64url");
    const tamperedLastByte = Buffer.from(rawSig);
    tamperedLastByte[31] ^= 0x01;
    const tamperedSig = tamperedLastByte.toString("base64url");
    expect(verifyRequestSignatureV1(KEY, knownFields(), tamperedSig, KNOWN_BODY)).toBe(false);
  });
});

describe("collector protocol v1 header grammar", () => {
  it("parses the exact required singleton headers", () => {
    expect(parseCollectorHeaders(headerRecord(), 1_700_000_000)).toEqual({
      ...knownFields(),
      signature: KNOWN_SIGNATURE,
    });
  });

  it("accepts exactly ±300 seconds and rejects ±301", () => {
    for (const signedAt of [1_699_999_700, 1_700_000_300]) {
      const fields = knownFields({ signedAt });
      expect(parseCollectorHeaders(headerRecord(fields), 1_700_000_000).signedAt).toBe(signedAt);
    }
    for (const signedAt of [1_699_999_699, 1_700_000_301]) {
      const fields = knownFields({ signedAt });
      expectProtocolError(
        () => parseCollectorHeaders(headerRecord(fields), 1_700_000_000),
        ProtocolErrorCode.CLOCK_SKEW,
      );
    }
  });

  it("rejects duplicate and comma-joined required headers", () => {
    const duplicateRecord = headerRecord();
    duplicateRecord["x-afo-host-id"] = [HOST_ID, HOST_ID];
    expectProtocolError(
      () => parseCollectorHeaders(duplicateRecord, 1_700_000_000),
      ProtocolErrorCode.HEADER_REJECTED,
    );

    for (const name of [
      "x-afo-host-id",
      "x-afo-key-id",
      "x-afo-signed-at",
      "x-afo-batch-id",
      "x-afo-content-sha256",
      "authorization",
      "content-length",
    ]) {
      const malformed = headerRecord();
      malformed[name] = `${malformed[name]},${malformed[name]}`;
      expectProtocolError(
        () => parseCollectorHeaders(malformed, 1_700_000_000),
        ProtocolErrorCode.HEADER_REJECTED,
      );
    }

    const webHeaders = new Headers(headerRecord() as unknown as Record<string, string>);
    webHeaders.append("x-afo-key-id", KEY_ID);
    expectProtocolError(
      () => parseCollectorHeaders(webHeaders, 1_700_000_000),
      ProtocolErrorCode.HEADER_REJECTED,
    );
  });

  it("rejects case-colliding raw header names", () => {
    expectProtocolError(
      () =>
        parseCollectorHeaders(
          { ...headerRecord(), "X-AFO-Host-ID": HOST_ID },
          1_700_000_000,
        ),
      ProtocolErrorCode.HEADER_REJECTED,
    );
  });

  it("rejects missing, noncanonical, or malformed required values", () => {
    const mutations: Array<[string, string | undefined]> = [
      ["x-afo-host-id", undefined],
      ["x-afo-host-id", HOST_ID.toUpperCase()],
      ["x-afo-key-id", "12345678-9abc-1def-8abc-123456789abc"],
      ["x-afo-signed-at", "01700000000"],
      ["x-afo-signed-at", "+1700000000"],
      ["x-afo-batch-id", "not-a-uuid"],
      ["x-afo-content-sha256", KNOWN_DIGEST.toUpperCase()],
      ["x-afo-content-sha256", "0".repeat(63)],
      ["authorization", `Bearer ${KNOWN_SIGNATURE}`],
      ["authorization", `AFO-HMAC-SHA256 Signature=${KNOWN_SIGNATURE}=`],
      ["content-length", "0"],
      ["content-length", "043"],
      ["content-length", String(MAX_BATCH_BYTES + 1)],
      ["content-type", "application/json; charset=utf-8"],
    ];
    for (const [name, value] of mutations) {
      const headers = headerRecord() as unknown as Record<string, string | string[] | undefined>;
      if (value === undefined) delete headers[name];
      else headers[name] = value;
      expectProtocolError(
        () => parseCollectorHeaders(headers, 1_700_000_000),
        ProtocolErrorCode.HEADER_REJECTED,
      );
    }
  });

  it("rejects compressed/chunked and spoofed transport identity headers", () => {
    for (const [name, value] of [
      ["content-encoding", "gzip"],
      ["transfer-encoding", "chunked"],
      ["forwarded", "for=canary"],
      ["x-forwarded-for", "127.0.0.1"],
      ["x-real-ip", "127.0.0.1"],
      ["tailscale-user-login", "canary@example.invalid"],
    ]) {
      expectProtocolError(
        () => parseCollectorHeaders({ ...headerRecord(), [name]: value }, 1_700_000_000),
        ProtocolErrorCode.HEADER_REJECTED,
      );
    }
    expect(parseCollectorHeaders({ ...headerRecord(), "content-encoding": "identity" }, 1_700_000_000)).toBeTruthy();
  });

  it("caps total header bytes before returning any sensitive value", () => {
    const canary = "CANARY_HEADER_BODY_SECRET";
    const headers = {
      ...headerRecord(),
      "x-padding": `${canary}${"x".repeat(8_192)}`,
    };
    const error = expectProtocolError(
      () => parseCollectorHeaders(headers, 1_700_000_000),
      ProtocolErrorCode.HEADERS_TOO_LARGE,
    );
    expect(error.message).not.toContain(canary);
    expect(error.code).not.toContain(canary);
  });
});

describe("authenticateCollectorRequestV1 unified server verifier", () => {
  const validBatchObj = batch();
  const validBody = batchBytes(validBatchObj);
  const validFields: CollectorSigningFieldsV1 = {
    hostId: HOST_ID,
    keyId: KEY_ID,
    signedAt: 1_700_000_000,
    batchId: BATCH_ID,
    contentLength: validBody.byteLength,
    contentSha256: hashBodySha256(validBody),
  };
  const validHeaders = headerRecord(validFields, signRequestV1(KEY, validFields));

  it("authenticates valid request and returns parsed batch and headers", () => {
    const result = authenticateCollectorRequestV1({
      method: "POST",
      pathname: "/v1/collector/session-batches",
      headers: validHeaders,
      body: validBody,
      key: KEY,
      nowSeconds: 1_700_000_000,
      nowMs: NOW_MS,
    });
    expect(result.headers.hostId).toBe(HOST_ID);
    expect(result.batch.batch_id).toBe(BATCH_ID);
    expect(result.batch.collection_status).toBe("ok");
  });

  it("rejects non-POST method and non-exact route/query", () => {
    expectProtocolError(
      () =>
        authenticateCollectorRequestV1({
          method: "GET",
          pathname: "/v1/collector/session-batches",
          headers: validHeaders,
          body: validBody,
          key: KEY,
          nowSeconds: 1_700_000_000,
        }),
      ProtocolErrorCode.METHOD_NOT_ALLOWED,
    );
    expectProtocolError(
      () =>
        authenticateCollectorRequestV1({
          method: "POST",
          pathname: "/v1/collector/session-batches/",
          headers: validHeaders,
          body: validBody,
          key: KEY,
          nowSeconds: 1_700_000_000,
        }),
      ProtocolErrorCode.ROUTE_NOT_FOUND,
    );
    expectProtocolError(
      () =>
        authenticateCollectorRequestV1({
          method: "POST",
          pathname: "/v1/collector/session-batches",
          search: "?canary=1",
          headers: validHeaders,
          body: validBody,
          key: KEY,
          nowSeconds: 1_700_000_000,
        }),
      ProtocolErrorCode.ROUTE_NOT_FOUND,
    );
  });

  it("rejects invalid HMAC signature with AUTH_FAILED", () => {
    const wrongKey = new Uint8Array(32).fill(0xff);
    expectProtocolError(
      () =>
        authenticateCollectorRequestV1({
          method: "POST",
          pathname: "/v1/collector/session-batches",
          headers: validHeaders,
          body: validBody,
          key: wrongKey,
          nowSeconds: 1_700_000_000,
        }),
      ProtocolErrorCode.AUTH_FAILED,
    );
  });

  it("rejects batch_id mismatch between header and parsed body", () => {
    const mismatchedBatch = batch({ batch_id: OTHER_BATCH_ID });
    const mismatchedBody = batchBytes(mismatchedBatch);
    const fieldsWithHeaderId: CollectorSigningFieldsV1 = {
      hostId: HOST_ID,
      keyId: KEY_ID,
      signedAt: 1_700_000_000,
      batchId: BATCH_ID, // header asserts BATCH_ID
      contentLength: mismatchedBody.byteLength,
      contentSha256: hashBodySha256(mismatchedBody),
    };
    const headers = headerRecord(fieldsWithHeaderId, signRequestV1(KEY, fieldsWithHeaderId));

    expectProtocolError(
      () =>
        authenticateCollectorRequestV1({
          method: "POST",
          pathname: "/v1/collector/session-batches",
          headers,
          body: mismatchedBody,
          key: KEY,
          nowSeconds: 1_700_000_000,
          nowMs: NOW_MS,
        }),
      ProtocolErrorCode.BATCH_SCHEMA_REJECTED,
    );
  });
});
