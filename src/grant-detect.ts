import { createDeterministicFingerprint } from "./observatory/events";

/**
 * Grant detection. AgentRouter grants land as a balance *increase* (the typical
 * consumption path only ever lowers balance), so any rise above a small epsilon is
 * a grant. Epsilon guards against floating-point noise and sub-cent rounding.
 */
export function isGrant(input: { before: number; after: number; epsilon?: number }): boolean {
  const epsilon = input.epsilon ?? 0.01;
  return Number.isFinite(input.before) &&
    Number.isFinite(input.after) &&
    input.after > input.before + epsilon;
}

/**
 * Stable fingerprint so re-polling the same grant never re-notifies (dedupe).
 * Includes account + balance-after + amount + day so a genuinely new grant (or a
 * different amount on a later day) produces its own fingerprint.
 */
export function grantFingerprint(input: {
  accountId: string;
  balanceAfter: number;
  amount: number;
  day?: string;
}): string {
  const day = input.day ?? new Date().toISOString().slice(0, 10);
  const rounded = Math.round(input.balanceAfter * 100) / 100;
  return createDeterministicFingerprint(
    "agentrouter_grant_received",
    input.accountId,
    day,
    rounded,
    input.amount,
  );
}
