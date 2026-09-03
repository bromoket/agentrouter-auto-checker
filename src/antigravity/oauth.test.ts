import { describe, expect, test } from "bun:test";
import {
  authorizeAntigravityStart,
  exchangeAntigravityCode,
  safeGoogleVerificationUrl,
} from "./oauth";
import type { HttpFetcher } from "./client";

const OAUTH = {
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:51121/oauth-callback",
};

function makeFetcher(): HttpFetcher {
  return async (url, init) => {
    if (url === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") !== "authorization_code") {
        return new Response(JSON.stringify({ error: "bad grant" }), { status: 400 });
      }
      if (!body.get("code_verifier")) {
        return new Response(JSON.stringify({ error: "missing verifier" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3599,
        }),
        { status: 200 },
      );
    }
    if (url.startsWith("https://www.googleapis.com/oauth2/v1/userinfo")) {
      return new Response(JSON.stringify({ email: "owner@example.com" }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };
}

describe("Antigravity OAuth flow", () => {
  test("authorize start builds a Google consent URL with PKCE state", () => {
    const started = authorizeAntigravityStart({ oauth: OAUTH, label: "owner" });
    const url = new URL(started.url);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe(OAUTH.clientId);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe(OAUTH.redirectUri);
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(started.state).toBeTruthy();
    expect(started.expiresInSec).toBe(300);
  });

  test("exchange succeeds with the same state and is single-use", async () => {
    const started = authorizeAntigravityStart({ oauth: OAUTH, label: "owner" });
    const first = await exchangeAntigravityCode({
      oauth: OAUTH,
      code: "auth-code-1",
      state: started.state,
      fetcher: makeFetcher(),
    });
    expect(first.type).toBe("success");
    if (first.type === "success") {
      expect(first.refreshToken).toBe("refresh-1");
      expect(first.email).toBe("owner@example.com");
      expect(first.label).toBe("owner");
    }
    const second = await exchangeAntigravityCode({
      oauth: OAUTH,
      code: "auth-code-2",
      state: started.state,
      fetcher: makeFetcher(),
    });
    expect(second.type).toBe("failed");
  });

  test("unknown or tampered state fails cleanly", async () => {
    const result = await exchangeAntigravityCode({
      oauth: OAUTH,
      code: "x",
      state: Buffer.from(JSON.stringify({ nonce: "does-not-exist" })).toString("base64url"),
      fetcher: makeFetcher(),
    });
    expect(result.type).toBe("failed");
    const malformed = await exchangeAntigravityCode({
      oauth: OAUTH,
      code: "x",
      state: "not-json",
      fetcher: makeFetcher(),
    });
    expect(malformed.type).toBe("failed");
  });

  test("safeGoogleVerificationUrl only accepts accounts.google.com https", () => {
    expect(safeGoogleVerificationUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(safeGoogleVerificationUrl("http://evil.example.com/x")).toBeUndefined();
    expect(safeGoogleVerificationUrl("")).toBeUndefined();
    expect(safeGoogleVerificationUrl(undefined)).toBeUndefined();
  });
});
