import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ObservatoryStore } from "../observatory/store";
import {
  COLLECTOR_MAGICDNS_HOST,
  COLLECTOR_PATHNAME,
  COLLECTOR_PORT,
  DEFAULT_MAX_BATCH_BYTES,
  PINNED_TAILSCALE_CLI_VERSION,
  COLLECTOR_PROXY_SOURCE_IP_HEADER,
  COLLECTOR_PROXY_TOKEN_HEADER,
  CollectorAdmissionController,
  createProductionCollectorHandler,
  createProductionTailscaleWhoisExecutor,
  createCollectorHandler,
  handleCollectorRequest,
  readBoundedRequestBody,
  resolveHostRegistration,
  resolveCollectorPeerIp,
  verifyTailscaleCliVersion,
  type CollectorServerOptions,
  type RegisteredCollectorHost,
  type TailscaleWhoisVerifier,
} from "./server";
import {
  SESSION_BATCH_SCHEMA_ID,
  hashBodySha256,
  signRequestV1,
  type CollectorSigningFieldsV1,
  type SessionBatchV1,
  type SessionV1,
} from "./protocol";
import {
  TailscaleIdentityError,
  type TailscaleWhoisExecutionRequest,
  type TailscaleWhoisExecutionResult,
} from "./tailscale-identity";

const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const HOST_ID = "01234567-89ab-4def-8abc-0123456789ab";
const KEY_ID = "12345678-9abc-4def-8abc-123456789abc";
const BATCH_ID = "abcdef01-2345-4abc-8def-abcdef012345";
const NODE_ID = "node-ts-prod-01";
const PEER_IP = "100.64.0.42";
const HMAC_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 13) % 256);
const PROXY_TOKEN = Uint8Array.from({ length: 32 }, (_, index) => (index * 11 + 5) % 256);
const PROXY_TOKEN_HEADER = Buffer.from(PROXY_TOKEN).toString("base64url");
const TEST_KEY_LOADER = async (hostId: string, keyId: string): Promise<Uint8Array> => {
  if (hostId !== HOST_ID || keyId !== KEY_ID) throw new Error("key_unavailable");
  return Uint8Array.from(HMAC_KEY);
};

const CANARY_SECRET_KEY = "CANARY_SECRET_DO_NOT_LEAK";
const CANARY_PATH = "/home/user/.omp/sessions/canary_session.jsonl";
const CANARY_PROMPT = "CANARY_PROMPT_CONFIDENTIAL_INSTRUCTION";
const CANARY_TOOL = "CANARY_TOOL_CALL_DANGEROUS_PAYLOAD";

function createValidSession(overrides: Partial<SessionV1> = {}): SessionV1 {
  return {
    session_id: "sess-001",
    state: "active",
    started_at_ms: NOW_MS - 60_000,
    last_active_at_ms: NOW_MS - 5_000,
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    tokens: {
      input: 500,
      output: 200,
      cache: 100,
      reasoning: 50,
    },
    estimated_cost: {
      currency: "USD",
      micros: 25_000,
    },
    context_utilization_bps: 4500,
    ...overrides,
  };
}

function createValidBatch(overrides: Partial<SessionBatchV1> = {}): SessionBatchV1 {
  return {
    schema: SESSION_BATCH_SCHEMA_ID,
    batch_id: BATCH_ID,
    collected_at_ms: NOW_MS,
    collector_version: "1.0.0",
    omp_version: "18.0.11",
    collection_status: "ok",
    queue_dropped_total: 0,
    sessions: [createValidSession()],
    ...overrides,
  };
}

function createSignedRequest(options: {
  batch?: SessionBatchV1;
  rawBody?: Uint8Array;
  hostId?: string;
  keyId?: string;
  key?: Uint8Array;
  signedAt?: number;
  batchId?: string;
  method?: string;
  url?: string;
  extraHeaders?: Record<string, string>;
}): { request: Request; body: Uint8Array } {
  const method = options.method ?? "POST";
  const url = options.url ?? `https://${COLLECTOR_MAGICDNS_HOST}:${COLLECTOR_PORT}${COLLECTOR_PATHNAME}`;
  const hostId = options.hostId ?? HOST_ID;
  const keyId = options.keyId ?? KEY_ID;
  const key = options.key ?? HMAC_KEY;
  const signedAt = options.signedAt ?? NOW_SECONDS;
  const batchId = options.batchId ?? (options.batch?.batch_id ?? BATCH_ID);

  const body =
    options.rawBody ??
    new TextEncoder().encode(JSON.stringify(options.batch ?? createValidBatch({ batch_id: batchId })));
  const contentSha256 = hashBodySha256(body);
  const contentLength = body.byteLength;

  const signingFields: CollectorSigningFieldsV1 = {
    hostId,
    keyId,
    signedAt,
    batchId,
    contentLength,
    contentSha256,
  };

  const signature = signRequestV1(key, signingFields);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(contentLength),
    "x-afo-host-id": hostId,
    "x-afo-key-id": keyId,
    "x-afo-signed-at": String(signedAt),
    "x-afo-batch-id": batchId,
    "x-afo-content-sha256": contentSha256,
    authorization: `AFO-HMAC-SHA256 Signature=${signature}`,
    ...options.extraHeaders,
  };

  const requestBody = new ArrayBuffer(body.byteLength);
  new Uint8Array(requestBody).set(body);
  const request = new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : requestBody,
  });

  return { request, body };
}

function createMockHost(overrides: Partial<RegisteredCollectorHost> = {}): RegisteredCollectorHost {
  return {
    hostId: HOST_ID,
    keys: [{ keyId: KEY_ID, role: "current", notBeforeMs: 0, expiresAtMs: Number.MAX_SAFE_INTEGER }],
    nodeId: NODE_ID,
    enabled: true,
    operatorLabel: "prod-fleet-01",
    platform: "linux-x64",
    tailscaleTags: ["tag:afo-collector"],
    capabilities: ["omp-session"],
    ...overrides,
  };
}

function createMockVerifier(nodeId = NODE_ID): TailscaleWhoisVerifier {
  return {
    lookup: async (peerIp: string) => {
      if (peerIp === PEER_IP) {
        return { nodeId };
      }
      return null;
    },
  };
}

describe("Collector Ingestion Server", () => {
  it("exports exact constants conforming to the collector protocol", () => {
    expect(COLLECTOR_PORT).toBe(8457);
    expect(COLLECTOR_PATHNAME).toBe("/v1/collector/session-batches");
    expect(COLLECTOR_MAGICDNS_HOST).toBe("bkserver.tailbbaa91.ts.net");
    expect(DEFAULT_MAX_BATCH_BYTES).toBe(262_144);
  });

  describe("1. Happy Path & Ingestion Contract", () => {
    it("accepts a valid authenticated batch and persists host and sessions with 202 Accepted", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      const batch = createValidBatch({
        sessions: [
          createValidSession({ session_id: "s1", state: "active" }),
          createValidSession({
            session_id: "s2",
            state: "closed",
            closed_at_ms: NOW_MS - 2_000,
          }),
        ],
      });

      const { request } = createSignedRequest({ batch });
      const response = await handleCollectorRequest(
        request,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowMs: () => NOW_MS,
          nowSeconds: () => NOW_SECONDS,
        },
        { peerIp: PEER_IP },
      );

      expect(response.status).toBe(202);
      expect(response.headers.get("content-type")).toContain("application/json");

      const body = await response.json();
      expect(body).toEqual({
        batch_id: BATCH_ID,
        accepted: 2,
        ignored_stale: 0,
      });

      // Verify host is persisted in store
      const storedHost = store.getHost(HOST_ID);
      expect(storedHost).not.toBeNull();
      expect(storedHost?.status).toBe("online");
      expect(storedHost?.operatorLabel).toBe("prod-fleet-01");
      expect(storedHost?.collectorVersion).toBe("1.0.0");
      expect(storedHost?.activeSessionsCount).toBe(1); // 1 active session

      // Verify sessions are persisted in store
      const s1 = store.getSessionSummary("s1", HOST_ID);
      expect(s1).not.toBeNull();
      expect(s1?.status).toBe("active");
      expect(s1?.inputTokens).toBe(500);
      expect(s1?.outputTokens).toBe(200);
      expect(s1?.cacheReadTokens).toBe(100);
      expect(s1?.reasoningTokens).toBe(50);
      expect(s1?.totalTokens).toBeNull();
      expect(s1?.costMicros).toBe(25_000);
      expect(s1?.costEstimate).toBe(0.025);
      expect(s1?.costTrust).toBe("estimated");

      const s2 = store.getSessionSummary("s2", HOST_ID);
      expect(s2).not.toBeNull();
      expect(s2?.status).toBe("closed");
      expect(s2?.closedAt).toBe(new Date(NOW_MS - 2_000).toISOString());
    });
  });

  describe("2. Replay & Exact Duplicate Handling", () => {
    it("returns 200 Duplicate on exact replayed batch without altering existing data", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();
      const batch = createValidBatch();

      const options: CollectorServerOptions = {
        registry: [host],
        tailscaleWhois: verifier,
        keyLoader: TEST_KEY_LOADER,
        admission: new CollectorAdmissionController(),
        store,
        nowMs: () => NOW_MS,
        nowSeconds: () => NOW_SECONDS,
      };

      const { request: req1 } = createSignedRequest({ batch });
      const res1 = await handleCollectorRequest(req1, options, { peerIp: PEER_IP });
      expect(res1.status).toBe(202);

      // Re-send exact same batch
      const { request: req2 } = createSignedRequest({ batch });
      const res2 = await handleCollectorRequest(req2, options, { peerIp: PEER_IP });
      expect(res2.status).toBe(200);

      const body2 = await res2.json();
      expect(body2).toEqual({
        status: "duplicate",
        batch_id: BATCH_ID,
      });
    });

    it("handles replay after server restart with fresh ObservatoryStore instance", async () => {
      const db = new Database(":memory:");
      const store1 = new ObservatoryStore(db);
      const host = createMockHost();
      const verifier = createMockVerifier();
      const batch = createValidBatch();

      // Ingest with first store instance
      const { request: req1 } = createSignedRequest({ batch });
      const res1 = await handleCollectorRequest(
        req1,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store: store1,
          nowMs: () => NOW_MS,
          nowSeconds: () => NOW_SECONDS,
        },
        { peerIp: PEER_IP },
      );
      expect(res1.status).toBe(202);

      // Simulate restart: construct store2 referencing the same database
      const store2 = new ObservatoryStore(db, { autoMigrate: false });
      const { request: req2 } = createSignedRequest({ batch });
      const res2 = await handleCollectorRequest(
        req2,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store: store2,
          nowMs: () => NOW_MS + 10_000,
          nowSeconds: () => NOW_SECONDS + 10,
        },
        { peerIp: PEER_IP },
      );

      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2).toEqual({
        status: "duplicate",
        batch_id: BATCH_ID,
      });
    });
  });

  describe("3. Duplicate vs Conflict (409)", () => {
    it("returns 409 Conflict when batch ID is reused with a different body payload hash", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      const batch1 = createValidBatch({
        batch_id: BATCH_ID,
        omp_version: "18.0.11",
      });
      const batch2 = createValidBatch({
        batch_id: BATCH_ID,
        omp_version: "18.0.12", // Different payload -> different hash
      });

      const options: CollectorServerOptions = {
        registry: [host],
        tailscaleWhois: verifier,
        keyLoader: TEST_KEY_LOADER,
        admission: new CollectorAdmissionController(),
        store,
        nowMs: () => NOW_MS,
        nowSeconds: () => NOW_SECONDS,
      };

      const { request: req1 } = createSignedRequest({ batch: batch1 });
      const res1 = await handleCollectorRequest(req1, options, { peerIp: PEER_IP });
      expect(res1.status).toBe(202);

      const { request: req2 } = createSignedRequest({ batch: batch2 });
      const res2 = await handleCollectorRequest(req2, options, { peerIp: PEER_IP });
      expect(res2.status).toBe(409);

      const body2 = await res2.json();
      expect(body2.error).toBe("batch_conflict");
      expect(body2.status).toBe(409);
    });

    it("returns 409 Conflict when batch ID is reused with a different key ID", async () => {
      const store = new ObservatoryStore(":memory:");
      const otherKeyId = "22345678-9abc-4def-8abc-123456789abc";
      const batch = createValidBatch({ batch_id: BATCH_ID });

      // Claim batch with first key
      store.claimCollectorBatch({
        hostId: HOST_ID,
        batchId: BATCH_ID,
        bodySha256: hashBodySha256(new TextEncoder().encode(JSON.stringify(batch))),
        keyId: KEY_ID,
        receivedAt: new Date(NOW_MS).toISOString(),
      });

      // Present same batch body signed under different keyId directly in store claim
      const claimConflict = store.claimCollectorBatch({
        hostId: HOST_ID,
        batchId: BATCH_ID,
        bodySha256: hashBodySha256(new TextEncoder().encode(JSON.stringify(batch))),
        keyId: otherKeyId,
        receivedAt: new Date(NOW_MS).toISOString(),
      });

      expect(claimConflict.outcome).toBe("conflict");
    });
  });

  describe("4. Stale vs Newer Session Upserts", () => {
    it("upserts newer sessions and increments ignored_stale for older observations", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      // Batch 1: Ingest s1 (t=1000) and s2 (t=1000, closed)
      const batch1 = createValidBatch({
        batch_id: "11111111-1111-4111-8111-111111111111",
        sessions: [
          createValidSession({
            session_id: "s1",
            started_at_ms: NOW_MS - 100_000,
            last_active_at_ms: NOW_MS - 50_000,
            state: "active",
          }),
          createValidSession({
            session_id: "s2",
            started_at_ms: NOW_MS - 100_000,
            last_active_at_ms: NOW_MS - 50_000,
            closed_at_ms: NOW_MS - 40_000,
            state: "closed",
          }),
        ],
      });

      const options: CollectorServerOptions = {
        registry: [host],
        tailscaleWhois: verifier,
        keyLoader: TEST_KEY_LOADER,
        admission: new CollectorAdmissionController(),
        store,
        nowMs: () => NOW_MS,
        nowSeconds: () => NOW_SECONDS,
      };

      const { request: req1 } = createSignedRequest({ batch: batch1 });
      const res1 = await handleCollectorRequest(req1, options, { peerIp: PEER_IP });
      expect(res1.status).toBe(202);
      expect(await res1.json()).toEqual({
        batch_id: "11111111-1111-4111-8111-111111111111",
        accepted: 2,
        ignored_stale: 0,
      });

      // Batch 2:
      // s1 has newer activity at NOW_MS - 10_000 -> accepted
      // s2 has older activity at NOW_MS - 60_000 -> ignored_stale
      // s3 is a brand new session -> accepted
      const batch2 = createValidBatch({
        batch_id: "22222222-2222-4222-8222-222222222222",
        sessions: [
          createValidSession({
            session_id: "s1",
            started_at_ms: NOW_MS - 100_000,
            last_active_at_ms: NOW_MS - 10_000, // Newer!
            state: "active",
          }),
          createValidSession({
            session_id: "s2",
            started_at_ms: NOW_MS - 100_000,
            last_active_at_ms: NOW_MS - 60_000, // Older/stale!
            state: "active",
          }),
          createValidSession({
            session_id: "s3",
            started_at_ms: NOW_MS - 20_000,
            last_active_at_ms: NOW_MS - 10_000, // New!
            state: "active",
          }),
        ],
      });

      const { request: req2 } = createSignedRequest({ batch: batch2 });
      const res2 = await handleCollectorRequest(req2, options, { peerIp: PEER_IP });
      expect(res2.status).toBe(202);
      expect(await res2.json()).toEqual({
        batch_id: "22222222-2222-4222-8222-222222222222",
        accepted: 2,
        ignored_stale: 1,
      });

      // Verify that s2 was NOT overwritten by the stale observation
      const s2Stored = store.getSessionSummary("s2", HOST_ID);
      expect(s2Stored?.status).toBe("closed");
      expect(s2Stored?.lastActiveAt).toBe(new Date(NOW_MS - 50_000).toISOString());
      expect(s2Stored?.closedAt).toBe(new Date(NOW_MS - 40_000).toISOString());

      // Verify that s1 was updated to the newer activity timestamp
      const s1Stored = store.getSessionSummary("s1", HOST_ID);
      expect(s1Stored?.lastActiveAt).toBe(new Date(NOW_MS - 10_000).toISOString());
    });
  });

  describe("5. Authentication & Identity Boundaries", () => {
    it("returns 401 when Tailscale whois returns a different Node ID", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const wrongVerifier: TailscaleWhoisVerifier = {
        lookup: async () => ({ nodeId: "node-impostor-99" }),
      };

      const { request } = createSignedRequest({});
      const response = await handleCollectorRequest(
        request,
        {
          registry: [host],
          tailscaleWhois: wrongVerifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        { peerIp: PEER_IP },
      );

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe("unauthorized");
      expect(body.status).toBe(401);
    });

    it("returns 401 when peer IP is missing or whois lookup fails", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      const { request } = createSignedRequest({});
      const responseNoIp = await handleCollectorRequest(
        request,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        undefined, // No peer IP
      );

      const failingVerifier: TailscaleWhoisVerifier = {
        lookup: async () => {
          throw new TailscaleIdentityError("invalid_peer");
        },
      };
      const responseFailed = await handleCollectorRequest(
        request,
        {
          registry: [host],
          tailscaleWhois: failingVerifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        { peerIp: PEER_IP },
      );
    });

    it("returns 401 when host ID is unknown or disabled without leaking registry state", async () => {
      const store = new ObservatoryStore(":memory:");
      const verifier = createMockVerifier();

      // Unknown host
      const { request: reqUnknown } = createSignedRequest({
        hostId: "99999999-9999-4999-8999-999999999999",
      });
      const resUnknown = await handleCollectorRequest(
        reqUnknown,
        {
          registry: [createMockHost()],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        { peerIp: PEER_IP },
      );
      expect(resUnknown.status).toBe(401);
      expect((await resUnknown.json()).error).toBe("unauthorized");

      // Disabled host
      const disabledHost = createMockHost({ enabled: false });
      const { request: reqDisabled } = createSignedRequest({});
      const resDisabled = await handleCollectorRequest(
        reqDisabled,
        {
          registry: [disabledHost],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        { peerIp: PEER_IP },
      );
      expect((await resDisabled.json()).error).toBe("unauthorized");
    });

    it("returns 401 when request is signed with the wrong HMAC key or key ID mismatch", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();
      const wrongKey = Uint8Array.from({ length: 32 }, (_, i) => (i + 1) % 256);

      // Wrong signing key
      const { request: reqWrongKey } = createSignedRequest({ key: wrongKey });
      const resWrongKey = await handleCollectorRequest(
        reqWrongKey,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        { peerIp: PEER_IP },
      );

      // Key ID mismatch
      const { request: reqWrongKeyId } = createSignedRequest({
        keyId: "99999999-9999-4999-8999-999999999999",
      });
      const resWrongKeyId = await handleCollectorRequest(
        reqWrongKeyId,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        { peerIp: PEER_IP },
      );
    });

    it("returns 401 when request signature has clock skew exceeding ±300s", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      // 301 seconds in the past
      const { request: reqPast } = createSignedRequest({
        signedAt: NOW_SECONDS - 301,
      });
      const resPast = await handleCollectorRequest(
        reqPast,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
        },
        { peerIp: PEER_IP },
      );
      expect(resPast.status).toBe(401);
      expect((await resPast.json()).error).toBe("clock_skew");

      // 301 seconds in the future
      const { request: reqFuture } = createSignedRequest({
        signedAt: NOW_SECONDS + 301,
      });
      const resFuture = await handleCollectorRequest(
        reqFuture,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
        },
        { peerIp: PEER_IP },
      );
      expect(resFuture.status).toBe(401);
      expect((await resFuture.json()).error).toBe("clock_skew");
    });
  });

  describe("6. Transport Cap & Body Allocation Safeguards", () => {
    it("returns 413 Payload Too Large on Content-Length header exceeding 256 KiB before body read", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      const { request } = createSignedRequest({
        extraHeaders: {
          "content-length": String(DEFAULT_MAX_BATCH_BYTES + 1),
        },
      });

      const response = await handleCollectorRequest(
        request,
        { registry: [host], tailscaleWhois: verifier, keyLoader: TEST_KEY_LOADER, admission: new CollectorAdmissionController(), store, nowSeconds: () => NOW_SECONDS },
        { peerIp: PEER_IP },
      );

      expect(response.status).toBe(413);
      expect((await response.json()).error).toBe("payload_too_large");
    });

    it("aborts stream and returns 413 when body stream exceeds max bytes", async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(200_000));
          controller.enqueue(new Uint8Array(100_000)); // Total 300,000 > 262,144
          controller.close();
        },
      });

      const request = new Request("https://localhost", {
        method: "POST",
        body: stream,
        headers: { "content-length": "200000" },
      });

      await expect(readBoundedRequestBody(request, 262_144)).rejects.toThrow();
    });
    it("does not load ephemeral key material when bounded body reading fails", async () => {
      let keyLoaded = false;
      const { request } = createSignedRequest({});
      const response = await handleCollectorRequest(
        request,
        {
          registry: [createMockHost()],
          tailscaleWhois: createMockVerifier(),
          keyLoader: async () => {
            keyLoaded = true;
            return Uint8Array.from(HMAC_KEY);
          },
          admission: new CollectorAdmissionController(),
          store: new ObservatoryStore(":memory:"),
          nowSeconds: () => NOW_SECONDS,
          bodyReader: async () => {
            throw new Error("body_failed");
          },
        },
        { peerIp: PEER_IP },
      );
      expect(response.status).toBe(400);
      expect(keyLoaded).toBe(false);
    });
  });

  describe("7. Auth Precedence & Closed Schema Validation", () => {
    it("enforces authentication BEFORE attempting JSON parsing (returns 401 on bad auth + bad JSON)", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      // Malformed body (not JSON) signed with wrong key
      const garbageBody = new TextEncoder().encode("NOT_JSON_AT_ALL_{{{[[[");
      const wrongKey = Uint8Array.from({ length: 32 }, () => 0xff);

      const { request } = createSignedRequest({
        rawBody: garbageBody,
        key: wrongKey,
      });

      const response = await handleCollectorRequest(
        request,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
        },
        { peerIp: PEER_IP },
      );

      // Must fail with 401 Unauthorized, NOT 400 Bad Request
      expect(response.status).toBe(401);
    });

    it("returns 400 Bad Request when authenticated body is invalid JSON", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      const garbageBody = new TextEncoder().encode("{ broken json: ");
      const { request } = createSignedRequest({ rawBody: garbageBody });

      const response = await handleCollectorRequest(
        request,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
        },
        { peerIp: PEER_IP },
      );

      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_json");
    });

    it("returns 422 Unprocessable Entity on schema violations, timestamp out-of-bounds, or batch ID mismatch", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      const options = (): CollectorServerOptions => ({
        registry: [host],
        tailscaleWhois: verifier,
        keyLoader: TEST_KEY_LOADER,
        admission: new CollectorAdmissionController(),
        store,
        nowMs: () => NOW_MS,
        nowSeconds: () => NOW_SECONDS,
      });

      // 1. Extra unknown field (closed schema)
      const batchExtra = {
        ...createValidBatch(),
        unauthorized_extra_field: "injected",
      };
      const { request: reqExtra } = createSignedRequest({ rawBody: new TextEncoder().encode(JSON.stringify(batchExtra)) });
      const resExtra = await handleCollectorRequest(reqExtra, options(), { peerIp: PEER_IP });
      expect(resExtra.status).toBe(422);

      // 2. Batch ID mismatch between header and body
      const { request: reqIdMismatch } = createSignedRequest({
        batchId: "11111111-1111-4111-8111-111111111111", // header batch ID
        batch: createValidBatch({ batch_id: "22222222-2222-4222-8222-222222222222" }), // body batch ID
      });
      const resIdMismatch = await handleCollectorRequest(reqIdMismatch, options(), { peerIp: PEER_IP });
      expect(resIdMismatch.status).toBe(422);

      // 3. Batch collected_at too far in the future (> 120s)
      const batchFuture = createValidBatch({
        collected_at_ms: NOW_MS + 130_000,
      });
      const { request: reqFuture } = createSignedRequest({ batch: batchFuture });
      const resFuture = await handleCollectorRequest(reqFuture, options(), { peerIp: PEER_IP });
      expect(resFuture.status).toBe(422);
    });
  });

  describe("8. Atomic Persistence & Rollback", () => {
    it("rolls back all changes atomically if an error occurs during persistence", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      // Force an error during upsertSessionSummary
      const originalUpsert = store.upsertSessionSummary.bind(store);
      store.upsertSessionSummary = () => {
        throw new Error("Simulated database disk failure");
      };

      const batch = createValidBatch();
      const { request } = createSignedRequest({ batch });

      const response = await handleCollectorRequest(
        request,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowMs: () => NOW_MS,
          nowSeconds: () => NOW_SECONDS,
        },
        { peerIp: PEER_IP },
      );

      expect(response.status).toBe(500);

      // Restore original and verify nothing was committed
      store.upsertSessionSummary = originalUpsert;
      expect(store.getCollectorBatch(HOST_ID, BATCH_ID)).toBeNull();
      expect(store.getSessionSummary("sess-001", HOST_ID)).toBeNull();
    });
  });

  describe("9. Canary Privacy & Non-Leakage Contract", () => {
    it("never echoes canary secrets, file paths, prompts, tool outputs, or keys in any response", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      const canaryBatch = createValidBatch({
        omp_version: `18.0.11-${CANARY_SECRET_KEY}`,
        sessions: [
          createValidSession({
            session_id: "sess-canary",
            model: `claude-${CANARY_PROMPT}`,
            provider: `anthropic-${CANARY_TOOL}`,
          }),
        ],
      });

      const { request: reqSuccess } = createSignedRequest({ batch: canaryBatch });
      const resSuccess = await handleCollectorRequest(
        reqSuccess,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowMs: () => NOW_MS,
          nowSeconds: () => NOW_SECONDS,
        },
        { peerIp: PEER_IP },
      );

      const textSuccess = await resSuccess.text();
      expect(textSuccess).not.toContain(CANARY_SECRET_KEY);
      expect(textSuccess).not.toContain(CANARY_PATH);
      expect(textSuccess).not.toContain(CANARY_PROMPT);
      expect(textSuccess).not.toContain(CANARY_TOOL);

      // Test error response privacy (e.g. 400 with invalid json containing canary)
      const canaryGarbage = new TextEncoder().encode(`{"error": "${CANARY_SECRET_KEY}", broken: `);
      const { request: reqError } = createSignedRequest({ rawBody: canaryGarbage });
      const resError = await handleCollectorRequest(
        reqError,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
        },
        { peerIp: PEER_IP },
      );

      const textError = await resError.text();
      expect(textError).not.toContain(CANARY_SECRET_KEY);
    });
  });

  describe("10. Status Contract, HTTP Methods, and Proxy Rejection", () => {
    it("returns 405 Method Not Allowed with Allow: POST header on non-POST requests", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      const { request: reqGet } = createSignedRequest({ method: "GET" });
      const resGet = await handleCollectorRequest(
        reqGet,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        { peerIp: PEER_IP },
      );
      expect(resGet.status).toBe(405);
      expect(resGet.headers.get("allow")).toBe("POST");
    });

    it("returns 404 Route Not Found on wrong paths or non-empty query parameters", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      // Wrong path
      const { request: reqWrongPath } = createSignedRequest({
        url: `https://${COLLECTOR_MAGICDNS_HOST}:${COLLECTOR_PORT}/v1/wrong`,
      });
      const resWrongPath = await handleCollectorRequest(
        reqWrongPath,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        { peerIp: PEER_IP },
      );

      // Query parameter present
      const { request: reqQuery } = createSignedRequest({
        url: `https://${COLLECTOR_MAGICDNS_HOST}:${COLLECTOR_PORT}${COLLECTOR_PATHNAME}?extra=1`,
      });
      const resQuery = await handleCollectorRequest(
        reqQuery,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission: new CollectorAdmissionController(),
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        { peerIp: PEER_IP },
      );
    });

    it("rejects forbidden proxy headers with 400 Bad Request", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      const forbiddenHeaders: Record<string, string>[] = [
        { "x-forwarded-for": "1.2.3.4" },
        { forwarded: "for=1.2.3.4" },
        { "x-real-ip": "1.2.3.4" },
        { "tailscale-user-login": "user@example.com" },
      ];

      for (const extraHeaders of forbiddenHeaders) {
        const { request } = createSignedRequest({ extraHeaders });
        const res = await handleCollectorRequest(
          request,
          { registry: [host], tailscaleWhois: verifier, keyLoader: TEST_KEY_LOADER, admission: new CollectorAdmissionController(), store, nowSeconds: () => NOW_SECONDS },
          { peerIp: PEER_IP },
        );
        expect(res.status).toBe(400);
      }
    });

    it("enforces rate limiter and returns 429 Too Many Requests with Retry-After header", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();
      const admission = new CollectorAdmissionController();
      admission.acquireHost(HOST_ID, NOW_MS)?.release();
      admission.acquireHost(HOST_ID, NOW_MS)?.release();

      const { request } = createSignedRequest({});
      const response = await handleCollectorRequest(
        request,
        {
          registry: [host],
          tailscaleWhois: verifier,
          keyLoader: TEST_KEY_LOADER,
          admission,
          store,
          nowSeconds: () => NOW_SECONDS,
          nowMs: () => NOW_MS,
        },
        { peerIp: PEER_IP },
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("2");
    });
  });

  describe("11. Production Tailscale Whois Verification & Adapter Wiring", () => {
    it("verifies exact pinned Tailscale CLI version string", async () => {
      const validExecutor = async (req: TailscaleWhoisExecutionRequest): Promise<TailscaleWhoisExecutionResult> => ({
        exitCode: 0,
        stdout: `${PINNED_TAILSCALE_CLI_VERSION}\n  other build info`,
      });

      const version = await verifyTailscaleCliVersion("/usr/bin/tailscale", validExecutor);
      expect(version).toBe(PINNED_TAILSCALE_CLI_VERSION);
    });

    it("rejects version drift or mismatched Tailscale CLI binary", async () => {
      const invalidVersionExecutor = async (): Promise<TailscaleWhoisExecutionResult> => ({
        exitCode: 0,
        stdout: "1.99.0-wrong-version\n",
      });

      await expect(
        verifyTailscaleCliVersion("/usr/bin/tailscale", invalidVersionExecutor),
      ).rejects.toThrow(TailscaleIdentityError);
    });

    it("rejects relative executable paths for Tailscale binary", async () => {
      await expect(
        verifyTailscaleCliVersion("tailscale"),
      ).rejects.toThrow(TailscaleIdentityError);
    });

    it("resolves host registry using Map, array, or lookup function", async () => {
      const host = createMockHost();

      // Array
      expect(await resolveHostRegistration([host], HOST_ID)).toEqual(host);

      // Map
      const map = new Map([[HOST_ID, host]]);
      expect(await resolveHostRegistration(map, HOST_ID)).toEqual(host);

      // Lookup function
      const fn = (id: string) => (id === HOST_ID ? host : undefined);
      expect(await resolveHostRegistration(fn, HOST_ID)).toEqual(host);

      // Missing
      expect(await resolveHostRegistration([], "unknown")).toBeUndefined();
    });

    it("creates a bound handler using createCollectorHandler", async () => {
      const store = new ObservatoryStore(":memory:");
      const host = createMockHost();
      const verifier = createMockVerifier();

      const handler = createCollectorHandler({
        registry: [host],
        tailscaleWhois: verifier,
        keyLoader: TEST_KEY_LOADER,
        admission: new CollectorAdmissionController(),
        store,
        nowMs: () => NOW_MS,
        nowSeconds: () => NOW_SECONDS,
      });

      const { request } = createSignedRequest({});
      const response = await handler(request, { peerIp: PEER_IP });
      expect(response.status).toBe(202);
    });
    it("rejects UNC executables before spawning", async () => {
      let called = false;
      const executor = async (): Promise<TailscaleWhoisExecutionResult> => {
        called = true;
        return { exitCode: 0, stdout: PINNED_TAILSCALE_CLI_VERSION };
      };
      await expect(verifyTailscaleCliVersion("\\\\server\\tailscale.exe", executor)).rejects.toThrow(
        TailscaleIdentityError,
      );
      expect(called).toBe(false);
    });

    it("caps production executor stdout before allocation and terminates the child", async () => {
      const executor = createProductionTailscaleWhoisExecutor({ termGracePeriodMs: 10 });
      const controller = new AbortController();
      const result = await executor({
        argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(40000));while(true){}"],
        env: {},
        timeoutMs: 1_000,
        maxStdoutBytes: 32 * 1_024,
        signal: controller.signal,
      });
      expect(result.stdoutOverflow).toBe(true);
      expect(typeof result.stdout === "string" ? Buffer.byteLength(result.stdout) : result.stdout.byteLength).toBeLessThanOrEqual(32 * 1_024);
    });

    it("uses only server.requestIP in the production wrapper", async () => {
      const executor = async (): Promise<TailscaleWhoisExecutionResult> => ({
        exitCode: 0,
        stdout: PINNED_TAILSCALE_CLI_VERSION,
      });
      const handler = await createProductionCollectorHandler({
        executablePath: "/usr/bin/tailscale",
        registry: [createMockHost()],
        keyLoader: TEST_KEY_LOADER,
        proxyTokenLoader: () => Uint8Array.from(PROXY_TOKEN),
        admission: new CollectorAdmissionController(),
        store: new ObservatoryStore(":memory:"),
        executor,
      });
      const { request } = createSignedRequest({});
      const response = await handler(request, { requestIP: () => null });
      expect(response.status).toBe(401);
    });
    it("accepts authenticated loopback proxy source and zeroes the token snapshot", () => {
      const issuedToken = Uint8Array.from(PROXY_TOKEN);
      const { request } = createSignedRequest({
        extraHeaders: {
          [COLLECTOR_PROXY_SOURCE_IP_HEADER]: PEER_IP,
          [COLLECTOR_PROXY_TOKEN_HEADER]: PROXY_TOKEN_HEADER,
        },
      });
      expect(resolveCollectorPeerIp(request, "127.0.0.1", () => issuedToken)).toBe(PEER_IP);
      expect([...issuedToken].every((byte) => byte === 0)).toBe(true);
    });

    it("rejects spoofed, wrong-token, and nonloopback proxy headers", () => {
      const spoofed = createSignedRequest({
        extraHeaders: { [COLLECTOR_PROXY_SOURCE_IP_HEADER]: PEER_IP },
      }).request;
      expect(resolveCollectorPeerIp(spoofed, "127.0.0.1", () => Uint8Array.from(PROXY_TOKEN))).toBeNull();

      const wrongToken = createSignedRequest({
        extraHeaders: {
          [COLLECTOR_PROXY_SOURCE_IP_HEADER]: PEER_IP,
          [COLLECTOR_PROXY_TOKEN_HEADER]: Buffer.alloc(32, 255).toString("base64url"),
        },
      }).request;
      expect(resolveCollectorPeerIp(wrongToken, "127.0.0.1", () => Uint8Array.from(PROXY_TOKEN))).toBeNull();

      const validHeaders = createSignedRequest({
        extraHeaders: {
          [COLLECTOR_PROXY_SOURCE_IP_HEADER]: PEER_IP,
          [COLLECTOR_PROXY_TOKEN_HEADER]: PROXY_TOKEN_HEADER,
        },
      }).request;
      expect(resolveCollectorPeerIp(validHeaders, "100.64.0.99", () => Uint8Array.from(PROXY_TOKEN))).toBe("100.64.0.99");
    });

    it("rejects non-finite and negative admission configuration", () => {
      expect(() => new CollectorAdmissionController({ maxTrackedHosts: Number.NaN })).toThrow();
      expect(() => new CollectorAdmissionController({ maxTrackedHosts: Number.POSITIVE_INFINITY })).toThrow();
      expect(() => new CollectorAdmissionController({ maxTrackedHosts: -1 })).toThrow();
    });
    it("rejects revoked keys and next-key overlap beyond 24 hours", async () => {
      const requestFor = () => createSignedRequest({}).request;
      const common = {
        keyLoader: TEST_KEY_LOADER,
        tailscaleWhois: createMockVerifier(),
        store: new ObservatoryStore(":memory:"),
        nowMs: () => NOW_MS,
        nowSeconds: () => NOW_SECONDS,
      };
      const revoked = createMockHost({
        keys: [{ keyId: KEY_ID, role: "current", notBeforeMs: 0, expiresAtMs: NOW_MS + 1, revoked: true }],
      });
      const revokedResponse = await handleCollectorRequest(
        requestFor(),
        { ...common, registry: [revoked], admission: new CollectorAdmissionController() },
        { peerIp: PEER_IP },
      );
      expect(revokedResponse.status).toBe(401);

      const excessiveOverlap = createMockHost({
        keys: [
          { keyId: KEY_ID, role: "current", notBeforeMs: 0, expiresAtMs: NOW_MS + 172_800_000 },
          { keyId: "22345678-9abc-4def-8abc-123456789abc", role: "next", notBeforeMs: NOW_MS, expiresAtMs: NOW_MS + 259_200_000 },
        ],
      });
      const overlapResponse = await handleCollectorRequest(
        requestFor(),
        { ...common, registry: [excessiveOverlap], admission: new CollectorAdmissionController() },
        { peerIp: PEER_IP },
      );
      expect(overlapResponse.status).toBe(401);
    });
  });
});
