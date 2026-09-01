import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export const DASHBOARD_SESSION_COOKIE_NAME = "dashboard_session";
export const SESSION_COOKIE_NAME = DASHBOARD_SESSION_COOKIE_NAME;
export const SESSION_MAX_AGE_SECONDS = 604_800; // 7 days in seconds (7 * 24 * 60 * 60)
export const MIN_API_KEY_LENGTH_BYTES = 32;

export interface DashboardAuthOptions {
  env?: Record<string, string | undefined>;
  host?: string;
  disabled?: boolean;
  apiKey?: string;
  observatoryEnabled?: boolean;
  cookieName?: string;
  cookiePath?: string;
}

export interface DashboardAuthConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly isLoopback: boolean;
  readonly cookieName: string;
}

export interface CreateSessionResponseOptions {
  body?: unknown;
  status?: number;
  headers?: HeadersInit;
  maxAge?: number;
}

export interface CreateClearSessionResponseOptions {
  body?: unknown;
  status?: number;
  headers?: HeadersInit;
}

export interface ParsedSessionToken {
  readonly nonce: string;
  readonly expiresAt: number;
  readonly signature: string;
}

export function isLoopbackHost(rawHost: string | undefined | null): boolean {
  if (!rawHost) return false;
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost") {
    return true;
  }
  const family = isIP(host);
  if (family === 4) {
    return host.startsWith("127.");
  }
  if (family === 6) {
    if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("::ffff:127.")) {
      return true;
    }
  }
  return false;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "1" || trimmed === "yes" || trimmed === "on") {
    return true;
  }
  if (trimmed === "false" || trimmed === "0" || trimmed === "no" || trimmed === "off") {
    return false;
  }
  return undefined;
}

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(Buffer.from(secret, "utf-8")).digest();
}

export function timingSafeEqualDigests(a: Uint8Array | Buffer, b: Uint8Array | Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function createSessionToken(apiKey: string, ttlSeconds = SESSION_MAX_AGE_SECONDS): string {
  if (!apiKey) {
    throw new Error("API key is required to create session token.");
  }
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${nonce}.${expiresAt}`;
  const signature = createHmac("sha256", apiKey).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

export function parseSessionToken(token: string | null | undefined): ParsedSessionToken | null {
  if (!token || typeof token !== "string") return null;
  const trimmed = token.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3) return null;
  const [nonce, rawExpiresAt, signature] = parts;
  if (!nonce || !/^[0-9a-fA-F]+$/.test(nonce)) return null;
  if (!rawExpiresAt || !/^\d+$/.test(rawExpiresAt)) return null;
  if (!signature || !/^[0-9a-fA-F]{64}$/.test(signature)) return null;

  const expiresAt = Number.parseInt(rawExpiresAt, 10);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return null;

  return { nonce, expiresAt, signature };
}

export function verifySessionToken(token: string | null | undefined, apiKey: string): boolean {
  if (!token || !apiKey) return false;
  const parsed = parseSessionToken(token);
  if (!parsed) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const isExpired = parsed.expiresAt > 1e11 ? Date.now() > parsed.expiresAt : nowSeconds > parsed.expiresAt;
  if (isExpired) return false;

  const payload = `${parsed.nonce}.${parsed.expiresAt}`;
  const expectedSignature = createHmac("sha256", apiKey).update(payload).digest("hex");

  if (parsed.signature.length !== expectedSignature.length) return false;
  return timingSafeEqual(
    Buffer.from(parsed.signature, "utf-8"),
    Buffer.from(expectedSignature, "utf-8"),
  );
}

export function createSessionCookieHeader(
  token: string,
  cookieName = DASHBOARD_SESSION_COOKIE_NAME,
  maxAge = SESSION_MAX_AGE_SECONDS,
  cookiePath = "/",
): string {
  return `${cookieName}=${token}; Path=${cookiePath}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

export function parseCookieHeader(header: string | null | undefined, name: string): string | null {
  if (!header || typeof header !== "string") {
    return null;
  }
  const parts = header.split(";");
  for (const part of parts) {
    const equalIndex = part.indexOf("=");
    if (equalIndex === -1) continue;
    const key = part.slice(0, equalIndex).trim();
    if (key === name) {
      const val = part.slice(equalIndex + 1).trim();
      return val.replace(/^"|"$/g, "");
    }
  }
  return null;
}

export function extractCookieHeader(input: unknown): string | null {
  if (!input) return null;
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof Headers) {
    return input.get("cookie");
  }
  if (typeof input === "object") {
    if ("headers" in input) {
      const headers = (input as { headers: unknown }).headers;
      if (headers instanceof Headers) {
        return headers.get("cookie");
      }
      if (headers && typeof headers === "object") {
        const record = headers as Record<string, string | undefined>;
        return record.cookie ?? record.Cookie ?? null;
      }
    }
    if ("get" in input && typeof (input as { get: unknown }).get === "function") {
      return (input as Headers).get("cookie");
    }
  }
  return null;
}


export function createUnauthorizedResponse(
  arg1?: string,
  arg2?: string,
): Response {
  const errorMessage = arg2 !== undefined ? arg2 : (arg1 ?? "Unauthorized");
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  return new Response(JSON.stringify({ error: errorMessage }), {
    status: 401,
    statusText: "Unauthorized",
    headers,
  });
}

function normalizeCookiePath(rawPath: string): string {
  const cookiePath = rawPath.trim();
  if (!cookiePath.startsWith("/") || /[\u0000-\u001f\u007f;\s]/.test(cookiePath)) {
    throw new Error("DASHBOARD_SESSION_COOKIE_PATH must be an absolute cookie path.");
  }
  return cookiePath;
}

export class DashboardAuth implements DashboardAuthConfig {
  readonly enabled: boolean;
  readonly host: string;
  readonly isLoopback: boolean;
  readonly cookieName: string;

  readonly #apiKey: string | null;
  readonly #apiKeyHash: Buffer | null;
  readonly #cookiePath: string;

  constructor(init: {
    enabled: boolean;
    host: string;
    isLoopback: boolean;
    apiKey: string | null;
    cookieName?: string;
    cookiePath?: string;
  }) {
    this.enabled = init.enabled;
    this.host = init.host;
    this.isLoopback = init.isLoopback;
    this.cookieName = init.cookieName ?? DASHBOARD_SESSION_COOKIE_NAME;
    this.#cookiePath = init.cookiePath ?? "/";
    this.#apiKey = init.apiKey;
    this.#apiKeyHash = init.apiKey ? hashSecret(init.apiKey) : null;
  }

  public verifyApiKey(candidate: string): boolean {
    if (this.#apiKey === null || this.#apiKeyHash === null) {
      return false;
    }
    const key = candidate.trim();
    if (!key) {
      return false;
    }
    const candidateHash = hashSecret(key);
    return timingSafeEqual(candidateHash, this.#apiKeyHash);
  }

  public createSessionToken(ttlSeconds = SESSION_MAX_AGE_SECONDS): string {
    if (this.#apiKey === null) {
      throw new Error("Cannot issue session token without configured DASHBOARD_API_KEY.");
    }
    return createSessionToken(this.#apiKey, ttlSeconds);
  }

  public createSessionCookie(maxAge = SESSION_MAX_AGE_SECONDS): string {
    const token = this.createSessionToken(maxAge);
    return createSessionCookieHeader(token, this.cookieName, maxAge, this.#cookiePath);
  }

  public createSessionResponse(options: CreateSessionResponseOptions = {}): Response {
    const maxAge = options.maxAge ?? SESSION_MAX_AGE_SECONDS;
    const cookieHeader = this.createSessionCookie(maxAge);
    const headers = new Headers(options.headers);
    headers.set("set-cookie", cookieHeader);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    headers.set("referrer-policy", "no-referrer");

    const status = options.status ?? 200;
    const payload = options.body !== undefined ? options.body : { ok: true, status: "ok" };
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);

    return new Response(body, {
      status,
      headers,
    });
  }

  public createClearSessionResponse(options: CreateClearSessionResponseOptions = {}): Response {
    const headers = new Headers(options.headers);
    headers.set(
      "set-cookie",
      `${this.cookieName}=; Path=${this.#cookiePath}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict`,
    );
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-frame-options", "DENY");
    headers.set("referrer-policy", "no-referrer");

    const status = options.status ?? 200;
    const payload = options.body !== undefined ? options.body : { ok: true, status: "logged_out" };
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);

    return new Response(body, {
      status,
      headers,
    });
  }

  public verifySessionToken(token: string | null | undefined): boolean {
    if (!this.enabled) {
      return true;
    }
    if (this.#apiKey === null) {
      return false;
    }
    return verifySessionToken(token, this.#apiKey);
  }

  public verifySessionCookie(cookieHeaderOrValue: string | null | undefined): boolean {
    if (!this.enabled) {
      return true;
    }
    if (!cookieHeaderOrValue || typeof cookieHeaderOrValue !== "string") {
      return false;
    }
    const fromHeader = parseCookieHeader(cookieHeaderOrValue, this.cookieName);
    const token = fromHeader ?? cookieHeaderOrValue.trim();
    return this.verifySessionToken(token);
  }

  public verify(input: unknown): boolean {
    if (!this.enabled) {
      return true;
    }
    if (input instanceof Request || input instanceof Headers || (input && typeof input === "object" && "headers" in input)) {
      return this.verifyRequest(input);
    }
    if (typeof input === "string") {
      return this.verifySessionCookie(input);
    }
    return false;
  }

  public verifyRequest(request: Request | Headers | unknown): boolean {
    if (!this.enabled) {
      return true;
    }
    const cookieHeader = extractCookieHeader(request);
    if (!cookieHeader) {
      return false;
    }
    const token = parseCookieHeader(cookieHeader, this.cookieName);
    if (!token) {
      return false;
    }
    return this.verifySessionToken(token);
  }

  public authenticate(request: Request | Headers | unknown): Response | null {
    if (!this.enabled) {
      return null;
    }
    if (this.verifyRequest(request)) {
      return null;
    }
    return this.createUnauthorizedResponse();
  }

  public createUnauthorizedResponse(errorMessage?: string): Response {
    return createUnauthorizedResponse(errorMessage);
  }

  public toJSON(): DashboardAuthConfig {
    return {
      enabled: this.enabled,
      host: this.host,
      isLoopback: this.isLoopback,
      cookieName: this.cookieName,
    };
  }

  public [Symbol.for("nodejs.util.inspect.custom")](): DashboardAuthConfig {
    return this.toJSON();
  }
}

export function createDashboardAuth(options: DashboardAuthOptions = {}): DashboardAuth {
  const env = options.env ?? process.env;
  const host = (options.host ?? env.DASHBOARD_HOST ?? "127.0.0.1").trim().toLowerCase();
  const isLoopback = isLoopbackHost(host);

  // Reject username/password credentials
  const FORBIDDEN_USERNAME_KEYS = [
    "DASHBOARD_AUTH_USERNAME",
    "DASHBOARD_USERNAME",
    "DASHBOARD_USER",
  ];
  const FORBIDDEN_PASSWORD_KEYS = [
    "DASHBOARD_AUTH_PASSWORD",
    "DASHBOARD_PASSWORD",
    "DASHBOARD_PASS",
  ];
  for (const key of [...FORBIDDEN_USERNAME_KEYS, ...FORBIDDEN_PASSWORD_KEYS]) {
    if (env[key] !== undefined) {
      throw new Error(
        "Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.",
      );
    }
  }
  if (
    (options as Record<string, unknown>).username !== undefined ||
    (options as Record<string, unknown>).password !== undefined
  ) {
    throw new Error(
      "Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.",
    );
  }

  const explicitDisabled =
    options.disabled ??
    parseBooleanEnv(env.DASHBOARD_AUTH_DISABLED);

  const observatoryEnabled =
    options.observatoryEnabled ??
    (env.OBSERVATORY_ENABLED !== undefined ? parseBooleanEnv(env.OBSERVATORY_ENABLED) ?? false : false);

  const rawApiKey = options.apiKey ?? env.DASHBOARD_API_KEY;
  const apiKey = rawApiKey !== undefined ? String(rawApiKey).trim() : undefined;
  if (apiKey !== undefined) {
    if (apiKey.startsWith("__SET_") && apiKey.endsWith("__")) {
      throw new Error("DASHBOARD_API_KEY must be replaced with a generated owner API key.");
    }
    const keyBytes = Buffer.from(apiKey, "utf-8").length;
    if (keyBytes < MIN_API_KEY_LENGTH_BYTES) {
      throw new Error("DASHBOARD_API_KEY must be at least 32 bytes.");
    }
  }

  const cookiePath = normalizeCookiePath(options.cookiePath ?? env.DASHBOARD_SESSION_COOKIE_PATH ?? "/");

  if (observatoryEnabled) {
    if (explicitDisabled === true) {
      throw new Error("Dashboard authentication cannot be disabled when Observatory is enabled.");
    }
    if (!apiKey) {
      throw new Error("DASHBOARD_API_KEY is required when Observatory is enabled.");
    }
  }

  if (!isLoopback) {
    if (explicitDisabled === true) {
      throw new Error(
        `Dashboard authentication cannot be disabled on non-loopback host (${host}).`,
      );
    }
    if (!apiKey) {
      throw new Error(
        `Dashboard authentication API key (DASHBOARD_API_KEY) is required for non-loopback host (${host}).`,
      );
    }
  }

  if (isLoopback && !observatoryEnabled) {
    if (explicitDisabled === true) {
      return new DashboardAuth({
        enabled: false,
        host,
        isLoopback: true,
        apiKey: apiKey ?? null,
        cookieName: options.cookieName,
        cookiePath,
      });
    }
    if (!apiKey) {
      return new DashboardAuth({
        enabled: false,
        host,
        isLoopback: true,
        apiKey: null,
        cookieName: options.cookieName,
        cookiePath,
      });
    }
  }

  return new DashboardAuth({
    enabled: true,
    host,
    isLoopback,
    apiKey: apiKey!,
    cookieName: options.cookieName,
    cookiePath,
  });
}
