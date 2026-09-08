/**
 * Command Code HTTP client: bearer-API quota/subscription query.
 *
 * Mirrors the Antigravity client style: narrow typed results, categorized errors,
 * nothing raw logged. Uses the exact endpoints/field names verified in the Command
 * Code quota implementation.
 */

import { COMMANDCODE_API_BASE } from "./constants";

export const COMMANDCODE_USAGE_UNIT = "credits";

export type CommandCodeErrorCategory = "network" | "timeout" | "auth" | "server" | "payload" | "unknown";

export class CommandCodeClientError extends Error {
  readonly category: CommandCodeErrorCategory;
  readonly status: number | null;
  constructor(message: string, options: { category?: CommandCodeErrorCategory; status?: number | null } = {}) {
    super(message);
    this.name = "CommandCodeClientError";
    this.category = options.category ?? "unknown";
    this.status = options.status ?? null;
  }
}

export type HttpFetcher = (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;

export const commandCodeDefaultFetcher: HttpFetcher = async (url, init, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

function toError(e: unknown): CommandCodeClientError {
  if (e instanceof CommandCodeClientError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof DOMException && e.name === "AbortError") {
    return new CommandCodeClientError(message, { category: "timeout" });
  }
  if (e instanceof TypeError) return new CommandCodeClientError(message, { category: "network" });
  return new CommandCodeClientError(message, { category: "unknown" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Normalize a reset timestamp (epoch seconds/ms or ISO string) to epoch ms. */
function normalizeResetAt(value: unknown): string | null {
  let timestamp: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) timestamp = value;
  if (typeof value === "string" && value.length > 0) {
    const trimmed = value.trim();
    timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  }
  if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp < 0) return null;
  const ms = timestamp >= 1e12 ? Math.round(timestamp / 1000) * 1000 : timestamp * 1000;
  return new Date(ms).toISOString();
}

export interface CommandCodeWindowLimit {
  window: "fiveHour" | "weekly";
  used: number;
  cap: number;
  resetAt: string | null;
}

export interface CommandCodeCredits {
  monthlyCredits: number;
  purchasedCredits: number;
  freeCredits: number;
  remainingCredits: number;
  windowLimits: CommandCodeWindowLimit[];
}

export interface CommandCodeSubscription {
  planId: string | null;
  status: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
}

export interface CommandCodeUsageSummary {
  totalCost: number;
  totalCount: number;
  totalTokens: number | null;
}

export interface CommandCodeAccount {
  login: string;
  orgId: string | null;
  keyName?: string;
}

export interface CommandCodeQuota {
  account: CommandCodeAccount;
  credits: CommandCodeCredits | null;
  subscription: CommandCodeSubscription | null;
  summary: CommandCodeUsageSummary | null;
  unavailable: Array<"credits" | "subscription" | "usage">;
}

export type CommandCodeQuotaResult =
  | { ok: true; quota: CommandCodeQuota }
  | { ok: false; error: { kind: CommandCodeErrorCategory; message: string } };

export interface CommandCodeQuotaOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: HttpFetcher;
}

interface HttpErrorShape {
  status: number;
  body: string;
}

function windowLimitsFrom(value: unknown): CommandCodeWindowLimit[] {
  if (!isRecord(value)) return [];
  const limits: CommandCodeWindowLimit[] = [];
  for (const [window, entry] of [["fiveHour", value.fiveHour], ["weekly", value.weekly]] as const) {
    if (!isRecord(entry)) continue;
    const used = numberValue(entry.used);
    const cap = numberValue(entry.cap);
    if (used === undefined || cap === undefined) continue;
    limits.push({ window, used, cap, resetAt: normalizeResetAt(entry.resetAt) });
  }
  return limits;
}

function parseCredits(value: unknown): CommandCodeCredits | null {
  if (!isRecord(value) || !isRecord(value.credits)) return null;
  const credits = value.credits;
  const monthly = numberValue(credits.monthlyCredits);
  const purchased = numberValue(credits.purchasedCredits);
  const free = numberValue(credits.freeCredits);
  if (monthly === undefined && purchased === undefined && free === undefined) return null;
  const m = monthly ?? 0;
  const p = purchased ?? 0;
  const f = free ?? 0;
  return {
    monthlyCredits: m,
    purchasedCredits: p,
    freeCredits: f,
    remainingCredits: m + p + f,
    windowLimits: windowLimitsFrom(value.windowLimits),
  };
}

function parseSubscription(value: unknown): CommandCodeSubscription | null {
  if (!isRecord(value) || !isRecord(value.data)) return null;
  const data = value.data;
  const planId = stringValue(data.planId);
  const status = stringValue(data.status);
  const start = stringValue(data.currentPeriodStart);
  const end = stringValue(data.currentPeriodEnd);
  if (!planId && !status && !start && !end) return null;
  return { planId: planId ?? null, status: status ?? null, currentPeriodStart: start ?? null, currentPeriodEnd: end ?? null };
}

function parseSummary(value: unknown): CommandCodeUsageSummary | null {
  if (!isRecord(value)) return null;
  const totalCost = numberValue(value.totalCost);
  const totalCount = numberValue(value.totalCount);
  if (totalCost === undefined || totalCount === undefined) return null;
  const totalTokens = numberValue(value.totalTokens) ?? numberValue(value.tokens) ?? null;
  return { totalCost, totalCount, totalTokens };
}

function parseWhoami(value: unknown): CommandCodeAccount | null {
  if (!isRecord(value)) return null;
  const org = isRecord(value.org) ? value.org : undefined;
  const user = isRecord(value.user) ? value.user : undefined;
  const login =
    (org ? stringValue(org.login) : undefined) ??
    (user ? (stringValue(user.userName) ?? stringValue(user.name)) : undefined);
  if (!login) return null;
  const orgId = org ? stringValue(org.id) : undefined;
  const keyName = user ? (stringValue(user.keyName) ?? stringValue(user.displayName)) : undefined;
  return { login, orgId: orgId ?? null, ...(keyName ? { keyName } : {}) };
}

function buildUrl(base: string, path: string, params?: Record<string, string | undefined>): string {
  const url = new URL(path, base);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * Query Command Code quota/subscription for one account.
 * Returns a categorized result; never throws, never logs raw payloads.
 */
export async function fetchCommandCodeQuota(options: CommandCodeQuotaOptions): Promise<CommandCodeQuotaResult> {
  const baseUrl = options.baseUrl ?? COMMANDCODE_API_BASE;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetcher = options.fetcher ?? commandCodeDefaultFetcher;
  if (!options.apiKey) {
    return { ok: false, error: { kind: "payload", message: "No Command Code API key found" } };
  }
  const headers = { accept: "application/json", Authorization: `Bearer ${options.apiKey}` };

  const request = async (path: string, params?: Record<string, string | undefined>): Promise<unknown | HttpErrorShape> => {
    try {
      const response = await fetcher(buildUrl(baseUrl, path, params), { method: "GET", headers }, timeoutMs);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { status: response.status, body } satisfies HttpErrorShape;
      }
      return await response.json();
    } catch (e) {
      throw toError(e);
    }
  };

  const safeRequest = async (path: string, params?: Record<string, string | undefined>): Promise<unknown> => {
    try {
      return await request(path, params);
    } catch (e) {
      return { status: 0, body: e instanceof Error ? e.message : String(e), __network: true };
    }
  };

  const isHttpError = (value: unknown): value is HttpErrorShape =>
    isRecord(value) && typeof value.status === "number" && !value.__network;

  const unavailable: Array<"credits" | "subscription" | "usage"> = [];

  try {
    const whoamiRaw = await request("/alpha/whoami");
    if (isHttpError(whoamiRaw)) {
      const status = whoamiRaw.status;
      const category = status === 401 || status === 403 ? "auth" : "server";
      return { ok: false, error: { kind: category, message: `whoami failed (${status})` } };
    }
    const account = parseWhoami(whoamiRaw);
    if (!account) {
      return { ok: false, error: { kind: "payload", message: "Command Code returned an unrecognized account response" } };
    }
    const orgId = account.orgId ?? undefined;

    const [creditsRaw, subscriptionRaw] = await Promise.all([
      safeRequest("/alpha/billing/credits", { orgId }),
      safeRequest("/alpha/billing/subscriptions", { orgId }),
    ]);

    const credits = isHttpError(creditsRaw) ? null : parseCredits(creditsRaw);
    if (!credits) unavailable.push("credits");
    const subscription = isHttpError(subscriptionRaw) ? null : parseSubscription(subscriptionRaw);
    if (!subscription) unavailable.push("subscription");

    const summaryRaw = await safeRequest("/alpha/usage/summary", {
      orgId,
      since: subscription?.currentPeriodStart ?? undefined,
    });
    const summary = isHttpError(summaryRaw) ? null : parseSummary(summaryRaw);
    if (!summary) unavailable.push("usage");

    if (!credits && !subscription && !summary) {
      return { ok: false, error: { kind: "payload", message: "Command Code returned no recognized usage data for the account" } };
    }

    return { ok: true, quota: { account, credits, subscription, summary, unavailable } };
  } catch (e) {
    const err = toError(e);
    return { ok: false, error: { kind: err.category, message: err.message.slice(0, 300) } };
  }
}
