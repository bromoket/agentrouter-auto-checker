/**
 * ChatGPT quota HTTP client: parse `wham/usage` into normalized quota windows.
 *
 * Mirrors the Command Code / Antigravity client style: narrow typed results,
 * categorized errors, fail-safe parsing, nothing raw logged.
 */

import { CHATGPT_USAGE_ENDPOINT } from "./constants";

export type ChatgptErrorCategory = "network" | "timeout" | "auth" | "server" | "payload" | "unknown";

export class ChatgptClientError extends Error {
  readonly category: ChatgptErrorCategory;
  readonly status: number | null;
  constructor(message: string, options: { category?: ChatgptErrorCategory; status?: number | null } = {}) {
    super(message);
    this.name = "ChatgptClientError";
    this.category = options.category ?? "unknown";
    this.status = options.status ?? null;
  }
}

export type HttpFetcher = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;

export const chatgptDefaultFetcher: HttpFetcher = async (url, init, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(e: unknown): ChatgptClientError {
  if (e instanceof ChatgptClientError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof DOMException && e.name === "AbortError") return new ChatgptClientError(message, { category: "timeout" });
  if (e instanceof TypeError) return new ChatgptClientError(message, { category: "network" });
  return new ChatgptClientError(message, { category: "unknown" });
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Normalize an epoch-seconds reset to an ISO string (or null). */
function resetIso(value: unknown): string | null {
  const v = num(value);
  if (v === null) return null;
  return new Date(v * 1000).toISOString();
}

export interface ChatgptWindow {
  /** Stable bucket id within the provider. */
  bucketId: string;
  /** "weekly" or "5h". */
  windowId: "weekly" | "5h";
  usedPercent: number;
  limitWindowSeconds: number;
  resetAt: string | null;
  meter: string | null;
}

export interface ChatgptUsage {
  planType: string | null;
  email: string | null;
  credits: number | null;
  resetCredits: number | null;
  windows: ChatgptWindow[];
}

/**
 * Parse a raw `wham/usage` payload into normalized quota windows. Never throws.
 * Extracts the primary (weekly) window plus any per-model additional windows.
 */
export function parseChatgptUsage(data: unknown): ChatgptUsage {
  const rec = isRecord(data) ? data : {};
  const rl = isRecord(rec.rate_limit) ? rec.rate_limit : {};
  const primary = isRecord(rl.primary_window) ? rl.primary_window : null;
  const secondary = isRecord(rl.secondary_window) ? rl.secondary_window : null;

  const windows: ChatgptWindow[] = [];
  if (primary) {
    const limitSeconds = num(primary.limit_window_seconds) ?? 604800;
    const windowId = limitSeconds >= 5 * 24 * 3600 ? "weekly" : "5h";
    windows.push({
      bucketId: windowId === "weekly" ? "chatgpt-weekly" : "chatgpt-5h",
      windowId: windowId as "weekly" | "5h",
      usedPercent: num(primary.used_percent) ?? 0,
      limitWindowSeconds: limitSeconds,
      resetAt: resetIso(primary.reset_at),
      meter: "percent",
    });
  }
  if (secondary) {
    const limitSeconds = num(secondary.limit_window_seconds) ?? 604800;
    const windowId = limitSeconds >= 5 * 24 * 3600 ? "weekly" : "5h";
    windows.push({
      bucketId: windowId === "weekly" ? "chatgpt-weekly-secondary" : "chatgpt-5h-secondary",
      windowId: windowId as "weekly" | "5h",
      usedPercent: num(secondary.used_percent) ?? 0,
      limitWindowSeconds: limitSeconds,
      resetAt: resetIso(secondary.reset_at),
      meter: "percent",
    });
  }

  const additional = Array.isArray(rec.additional_rate_limits) ? rec.additional_rate_limits : [];
  for (const raw of additional) {
    if (!isRecord(raw)) continue;
    const limitName = typeof raw.limit_name === "string" ? raw.limit_name : "additional";
    const inner = isRecord(raw.rate_limit) ? raw.rate_limit : {};
    const p = isRecord(inner.primary_window) ? inner.primary_window : null;
    const s = isRecord(inner.secondary_window) ? inner.secondary_window : null;
    if (p) {
      const limitSeconds = num(p.limit_window_seconds) ?? 18000;
      const windowId = limitSeconds >= 5 * 24 * 3600 ? "weekly" : "5h";
      windows.push({
        bucketId: `chatgpt-${windowId}-${limitName}`,
        windowId: windowId as "weekly" | "5h",
        usedPercent: num(p.used_percent) ?? 0,
        limitWindowSeconds: limitSeconds,
        resetAt: resetIso(p.reset_at),
        meter: limitName,
      });
    }
    if (s) {
      const limitSeconds = num(s.limit_window_seconds) ?? 604800;
      const windowId = limitSeconds >= 5 * 24 * 3600 ? "weekly" : "5h";
      windows.push({
        bucketId: `chatgpt-${windowId}-${limitName}-sec`,
        windowId: windowId as "weekly" | "5h",
        usedPercent: num(s.used_percent) ?? 0,
        limitWindowSeconds: limitSeconds,
        resetAt: resetIso(s.reset_at),
        meter: limitName,
      });
    }
  }

  const credits = isRecord(rec.credits) ? num(rec.credits) : num(rec.credits);
  let resetCredits: number | null = null;
  const rrc = rec.rate_limit_reset_credits;
  if (typeof rrc === "number") {
    resetCredits = rrc;
  } else if (isRecord(rrc)) {
    for (const k of ["count", "available", "remaining", "amount"]) {
      const v = num(rrc[k]);
      if (v !== null && v >= 0) {
        resetCredits = v;
        break;
      }
    }
  }


  return {
    planType: typeof rec.plan_type === "string" ? rec.plan_type : null,
    email: typeof rec.email === "string" ? rec.email : null,
    credits,
    resetCredits,
    windows,
  };
}

export interface ChatgptUsageOptions {
  accessToken: string;
  timeoutMs?: number;
  fetcher?: HttpFetcher;
}

export type ChatgptUsageResult =
  | { ok: true; usage: ChatgptUsage }
  | { ok: false; error: { kind: ChatgptErrorCategory; message: string } };

/**
 * Query `wham/usage` for one ChatGPT/Codex account. Categorized result; never throws.
 */
export async function fetchChatgptUsage(options: ChatgptUsageOptions): Promise<ChatgptUsageResult> {
  if (!options.accessToken) {
    return { ok: false, error: { kind: "payload", message: "No ChatGPT access token found" } };
  }
  const fetcher = options.fetcher ?? chatgptDefaultFetcher;
  try {
    const response = await fetcher(
      CHATGPT_USAGE_ENDPOINT,
      {
        method: "GET",
        headers: { accept: "application/json", Authorization: `Bearer ${options.accessToken}` },
      },
      options.timeoutMs ?? 15_000,
    );
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: { kind: "auth", message: "ChatGPT rejected the access token" } };
    }
    if (!response.ok) {
      return { ok: false, error: { kind: "server", message: `wham/usage HTTP ${response.status}` } };
    }
    const data = await response.json();
    return { ok: true, usage: parseChatgptUsage(data) };
  } catch (e) {
    const err = toError(e);
    return { ok: false, error: { kind: err.category, message: err.message.slice(0, 300) } };
  }
}
