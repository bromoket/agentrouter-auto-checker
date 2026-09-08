/**
 * Command Code monitoring constants.
 *
 * Verified against the Command Code provider source / live quota impl:
 * - OAuth is a browser-assisted API-key retrieval flow (no PKCE; keys don't expire).
 * - Quota is queried from api.commandcode.ai with `Authorization: Bearer <apiKey>`.
 */

/** Base URL for all Command Code bearer-API calls. */
export const COMMANDCODE_API_BASE = "https://api.commandcode.ai";

/** Studio auth base for the browser-assisted key retrieval flow. */
export const COMMANDCODE_STUDIO_BASE_URL = "https://commandcode.ai";

/** Default local callback port (Command Code CLI-compatible). */
export const COMMANDCODE_AUTH_DEFAULT_PORT = 5959;
/** How many consecutive ports to try when the default is occupied. */
export const COMMANDCODE_AUTH_PORT_RANGE = 10;

/** Far-future expiry (ms): Command Code API keys do not expire. */
export const COMMANDCODE_TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/** Observatory provider id for Command Code subscription quota. */
export const COMMANDCODE_OBSERVATORY_PROVIDER = "commandcode";
/** Collector source tag recorded on observations/events. */
export const COMMANDCODE_PROBE_SOURCE = "commandcode-direct";

/** Plan without API access (Go) — used to skip/annotate accounts. */
export const COMMANDCODE_GO_PLAN_ID = "go";

/** Low/critical/exhausted remaining-fraction thresholds (matches Observatory defaults). */
export const COMMANDCODE_LOW_REMAINING_FRACTION = 0.2;
export const COMMANDCODE_CRITICAL_REMAINING_FRACTION = 0.1;
export const COMMANDCODE_EXHAUSTED_REMAINING_FRACTION = 0.02;
