import { afterEach, describe, expect, it } from "bun:test";
import { inspect } from "node:util";
import {
  createDashboardAuth,
  createSessionCookieHeader,
  createSessionToken,
  createUnauthorizedResponse,
  DashboardAuth,
  DASHBOARD_SESSION_COOKIE_NAME,
  extractCookieHeader,
  isLoopbackHost,
  parseCookieHeader,
  parseSessionToken,
  SESSION_MAX_AGE_SECONDS,
  timingSafeEqualDigests,
  verifySessionToken,
} from "./dashboard-auth";

const ORIGINAL_ENV = { ...process.env };
const VALID_KEY_32 = "a".repeat(32);
const VALID_KEY_64 = "k".repeat(64);

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("isLoopbackHost", () => {
  it("recognizes standard IPv4 and IPv6 loopback addresses and localhost", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.2")).toBe(true);
    expect(isLoopbackHost("127.255.255.255")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
  });

  it("identifies non-loopback addresses including Tailnet, LAN, and public IPs", () => {
    expect(isLoopbackHost("100.127.29.78")).toBe(false);
    expect(isLoopbackHost("100.64.0.1")).toBe(false);
    expect(isLoopbackHost("192.168.1.50")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
    expect(isLoopbackHost("172.16.0.1")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
    expect(isLoopbackHost("[::]")).toBe(false);
    expect(isLoopbackHost("bkserver")).toBe(false);
    expect(isLoopbackHost("my-fleet.ts.net")).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});

describe("parseCookieHeader and extractCookieHeader", () => {
  it("parses target cookie from single or multi-cookie header", () => {
    const single = "dashboard_session=token123";
    expect(parseCookieHeader(single, "dashboard_session")).toBe("token123");

    const multi = "pref=dark; dashboard_session=token456; theme=blue";
    expect(parseCookieHeader(multi, "dashboard_session")).toBe("token456");
  });

  it("handles quotes and whitespace around cookie values", () => {
    const quoted = 'dashboard_session="token789"';
    expect(parseCookieHeader(quoted, "dashboard_session")).toBe("token789");

    const spaces = "  dashboard_session =  my_token ; other=val ";
    expect(parseCookieHeader(spaces, "dashboard_session")).toBe("my_token");
  });

  it("returns null when cookie is absent or header is invalid", () => {
    expect(parseCookieHeader("other_cookie=value", "dashboard_session")).toBeNull();
    expect(parseCookieHeader("", "dashboard_session")).toBeNull();
    expect(parseCookieHeader(null, "dashboard_session")).toBeNull();
    expect(parseCookieHeader(undefined, "dashboard_session")).toBeNull();
  });

  it("extracts cookie header from Request, Headers, or object", () => {
    const req = new Request("http://127.0.0.1:3100/api/status", {
      headers: { cookie: "dashboard_session=tok1" },
    });
    expect(extractCookieHeader(req)).toBe("dashboard_session=tok1");

    const headers = new Headers();
    headers.set("cookie", "dashboard_session=tok2");
    expect(extractCookieHeader(headers)).toBe("dashboard_session=tok2");

    expect(extractCookieHeader({ headers: { cookie: "dashboard_session=tok3" } })).toBe(
      "dashboard_session=tok3",
    );
    expect(extractCookieHeader(null)).toBeNull();
    expect(extractCookieHeader({})).toBeNull();
  });
});


describe("createSessionToken and verifySessionToken", () => {
  it("creates a signed 7-day token with random nonce, absolute expiry, and HMAC-SHA256", () => {
    const token = createSessionToken(VALID_KEY_32);
    const parsed = parseSessionToken(token);
    expect(parsed).not.toBeNull();
    expect(parsed?.nonce).toMatch(/^[0-9a-fA-F]{32}$/);

    const now = Math.floor(Date.now() / 1000);
    expect(parsed?.expiresAt).toBeGreaterThanOrEqual(now + SESSION_MAX_AGE_SECONDS - 2);
    expect(parsed?.expiresAt).toBeLessThanOrEqual(now + SESSION_MAX_AGE_SECONDS + 2);
    expect(parsed?.signature).toMatch(/^[0-9a-fA-F]{64}$/);

    expect(verifySessionToken(token, VALID_KEY_32)).toBe(true);
  });

  it("invalidates token when API key is rotated", () => {
    const token = createSessionToken(VALID_KEY_32);
    const rotatedKey = "b".repeat(32);

    expect(verifySessionToken(token, VALID_KEY_32)).toBe(true);
    expect(verifySessionToken(token, rotatedKey)).toBe(false);
  });

  it("rejects tampered tokens (nonce, expiry, signature)", () => {
    const token = createSessionToken(VALID_KEY_32);
    const [nonce, expiresAt, signature] = token.split(".");

    const tamperedNonce = `${"f".repeat(32)}.${expiresAt}.${signature}`;
    expect(verifySessionToken(tamperedNonce, VALID_KEY_32)).toBe(false);

    const tamperedExpiry = `${nonce}.${Number(expiresAt) + 1000}.${signature}`;
    expect(verifySessionToken(tamperedExpiry, VALID_KEY_32)).toBe(false);

    const tamperedSig = `${nonce}.${expiresAt}.${"0".repeat(64)}`;
    expect(verifySessionToken(tamperedSig, VALID_KEY_32)).toBe(false);
  });

  it("rejects expired tokens", () => {
    // 10 seconds in the past
    const expiredToken = createSessionToken(VALID_KEY_32, -10);
    expect(verifySessionToken(expiredToken, VALID_KEY_32)).toBe(false);
  });

  it("rejects malformed token strings safely", () => {
    expect(verifySessionToken("", VALID_KEY_32)).toBe(false);
    expect(verifySessionToken("part1.part2", VALID_KEY_32)).toBe(false);
    expect(verifySessionToken("a.b.c.d", VALID_KEY_32)).toBe(false);
    expect(verifySessionToken("not-hex.123456.not-hex", VALID_KEY_32)).toBe(false);
    expect(verifySessionToken(null, VALID_KEY_32)).toBe(false);
    expect(verifySessionToken(undefined, VALID_KEY_32)).toBe(false);
  });
});

describe("createSessionCookieHeader", () => {
  it("formats standard 7-day cookie header with required security attributes", () => {
    const token = "mock.token.signature";
    const header = createSessionCookieHeader(token);

    expect(header).toContain(`${DASHBOARD_SESSION_COOKIE_NAME}=${token}`);
    expect(header).toContain("Path=/");
    expect(header).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
  });

  it("uses a configured dedicated path for the session cookie", () => {
    const auth = createDashboardAuth({
      host: "127.0.0.1",
      apiKey: VALID_KEY_32,
      cookiePath: "/observatory/",
    });

    expect(auth.createSessionResponse().headers.get("set-cookie")).toContain("Path=/observatory/");
    expect(auth.createClearSessionResponse().headers.get("set-cookie")).toContain("Path=/observatory/");
  });

  it("rejects a cookie path that could inject cookie attributes", () => {
    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        apiKey: VALID_KEY_32,
        cookiePath: "/observatory/; Domain=attacker.example",
      }),
    ).toThrow("DASHBOARD_SESSION_COOKIE_PATH must be an absolute cookie path.");
  });
});

describe("timingSafeEqualDigests", () => {
  it("returns true for identical buffers and false for differing buffers of equal length", () => {
    const bufA = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const bufB = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const bufC = Buffer.from("fedcba9876543210fedcba9876543210", "hex");

    expect(timingSafeEqualDigests(bufA, bufB)).toBe(true);
    expect(timingSafeEqualDigests(bufA, bufC)).toBe(false);
  });

  it("safely returns false for unequal length buffers without throwing TypeError", () => {
    const bufShort = Buffer.from("0123", "hex");
    const bufLong = Buffer.from("01234567", "hex");

    expect(timingSafeEqualDigests(bufShort, bufLong)).toBe(false);
  });
});

describe("createUnauthorizedResponse", () => {
  it("emits a 401 response with no-store and security headers without challenge headers", async () => {
    const res = createUnauthorizedResponse("Access Denied");
    expect(res.status).toBe(401);
    expect(res.statusText).toBe("Unauthorized");
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const body = await res.json();
    expect(body).toEqual({ error: "Access Denied" });
  });

  it("handles legacy two-argument form without emitting www-authenticate", async () => {
    const res = createUnauthorizedResponse("AI Fleet Observatory", "Invalid session");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    const body = await res.json();
    expect(body).toEqual({ error: "Invalid session" });
  });
});

describe("DashboardAuth - Loopback Disabled Mode", () => {
  it("defaults to disabled when no API key is provided on loopback host (127.0.0.1)", () => {
    const auth = createDashboardAuth({
      host: "127.0.0.1",
      env: {},
    });

    expect(auth.enabled).toBe(false);
    expect(auth.isLoopback).toBe(true);
    expect(auth.verify(null)).toBe(true);
    expect(auth.verify("invalid-token")).toBe(true);
    expect(auth.verifyRequest(new Request("http://127.0.0.1:3100/api/status"))).toBe(true);
    expect(auth.authenticate(new Request("http://127.0.0.1:3100/api/status"))).toBeNull();
    expect(auth.verifyApiKey("candidate")).toBe(false);
  });

  it("defaults to disabled on localhost and ::1 when no API key is provided", () => {
    const authLocalhost = createDashboardAuth({ host: "localhost", env: {} });
    expect(authLocalhost.enabled).toBe(false);
    expect(authLocalhost.isLoopback).toBe(true);

    const authIpv6 = createDashboardAuth({ host: "::1", env: {} });
    expect(authIpv6.enabled).toBe(false);
    expect(authIpv6.isLoopback).toBe(true);
  });

  it("disables auth when explicitly configured via options or env on loopback when Observatory is off", () => {
    const authExplicitOption = createDashboardAuth({
      host: "127.0.0.1",
      disabled: true,
      env: {
        DASHBOARD_API_KEY: VALID_KEY_32,
      },
    });
    expect(authExplicitOption.enabled).toBe(false);

    const authExplicitEnv = createDashboardAuth({
      host: "127.0.0.1",
      env: {
        DASHBOARD_AUTH_DISABLED: "true",
        DASHBOARD_API_KEY: VALID_KEY_32,
      },
    });
    expect(authExplicitEnv.enabled).toBe(false);
  });
});

describe("DashboardAuth - Rejection of Legacy Username/Password Configuration", () => {
  it("rejects DASHBOARD_AUTH_USERNAME and DASHBOARD_AUTH_PASSWORD in env", () => {
    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        env: { DASHBOARD_AUTH_USERNAME: "owner" },
      }),
    ).toThrow("Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.");

    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        env: { DASHBOARD_AUTH_PASSWORD: "secret-password" },
      }),
    ).toThrow("Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.");
  });

  it("rejects DASHBOARD_USERNAME, DASHBOARD_PASSWORD, DASHBOARD_USER, DASHBOARD_PASS", () => {
    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        env: { DASHBOARD_USERNAME: "owner" },
      }),
    ).toThrow("Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.");

    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        env: { DASHBOARD_PASSWORD: "pass" },
      }),
    ).toThrow("Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.");

    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        env: { DASHBOARD_USER: "owner" },
      }),
    ).toThrow("Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.");

    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        env: { DASHBOARD_PASS: "pass" },
      }),
    ).toThrow("Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.");
  });

  it("rejects username or password passed via options", () => {
    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        ...({ username: "owner" } as unknown as object),
      }),
    ).toThrow("Dashboard username/password configuration is not supported; configure DASHBOARD_API_KEY.");
  });
});

describe("DashboardAuth - API Key Validation and Enforcement", () => {
  it("rejects API keys under 32 UTF-8 bytes", () => {
    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        env: { DASHBOARD_API_KEY: "short_key_under_32_bytes" },
      }),
    ).toThrow("DASHBOARD_API_KEY must be at least 32 bytes.");

    expect(() =>
      createDashboardAuth({
        host: "100.127.29.78",
        apiKey: "29_characters_padded_here____",
      }),
    ).toThrow("DASHBOARD_API_KEY must be at least 32 bytes.");
  });

  it("rejects checked-in owner API key sentinel values", () => {
    for (const apiKey of [
      "__SET_OWNER_API_KEY__",
      "__SET_owner-dashboard-api-key-placeholder-value__",
    ]) {
      expect(() =>
        createDashboardAuth({
          host: "127.0.0.1",
          env: { DASHBOARD_API_KEY: apiKey },
        }),
      ).toThrow("DASHBOARD_API_KEY must be replaced with a generated owner API key.");
    }
  });

  it("requires DASHBOARD_API_KEY on non-loopback host", () => {
    expect(() =>
      createDashboardAuth({
        host: "100.127.29.78",
        env: {},
      }),
    ).toThrow("Dashboard authentication API key (DASHBOARD_API_KEY) is required for non-loopback host (100.127.29.78).");
  });

  it("forbids disabling authentication on non-loopback host", () => {
    expect(() =>
      createDashboardAuth({
        host: "100.127.29.78",
        disabled: true,
        env: { DASHBOARD_API_KEY: VALID_KEY_32 },
      }),
    ).toThrow("Dashboard authentication cannot be disabled on non-loopback host (100.127.29.78).");

    expect(() =>
      createDashboardAuth({
        host: "100.127.29.78",
        env: {
          DASHBOARD_AUTH_DISABLED: "true",
          DASHBOARD_API_KEY: VALID_KEY_32,
        },
      }),
    ).toThrow("Dashboard authentication cannot be disabled on non-loopback host (100.127.29.78).");
  });

  it("requires DASHBOARD_API_KEY whenever Observatory is enabled", () => {
    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        observatoryEnabled: true,
        env: {},
      }),
    ).toThrow("DASHBOARD_API_KEY is required when Observatory is enabled.");

    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        env: {
          OBSERVATORY_ENABLED: "true",
        },
      }),
    ).toThrow("DASHBOARD_API_KEY is required when Observatory is enabled.");
  });

  it("forbids disabling authentication on loopback whenever Observatory is enabled", () => {
    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        observatoryEnabled: true,
        disabled: true,
        apiKey: VALID_KEY_32,
      }),
    ).toThrow("Dashboard authentication cannot be disabled when Observatory is enabled.");

    expect(() =>
      createDashboardAuth({
        host: "127.0.0.1",
        apiKey: VALID_KEY_32,
        env: {
          OBSERVATORY_ENABLED: "true",
          DASHBOARD_AUTH_DISABLED: "true",
        },
      }),
    ).toThrow("Dashboard authentication cannot be disabled when Observatory is enabled.");
  });
});

describe("DashboardAuth - Session Issuance and Cookie Authentication", () => {
  const auth = createDashboardAuth({
    host: "127.0.0.1",
    apiKey: VALID_KEY_64,
  });

  it("verifies only matching API key values", () => {
    expect(auth.enabled).toBe(true);
    expect(auth.verifyApiKey(VALID_KEY_64)).toBe(true);
    expect(auth.verifyApiKey("wrong-api-key-that-does-not-match")).toBe(false);
    expect(auth.verifyApiKey("")).toBe(false);
    expect(auth.verifyApiKey(`Bearer ${VALID_KEY_64}`)).toBe(false);
  });

  it("creates a signed session response with Max-Age=604800, HttpOnly, Secure, SameSite=Strict", async () => {
    const sessionRes = auth.createSessionResponse();
    expect(sessionRes.status).toBe(200);

    const setCookie = sessionRes.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain("dashboard_session=");
    expect(setCookie).toContain("Max-Age=604800");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(sessionRes.headers.get("cache-control")).toBe("no-store");

    const body = await sessionRes.json();
    expect(body).toEqual({ ok: true, status: "ok" });
  });

  it("authenticates requests presenting a valid signed session cookie", () => {
    const token = auth.createSessionToken();
    const validReq = new Request("http://127.0.0.1:3100/api/observatory/status", {
      headers: { cookie: `dashboard_session=${token}` },
    });

    expect(auth.verifyRequest(validReq)).toBe(true);
    expect(auth.authenticate(validReq)).toBeNull();
  });

  it("rejects requests missing session cookie or presenting invalid cookie", () => {
    const unauthReq = new Request("http://127.0.0.1:3100/api/observatory/status");
    expect(auth.verifyRequest(unauthReq)).toBe(false);

    const unauthResponse = auth.authenticate(unauthReq);
    expect(unauthResponse).not.toBeNull();
    expect(unauthResponse?.status).toBe(401);
    expect(unauthResponse?.headers.get("www-authenticate")).toBeNull();
    expect(unauthResponse?.headers.get("cache-control")).toBe("no-store");

    const invalidCookieReq = new Request("http://127.0.0.1:3100/api/observatory/status", {
      headers: { cookie: "dashboard_session=tampered.12345.67890" },
    });
    expect(auth.verifyRequest(invalidCookieReq)).toBe(false);
  });

  it("creates clear session response for logout", () => {
    const clearRes = auth.createClearSessionResponse();
    expect(clearRes.status).toBe(200);
    const setCookie = clearRes.headers.get("set-cookie");
    expect(setCookie).toContain("dashboard_session=;");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });
});

describe("DashboardAuth - Secret Redaction and Safety", () => {
  const secretKey = "SuperSecretPlainTextApiKeyThatMustNeverLeakUnderAnyCircumstance!";

  it("never exposes raw API key or digest buffers in JSON serialization", () => {
    const auth = createDashboardAuth({
      host: "100.127.29.78",
      apiKey: secretKey,
    });

    const serialized = JSON.stringify(auth);
    expect(serialized).not.toContain(secretKey);
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("Hash");
    expect(serialized).not.toContain("Buffer");

    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual({
      enabled: true,
      host: "100.127.29.78",
      isLoopback: false,
      cookieName: "dashboard_session",
    });
  });

  it("never exposes secrets in util.inspect or console formatting", () => {
    const auth = createDashboardAuth({
      host: "100.127.29.78",
      apiKey: secretKey,
    });

    const inspected = inspect(auth);
    expect(inspected).not.toContain(secretKey);
    expect(inspected).not.toContain("apiKey");
    expect(inspected).not.toContain("Hash");
  });

  it("does not expose API key in Object.keys()", () => {
    const auth = createDashboardAuth({
      host: "100.127.29.78",
      apiKey: secretKey,
    });

    const keys = Object.keys(auth);
    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("apiKeyHash");
    expect(keys).toEqual(["enabled", "host", "isLoopback", "cookieName"]);
  });

  it("never reflects raw API key in error messages", () => {
    const shortSecret = "secret-key-too-short";
    let caughtError: Error | null = null;
    try {
      createDashboardAuth({
        host: "127.0.0.1",
        apiKey: shortSecret,
      });
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toBe("DASHBOARD_API_KEY must be at least 32 bytes.");
    expect(caughtError?.message).not.toContain(shortSecret);
    expect(String(caughtError)).not.toContain(shortSecret);
  });
});
