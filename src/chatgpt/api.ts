/**
 * ChatGPT/Codex dashboard API (owner-authenticated via the dashboard session).
 * Mounted under /api/chatgpt/* when ChatGPT monitoring is enabled.
 * Never returns access tokens — only presence flags + snapshot data.
 */

import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { readBoundedJsonObject } from "../bounded-json";
import type { ChatgptCollector } from "./collector";
import type { ChatgptStore } from "./store";

export interface ChatgptApiContext {
  store: ChatgptStore;
  collector: ChatgptCollector | null;
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

export async function handleChatgptApi(
  request: Request,
  url: URL,
  method: string,
  context: ChatgptApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;
  const { config, store, collector } = context;
  const enabled = config.chatgpt.enabled;

  if (method === "GET" && pathname === "/api/chatgpt/overview") {
    return json({
      enabled,
      probeIntervalMinutes: config.chatgpt.probeIntervalMinutes,
      status: collector?.getStatus() ?? null,
      accounts: store.listAccounts(),
    });
  }

  if (method === "POST" && pathname === "/api/chatgpt/probe") {
    if (!collector) return error("ChatGPT collector is not running.", 409);
    const body = await readBoundedJsonObject(request);
    const accountId = typeof body.accountId === "string" && body.accountId.trim()
      ? body.accountId.trim().toLowerCase()
      : null;
    if (accountId) {
      if (!ACCOUNT_ID_PATTERN.test(accountId)) return error("Invalid account id.", 400);
      if (!store.getAccessToken(accountId)) return error("Account not found.", 404);
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

  // Add an account by pasting a ChatGPT/Codex access token (or a JSON blob).
  if (method === "POST" && pathname === "/api/chatgpt/exchange") {
    if (!enabled) return error("ChatGPT monitoring is not enabled.", 503);
    const body = await readBoundedJsonObject(request);
    let accessToken = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 128) : "";
    let email: string | null = null;
    if (!accessToken && typeof body.tokenJson === "string" && body.tokenJson.trim()) {
      try {
        const parsed = JSON.parse(body.tokenJson.trim());
        accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "";
        email = typeof parsed.email === "string" ? parsed.email.trim() : null;
      } catch {
        return error("tokenJson is not valid JSON.", 400);
      }
    }
    if (!accessToken || accessToken.length < 20) {
      return error("A valid ChatGPT/Codex access token is required.", 400);
    }
    const account = store.upsertAccount({
      id: randomUUID(),
      label: label || "ChatGPT",
      email,
      accessToken,
      enabled: true,
    });
    return json({ account }, 201);
  }

  if (method === "PUT" && pathname.startsWith("/api/chatgpt/accounts/")) {
    const accountId = accountIdFromPath(pathname, "/api/chatgpt/accounts/");
    if (!accountId) return error("Invalid account id.", 400);
    const body = await readBoundedJsonObject(request);
    if (typeof body.enabled !== "boolean") return error("enabled (boolean) is required.", 400);
    const updated = store.setAccountEnabled(accountId, body.enabled);
    if (!updated) return error("Account not found.", 404);
    return json({ account: updated });
  }

  if (method === "DELETE" && pathname.startsWith("/api/chatgpt/accounts/")) {
    const accountId = accountIdFromPath(pathname, "/api/chatgpt/accounts/");
    if (!accountId) return error("Invalid account id.", 400);
    const removed = store.removeAccount(accountId);
    if (!removed) return error("Account not found.", 404);
    return json({ ok: true });
  }

  return null;
}
