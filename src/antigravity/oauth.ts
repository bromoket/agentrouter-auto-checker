/**
 * Antigravity OAuth flow state (PKCE). Ported from gemini_stack antigravity/oauth.ts.
 *
 * authorizeAntigravityStart produces a Google consent URL and keeps the PKCE verifier
 * server-side keyed by a nonce embedded in the `state` param. The verifier is single-use
 * and expires after OAUTH_STATE_TTL_MS. exchangeAntigravityCode completes the flow.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ANTIGRAVITY_SCOPES } from "./constants";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  type AntigravityOauthConfig,
  type HttpFetcher,
  type AntigravityTokenResult,
} from "./client";

export const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;

interface PendingOAuthState {
  verifier: string;
  projectId: string;
  expiresAt: number;
  label: string;
}

const pendingStates = new Map<string, PendingOAuthState>();

export interface AntigravityAuthorizationStart {
  url: string;
  state: string;
  expiresInSec: number;
}

export interface AntigravityExchangeSuccess extends AntigravityTokenResult {
  type: "success";
  projectId: string | null;
  label: string;
  email: string | null;
}

export interface AntigravityExchangeFailure {
  type: "failed";
  error: string;
}

export type AntigravityExchangeResult =
  | AntigravityExchangeSuccess
  | AntigravityExchangeFailure;

function cleanupExpiredStates(now = Date.now()): void {
  for (const [nonce, pending] of pendingStates) {
    if (pending.expiresAt <= now) pendingStates.delete(nonce);
  }
}

function encodeState(payload: { nonce: string; projectId: string; label: string }): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeState(state: string): { nonce: string; projectId: string; label: string } {
  const normalized = state.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    throw new Error("Malformed OAuth state parameter.");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.nonce !== "string" || !record.nonce) {
    throw new Error("Missing or invalid OAuth state nonce.");
  }
  return {
    nonce: record.nonce,
    projectId: typeof record.projectId === "string" ? record.projectId : "",
    label: typeof record.label === "string" ? record.label : "",
  };
}

function base64UrlEncode(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function safeGoogleVerificationUrl(rawUrl: string | null | undefined): string | undefined {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com") {
      return undefined;
    }
    return trimmed;
  } catch {
    return undefined;
  }
}

export interface AuthorizeAntigravityOptions {
  oauth: AntigravityOauthConfig;
  label?: string;
  loginHint?: string;
  projectId?: string;
}

/**
 * Build the Google consent URL for adding an Antigravity account.
 * The `state` value must be passed back with the exchanged code.
 */
export function authorizeAntigravityStart(
  options: AuthorizeAntigravityOptions,
): AntigravityAuthorizationStart {
  cleanupExpiredStates();
  const { verifier, challenge } = generatePkcePair();
  const nonce = randomUUID();
  const label = options.label?.trim() || "";
  const projectId = options.projectId?.trim() || "";
  pendingStates.set(nonce, {
    verifier,
    projectId,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
    label,
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", options.oauth.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", options.oauth.redirectUri);
  url.searchParams.set("scope", ANTIGRAVITY_SCOPES.join(" "));
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", encodeState({ nonce, projectId, label }));
  url.searchParams.set("access_type", "offline");
  const loginHint = options.loginHint?.trim();
  if (loginHint) {
    url.searchParams.set("login_hint", loginHint);
    url.searchParams.set("prompt", "consent");
  } else {
    url.searchParams.set("prompt", "consent select_account");
  }
  return { url: url.toString(), state: encodeState({ nonce, projectId, label }), expiresInSec: OAUTH_STATE_TTL_MS / 1000 };
}

export interface ExchangeAntigravityOptions {
  oauth: AntigravityOauthConfig;
  code: string;
  state: string;
  timeoutMs?: number;
  fetcher?: HttpFetcher;
}

/** Exchange an authorization code using the stored PKCE verifier. Single-use state. */
export async function exchangeAntigravityCode(
  options: ExchangeAntigravityOptions,
): Promise<AntigravityExchangeResult> {
  let decoded: { nonce: string; projectId: string; label: string };
  try {
    decoded = decodeState(options.state);
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : "Invalid OAuth state." };
  }
  const pending = pendingStates.get(decoded.nonce);
  if (!pending) {
    return { type: "failed", error: "Invalid or expired OAuth state nonce." };
  }
  pendingStates.delete(decoded.nonce);
  if (pending.expiresAt <= Date.now()) {
    return { type: "failed", error: "OAuth state has expired (5 minute window). Start again." };
  }
  try {
    const result = await exchangeAuthorizationCode({
      code: options.code,
      codeVerifier: pending.verifier,
      oauth: options.oauth,
      timeoutMs: options.timeoutMs,
      fetcher: options.fetcher,
    });
    return {
      type: "success",
      ...result,
      projectId: pending.projectId || null,
      label: pending.label || decoded.label,
      email: result.email,
    };
  } catch (error) {
    return { type: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

export interface RotateAccessTokenOptions {
  oauth: AntigravityOauthConfig;
  refreshToken: string;
  timeoutMs?: number;
  fetcher?: HttpFetcher;
}

export async function rotateAccessToken(
  options: RotateAccessTokenOptions,
): Promise<{ accessToken: string; expiresInSec: number; refreshToken: string | null }> {
  return refreshAccessToken({
    refreshToken: options.refreshToken,
    oauth: options.oauth,
    timeoutMs: options.timeoutMs,
    fetcher: options.fetcher,
  });
}
