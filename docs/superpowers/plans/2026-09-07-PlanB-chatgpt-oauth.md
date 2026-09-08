# Plan B — ChatGPT/OpenAI OAuth + Quota Monitoring

> **For agentic workers:** REQUIRED SUB-SKILL: Use skill://subagent-driven-development (recommended) or skill://executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ChatGPT/OpenAI credentials exactly like Antigravity — OAuth (PKCE) add-account, encrypted refresh-token store, periodic subscription/quota probe, dashboard page, and quota/reset events into the Observatory pipeline without spamming.

**Architecture:** A new `src/chatgpt/` module mirrors `src/antigravity/`. Verified from Codex source: authorize at `https://auth.openai.com/oauth/authorize` (`response_type=code`, PKCE S256, `scope="openid profile email offline_access api.connectors.read api.connectors.invoke"`), exchange/refresh at `POST https://auth.openai.com/oauth/token`. The client-id constant is the known public Codex client-id `app_EMoamEEZ73f0CkXaXp7hrann` (decision A). The quota poll hits `https://chatgpt.com/backend-api/wham/usage` and fails safe when the surface is unreachable.

**Tech Stack:** Bun, TypeScript, AES-256-GCM crypto (reuse the Antigravity `./crypto` pattern via a shared helper or a close copy), SQLite, Playwright not required (HTTP only).

## Global Constraints

- Bun is the only supported package manager/runtime. Worker/host scripts are Node-compatible `.mjs`.
- Refresh tokens are encrypted at rest (AES-256-GCM). Raw tokens never logged or stored in Git; never returned by the API (presence flags only).
- The client-id is a known-but-unofficial public id; treat it as a constant and fail safe on auth errors (no hard-coded undocumented reset-token contract).
- `bun run typecheck` passes; `bun test` passes; no secrets in logs, DB rows, API responses, or Telegram.
- New Dashboard mount is owner-authenticated (existing dashboard session) and loopback-only.
- TypeScript `strict`.

---

### Task B1: ChatGPT constants

**Files:**
- Create: `src/chatgpt/constants.ts`
- Test: (covered by other tasks; a minimal sanity test is optional)

**Interfaces:**
- Produces: `CHATGPT_CLIENT_ID`, `CHATGPT_REDIRECT_URI`, `CHATGPT_SCOPES`, `CHATGPT_AUTH_ENDPOINT`, `CHATGPT_TOKEN_ENDPOINT`, `CHATGPT_USAGE_ENDPOINT`.

- [ ] **Step 1: Implement constants**

```ts
// src/chatgpt/constants.ts
/** Known Codex public client-id (third-party; unofficial/unsupported). */
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Default loopback callback (Codex uses a local server; keep it configurable). */
export const CHATGPT_REDIRECT_URI = "http://localhost:5221/oauth-callback";

export const CHATGPT_SCOPES: readonly string[] = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "api.connectors.read",
  "api.connectors.invoke",
];

export const CHATGPT_AUTH_ENDPOINT = "https://auth.openai.com/oauth/authorize";
export const CHATGPT_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
/** Undocumented internal usage endpoint; fail safe when unreachable. */
export const CHATGPT_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
```

- [ ] **Step 2: Commit**

```bash
git add src/chatgpt/constants.ts
git commit -m "feat(chatgpt): add OpenAI OAuth and usage endpoint constants"
```

---

### Task B2: ChatGPT OAuth (PKCE) + HTTP client

**Files:**
- Create: `src/chatgpt/oauth.ts`
- Create: `src/chatgpt/client.ts`
- Test: `src/chatgpt/oauth.test.ts`, `src/chatgpt/client.test.ts`

**Interfaces:**
- Produces:
  - `authorizeChatgptStart(options): { url; state; expiresInSec }`
  - `exchangeChatgptCode(options): Promise<ChatgptExchangeResult>`
  - `rotateChatgptAccessToken(options): Promise<{ accessToken; expiresInSec; refreshToken | null }>`
  - `fetchChatgptUsage(accessToken, accountId?, headers?): Promise<ChatgptUsageResult>`

- [ ] **Step 1: Write the failing test**

```ts
// src/chatgpt/oauth.test.ts
import { describe, expect, test } from "bun:test";
import { authorizeChatgptStart, exchangeChatgptCode } from "./oauth";
import type { ChatgptOauthConfig } from "./client";

const oauth: ChatgptOauthConfig = { clientId: "app_EMoamEEZ73f0CkXaXp7hrann", clientSecret: null, redirectUri: "http://localhost:5221/oauth-callback" };

describe("ChatGPT OAuth PKCE", () => {
  test("authorize start builds a valid auth.openai.com URL", () => {
    const start = authorizeChatgptStart({ oauth, label: "Main" });
    const url = new URL(start.url);
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(start.expiresInSec).toBeGreaterThan(0);
  });

  test("exchange requires a fresh state and returns tokens", async () => {
    const start = authorizeChatgptStart({ oauth, label: "Main" });
    const state = start.state;
    // Codex token exchange is not stubbed here; validate the state round-trips
    // and that exchange rejects a replay of the same state.
  });
});
```

```ts
// src/chatgpt/client.test.ts
import { describe, expect, test } from "bun:test";
import { parseChatgptUsage, ChatgptClientError } from "./client";

describe("ChatGPT usage parser", () => {
  test("parses rolling 5h and weekly quota windows", () => {
    const out = parseChatgptUsage({
      data: {
        limits: [
          { name: "ChatGPT 5h Limit", used: 60, max: 100, reset_at: "2026-09-07T18:00:00Z" },
          { name: "ChatGPT Weekly Limit", used: 300, max: 500, reset_at: "2026-09-14T00:00:00Z" },
        ],
      },
    });
    expect(out).toHaveLength(2);
    expect(out[0].windowId).toBe("5h");
    expect(out[0].remainingFraction).toBeCloseTo(0.4, 2);
    expect(out[1].windowId).toBe("weekly");
  });

  test("fails safe on an unreachable/unexpected shape", () => {
    expect(parseChatgptUsage({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/chatgpt/oauth.test.ts src/chatgpt/client.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement the client**

`src/chatgpt/client.ts`:

```ts
import type { HttpFetcher } from "../antigravity/client";

export interface ChatgptOauthConfig {
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
}

export interface ChatgptTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresInSec: number;
  email: string | null;
}

export class ChatgptClientError extends Error {
  readonly category: "network" | "timeout" | "auth" | "server" | "payload" | "unknown";
  readonly status: number | null;
  constructor(message: string, options: { category?: ChatgptClientError["category"]; status?: number | null } = {}) {
    super(message);
    this.name = "ChatgptClientError";
    this.category = options.category ?? "unknown";
    this.status = options.status ?? null;
  }
}

export interface ChatgptUsageWindow {
  windowId: "5h" | "weekly" | "unknown";
  usedFraction: number;
  remainingFraction: number;
  usedUnits: number | null;
  totalUnits: number | null;
  resetAt: string | null;
}

/** Parse a `wham/usage`-style payload into normalized windows. Never throws. */
export function parseChatgptUsage(data: unknown): ChatgptUsageWindow[] {
  const rec = (data ?? {}) as Record<string, unknown>;
  const payload = (rec.data && typeof rec.data === "object" ? rec.data : rec) as Record<string, unknown>;
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const out: ChatgptUsageWindow[] = [];
  for (const raw of limits) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name.toLowerCase() : "";
    const used = Number(item.used ?? item.used_amount ?? item.usage);
    const max = Number(item.max ?? item.limit ?? item.amount);
    const windowId = name.includes("5 hour") || name.includes("5h")
      ? "5h"
      : name.includes("week")
        ? "weekly"
        : "unknown";
    if (!Number.isFinite(max) || max <= 0) continue;
    const usedFraction = Number.isFinite(used) && used >= 0 ? Math.min(1, used / max) : 0;
    out.push({
      windowId,
      usedFraction: Math.round(usedFraction * 1_000_000) / 1_000_000,
      remainingFraction: Math.round((1 - usedFraction) * 1_000_000) / 1_000_000,
      usedUnits: Number.isFinite(used) ? used : null,
      totalUnits: max,
      resetAt: typeof item.reset_at === "string" ? item.reset_at : null,
    });
  }
  return out;
}
```

- [ ] **Step 4: Implement the OAuth module**

`src/chatgpt/oauth.ts` (mirror `antigravity/oauth.ts`): PKCE, single-use state map, build `authorizeChatgptStart`, `exchangeChatgptCode` posting to `CHATGPT_TOKEN_ENDPOINT` with `grant_type=authorization_code&code=...&redirect_uri=...&client_id=...&code_verifier=...`; `rotateChatgptAccessToken` with `grant_type=refresh_token`. Reuse the base64url PKCE helpers and `defaultFetcher` from `../antigravity/client`.

- [ ] **Step 5: Run tests + typecheck**

Run:
```bash
bun test src/chatgpt/oauth.test.ts src/chatgpt/client.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/chatgpt/client.ts src/chatgpt/oauth.ts src/chatgpt/client.test.ts src/chatgpt/oauth.test.ts
git commit -m "feat(chatgpt): add OAuth PKCE flow and usage parser"
```

---

### Task B3: ChatGPT store (encrypted tokens)

**Files:**
- Create: `src/chatgpt/crypto.ts`
- Create: `src/chatgpt/store.ts`
- Test: `src/chatgpt/store.test.ts`

**Interfaces:**
- Produces: `ChatgptStore` (list/get/upsert/getRefreshToken/setEnabled/remove/saveSnapshot/close). Mirrors `AntigravityStore`. Uses AES-256-GCM. A shared crypto helper is preferred — add `src/chatgpt/crypto.ts` as a thin copy, or import `./crypto` from antigravity if it becomes a shared module.

- [ ] **Step 1: Write the failing test**

```ts
// src/chatgpt/store.test.ts
import { describe, expect, test } from "bun:test";
import { ChatgptStore } from "./store";

describe("ChatgptStore", () => {
  test("encrypts refresh token at rest and round-trips it", () => {
    const store = new ChatgptStore(":memory:", "a".repeat(32));
    const acct = store.upsertAccount({ id: "chatgpt-1", label: "Main", email: "a@b.c", refreshToken: "sk-secret-token" });
    expect(acct.refreshToken).toBeUndefined(); // never returned
    expect(acct.hasToken).toBe(true);
    expect(store.getRefreshToken("chatgpt-1")).toBe("sk-secret-token");
    store.close();
  });

  test("listAccounts hides the encrypted payload", () => {
    const store = new ChatgptStore(":memory:", "a".repeat(32));
    store.upsertAccount({ id: "chatgpt-2", label: "Second", refreshToken: "x".repeat(40) });
    const listed = store.listAccounts();
    expect(listed[0].refreshToken).toBeUndefined();
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/chatgpt/store.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement crypto + store**

`src/chatgpt/crypto.ts` — identical to `src/antigravity/crypto.ts` (export `deriveEncryptionKey`, `encryptToken`, `decryptToken`, prefix `v1.`).

`src/chatgpt/store.ts` — copy `AntigravityStore`, rename table to `chatgpt_accounts`/`chatgpt_snapshots`, type namespace `Chatgpt`, `upsertAccount` calls `validateId` with a `chatgpt-` prefix allowance.

- [ ] **Step 4: Run test + typecheck**

Run:
```bash
bun test src/chatgpt/store.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chatgpt/crypto.ts src/chatgpt/store.ts src/chatgpt/store.test.ts
git commit -m "feat(chatgpt): add encrypted token store"
```

---

### Task B4: ChatGPT collector (subscription + quota events)

**Files:**
- Create: `src/chatgpt/collector.ts`
- Test: `src/chatgpt/collector.test.ts`

**Interfaces:**
- Consumes: `ChatgptStore`, an ingest sink `ChatgptIngestSink` (mirror `AntigravityIngestSink`), `ChatgptOauthConfig`.
- Produces: `ChatgptCollector` (`start`, `stop`, `probeAll`, `probeAccountOnce`, `getStatus`) emitting `quota_reset`, `reset_credit_increased`/`reset_credit_decreased`, and quota warning/critical/exhausted events.

- [ ] **Step 1: Write the failing test**

```ts
// src/chatgpt/collector.test.ts
import { describe, expect, test } from "bun:test";
import { probeToEvents } from "./collector";

describe("ChatGPT collector event derivation", () => {
  test("emits reset_credit_increased only when credits rise", () => {
    const events = probeToEvents({ previousCredits: 1, newCredits: 2, hostId: "h", accountId: "c1" });
    expect(events.some((e) => e.eventType === "reset_credit_increased")).toBe(true);
  });
  test("does not emit an increase when credits unchanged or lower", () => {
    const events = probeToEvents({ previousCredits: 2, newCredits: 2, hostId: "h", accountId: "c1" });
    expect(events.some((e) => e.eventType === "reset_credit_increased")).toBe(false);
  });
  test("derives quota_status from remaining fraction thresholds", () => {
    expect(quotaEventForFraction(0.99).eventType).toBe("quota_ok");
    expect(quotaEventForFraction(0.15).eventType).toBe("quota_warning");
    expect(quotaEventForFraction(0.05).eventType).toBe("quota_critical");
    expect(quotaEventForFraction(0.01).eventType).toBe("quota_exhausted");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/chatgpt/collector.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement collector**

`src/chatgpt/collector.ts` — mirror `AntigravityCollector`: per-account access-token cache with skew, poll loop, `probeAccountOnce` refreshing the token and calling `fetchChatgptUsage`, aggregating windows into quota observations, deriving credit deltas into `reset_credit_*` events, and persisting a snapshot. Export `probeToEvents` and `quotaEventForFraction` (pure helpers) for tests.

```ts
export function quotaEventForFraction(remainingFraction: number, hostId: string, accountId: string) {
  if (remainingFraction <= 0.02) return { eventType: "quota_exhausted", severity: "critical" };
  if (remainingFraction <= 0.10) return { eventType: "quota_critical", severity: "critical" };
  if (remainingFraction <= 0.20) return { eventType: "quota_warning", severity: "warning" };
  return { eventType: "quota_ok", severity: "info" };
}
```

- [ ] **Step 4: Run test + typecheck**

Run:
```bash
bun test src/chatgpt/collector.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chatgpt/collector.ts src/chatgpt/collector.test.ts
git commit -m "feat(chatgpt): add subscription/quota collector with event derivation"
```

---

### Task B5: ChatGPT config + index wiring + API

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Create: `src/chatgpt/api.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: `AppConfig.chatgpt` block.
- Produces: `ChatgptApiContext` mounted at `/api/chatgpt/*`; config env `CHATGPT_ENABLED`, `CHATGPT_DB_PATH`, `CHATGPT_ENC_KEY`, `CHATGPT_OAUTH_CLIENT_ID`, `CHATGPT_OAUTH_CLIENT_SECRET`, `CHATGPT_OAUTH_REDIRECT_URI`, `CHATGPT_PROBE_INTERVAL_MINUTES`, `CHATGPT_PROBE_TIMEOUT_MS`.

- [ ] **Step 1: Write failing config test**

```ts
// src/config.test.ts
test("loads ChatGPT config when enabled and requires observatory + key", () => {
  // Assert: with CHATGPT_ENABLED=true and no CHATGPT_ENC_KEY -> throws; with key -> populated.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL — `config.chatgpt` undefined.

- [ ] **Step 3: Implement config**

`src/config.ts` — add `ChatgptConfig` interface and `loadChatgptConfig(dataDir, observatory, agentRouterDbPath)`:

```ts
export interface ChatgptConfig {
  enabled: boolean;
  dbPath: string;
  encryptionKey: string | null;
  probeIntervalMinutes: number;
  probeTimeoutMs: number;
  oauthClientId: string;
  oauthClientSecret: string | null;
  oauthRedirectUri: string;
}
```

Validation mirrors `loadAntigravityConfig`: requires `observatory.enabled`, a 32-byte `encryptionKey`, and allows `oauthClientSecret: null` (the known Codex public client-id needs no secret; refresh uses the same client-id). Add `chatgpt` to `AppConfig` and `loadConfig()`.

- [ ] **Step 4: Implement index wiring + API**

`src/index.ts` — create `ChatgptStore`/`ChatgptCollector` when `config.chatgpt.enabled && observatoryCoordinator && encryptionKey`, mount `/api/chatgpt/*` via `handleChatgptApi`, and start/stop with the other loops.

`src/chatgpt/api.ts` — mirror `handleAntigravityApi`: `/api/chatgpt/overview`, `/api/chatgpt/probe`, `/api/chatgpt/oauth/start`, `/api/chatgpt/oauth/exchange`, `/api/chatgpt/accounts/:id` (PUT/DELETE). Never return refresh tokens.

- [ ] **Step 5: Run tests + typecheck**

Run:
```bash
bun test src/config.test.ts
bun run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/config.test.ts src/index.ts src/chatgpt/api.ts
git commit -m "feat(chatgpt): wire config, collector lifecycle, and dashboard API"
```

---

### Task B6: Dashboard page

**Files:**
- Create: `src/web/chatgpt.js`
- Create: `src/web/chatgpt.css`
- Modify: `src/web/dashboard.html`, `src/web/dashboard.js` (mount + nav + add-account flow)
- Modify: `src/dashboard.ts` (serve `/chatgpt.css`, `/chatgpt.js`, route mount)

**Interfaces:**
- Consumes: `/api/chatgpt/overview`, `/api/chatgpt/probe`, `/api/chatgpt/oauth/*`.
- Produces: chatgpt dashboard page with add-account (OAuth), per-account quota bars, reset-credit, health, and manual probe. Mirrors the Antigravity page.

- [ ] **Step 1: Implement page + mount**

Model the chatgpt page on `src/web/antigravity.js` + `antigravity.css`. Mount under the dashboard shell and add a nav entry. Serve the static assets in `src/dashboard.ts` analogous to the antigravity ones (lines 270-275 pattern).

- [ ] **Step 2: Verify with a dev run**

Run: `bun run dashboard` (or `bun run start --dashboard`), open `http://127.0.0.1:3100/`, navigate to the ChatGPT page. Confirm the add-account OAuth button starts a flow and the status panel renders.

- [ ] **Step 3: Commit**

```bash
git add src/web/chatgpt.js src/web/chatgpt.css src/web/dashboard.html src/web/dashboard.js src/dashboard.ts
git commit -m "feat(chatgpt): add dashboard page with OAuth add-account and quota view"
```

---

### Task B7: Anti-spam confirmation + full verification

- [ ] **Step 1: Confirm event dedup**

Verify ChatGPT quota events flow through the existing `ObservatoryNotificationPolicy` with defaults: warning/critical/exhausted once per arm epoch; reset_credit only Telegram on increase; grant received once per grant (dedupe by fingerprint). Add any missing policy coverage in `src/observatory/policies.test.ts`.

- [ ] **Step 2: Full suite**

Run: `bun test`
Expected: zero failures (12 POSIX skips on Windows expected).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Confirm no secrets leak**

Run a static grep for `refreshToken`/access token literals in logs/API/Telegram paths; confirm the ChatgptStore and API never return `refreshToken`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: verify Plan B ChatGPT monitoring end to end" || echo "nothing new to commit"
```
