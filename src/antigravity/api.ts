/**
 * Antigravity dashboard API (owner-authenticated via the dashboard session).
 *
 * Mounted by the dashboard under /api/antigravity/* only when direct probing is enabled.
 * Never returns refresh tokens or fingerprints — only presence flags.
 */

import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { readBoundedJsonObject } from "../bounded-json";
import { exchangeAntigravityCode, authorizeAntigravityStart } from "./oauth";
import type { AntigravityCollector } from "./collector";
import type { AntigravityStore } from "./store";

export interface AntigravityApiContext {
  store: AntigravityStore;
  collector: AntigravityCollector | null;
  config: AppConfig;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function error(message: string, status: number): Response {
  return json({ error: message }, status);
}

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function accountIdFromPath(pathname: string, prefix: string): string | null {
  const raw = pathname.slice(prefix.length).split("/")[0];
  if (!raw || !ACCOUNT_ID_PATTERN.test(raw)) return null;
  return raw;
}

export async function handleAntigravityApi(
  request: Request,
  url: URL,
  method: string,
  context: AntigravityApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;
  const { config, store, collector } = context;
  const enabled = config.antigravity.enabled;

  // Overview (accounts + status)
  if (method === "GET" && pathname === "/api/antigravity/overview") {
    const oauthConfigured = Boolean(
      config.antigravity.oauthClientSecret && config.antigravity.oauthClientId,
    );
    return json({
      enabled,
      oauthConfigured,
      oauthRedirectUri: config.antigravity.oauthRedirectUri,
      probeIntervalMinutes: config.antigravity.probeIntervalMinutes,
      status: collector?.getStatus() ?? null,
      accounts: store.listAccounts(),
    });
  }

  // Manual probe (one or all)
  if (method === "POST" && pathname === "/api/antigravity/probe") {
    if (!collector) return error("Antigravity collector is not running.", 409);
    const body = await readBoundedJsonObject(request);
    const accountId = typeof body.accountId === "string" && body.accountId.trim()
      ? body.accountId.trim().toLowerCase()
      : null;
    if (accountId) {
      if (!ACCOUNT_ID_PATTERN.test(accountId)) {
        return error("Invalid account id.", 400);
      }
      const exists = store.getAccount(accountId);
      if (!exists) return error("Account not found.", 404);
      try {
        await collector.probeAccountOnce(accountId);
      } catch (probeError) {
        return error(probeError instanceof Error ? probeError.message.slice(0, 300) : "Probe failed.", 502);
      }
      return json({ ok: true, accountId });
    }
    const failures = await collector.probeAll();
    return json({ ok: true, probedAccounts: collector.getStatus().enabledAccountCount, failures });
  }

  // OAuth add-account flow
  if (method === "POST" && pathname === "/api/antigravity/oauth/start") {
    if (!enabled || !config.antigravity.oauthClientSecret) {
      return error("Antigravity OAuth is not configured (ANTIGRAVITY_OAUTH_CLIENT_SECRET missing).", 503);
    }
    const body = await readBoundedJsonObject(request);
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 128) : "";
    const started = authorizeAntigravityStart({
      oauth: {
        clientId: config.antigravity.oauthClientId,
        clientSecret: config.antigravity.oauthClientSecret,
        redirectUri: config.antigravity.oauthRedirectUri,
      },
      label,
    });
    return json({
      url: started.url,
      state: started.state,
      expiresInSec: started.expiresInSec,
      hint: "After consent, Google redirects to the loopback callback. Paste the full redirect URL (or the code and state values) into the exchange step.",
    });
  }

  if (method === "POST" && pathname === "/api/antigravity/oauth/exchange") {
    if (!enabled || !config.antigravity.oauthClientSecret) {
      return error("Antigravity OAuth is not configured.", 503);
    }
    const body = await readBoundedJsonObject(request);
    let code = typeof body.code === "string" ? body.code.trim() : "";
    let state = typeof body.state === "string" ? body.state.trim() : "";
    if (!code && !state && typeof body.redirectUrl === "string" && body.redirectUrl.trim()) {
      try {
        const parsed = new URL(body.redirectUrl.trim());
        code = parsed.searchParams.get("code") ?? "";
        state = parsed.searchParams.get("state") ?? "";
      } catch {
        return error("redirectUrl is not a valid URL.", 400);
      }
    }
    if (!code || !state) {
      return error("code and state are required (or a redirectUrl containing them).", 400);
    }
    const result = await exchangeAntigravityCode({
      oauth: {
        clientId: config.antigravity.oauthClientId,
        clientSecret: config.antigravity.oauthClientSecret,
        redirectUri: config.antigravity.oauthRedirectUri,
      },
      code,
      state,
    });
    if (result.type === "failed") {
      return error(result.error, 400);
    }
    const email = result.email ?? null;
    const label = result.label.trim() || email || `antigravity-${randomUUID().slice(0, 8)}`;
    const account = store.upsertAccount({
      id: randomUUID(),
      label,
      email,
      refreshToken: result.refreshToken ?? "",
      fingerprintJson: null,
      projectId: result.projectId,
      enabled: true,
    });
    return json({ account }, 201);
  }

  // Enable / disable
  if (method === "PUT" && pathname.startsWith("/api/antigravity/accounts/")) {
    const accountId = accountIdFromPath(pathname, "/api/antigravity/accounts/");
    if (!accountId) return error("Invalid account id.", 400);
    const body = await readBoundedJsonObject(request);
    if (typeof body.enabled !== "boolean") {
      return error("enabled (boolean) is required.", 400);
    }
    const updated = store.setAccountEnabled(accountId, body.enabled);
    if (!updated) return error("Account not found.", 404);
    return json({ account: updated });
  }

  // Delete
  if (method === "DELETE" && pathname.startsWith("/api/antigravity/accounts/")) {
    const accountId = accountIdFromPath(pathname, "/api/antigravity/accounts/");
    if (!accountId) return error("Invalid account id.", 400);
    const removed = store.removeAccount(accountId);
    if (!removed) return error("Account not found.", 404);
    return json({ ok: true });
  }

  return null;
}
