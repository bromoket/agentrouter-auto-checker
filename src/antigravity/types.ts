/**
 * Antigravity direct-account domain types (internal; never persisted raw).
 */

export type AntigravityPoolId = "gemini" | "claude-gpt" | "cli";

export interface AntigravityModelBucket {
  modelId: string;
  /** "WTUS" (IDE) or "REQUESTS" (Gemini CLI). */
  tokenType: string;
  remainingFraction: number;
  remainingAmount?: number | null;
  resetTime: string | null;
}

export interface AntigravityPoolSummary {
  pool: AntigravityPoolId;
  meter: string;
  remainingFraction: number;
  resetTime: string | null;
  modelCount: number;
  source: "server" | "inferred";
  observedAt: string;
}

export interface AntigravityCatalogModel {
  modelId: string;
  displayName: string;
  modelProvider: string;
  quotaRemainingFraction?: number | null;
  quotaResetTime?: string | null;
}

export interface AntigravitySubscriptionInfo {
  currentTierId: string | null;
  currentTierName: string | null;
  paidTierId: string | null;
  availableCredits: number;
  gcpManaged: boolean;
  observedAt: string;
}

/** One full probe result per account. */
export interface AntigravityProbeResult {
  accountId: string;
  label: string;
  projectId: string | null;
  pools: AntigravityPoolSummary[];
  catalog?: AntigravityCatalogModel[] | null;
  subscription: AntigravitySubscriptionInfo | null;
  verificationRequired: boolean;
  probedAt: string;
  error?: string | null;
}

/** Persisted per-account snapshot (credits/tier/pools for UI + event deltas). */
export interface AntigravityAccountSnapshot {
  pools: AntigravityPoolSummary[];
  subscription: AntigravitySubscriptionInfo | null;
  verificationRequired: boolean;
  projectId: string | null;
  catalogAt?: string | null;
  probedAt: string;
  lastError: string | null;
  consecutiveFailures: number;
}

export interface AntigravityAccountRecord {
  id: string;
  label: string;
  email: string | null;
  refreshTokenEnc: string;
  fingerprintJson: string | null;
  projectId: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AntigravityAccountPublic {
  id: string;
  label: string;
  email: string | null;
  projectId: string | null;
  enabled: boolean;
  hasToken: boolean;
  hasFingerprint: boolean;
  createdAt: string;
  updatedAt: string;
  snapshot: AntigravityAccountSnapshot | null;
}

/** Ported model classification from gemini_stack model-metadata.ts (pool only). */
export function classifyAntigravityPool(modelId: string): AntigravityPoolId | "internal" | "unknown" {
  const id = modelId.trim().toLowerCase();
  if (id.startsWith("gemini")) return "gemini";
  if (id.startsWith("claude") || id.startsWith("gpt")) return "claude-gpt";
  if (id.startsWith("tab_") || id.startsWith("chat_")) return "internal";
  return "unknown";
}

export function isInternalBucket(modelId: string): boolean {
  return classifyAntigravityPool(modelId) === "internal";
}
