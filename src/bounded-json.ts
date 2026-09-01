/**
 * Bounded JSON Request Reader
 *
 * Provides streaming, size-bounded, time-bounded, and structure-bounded
 * parsing of JSON HTTP request bodies with prototype pollution protection.
 */

export const BoundedJsonErrorCode = {
  INVALID_CONTENT_TYPE: "INVALID_CONTENT_TYPE",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  TIMEOUT: "TIMEOUT",
  ABORTED: "ABORTED",
  PARSE_ERROR: "PARSE_ERROR",
  STRUCTURE_ERROR: "STRUCTURE_ERROR",
  PROTOTYPE_POLLUTION: "PROTOTYPE_POLLUTION",
  STREAM_ERROR: "STREAM_ERROR",
} as const;

export type BoundedJsonErrorCode =
  (typeof BoundedJsonErrorCode)[keyof typeof BoundedJsonErrorCode];

export const BoundedJsonCategory = {
  INVALID_CONTENT_TYPE: "invalid_content_type",
  PAYLOAD_TOO_LARGE: "payload_too_large",
  TIMEOUT: "timeout",
  ABORTED: "aborted",
  PARSE_ERROR: "parse_error",
  STRUCTURE_ERROR: "structure_error",
  PROTOTYPE_POLLUTION: "prototype_pollution",
  STREAM_ERROR: "stream_error",
} as const;

export type BoundedJsonCategory =
  (typeof BoundedJsonCategory)[keyof typeof BoundedJsonCategory];

export class BoundedJsonError extends Error {
  readonly code: BoundedJsonErrorCode;
  readonly category: BoundedJsonCategory;
  readonly status: number;

  constructor(
    message: string,
    code: BoundedJsonErrorCode,
    category: BoundedJsonCategory,
    status: number
  ) {
    super(message);
    this.name = "BoundedJsonError";
    this.code = code;
    this.category = category;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isBoundedJsonError(error: unknown): error is BoundedJsonError {
  return error instanceof BoundedJsonError;
}

export interface BoundedJsonOptions {
  /** Maximum body size in bytes (default: 65_536 = 64 KiB). */
  maxBytes?: number;
  /** Maximum time allowed for reading and parsing the body in milliseconds (default: 10_000). */
  timeoutMs?: number;
  /** Maximum container nesting depth for objects and arrays (default: 10). */
  maxDepth?: number;
  /** Maximum number of keys allowed in any single object (default: 256). */
  maxKeys?: number;
  /** Maximum total number of keys across the entire document (default: 1024). */
  maxTotalKeys?: number;
  /** Maximum character length of any string value or key (default: 8192). */
  maxStringLength?: number;
  /** Maximum number of elements in any array (default: 256). */
  maxArrayLength?: number;
  /** Optional external AbortSignal to cancel reading. */
  signal?: AbortSignal;
}

export const DEFAULT_BOUNDED_JSON_OPTIONS: Required<
  Omit<BoundedJsonOptions, "signal">
> = {
  maxBytes: 64 * 1024,
  timeoutMs: 10_000,
  maxDepth: 10,
  maxKeys: 256,
  maxTotalKeys: 1024,
  maxStringLength: 8192,
  maxArrayLength: 256,
};

function validateContentType(headers: Headers): void {
  const contentType = headers.get("content-type");
  if (!contentType) {
    throw new BoundedJsonError(
      "Content-Type header must be application/json.",
      BoundedJsonErrorCode.INVALID_CONTENT_TYPE,
      BoundedJsonCategory.INVALID_CONTENT_TYPE,
      415
    );
  }

  const parts = contentType.split(";");
  const mediaType = parts[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new BoundedJsonError(
      "Content-Type header must be application/json.",
      BoundedJsonErrorCode.INVALID_CONTENT_TYPE,
      BoundedJsonCategory.INVALID_CONTENT_TYPE,
      415
    );
  }

  for (let i = 1; i < parts.length; i++) {
    const param = parts[i]?.trim();
    if (!param) continue;
    const eqIdx = param.indexOf("=");
    if (eqIdx === -1) continue;
    const key = param.slice(0, eqIdx).trim().toLowerCase();
    const rawVal = param.slice(eqIdx + 1).trim();
    const val = rawVal.replace(/^["']|["']$/g, "").toLowerCase();
    if (key === "charset" && val !== "utf-8" && val !== "utf8") {
      throw new BoundedJsonError(
        "Unsupported charset in Content-Type header; only UTF-8 is supported.",
        BoundedJsonErrorCode.INVALID_CONTENT_TYPE,
        BoundedJsonCategory.INVALID_CONTENT_TYPE,
        415
      );
    }
  }
}

function validateContentLength(headers: Headers, maxBytes: number): void {
  const contentLength = headers.get("content-length");
  if (contentLength === null) {
    return;
  }
  const trimmed = contentLength.trim();
  if (trimmed === "") {
    return;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new BoundedJsonError(
      "Invalid Content-Length header.",
      BoundedJsonErrorCode.PARSE_ERROR,
      BoundedJsonCategory.PARSE_ERROR,
      400
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BoundedJsonError(
      "Invalid Content-Length header.",
      BoundedJsonErrorCode.PARSE_ERROR,
      BoundedJsonCategory.PARSE_ERROR,
      400
    );
  }
  if (parsed > maxBytes) {
    throw new BoundedJsonError(
      "Request Content-Length exceeded maximum byte limit.",
      BoundedJsonErrorCode.PAYLOAD_TOO_LARGE,
      BoundedJsonCategory.PAYLOAD_TOO_LARGE,
      413
    );
  }
}

async function collectStreamBytes(
  request: Request,
  maxBytes: number,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Uint8Array> {
  if (request.signal?.aborted || externalSignal?.aborted) {
    throw new BoundedJsonError(
      "Request was aborted.",
      BoundedJsonErrorCode.ABORTED,
      BoundedJsonCategory.ABORTED,
      499
    );
  }

  const body = request.body;
  if (!body) {
    throw new BoundedJsonError(
      "Request body is empty.",
      BoundedJsonErrorCode.PARSE_ERROR,
      BoundedJsonCategory.PARSE_ERROR,
      400
    );
  }

  if (body.locked) {
    throw new BoundedJsonError(
      "Request body stream is already locked or consumed.",
      BoundedJsonErrorCode.STREAM_ERROR,
      BoundedJsonCategory.STREAM_ERROR,
      400
    );
  }

  const reader = body.getReader();
  let isCancelled = false;

  const cancelStream = async (reason?: unknown) => {
    if (isCancelled) return;
    isCancelled = true;
    try {
      await reader.cancel(reason);
    } catch {
      // Ignore cancellation failures
    }
  };

  let timeoutId: Timer | number | undefined;
  let onAbort: (() => void) | undefined;

  const { promise: abortPromise, reject: rejectAbort } =
    Promise.withResolvers<never>();
  onAbort = () => {
    rejectAbort(
      new BoundedJsonError(
        "Request was aborted.",
        BoundedJsonErrorCode.ABORTED,
        BoundedJsonCategory.ABORTED,
        499
      )
    );
  };

  const { promise: timeoutPromise, reject: rejectTimeout } =
    Promise.withResolvers<never>();
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timeoutId = setTimeout(() => {
      rejectTimeout(
        new BoundedJsonError(
          "Request timed out while reading body.",
          BoundedJsonErrorCode.TIMEOUT,
          BoundedJsonCategory.TIMEOUT,
          408
        )
      );
    }, timeoutMs);
  }

  if (request.signal && onAbort) {
    request.signal.addEventListener("abort", onAbort, { once: true });
  }
  if (externalSignal && onAbort) {
    externalSignal.addEventListener("abort", onAbort, { once: true });
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      if (request.signal?.aborted || externalSignal?.aborted) {
        throw new BoundedJsonError(
          "Request was aborted.",
          BoundedJsonErrorCode.ABORTED,
          BoundedJsonCategory.ABORTED,
          499
        );
      }

      const result = await Promise.race([
        reader.read(),
        abortPromise,
        timeoutPromise,
      ]);

      if (result.done) {
        break;
      }

      const chunk = result.value;
      if (chunk && chunk.byteLength > 0) {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          await cancelStream("payload_too_large");
          throw new BoundedJsonError(
            "Request body exceeded maximum byte limit.",
            BoundedJsonErrorCode.PAYLOAD_TOO_LARGE,
            BoundedJsonCategory.PAYLOAD_TOO_LARGE,
            413
          );
        }
        chunks.push(chunk);
      }
    }
  } catch (error) {
    await cancelStream(error);
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    if (onAbort) {
      if (request.signal) {
        request.signal.removeEventListener("abort", onAbort);
      }
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onAbort);
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore releaseLock errors if stream was closed/cancelled
    }
  }

  if (totalBytes === 0) {
    throw new BoundedJsonError(
      "Request body is empty.",
      BoundedJsonErrorCode.PARSE_ERROR,
      BoundedJsonCategory.PARSE_ERROR,
      400
    );
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined;
}

interface StructureValidationLimits {
  maxDepth: number;
  maxKeys: number;
  maxTotalKeys: number;
  maxStringLength: number;
  maxArrayLength: number;
}

interface ValidationState {
  totalKeys: number;
}

function validateStructure(
  value: unknown,
  containerDepth: number,
  limits: StructureValidationLimits,
  state: ValidationState
): void {
  if (containerDepth > limits.maxDepth) {
    throw new BoundedJsonError(
      "JSON nesting depth exceeded maximum limit.",
      BoundedJsonErrorCode.STRUCTURE_ERROR,
      BoundedJsonCategory.STRUCTURE_ERROR,
      400
    );
  }

  if (typeof value === "string") {
    if (value.length > limits.maxStringLength) {
      throw new BoundedJsonError(
        "JSON string length exceeded maximum limit.",
        BoundedJsonErrorCode.STRUCTURE_ERROR,
        BoundedJsonCategory.STRUCTURE_ERROR,
        400
      );
    }
    return;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    if (value.length > limits.maxArrayLength) {
      throw new BoundedJsonError(
        "JSON array length exceeded maximum limit.",
        BoundedJsonErrorCode.STRUCTURE_ERROR,
        BoundedJsonCategory.STRUCTURE_ERROR,
        400
      );
    }
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      const nextDepth =
        item !== null && typeof item === "object"
          ? containerDepth + 1
          : containerDepth;
      validateStructure(item, nextDepth, limits, state);
    }
    return;
  }

  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new BoundedJsonError(
        "Invalid object prototype in JSON structure.",
        BoundedJsonErrorCode.STRUCTURE_ERROR,
        BoundedJsonCategory.STRUCTURE_ERROR,
        400
      );
    }

    const keys = Object.getOwnPropertyNames(value);
    if (keys.length > limits.maxKeys) {
      throw new BoundedJsonError(
        "JSON object key count exceeded maximum limit.",
        BoundedJsonErrorCode.STRUCTURE_ERROR,
        BoundedJsonCategory.STRUCTURE_ERROR,
        400
      );
    }

    for (const key of keys) {
      if (
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype"
      ) {
        throw new BoundedJsonError(
          "Forbidden prototype-pollution key detected.",
          BoundedJsonErrorCode.PROTOTYPE_POLLUTION,
          BoundedJsonCategory.PROTOTYPE_POLLUTION,
          400
        );
      }

      if (key.length > limits.maxStringLength) {
        throw new BoundedJsonError(
          "JSON object key length exceeded maximum limit.",
          BoundedJsonErrorCode.STRUCTURE_ERROR,
          BoundedJsonCategory.STRUCTURE_ERROR,
          400
        );
      }

      state.totalKeys += 1;
      if (state.totalKeys > limits.maxTotalKeys) {
        throw new BoundedJsonError(
          "JSON total key count exceeded maximum limit.",
          BoundedJsonErrorCode.STRUCTURE_ERROR,
          BoundedJsonCategory.STRUCTURE_ERROR,
          400
        );
      }

      const val = (value as Record<string, unknown>)[key];
      const nextDepth =
        val !== null && typeof val === "object"
          ? containerDepth + 1
          : containerDepth;
      validateStructure(val, nextDepth, limits, state);
    }
    return;
  }

  throw new BoundedJsonError(
    "Invalid data type in JSON structure.",
    BoundedJsonErrorCode.STRUCTURE_ERROR,
    BoundedJsonCategory.STRUCTURE_ERROR,
    400
  );
}

/**
 * Reads and validates a JSON object from an HTTP Request body under strict bounds.
 *
 * @param request The incoming HTTP Request object.
 * @param options Configurable constraints for byte size, timeouts, depth, keys, strings, and arrays.
 * @returns The parsed and validated plain JSON object.
 * @throws {BoundedJsonError} If any validation limit, format rule, or prototype pollution check fails.
 */
export async function readBoundedJsonObject<
  T extends Record<string, unknown> = Record<string, unknown>
>(
  request: Request,
  options: BoundedJsonOptions = {}
): Promise<T> {
  const maxBytes = options.maxBytes ?? DEFAULT_BOUNDED_JSON_OPTIONS.maxBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULT_BOUNDED_JSON_OPTIONS.timeoutMs;
  const maxDepth = options.maxDepth ?? DEFAULT_BOUNDED_JSON_OPTIONS.maxDepth;
  const maxKeys = options.maxKeys ?? DEFAULT_BOUNDED_JSON_OPTIONS.maxKeys;
  const maxTotalKeys =
    options.maxTotalKeys ?? DEFAULT_BOUNDED_JSON_OPTIONS.maxTotalKeys;
  const maxStringLength =
    options.maxStringLength ?? DEFAULT_BOUNDED_JSON_OPTIONS.maxStringLength;
  const maxArrayLength =
    options.maxArrayLength ?? DEFAULT_BOUNDED_JSON_OPTIONS.maxArrayLength;

  validateContentType(request.headers);
  validateContentLength(request.headers, maxBytes);

  const rawBytes = await collectStreamBytes(
    request,
    maxBytes,
    timeoutMs,
    options.signal
  );

  let text: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    text = decoder.decode(rawBytes);
  } catch {
    throw new BoundedJsonError(
      "Invalid UTF-8 encoding in request body.",
      BoundedJsonErrorCode.PARSE_ERROR,
      BoundedJsonCategory.PARSE_ERROR,
      400
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BoundedJsonError(
      "Malformed JSON payload.",
      BoundedJsonErrorCode.PARSE_ERROR,
      BoundedJsonCategory.PARSE_ERROR,
      400
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BoundedJsonError(
      "Request body must be a JSON object.",
      BoundedJsonErrorCode.STRUCTURE_ERROR,
      BoundedJsonCategory.STRUCTURE_ERROR,
      400
    );
  }

  const limits: StructureValidationLimits = {
    maxDepth,
    maxKeys,
    maxTotalKeys,
    maxStringLength,
    maxArrayLength,
  };

  const state: ValidationState = {
    totalKeys: 0,
  };

  validateStructure(parsed, 1, limits, state);

  return parsed as T;
}
