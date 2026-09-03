/**
 * Pure aggregation helpers: raw Antigravity quota buckets -> per-pool summaries.
 * Ported logic from gemini_stack plugin/quota.ts + plugin/model-metadata.ts.
 */

import type {
  AntigravityModelBucket,
  AntigravityPoolId,
  AntigravityPoolSummary,
} from "./types";

export function parseFraction(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(1, Math.max(0, value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.min(1, Math.max(0, parsed));
    }
  }
  return null;
}

export function normalizeIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Convert a raw server quota bucket into the normalized internal model.
 * Buckets with an unparsable fraction are skipped (never guessed).
 */
export function normalizeModelBucket(raw: {
  tokenType?: unknown;
  modelId?: unknown;
  remainingFraction?: unknown;
  remainingAmount?: unknown;
  resetTime?: unknown;
}): AntigravityModelBucket | null {
  const tokenType = typeof raw.tokenType === "string" ? raw.tokenType : "WTUS";
  const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
  if (!modelId) return null;
  const remainingFraction = parseFraction(raw.remainingFraction);
  if (remainingFraction === null) return null;
  const remainingAmount =
    raw.remainingAmount !== undefined && raw.remainingAmount !== null
      ? Number(raw.remainingAmount)
      : null;
  return {
    modelId,
    tokenType,
    remainingFraction,
    remainingAmount: Number.isFinite(remainingAmount ?? 0) ? remainingAmount : null,
    resetTime: normalizeIsoTimestamp(typeof raw.resetTime === "string" ? raw.resetTime : null),
  };
}

/**
 * Aggregate raw WTUS buckets into gemini + claude-gpt pool summaries.
 * Pool remaining = MAX remaining fraction across non-internal members; pool reset =
 * the resetTime carried by that member. modelCount excludes tab_* and chat_* internals.
 */
export function aggregatePoolBuckets(
  buckets: AntigravityModelBucket[],
  observedAtIso: string,
): AntigravityPoolSummary[] {
  const members: Record<AntigravityPoolId, AntigravityModelBucket[]> = {
    gemini: [],
    "claude-gpt": [],
    cli: [],
  };
  for (const bucket of buckets) {
    if (bucket.modelId.startsWith("tab_") || bucket.modelId.startsWith("chat_")) continue;
    const lower = bucket.modelId.toLowerCase();
    if (lower.startsWith("gemini")) {
      members.gemini.push(bucket);
    } else if (lower.startsWith("claude") || lower.startsWith("gpt")) {
      members["claude-gpt"].push(bucket);
    } else {
      members.cli.push(bucket);
    }
  }
  const summaries: AntigravityPoolSummary[] = [];
  const pools: AntigravityPoolId[] = ["gemini", "claude-gpt"];
  for (const pool of pools) {
    const list = members[pool];
    if (list.length === 0) continue;
    const maxMember = list.reduce((best, candidate) =>
      candidate.remainingFraction > best.remainingFraction ? candidate : best,
    );
    summaries.push({
      pool,
      meter: maxMember.tokenType || "WTUS",
      remainingFraction: maxMember.remainingFraction,
      resetTime: maxMember.resetTime,
      modelCount: list.length,
      source: "server",
      observedAt: observedAtIso,
    });
  }
  return summaries;
}

/**
 * Aggregate CLI-style REQUESTS buckets (Gemini CLI path) into a single 'cli' summary.
 */
export function aggregateCliBuckets(
  buckets: AntigravityModelBucket[],
  observedAtIso: string,
): AntigravityPoolSummary | null {
  const valid = buckets.filter(
    (bucket) => !bucket.modelId.startsWith("tab_") && !bucket.modelId.startsWith("chat_"),
  );
  if (valid.length === 0) return null;
  const maxMember = valid.reduce((best, candidate) =>
    candidate.remainingFraction > best.remainingFraction ? candidate : best,
  );
  return {
    pool: "cli",
    meter: "REQUESTS",
    remainingFraction: maxMember.remainingFraction,
    resetTime: maxMember.resetTime,
    modelCount: valid.length,
    source: "server",
    observedAt: observedAtIso,
  };
}

/**
 * Derive quota observation status from remaining fraction (mirrors observatory classifier).
 */
export function deriveQuotaStatus(remainingFraction: number): string {
  if (remainingFraction <= 0.02) return "exhausted";
  if (remainingFraction <= 0.1) return "critical";
  if (remainingFraction <= 0.2) return "warning";
  return "ok";
}
