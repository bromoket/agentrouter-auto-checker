# AI Fleet Observatory — Persistent Sessions, Grant Cadence & ChatGPT OAuth

## Status: Design for review

## Purpose

Unify the Observatory's account monitoring into two clean, decoupled behaviors and
add ChatGPT/OpenAI credential monitoring alongside Antigravity:

1. **AgentRouter**: constant (1-minute) read-only polling of all current account data
   using a live persistent browser session, plus a single logout→login grant cycle
   every 24h (configurable, default 12h) to claim daily/random grants.
2. **ChatGPT OAuth**: add ChatGPT/OpenAI credentials the same way Antigravity is
   added — OAuth (PKCE) → store refresh token encrypted → poll subscription/quota →
   surface in dashboard → emit quota/reset events → Telegram with anti-spam.

## Verified facts (research + repo)

- AgentRouter grants are `$25` (observed via daily sign-in log `每日签到成功，增加额度 ＄25`),
  but can be `$1000` or random amounts. Grants land as a **balance increase** (a rise,
  not the typical consumption-driven drop).
- ChatGPT/OpenAI uses **OAuth 2.0 Authorization Code + PKCE**; access token sent as
  Bearer; refresh-token support documented in `codex`; credentials live in `auth.json`
  and can be refreshed near expiry. This matches the Antigravity "add account" model.
- **Verified from Codex source** (`codex-rs/login/src/server.rs`): authorize URL is
  `https://auth.openai.com/oauth/authorize` with
  `response_type=code&client_id=...&redirect_uri=http://localhost:PORT/auth/callback`
  and `scope="openid profile email offline_access api.connectors.read api.connectors.invoke"`;
  PKCE S256; token exchange/refresh at `POST https://auth.openai.com/oauth/token`.
- `chatgpt.com/backend-api/wham/usage` reports rolling 5-hour and weekly quotas + reset
  timestamps. **Caveat:** reset-token (banked reset) mechanics and some endpoint
  details are third-party/undocumented and must NOT be treated as a hard contract —
  the collector must fail safe when a surface is unreachable.
- **Approved credential source (decision):** use the known Codex/OpenAI public client-id
  `app_EMoamEEZ73f0CkXaXp7hrann` directly (option A). Owner-only, self-hosted tool; the
  client-id is treated as a constant like `ANTIGRAVITY_CLIENT_ID`. Rotate/blacklist risk
  is accepted; the collector fails safe on auth errors.

## Current architecture (facts)

- `runCycle()` (`src/coordinator.ts`) runs full browser checks every `intervalMinutes`
  via `runSingleAccountCheck()` → `scripts/agentrouter-worker.mjs`. The worker **always
  calls `logoutAndPersist()`** at the end ("claim grants"), which is why every 60-min
  cycle re-triggers GitHub OAuth + the AgentRouter Access-Verification WAF slider.
- A lightweight read-only path exists: `endpointPollingLoop()` +
  `DefaultAgentRouterReadSessions` (`src/agentrouter-session.ts`) +
  `scripts/agentrouter-read-session-worker.mjs`. It keeps **one** persistent native
  Chrome process, per-account isolated contexts loaded from `*.monitor.json`, and reads
  `/api/user/self` **in-page** (real authenticated browser read). It never logs out.
  It's **disabled by default** (`endpointPollingEnabled: false`) and reads only
  `/api/user/self`.
- Native Chrome CDP cutover is complete: `scripts/native-chrome-host.mjs` launches real
  Google Chrome Stable over loopback CDP with exactly 5 approved switches, no
  `--headless`/`--no-sandbox`/`--enable-automation`. Anti-detection-safe.
- Antigravity OAuth+collector+store+crypto is the pattern to replicate for ChatGPT:
  `src/antigravity/{oauth,client,collector,store,crypto,constants,types,api}.ts`.
- `agentrouter_grant_received`, `reset_credit_increased`, `quota_reset` Observatory
  event types already exist and flow through the policies→Telegram path.
- `creditGrantEvents()` in the worker is **dead code** (never called);
  `snapshot.summary.creditGrantEvents` is read by storage but never populated.

## Design

### Part 1 — AgentRouter: 1-min read + 24h grant cycle (Option B)

Remove the 60-min full-cycle login/check. Replace with two cadences:

**A. Read loop (1 min, persistent session)**
- Reuse the existing `DefaultAgentRouterReadSessions` browser-based poller, but:
  - extend it to read **all current data** — `/api/user/self` (balance, consumed,
    request count) **plus** the console/wallet usage cards (statistical tokens, RPM,
    TPM, available models) via the existing in-page read.
  - enable it by default (`endpointPollingEnabled: true`).
  - run on `endpointPollIntervalMinutes` (default 1).
  - never logs out. If the session is dead, signal recovery and re-login
    (existing `healAgentRouterSession` with cooldown).
- The dashboard live view surfaces these observations (balance, consumed, request
  count, stats) so the "constant data" requirement is met.

**B. Grant cycle (logout→login, every `grantIntervalHours`)**
- New background loop (default 12h, configurable, bounds `[4,168]`) that:
  - performs the explicit logout→login sequence,
  - confirms login (proves grant cycle healthy),
  - reads balance-before and balance-after from `/api/user/self`,
  - detects a **positive delta** (`balance_after > balance_before + threshold`) as a
    grant — since a grant is a rise, a normal consumption-driven drop is not a grant,
  - emits `agentrouter_grant_received` Observatory event,
  - sends a Telegram confirmation (account, balance before→after, grant amount if the
    sign-in log supplies it else the delta),
  - logs out again (expected here; part of the grant strategy).
- Grant detection: **balance rise** is the primary signal (approved). Cross-check the
  daily sign-in log when parseable for an exact labeled amount, but fall back to the
  delta (approved: "A, but only gets triggered once in 24h").

### Part 2 — ChatGPT/OpenAI OAuth + quota (mirror Antigravity)

- `src/chatgpt/` module mirroring `src/antigravity/`:
  - `oauth.ts` — ChatGPT OAuth PKCE start/exchange/refresh (OpenAI auth endpoint;
    concrete client-id/redirect constants).
  - `client.ts` — Bearer-token HTTP client; probe `backend-api/wham/usage` for rolling
    5-hour/weekly quota windows + reset timestamps; fail safe (category `payload`/
    `auth`/`network`) rather than inventing a reset-token contract.
  - `store.ts` — encrypted at-rest refresh tokens (AES-256-GCM, reuse `./crypto`
    pattern), separate sqlite file.
  - `collector.ts` — periodic probe of each account; emits `quota_reset`,
    `reset_credit_increased`/`reset_credit_decreased`, and quota-warning/critical/
    exhausted events into the Observatory sink.
  - `api.ts` + dashboard mount `/api/chatgpt/` and a ChatGPT page — replicate the
    Antigravity add-account and status UI.
- Config: `src/config.ts` gains a `chatgpt` block mirroring `antigravity`
  (`enabled`, `dbPath`, `encryptionKey`, `oauthClientId`, `oauthClientSecret`,
  `oauthRedirectUri`, `probeIntervalMinutes`, `probeTimeoutMs`).

### Part 3 — Anti-spam telemetry policy

- Reuse the existing `ObservatoryNotificationPolicy` model. Defaults already route
  quota warning/critical/exhausted once per generation, reset once, credit change on
  dashboard. Do not spam:
  - quota threshold crossings emit once per arm epoch (existing hysteresis).
  - reset_credit changes: dashboard always, Telegram only on **increase** (existing).
  - grant received: once per grant (dedupe by fingerprint including the amount +
    balance-after, so a re-poll of the same grant does not re-notify).
  - AgentRouter read failures: only after `repeatedFailureCount` consecutive, and a
    single recovery notification (existing policy).
- The grant cycle and read loop are independent; a read failure never triggers a
  login or WAF challenge (that was the runaway-spam root cause).

## Data flow (grant confirmation Telegram)

`grant cycle → worker RunSnapshot{balanceBefore,balanceAfter,grantDelta} →
coordinator compares → emits agentrouter_grant_received →
Observatory policies → TelegramNotifier`. One notification per grant; dedupe by
fingerprint. No per-cycle re-login.

## Error handling

- Read loop: transient failure logged + retried next interval; only a genuine
  session-dead triggers a recovery re-login, rate-limited by `healAgentRouterSession`
  cooldown (10 min). No WAF trigger from reads.
- Grant cycle: logout→login failure logs + retries next long tick; never falls back to
  per-cycle re-login.
- ChatGPT collector mirrors Antigravity: auth → `auth` category (no retry on other
  endpoints); transient → `network`/`server` retry next probe.
- All provider surfaces: unknown/unreachable → `unknown`/`payload` category and fail
  safe; never log raw tokens, cookies, or provider payloads.

## Testing

- Part 1: read-mode cycle does NOT call `logoutAndPersist()`; grant-mode does.
  Grant detection on balance rise; no grant on consumption-driven drop. Settings
  validation/bounds for `grantIntervalHours`.
- Part 2: `chatgpt` OAuth PKCE start/exchange/refresh (fixtures with placeholder
  secrets); client parses `wham/usage` windows; store encrypts tokens and round-trips;
  collector emits events and persists snapshots.
- Part 3: policy dedupe — same grant does not re-notify; reset_credit only Telegram on
  increase; read failures throttle.
- Full suite: `bun test`, `bun run typecheck`, worker `node --check`.

## Non-goals

- No stealth/fingerprint-spoofing, CAPTCHA evasion, or UA/webdriver spoofing.
- No changes to the native-Chrome launch-args contract (already clean).
- No per-cycle re-login once persistent reuse is on.
- No undocumented reset-token contract assumed as authoritative; fail safe instead.
- OMP session-discovery is separate and out of scope.

## Suggested decomposition (implementation plans)

1. **Plan A — AgentRouter persistent read + grant cadence** (Part 1). Self-contained:
   the browser poller already exists; change *when* logout/login happens.
2. **Plan B — ChatGPT OAuth + quota + dashboard** (Part 2). Self-contained new module.
3. **Plan C — anti-spam telemetry hardening** (Part 3). Cross-cuts both, but is small.
