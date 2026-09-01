import { describe, expect, it } from "bun:test";
import {
  BoundedJsonCategory,
  BoundedJsonError,
  BoundedJsonErrorCode,
  isBoundedJsonError,
  readBoundedJsonObject,
} from "./bounded-json";

function fail(message = "Expected promise to reject"): never {
  throw new Error(message);
}

function createMockRequest(options: {
  body?: string | Uint8Array | ReadableStream<Uint8Array> | null;
  contentType?: string | null;
  contentLength?: string | number | null;
  signal?: AbortSignal;
}): Request {
  const headers = new Headers();
  if (options.contentType !== null) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  if (options.contentLength !== undefined && options.contentLength !== null) {
    headers.set("content-length", String(options.contentLength));
  }

  let bodyStream: ReadableStream<Uint8Array> | null = null;
  if (options.body instanceof ReadableStream) {
    bodyStream = options.body;
  } else if (typeof options.body === "string") {
    const encoded = new TextEncoder().encode(options.body);
    bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
  } else if (options.body instanceof Uint8Array) {
    const data = options.body;
    bodyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });
  }

  return new Request("https://example.com/api/json", {
    method: "POST",
    headers,
    body: bodyStream,
    signal: options.signal,
    // @ts-expect-error duplex required in Node/Bun when body is a stream
    duplex: "half",
  });
}

function createChunkedStream(
  chunks: (string | Uint8Array)[],
  options: {
    onPull?: (index: number) => void;
    onCancel?: (reason: unknown) => void;
  } = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (options.onPull) {
        options.onPull(index);
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index++];
      const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
      controller.enqueue(bytes);
    },
    cancel(reason) {
      if (options.onCancel) {
        options.onCancel(reason);
      }
    },
  });
}

describe("Bounded JSON Reader", () => {
  describe("Early Content-Length Rejection", () => {
    it("rejects immediately when Content-Length exceeds maxBytes without reading body", async () => {
      let cancelCalled = false;
      const stream = createChunkedStream(['{"ok":true}'], {
        onCancel: () => {
          cancelCalled = true;
        },
      });

      const request = createMockRequest({
        body: stream,
        contentLength: 10_000,
      });

      try {
        await readBoundedJsonObject(request, { maxBytes: 100 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PAYLOAD_TOO_LARGE);
        expect(err.category).toBe(BoundedJsonCategory.PAYLOAD_TOO_LARGE);
        expect(err.status).toBe(413);
        // Stream should not even have been locked/read
        expect(stream.locked).toBe(false);
        expect(cancelCalled).toBe(false);
      }
    });

    it("rejects non-numeric or negative Content-Length header", async () => {
      const requestInvalid = createMockRequest({
        body: '{"ok":true}',
        contentLength: "invalid-len",
      });

      try {
        await readBoundedJsonObject(requestInvalid);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PARSE_ERROR);
        expect(err.status).toBe(400);
      }

      const requestNegative = createMockRequest({
        body: '{"ok":true}',
        contentLength: -50,
      });

      try {
        await readBoundedJsonObject(requestNegative);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PARSE_ERROR);
        expect(err.status).toBe(400);
      }
    });
  });

  describe("Chunk Overflow Enforcement", () => {
    it("rejects when chunked stream without Content-Length exceeds maxBytes", async () => {
      let cancelled = false;
      const stream = createChunkedStream(
        ['{"a": "', "1234567890", "1234567890", "1234567890", '"}'],
        {
          onCancel: () => {
            cancelled = true;
          },
        }
      );

      const request = createMockRequest({
        body: stream,
        contentLength: null,
      });

      try {
        await readBoundedJsonObject(request, { maxBytes: 20 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PAYLOAD_TOO_LARGE);
        expect(err.category).toBe(BoundedJsonCategory.PAYLOAD_TOO_LARGE);
        expect(err.status).toBe(413);
        expect(cancelled).toBe(true);
      }
    });

    it("rejects when Content-Length header is smaller than actual stream bytes (lying header)", async () => {
      let cancelled = false;
      const stream = createChunkedStream(
        ['{"msg":"', "abcdefghijklmnopqrstuvwxyz", '"}'],
        {
          onCancel: () => {
            cancelled = true;
          },
        }
      );

      const request = createMockRequest({
        body: stream,
        contentLength: 10,
      });

      try {
        await readBoundedJsonObject(request, { maxBytes: 20 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PAYLOAD_TOO_LARGE);
        expect(err.status).toBe(413);
        expect(cancelled).toBe(true);
      }
    });
  });

  describe("Multibyte Byte Accounting", () => {
    it("counts exact raw UTF-8 bytes rather than string character count", async () => {
      // 🚀 is 4 bytes in UTF-8: F0 9F 9A 80.
      // String length of '{"x":"🚀"}' is 9 characters (x: 1, ": 2, {: 1, }: 1, 🚀: 2 code units).
      // Exact byte count: 1 + 1 + 1 + 1 + 1 + 1 + 4 + 1 + 1 = 12 bytes.
      const payload = '{"x":"🚀"}';
      const byteLength = new TextEncoder().encode(payload).byteLength;
      expect(byteLength).toBe(12);

      // maxBytes 11 is too small for 12 bytes, even though char length might seem close
      const request = createMockRequest({ body: payload });
      try {
        await readBoundedJsonObject(request, { maxBytes: 11 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PAYLOAD_TOO_LARGE);
        expect(err.status).toBe(413);
      }

      // maxBytes 12 exactly fits 12 bytes
      const requestExact = createMockRequest({ body: payload });
      const result = await readBoundedJsonObject(requestExact, { maxBytes: 12 });
      expect(result).toEqual({ x: "🚀" });
    });

    it("rejects invalid UTF-8 byte sequences", async () => {
      // 0xFF and 0xFE are invalid UTF-8 byte sequences
      const rawInvalidUtf8 = new Uint8Array([123, 34, 97, 34, 58, 34, 0xff, 0xfe, 34, 125]);
      const request = createMockRequest({ body: rawInvalidUtf8 });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PARSE_ERROR);
        expect(err.category).toBe(BoundedJsonCategory.PARSE_ERROR);
        expect(err.status).toBe(400);
      }
    });
  });

  describe("Slow Timeout & Abort Handling", () => {
    it("rejects with TIMEOUT and cancels stream when stream stalls longer than timeoutMs", async () => {
      let cancelled = false;
      const { promise: stallPromise } = Promise.withResolvers<void>();

      // Stream deliberately stalls on the second chunk to test timeout deadline
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(new TextEncoder().encode('{"first":1,'));
          await stallPromise;
        },
        cancel() {
          cancelled = true;
        },
      });

      const request = createMockRequest({ body: stream });
      try {
        // 20ms timeout against real platform timer
        await readBoundedJsonObject(request, { timeoutMs: 20 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.TIMEOUT);
        expect(err.category).toBe(BoundedJsonCategory.TIMEOUT);
        expect(err.status).toBe(408);
        expect(cancelled).toBe(true);
      }
    });

    it("rejects immediately when request.signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const request = createMockRequest({
        body: '{"ok":true}',
        signal: controller.signal,
      });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.ABORTED);
        expect(err.category).toBe(BoundedJsonCategory.ABORTED);
        expect(err.status).toBe(499);
      }
    });

    it("rejects immediately when options.signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const request = createMockRequest({
        body: '{"ok":true}',
      });

      try {
        await readBoundedJsonObject(request, { signal: controller.signal });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.ABORTED);
        expect(err.status).toBe(499);
      }
    });

    it("rejects with ABORTED and cancels stream when aborted mid-flight", async () => {
      let cancelled = false;
      const controller = new AbortController();

      const stream = createChunkedStream(['{"start":1,', '"more":2}'], {
        onPull(index) {
          if (index === 1) {
            controller.abort();
          }
        },
        onCancel: () => {
          cancelled = true;
        },
      });

      const request = createMockRequest({
        body: stream,
        signal: controller.signal,
      });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.ABORTED);
        expect(err.status).toBe(499);
        expect(cancelled).toBe(true);
      }
    });
  });

  describe("Content-Type Validation", () => {
    it("rejects request without Content-Type header", async () => {
      const request = createMockRequest({
        body: '{"ok":true}',
        contentType: null,
      });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.INVALID_CONTENT_TYPE);
        expect(err.category).toBe(BoundedJsonCategory.INVALID_CONTENT_TYPE);
        expect(err.status).toBe(415);
      }
    });

    it("rejects non-JSON Content-Type", async () => {
      const requestHtml = createMockRequest({
        body: '{"ok":true}',
        contentType: "text/html",
      });

      try {
        await readBoundedJsonObject(requestHtml);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.INVALID_CONTENT_TYPE);
        expect(err.status).toBe(415);
      }

      const requestXml = createMockRequest({
        body: '{"ok":true}',
        contentType: "application/xml",
      });

      try {
        await readBoundedJsonObject(requestXml);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.INVALID_CONTENT_TYPE);
        expect(err.status).toBe(415);
      }
    });

    it("accepts valid application/json and application/json; charset=utf-8", async () => {
      const request1 = createMockRequest({
        body: '{"hello":"world"}',
        contentType: "application/json",
      });
      const res1 = await readBoundedJsonObject(request1);
      expect(res1).toEqual({ hello: "world" });

      const request2 = createMockRequest({
        body: '{"hello":"world"}',
        contentType: "application/json; charset=utf-8",
      });
      const res2 = await readBoundedJsonObject(request2);
      expect(res2).toEqual({ hello: "world" });

      const request3 = createMockRequest({
        body: '{"hello":"world"}',
        contentType: 'APPLICATION/JSON; CHARSET="UTF-8"',
      });
      const res3 = await readBoundedJsonObject(request3);
      expect(res3).toEqual({ hello: "world" });
    });

    it("rejects unsupported charsets", async () => {
      const request = createMockRequest({
        body: '{"hello":"world"}',
        contentType: "application/json; charset=iso-8859-1",
      });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.INVALID_CONTENT_TYPE);
        expect(err.status).toBe(415);
      }
    });
  });

  describe("Malformed and Non-Object JSON", () => {
    it("rejects empty body", async () => {
      const request = createMockRequest({
        body: "",
      });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PARSE_ERROR);
        expect(err.category).toBe(BoundedJsonCategory.PARSE_ERROR);
        expect(err.status).toBe(400);
      }
    });

    it("rejects malformed JSON syntax", async () => {
      const request = createMockRequest({
        body: '{"invalid": json syntax ...',
      });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PARSE_ERROR);
        expect(err.status).toBe(400);
      }
    });

    it("rejects top-level arrays", async () => {
      const request = createMockRequest({
        body: "[1, 2, 3]",
      });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.STRUCTURE_ERROR);
        expect(err.category).toBe(BoundedJsonCategory.STRUCTURE_ERROR);
        expect(err.status).toBe(400);
      }
    });

    it("rejects top-level primitives and null", async () => {
      const primitives = ['"just a string"', "12345", "true", "false", "null"];

      for (const prim of primitives) {
        const request = createMockRequest({ body: prim });
        try {
          await readBoundedJsonObject(request);
          fail();
        } catch (error) {
          expect(isBoundedJsonError(error)).toBe(true);
          const err = error as BoundedJsonError;
          expect(err.code).toBe(BoundedJsonErrorCode.STRUCTURE_ERROR);
          expect(err.status).toBe(400);
        }
      }
    });
  });

  describe("Structure Caps (Depth, Keys, Strings, Arrays)", () => {
    it("enforces maxDepth limit on nested objects and arrays", async () => {
      // depth 1: root {}, depth 2: level1 {}, depth 3: level2 {}, depth 4: level3 {}
      const nested4 = JSON.stringify({
        level1: {
          level2: {
            level3: {
              value: 123,
            },
          },
        },
      });

      // maxDepth: 3 should reject depth 4
      const requestReject = createMockRequest({ body: nested4 });
      try {
        await readBoundedJsonObject(requestReject, { maxDepth: 3 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.STRUCTURE_ERROR);
        expect(err.status).toBe(400);
      }

      // maxDepth: 4 should allow depth 4
      const requestAllow = createMockRequest({ body: nested4 });
      const res = await readBoundedJsonObject(requestAllow, { maxDepth: 4 });
      expect(res).toEqual({
        level1: {
          level2: {
            level3: {
              value: 123,
            },
          },
        },
      });
    });

    it("enforces maxKeys limit per object", async () => {
      const obj = { k1: 1, k2: 2, k3: 3, k4: 4, k5: 5 };
      const requestReject = createMockRequest({ body: JSON.stringify(obj) });

      try {
        await readBoundedJsonObject(requestReject, { maxKeys: 4 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.STRUCTURE_ERROR);
        expect(err.status).toBe(400);
      }

      const requestAllow = createMockRequest({ body: JSON.stringify(obj) });
      const res = await readBoundedJsonObject(requestAllow, { maxKeys: 5 });
      expect(res).toEqual(obj);
    });

    it("enforces maxTotalKeys limit across document", async () => {
      const multiObject = {
        a: { k1: 1, k2: 2 },
        b: { k3: 3, k4: 4 },
      };
      // total keys = 2 (a, b) + 2 (k1, k2) + 2 (k3, k4) = 6 keys
      const requestReject = createMockRequest({ body: JSON.stringify(multiObject) });

      try {
        await readBoundedJsonObject(requestReject, { maxTotalKeys: 5 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.STRUCTURE_ERROR);
        expect(err.status).toBe(400);
      }
    });

    it("enforces maxStringLength limit on values and keys", async () => {
      const longValueObj = { title: "a".repeat(100) };
      const reqVal = createMockRequest({ body: JSON.stringify(longValueObj) });

      try {
        await readBoundedJsonObject(reqVal, { maxStringLength: 50 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.STRUCTURE_ERROR);
        expect(err.status).toBe(400);
      }

      const longKeyObj = { ["k".repeat(60)]: "short" };
      const reqKey = createMockRequest({ body: JSON.stringify(longKeyObj) });

      try {
        await readBoundedJsonObject(reqKey, { maxStringLength: 50 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.STRUCTURE_ERROR);
        expect(err.status).toBe(400);
      }
    });

    it("enforces maxArrayLength limit on array values", async () => {
      const arrayObj = { items: [1, 2, 3, 4, 5] };
      const requestReject = createMockRequest({ body: JSON.stringify(arrayObj) });

      try {
        await readBoundedJsonObject(requestReject, { maxArrayLength: 3 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.STRUCTURE_ERROR);
        expect(err.status).toBe(400);
      }

      const requestAllow = createMockRequest({ body: JSON.stringify(arrayObj) });
      const res = await readBoundedJsonObject(requestAllow, { maxArrayLength: 5 });
      expect(res).toEqual(arrayObj);
    });
  });

  describe("Prototype Pollution Prevention", () => {
    it("rejects payload containing top-level __proto__", async () => {
      const payload = '{"__proto__": {"admin": true}, "valid": 1}';
      const request = createMockRequest({ body: payload });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PROTOTYPE_POLLUTION);
        expect(err.category).toBe(BoundedJsonCategory.PROTOTYPE_POLLUTION);
        expect(err.status).toBe(400);
      }
    });

    it("rejects payload containing top-level constructor", async () => {
      const payload = '{"constructor": {"prototype": {"polluted": true}}}';
      const request = createMockRequest({ body: payload });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PROTOTYPE_POLLUTION);
        expect(err.status).toBe(400);
      }
    });

    it("rejects payload containing top-level prototype", async () => {
      const payload = '{"prototype": {"polluted": true}}';
      const request = createMockRequest({ body: payload });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PROTOTYPE_POLLUTION);
        expect(err.status).toBe(400);
      }
    });

    it("rejects payload containing nested prototype pollution keys", async () => {
      const nestedProto = '{"config": {"nested": {"__proto__": {"polluted": true}}}}';
      const req1 = createMockRequest({ body: nestedProto });

      try {
        await readBoundedJsonObject(req1);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PROTOTYPE_POLLUTION);
        expect(err.status).toBe(400);
      }

      const nestedConstructor = '{"list": [{"constructor": 123}]}';
      const req2 = createMockRequest({ body: nestedConstructor });

      try {
        await readBoundedJsonObject(req2);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PROTOTYPE_POLLUTION);
        expect(err.status).toBe(400);
      }
    });
  });

  describe("Valid Body Parsing", () => {
    it("successfully parses valid plain JSON object with nested structures", async () => {
      const validPayload = {
        name: "test-item",
        count: 42,
        active: true,
        tags: ["a", "b", "c"],
        metadata: {
          author: "admin",
          ratings: [5, 4, 5],
          extra: null,
        },
      };

      const request = createMockRequest({ body: JSON.stringify(validPayload) });
      const result = await readBoundedJsonObject<typeof validPayload>(request);

      expect(result).toEqual(validPayload);
      expect(result.name).toBe("test-item");
      expect(result.count).toBe(42);
      expect(result.metadata.ratings).toEqual([5, 4, 5]);
    });

    it("successfully parses empty JSON object {}", async () => {
      const request = createMockRequest({ body: "{}" });
      const result = await readBoundedJsonObject(request);
      expect(result).toEqual({});
    });
  });

  describe("No Content Leak in Errors", () => {
    const SECRET = "TOP_SECRET_CREDENTIAL_98765_ABCD";

    it("does not leak secret text in parse errors", async () => {
      const badPayload = `{"secret": "${SECRET}", "invalid_syntax": `;
      const request = createMockRequest({ body: badPayload });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.message.includes(SECRET)).toBe(false);
        expect(String(err).includes(SECRET)).toBe(false);
        expect(JSON.stringify(err).includes(SECRET)).toBe(false);
        if (err.stack) {
          expect(err.stack.includes(SECRET)).toBe(false);
        }
      }
    });

    it("does not leak secret text in size overflow errors", async () => {
      const largePayload = JSON.stringify({
        token: SECRET,
        padding: "x".repeat(500),
      });

      const request = createMockRequest({ body: largePayload });

      try {
        await readBoundedJsonObject(request, { maxBytes: 50 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.message.includes(SECRET)).toBe(false);
        expect(String(err).includes(SECRET)).toBe(false);
      }
    });

    it("does not leak secret text in prototype pollution errors", async () => {
      const pollutionPayload = `{"__proto__": {"secret": "${SECRET}"}, "data": "${SECRET}"}`;

      const request = createMockRequest({ body: pollutionPayload });

      try {
        await readBoundedJsonObject(request);
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.code).toBe(BoundedJsonErrorCode.PROTOTYPE_POLLUTION);
        expect(err.message.includes(SECRET)).toBe(false);
        expect(String(err).includes(SECRET)).toBe(false);
      }
    });

    it("does not leak secret text in structure cap errors", async () => {
      const longStringPayload = JSON.stringify({
        secretKey: `${SECRET}_` + "x".repeat(200),
      });

      const request = createMockRequest({ body: longStringPayload });

      try {
        await readBoundedJsonObject(request, { maxStringLength: 20 });
        fail();
      } catch (error) {
        expect(isBoundedJsonError(error)).toBe(true);
        const err = error as BoundedJsonError;
        expect(err.message.includes(SECRET)).toBe(false);
        expect(String(err).includes(SECRET)).toBe(false);
      }
    });
  });
});
