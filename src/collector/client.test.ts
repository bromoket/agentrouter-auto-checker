import { describe, expect, it } from "bun:test";
import {
  COLLECTOR_CONNECT_TIMEOUT_MS,
  COLLECTOR_TOTAL_TIMEOUT_MS,
  MAX_COLLECTOR_RESPONSE_BYTES,
  MAX_RETRY_AFTER_SECONDS,
  REGISTERED_COLLECTOR_ENDPOINT,
  CollectorClientError,
  type CollectorFetcher,
  type CollectorTimeoutHandle,
  type CollectorUploadOptions,
  type UploadCategory,
  type UploadDisposition,
  uploadQueuedBatch,
  validateCollectorEndpoint,
} from "./client";
import type { QueuedBatch } from "./queue";
import { hashBodySha256, signRequestV1 } from "./protocol";

const HOST_ID = "018f47d2-a3b4-4c5d-8e6f-0123456789ab";
const KEY_ID = "128f47d2-a3b4-4c5d-8e6f-0123456789ab";
const BATCH_ID = "228f47d2-a3b4-4c5d-8e6f-0123456789ab";
const ENDPOINT = REGISTERED_COLLECTOR_ENDPOINT;
const KEY = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));

function queuedBatch(body = `{"schema":"afo.collector.session-batch.v1","batch_id":"${BATCH_ID}"}`): QueuedBatch {
  const bodyBytes = new TextEncoder().encode(body);
  return {
    batchId: BATCH_ID,
    body,
    bodyBytes,
    contentLength: bodyBytes.byteLength,
    bodySha256: hashBodySha256(bodyBytes),
    enqueuedAtMs: 1_700_000_000_000,
  };
}

function options(overrides: Partial<CollectorUploadOptions> = {}): CollectorUploadOptions {
  return {
    endpointUrl: ENDPOINT,
    hostId: HOST_ID,
    keyId: KEY_ID,
    loadKey: () => KEY,
    nowSeconds: () => 1_700_000_000,
    ...overrides,
  };
}

function jsonResponse(status: number, value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function acceptedResponse(batchId = BATCH_ID): Response {
  return jsonResponse(202, { batch_id: batchId, accepted: 3, ignored_stale: 1 });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("collector client endpoint validation", () => {
  it("accepts only the canonical MagicDNS HTTPS collector URL", () => {
    expect(validateCollectorEndpoint(ENDPOINT)).toBe(ENDPOINT);

    const rejected = [
      "http://bkserver.tailbbaa91.ts.net:8457/v1/collector/session-batches",
      "https://100.127.29.78:8457/v1/collector/session-batches",
      "https://[fd7a:115c:a1e0::1]:8457/v1/collector/session-batches",
      "https://other.tailbbaa91.ts.net:8457/v1/collector/session-batches",
      "https://bkserver.tailbbaa91.ts.net/v1/collector/session-batches",
      "https://bkserver.tailbbaa91.ts.net:443/v1/collector/session-batches",
      "https://bkserver.tailbbaa91.ts.net:8457/v1/collector/session-batches/",
      "https://bkserver.tailbbaa91.ts.net:8457/v1/collector/session-batches?next=http://bad",
      "https://bkserver.tailbbaa91.ts.net:8457/v1/collector/session-batches#fragment",
      "https://user:pass@bkserver.tailbbaa91.ts.net:8457/v1/collector/session-batches",
      "HTTPS://BKSERVER.TAILBBAA91.TS.NET:8457/v1/collector/session-batches",
    ];

    for (const endpoint of rejected) {
      expect(() => validateCollectorEndpoint(endpoint)).toThrow(CollectorClientError);
      try {
        validateCollectorEndpoint(endpoint);
      } catch (error) {
        expect((error as Error).message).toBe("invalid_endpoint");
        expect((error as Error).message).not.toContain(endpoint);
      }
    }
  });
});

describe("collector client request", () => {
  it("sends exact signed headers and the immutable queued bytes once", async () => {
    const batch = queuedBatch();
    let called = 0;
    const fetcher: CollectorFetcher = async (url, init) => {
      called++;
      expect(url).toBe(ENDPOINT);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      expect(Array.from(new Uint8Array(init.body as ArrayBuffer))).toEqual(Array.from(batch.bodyBytes));
      expect(init.body).toBeInstanceOf(ArrayBuffer);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.tls?.rejectUnauthorized).toBe(true);
      expect(init.verbose).toBe(false);

      const headers = init.headers as Headers;
      expect([...headers.keys()].sort()).toEqual(
        [
          "authorization",
          "content-length",
          "content-type",
          "x-afo-batch-id",
          "x-afo-content-sha256",
          "x-afo-host-id",
          "x-afo-key-id",
          "x-afo-signed-at",
        ].sort()
      );
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("content-length")).toBe(String(batch.bodyBytes.byteLength));
      expect(headers.get("x-afo-host-id")).toBe(HOST_ID);
      expect(headers.get("x-afo-key-id")).toBe(KEY_ID);
      expect(headers.get("x-afo-signed-at")).toBe("1700000000");
      expect(headers.get("x-afo-batch-id")).toBe(BATCH_ID);
      expect(headers.get("x-afo-content-sha256")).toBe(batch.bodySha256);
      expect(headers.get("authorization")).toBe(
        `AFO-HMAC-SHA256 Signature=${signRequestV1(KEY, {
          hostId: HOST_ID,
          keyId: KEY_ID,
          signedAt: 1_700_000_000,
          batchId: BATCH_ID,
          contentLength: batch.contentLength,
          contentSha256: batch.bodySha256,
        })}`
      );
      return acceptedResponse();
    };

    await expect(uploadQueuedBatch(options({ fetcher }), batch)).resolves.toEqual({
      disposition: "accepted",
      category: "accepted",
      status: 202,
      accepted: 3,
      ignoredStale: 1,
    });
    expect(called).toBe(1);
  });

  it("keeps body and batch ID identical while refreshing timestamp and signature", async () => {
    const batch = queuedBatch();
    const originalBody = batch.bodyBytes.slice();
    const seen: Array<{ body: BodyInit | null | undefined; batchId: string | null; at: string | null; signature: string | null }> = [];
    let now = 1_700_000_000;
    const fetcher: CollectorFetcher = async (_url, init) => {
      const headers = init.headers as Headers;
      seen.push({
        body: init.body,
        batchId: headers.get("x-afo-batch-id"),
        at: headers.get("x-afo-signed-at"),
        signature: headers.get("authorization"),
      });
      return new Response("", { status: 503 });
    };
    const uploadOptions = options({ fetcher, nowSeconds: () => now });

    await uploadQueuedBatch(uploadOptions, batch);
    now++;
    await uploadQueuedBatch(uploadOptions, batch);

    expect(seen).toHaveLength(2);
    expect(Array.from(new Uint8Array(seen[0]!.body as ArrayBuffer))).toEqual(Array.from(batch.bodyBytes));
    expect(Array.from(new Uint8Array(seen[1]!.body as ArrayBuffer))).toEqual(Array.from(batch.bodyBytes));
    expect(seen[0]!.body).toBeInstanceOf(ArrayBuffer);
    expect(seen[1]!.body).toBeInstanceOf(ArrayBuffer);
    expect(seen.map((item) => item.batchId)).toEqual([BATCH_ID, BATCH_ID]);
    expect(seen.map((item) => item.at)).toEqual(["1700000000", "1700000001"]);
    expect(seen[0]!.signature).not.toBe(seen[1]!.signature);
    expect(batch.bodyBytes).toEqual(originalBody);
    expect(batch.bodySha256).toBe(hashBodySha256(originalBody));
  });

  it("snapshots identity, metadata, and exact bytes before awaiting the key", async () => {
    const keyLoad = deferred<Uint8Array>();
    const batch = queuedBatch();
    const expectedBody = batch.bodyBytes.slice();
    const expectedHash = batch.bodySha256;
    let loadedIdentity: { hostId: string; keyId: string } | undefined;
    let captured: BunFetchRequestInit | undefined;
    const uploadOptions = options({
      loadKey: (identity) => {
        loadedIdentity = identity;
        return keyLoad.promise;
      },
      fetcher: async (_url, init) => {
        captured = init;
        return acceptedResponse();
      },
    });

    const resultPromise = uploadQueuedBatch(uploadOptions, batch);
    uploadOptions.hostId = "328f47d2-a3b4-4c5d-8e6f-0123456789ab";
    uploadOptions.keyId = "428f47d2-a3b4-4c5d-8e6f-0123456789ab";
    batch.bodyBytes.fill(0);
    keyLoad.resolve(KEY);

    await expect(resultPromise).resolves.toMatchObject({ disposition: "accepted" });
    expect(loadedIdentity).toEqual({ hostId: HOST_ID, keyId: KEY_ID });
    expect(new Uint8Array(captured?.body as ArrayBuffer)).toEqual(expectedBody);
    expect((captured?.headers as Headers).get("x-afo-host-id")).toBe(HOST_ID);
    expect((captured?.headers as Headers).get("x-afo-key-id")).toBe(KEY_ID);
    expect((captured?.headers as Headers).get("x-afo-content-sha256")).toBe(expectedHash);
  });

  it("fails closed before key loading when Bun TLS validation is disabled", async () => {
    const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    let keyLoaded = false;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      await expect(
        uploadQueuedBatch(options({ loadKey: () => {
          keyLoaded = true;
          return KEY;
        } }), queuedBatch())
      ).rejects.toMatchObject({ code: "unsafe_runtime", message: "unsafe_runtime" });
    } finally {
      if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
    }
    expect(keyLoaded).toBe(false);
  });

  it("rejects case-insensitive proxy environments before key load or fetch", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return acceptedResponse();
    }) as unknown as typeof fetch;

    try {
      for (const name of ["HTTP_PROXY", "https_proxy", "AlL_PrOxY"]) {
        const previous = process.env[name];
        let keyLoaded = false;
        process.env[name] = "http://proxy.invalid";
        try {
          await expect(
            uploadQueuedBatch(options({
              loadKey: () => {
                keyLoaded = true;
                return KEY;
              },
            }), queuedBatch())
          ).rejects.toMatchObject({ code: "unsafe_runtime", message: "unsafe_runtime" });
        } finally {
          if (previous === undefined) delete process.env[name];
          else process.env[name] = previous;
        }
        expect(keyLoaded).toBe(false);
        expect(fetchCalled).toBe(false);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects a redirect without issuing a second request", async () => {
    let called = 0;
    const fetcher: CollectorFetcher = async (_url, init) => {
      called++;
      expect(init.redirect).toBe("manual");
      return new Response("moved", {
        status: 307,
        headers: { location: "http://100.127.29.78/collector" },
      });
    };

    await expect(uploadQueuedBatch(options({ fetcher }), queuedBatch())).resolves.toEqual({
      disposition: "retry",
      category: "redirect_rejected",
      status: 307,
    });
    expect(called).toBe(1);
  });

  it("rejects queue metadata that no longer matches the immutable bytes", async () => {
    const batch = queuedBatch();
    batch.bodyBytes[0] = 0;
    let called = false;
    try {
      await uploadQueuedBatch(options({ fetcher: async () => {
        called = true;
        return acceptedResponse();
      } }), batch);
      throw new Error("expected invalid batch");
    } catch (error) {
      expect(error).toBeInstanceOf(CollectorClientError);
      expect((error as Error).message).toBe("invalid_batch");
    }
    expect(called).toBe(false);
  });
  it("rejects a decoded body batch_id that differs from queue metadata", async () => {
    const differentId = "528f47d2-a3b4-4c5d-8e6f-0123456789ab";
    const batch = queuedBatch(`{"batch_id":"${differentId}"}`);
    let called = false;
    await expect(
      uploadQueuedBatch(options({ fetcher: async () => {
        called = true;
        return acceptedResponse();
      } }), batch)
    ).rejects.toMatchObject({ code: "invalid_batch", message: "invalid_batch" });
    expect(called).toBe(false);
  });

});

describe("collector client deadlines", () => {
  it("uses a 5 second connect deadline inside the 15 second total deadline", async () => {
    const callbacks = new Map<number, () => void>();
    const delays: number[] = [];
    let nextHandle = 1;
    const scheduleTimeout = (callback: () => void, delayMs: number): CollectorTimeoutHandle => {
      delays.push(delayMs);
      callbacks.set(delayMs, callback);
      return nextHandle++;
    };
    const pending = deferred<Response>();
    const resultPromise = uploadQueuedBatch(
      options({
        fetcher: () => pending.promise,
        scheduleTimeout,
        clearTimeout: () => {},
      }),
      queuedBatch()
    );
    await settle();

    expect(delays).toEqual([COLLECTOR_TOTAL_TIMEOUT_MS, COLLECTOR_CONNECT_TIMEOUT_MS]);
    callbacks.get(COLLECTOR_CONNECT_TIMEOUT_MS)!();
    await expect(resultPromise).resolves.toEqual({
      disposition: "retry",
      category: "connect_timeout",
    });
  });

  it("keeps the total deadline active while reading a response", async () => {
    const callbacks = new Map<number, () => void>();
    const scheduleTimeout = (callback: () => void, delayMs: number): CollectorTimeoutHandle => {
      callbacks.set(delayMs, callback);
      return delayMs;
    };
    const stalledBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => {}),
    });
    const resultPromise = uploadQueuedBatch(
      options({
        fetcher: async () => new Response(stalledBody, { status: 202 }),
        scheduleTimeout,
        clearTimeout: () => {},
      }),
      queuedBatch()
    );
    await settle();

    callbacks.get(COLLECTOR_TOTAL_TIMEOUT_MS)!();
    await expect(resultPromise).resolves.toEqual({
      disposition: "retry",
      category: "total_timeout",
    });
  });
  it("aborts a pending key load at the total deadline without fetching", async () => {
    const callbacks = new Map<number, () => void>();
    const scheduleTimeout = (callback: () => void, delayMs: number): CollectorTimeoutHandle => {
      callbacks.set(delayMs, callback);
      return delayMs;
    };
    let keySignal: AbortSignal | undefined;
    let fetchCalled = false;
    const resultPromise = uploadQueuedBatch(
      options({
        loadKey: (_identity, signal) => {
          keySignal = signal;
          return new Promise<Uint8Array>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("categorical")), { once: true });
          });
        },
        fetcher: async () => {
          fetchCalled = true;
          return acceptedResponse();
        },
        scheduleTimeout,
        clearTimeout: () => {},
      }),
      queuedBatch()
    );
    await settle();

    callbacks.get(COLLECTOR_TOTAL_TIMEOUT_MS)!();
    await expect(resultPromise).resolves.toEqual({
      disposition: "retry",
      category: "total_timeout",
    });
    expect(keySignal?.aborted).toBe(true);
    expect(fetchCalled).toBe(false);
  });

});

describe("collector response classification and bounds", () => {
  const categories: Array<{
    status: number;
    disposition: UploadDisposition;
    category: UploadCategory;
  }> = [
    { status: 401, disposition: "auth", category: "auth_failed" },
    { status: 400, disposition: "poison", category: "bad_request" },
    { status: 413, disposition: "poison", category: "payload_too_large" },
    { status: 422, disposition: "poison", category: "schema_rejected" },
    { status: 409, disposition: "conflict-halt", category: "batch_conflict" },
    { status: 429, disposition: "retry", category: "rate_limited" },
    { status: 500, disposition: "retry", category: "server_unavailable" },
    { status: 503, disposition: "retry", category: "server_unavailable" },
    { status: 418, disposition: "retry", category: "unexpected_status" },
  ];

  for (const entry of categories) {
    it(`classifies HTTP ${entry.status} as ${entry.disposition}/${entry.category}`, async () => {
      const result = await uploadQueuedBatch(
        options({ fetcher: async () => new Response("categorical only", { status: entry.status }) }),
        queuedBatch()
      );
      expect(result.disposition).toBe(entry.disposition);
      expect(result.category).toBe(entry.category);
      expect(result.status).toBe(entry.status);
    });
  }

  it("accepts only exact accepted and duplicate acknowledgements for the same batch", async () => {
    await expect(
      uploadQueuedBatch(options({ fetcher: async () => acceptedResponse() }), queuedBatch())
    ).resolves.toMatchObject({ disposition: "accepted", category: "accepted" });

    await expect(
      uploadQueuedBatch(
        options({ fetcher: async () => jsonResponse(200, { status: "duplicate", batch_id: BATCH_ID }) }),
        queuedBatch()
      )
    ).resolves.toEqual({ disposition: "duplicate", category: "duplicate", status: 200 });

    const malformed = [
      jsonResponse(202, { batch_id: BATCH_ID, accepted: 1, ignored_stale: 0, detail: "no" }),
      jsonResponse(202, { batch_id: HOST_ID, accepted: 1, ignored_stale: 0 }),
      jsonResponse(202, { batch_id: BATCH_ID, accepted: -1, ignored_stale: 0 }),
      jsonResponse(200, { status: "duplicate", batch_id: BATCH_ID, signature: "no" }),
      new Response("not json", { status: 202 }),
    ];
    for (const response of malformed) {
      await expect(
        uploadQueuedBatch(options({ fetcher: async () => response }), queuedBatch())
      ).resolves.toMatchObject({ disposition: "retry", category: "invalid_response" });
    }
  });

  it("caps response bodies using both declared and streamed lengths", async () => {
    const tooLarge = "x".repeat(MAX_COLLECTOR_RESPONSE_BYTES + 1);
    await expect(
      uploadQueuedBatch(
        options({
          fetcher: async () => new Response(tooLarge, {
            status: 202,
            headers: { "content-length": String(MAX_COLLECTOR_RESPONSE_BYTES + 1) },
          }),
        }),
        queuedBatch()
      )
    ).resolves.toEqual({
      disposition: "retry",
      category: "response_too_large",
      status: 202,
    });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_COLLECTOR_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    await expect(
      uploadQueuedBatch(
        options({ fetcher: async () => new Response(stream, { status: 202 }) }),
        queuedBatch()
      )
    ).resolves.toMatchObject({ disposition: "retry", category: "response_too_large" });
  });

  it("bounds Retry-After and never treats it as an alternate instruction", async () => {
    const result = await uploadQueuedBatch(
      options({
        fetcher: async () => new Response("", {
          status: 429,
          headers: { "retry-after": "999999", location: "http://bad" },
        }),
      }),
      queuedBatch()
    );
    expect(result).toEqual({
      disposition: "retry",
      category: "rate_limited",
      status: 429,
      retryAfterSeconds: MAX_RETRY_AFTER_SECONDS,
    });
  });
});

describe("collector client redaction", () => {
  it("does not expose key-loader, transport, body, signature, or response canaries", async () => {
    const secret = "KEY_CANARY_DO_NOT_LEAK";
    const body = `{"batch_id":"${BATCH_ID}","private":"BODY_CANARY_DO_NOT_LEAK"}`;
    const loaderFailure = await uploadQueuedBatch(
      options({
        loadKey: () => { throw new Error(`${secret}:loader-path`); },
        fetcher: async () => acceptedResponse(),
      }),
      queuedBatch(body)
    );
    expect(JSON.stringify(loaderFailure)).toBe('{"disposition":"retry","category":"key_unavailable"}');

    const transportFailure = await uploadQueuedBatch(
      options({ fetcher: async (_url, init) => {
        const signature = (init.headers as Headers).get("authorization");
        throw new Error(`${secret}:${body}:${signature}:C:\\private\\path`);
      } }),
      queuedBatch(body)
    );
    const transportSerialized = JSON.stringify(transportFailure);
    expect(transportSerialized).toBe('{"disposition":"retry","category":"transport_failed"}');
    expect(transportSerialized).not.toContain(secret);
    expect(transportSerialized).not.toContain("BODY_CANARY");
    expect(transportSerialized).not.toContain("AFO-HMAC");
    expect(transportSerialized).not.toContain("private");

    const responseFailure = await uploadQueuedBatch(
      options({ fetcher: async () => new Response(`${secret}:${body}:HEADER_CANARY`, { status: 401 }) }),
      queuedBatch(body)
    );
    expect(JSON.stringify(responseFailure)).toBe(
      '{"disposition":"auth","category":"auth_failed","status":401}'
    );
  });
});
