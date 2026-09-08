/**
 * Command Code dashboard API (owner-authenticated via the dashboard session).
 * Mounted under /api/commandcode/* when Command Code monitoring is enabled.
 * Never returns API keys — only presence flags + snapshot data.
 */

import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config";
import { readBoundedJsonObject } from "../bounded-json";
import type { CommandCodeCollector } from "./collector";
import type { CommandCodeStore } from "./store";

export interface CommandCodeApiContext {
  store: CommandCodeStore;
  collector: CommandCodeCollector | null;
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

export async function handleCommandCodeApi(
  request: Request,
  url: URL,
  method: string,
  context: CommandCodeApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;
  const { config, store, collector } = context;
  const enabled = config.commandcode.enabled;

  if (method === "GET" && pathname === "/api/commandcode/overview") {
    return json({
      enabled,
      probeIntervalMinutes: config.commandcode.probeIntervalMinutes,
      status: collector?.getStatus() ?? null,
      accounts: store.listAccounts(),
    });
  }

  if (method === "POST" && pathname === "/api/commandcode/probe") {
    if (!collector) return error("Command Code collector is not running.", 409);
    const body = await readBoundedJsonObject(request);
    const accountId = typeof body.accountId === "string" && body.accountId.trim()
      ? body.accountId.trim().toLowerCase()
      : null;
    if (accountId) {
      if (!ACCOUNT_ID_PATTERN.test(accountId)) return error("Invalid account id.", 400);
      if (!store.getApiKey(accountId)) return error("Account not found.", 404);
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

  // Browser-assisted API-key retrieval is a localhost callback flow, so it is
  // handled client-side (dashboard JS opens the Studio URL; the key is captured by
  // the server's local auth server). For the dashboard API we expose the paste path
  // in /oauth/exchange. This route just confirms the flow and returns guidance.
  if (method === "POST" && pathname === "/api/commandcode/oauth/start") {
    if (!enabled) return error("Command Code monitoring is not enabled.", 503);
    return json({
      hint: "Command Code uses a browser-assisted API-key flow. Open the Command Code Studio auth URL in your browser, then paste the API key via the exchange step (or use the server-side browser capture).",
      expiresInSec: 900,
    });
  }

  // Manual paste fallback / exchange: accepts the raw API key directly.
  if (method === "POST" && pathname === "/api/commandcode/oauth/exchange") {
    if (!enabled) return error("Command Code monitoring is not enabled.", 503);
    const body = await readBoundedJsonObject(request);
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const label = typeof body.label === "string" ? body.label.trim().slice(0, 128) : "";
    if (!apiKey || apiKey.length < 8) {
      return error("A valid Command Code API key is required (or a redirect URL).", 400);
    }
    const account = store.upsertAccount({
      id: randomUUID(),
      label: label || `commandcode-${randomUUID().slice(0, 8)}`,
      email: null,
      apiKey,
      enabled: true,
    });
    return json({ account }, 201);
  }

  if (method === "PUT" && pathname.startsWith("/api/commandcode/accounts/")) {
    const accountId = accountIdFromPath(pathname, "/api/commandcode/accounts/");
    if (!accountId) return error("Invalid account id.", 400);
    const body = await readBoundedJsonObject(request);
    if (typeof body.enabled !== "boolean") return error("enabled (boolean) is required.", 400);
    const updated = store.setAccountEnabled(accountId, body.enabled);
    if (!updated) return error("Account not found.", 404);
    return json({ account: updated });
  }

  if (method === "DELETE" && pathname.startsWith("/api/commandcode/accounts/")) {
    const accountId = accountIdFromPath(pathname, "/api/commandcode/accounts/");
    if (!accountId) return error("Invalid account id.", 400);
    const removed = store.removeAccount(accountId);
    if (!removed) return error("Account not found.", 404);
    return json({ ok: true });
  }

  return null;
}
