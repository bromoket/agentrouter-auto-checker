/**
 * ChatGPT / OpenAI Codex quota monitoring constants.
 *
 * Verified: `chatgpt.com/backend-api/wham/usage` responds to a ChatGPT Bearer token
 * with `plan_type`, `rate_limit.primary_window` (weekly 7d), per-model
 * `additional_rate_limits` (primary 5h + secondary weekly), and credits/reset credits.
 */

export const CHATGPT_OBSERVATORY_PROVIDER = "openai-codex";
export const CHATGPT_PROBE_SOURCE = "chatgpt-direct";

export const CHATGPT_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";

/** Main rate-limit window (7 days) is the weekly quota meter. */
export const CHATGPT_WEEKLY_BUCKET = "chatgpt-weekly";
/** Per-model additional window (5h) bucket. */
export const CHATGPT_5H_BUCKET = "chatgpt-5h";

export const CHATGPT_LOW_REMAINING_FRACTION = 0.2;
export const CHATGPT_CRITICAL_REMAINING_FRACTION = 0.1;
export const CHATGPT_EXHAUSTED_REMAINING_FRACTION = 0.02;
