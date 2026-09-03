# Antigravity Account Add + Direct Quota Probing — Implementation Spec

Status: approved plan; supersedes quota UI assumptions built from `omp usage` only.
Owner: bromoket. Repos: `agentrouter_auto_checker` (target), `gemini_stack` (source of
verified logic, PoC that works). Compacted-session handoff doc.

## 1. Mission

Turn AI Fleet Observatory (Xeon service, `agentrouter_auto_checker`) into the place where
owner Antigravity (Google) accounts are added via OAuth and their **real per-account quotas
are probed directly**, displayed per account as the authoritative bars, with reset events and
reset-credit alerts. This ports the working, verified `gemini_stack` logic — it is **not** a
plugin and does not depend on OpenCode.

Order of work:
1. Antigravity account add (OAuth) + storage + direct quota collector + UI.
2. ChatGPT/Codex session integration (later; same service).
3. GitHub Copilot + other providers = TODO (later; research required).

## 2. Verified sources (do not guess beyond these)

All constants/facts below were read from `gemini_stack` source and a local raw probe file
(`gemini_stack/docs_endpoint_probe_raw.json`, never commit it — contains emails/cookies).

### OAuth (Google "Antigravity"-looking flow)
- Client: `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`
- Secret: set via `ANTIGRAVITY_OAUTH_CLIENT_SECRET` in the Xeon env (never in repo); source value lives in `gemini_stack/packages/plugin/src/constants.ts` and was copied to the service env directly.
- Redirect: `http://localhost:51121/oauth-callback` (local callback; on Xeon the flow must
  bind loopback and the user completes consent in a browser; port must be openable remotely
  via Tailscale or run locally on workstation then import).
- Scopes: cloud-platform, userinfo.email, userinfo.profile, cclog, experimentsandconfigs
  (`https://www.googleapis.com/auth/…` list in constants.ts).
- Auth URL: `https://accounts.google.com/o/oauth2/v2/auth` with PKCE S256,
  `access_type=offline`, `prompt=consent select_account`, state = base64url JSON
  `{nonce, projectId?}` (PKCE verifier kept server-side by nonce, TTL 5 min, single-use).
- Token exchange: `POST https://oauth2.googleapis.com/token`
  (grant_type=authorization_code, code_verifier, client_secret).
- Refresh: same endpoint with grant_type=refresh_token.
- User info: `GET https://www.googleapis.com/oauth2/v1/userinfo?alt=json` (email).
- Refresh token stored as `"${refreshToken}|${projectId}"`; project resolved via
  `loadCodeAssist` when absent. Hardcoded fallback project id when server returns none:
  `rising-fact-p41fc` (business/workspace accounts).

### Endpoints (fallback order matters)
- Quota (Antigravity IDE): POST `{endpoint}/v1internal:retrieveUserQuota`, body `{project}`.
  Endpoints order for quota: PROD, DAILY, AUTOPUSH:
  - PROD `https://cloudcode-pa.googleapis.com`
  - DAILY `https://daily-cloudcode-pa.sandbox.googleapis.com`
  - AUTOPUSH `https://autopush-cloudcode-pa.sandbox.googleapis.com`
- Catalog: POST `{endpoint}/v1internal:fetchAvailableModels`.
- Project discovery: POST `{endpoint}/v1internal:loadCodeAssist` (prod first), reads
  `cloudaicompanionProject` (string or `{id}`).
- CLI quota (Gemini CLI path): `retrieveUserQuota` with GEMINI_CLI_HEADERS UA instead of
  Antigravity UA; returns `REQUESTS` buckets for `gemini-2.5-*` models.

### Quota response semantics (verified)
- `retrieveUserQuota` → `{ buckets: [{ tokenType, modelId, remainingFraction (string),
  remainingAmount?, resetTime? }] }`; IDE buckets have `tokenType: "WTUS"`, CLI buckets
  `"REQUESTS"`. ~27 WTUS buckets per account, including internal `chat_*`/`tab_*`.
- Classify model id → pool:
  - starts with `gemini` → pool `gemini`
  - starts with `claude` or `gpt` → pool `claude-gpt`
  - internal `tab_*` / `chat_*` → excluded
- Pool remaining = MAX remaining fraction across pool members; pool reset = resetTime of
  that member. Pool `modelCount` = number of non-internal members.
- Catalog `quotaInfo` has `remainingFraction`, `resetTime` per model; Claude/GPT often omit
  remainingFraction there, so `retrieveUserQuota` is authoritative for those.
- "Weekly/7d" is a research question in gemini_stack (`QUOTA_RESEARCH.md`). Do not render a
  fake hard-coded 7-day bar. Render per-pool bars with server `resetTime`, and the CLI
  `REQUESTS` bar separately. Antigravity direct probe = the two pool bars + CLI bar.
- Codex (`omp usage`) separately has windows `5h`/`7d`; `resetCredits.availableCount`.

### User's mental model to honor (map onto the above, don't fabricate)
- Per Antigravity account: two model pools ("general/Gemini" and "Claude+GPT"), each with a
  server `resetTime` (observed ~5h cadence) and, per user, a "weekly/7d" notion that is not
  a stable server field → UI must label bars with the real `resetTime` and NOT invent a
  weekly meter. Display exactly: pool bar(s) + (if present) CLI REQUESTS bar; each with
  used %, remaining, countdown to `resetTime`, status tint, source.
- ChatGPT: weekly only (Codex primary 7d) — keep existing UI, do not show fake 5h.
- "Magic reset" (weekly drops to ~0 early): observatory event engine already emits
  `quota_reset` on used/remaining discontinuity (not timestamp movement). Ensure it fires
  and routes to Telegram (policy `quota_reset.telegramImmediate=true` already exists).
- Reset tokens/credits: Codex `resetCredits.availableCount` already surfaces; add Antigravity
  `paidTier.availableCredits[]` from `loadCodeAssist` as the reset-credit source for
  Antigravity accounts. Alert on gain (event `reset_credit_increased` exists).

### Headers (mandatory — always mimic Antigravity)
- Antigravity IDE style UA:
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/{version} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`
  or short `antigravity/{version} {platform}`; version fallback `2.8.1`.
- `X-Goog-Api-Client`: rotate among known values (constants.ts list).
- `Client-Metadata`: `{"ideType":"ANTIGRAVITY","platform":"WINDOWS|MACOS","pluginType":"GEMINI"}`.
- CLI style: `google-api-nodejs-client/9.15.1` UA + `gl-node/22.17.0` + ideType=IDE_UNSPECIFIED.
- Randomized header helper exists in gemini_stack `constants.ts` (`getRandomizedHeaders`) —
  port it as-is.

## 3. Where the collector runs & how accounts are added

- Collector lives inside the existing Xeon service process (same `ai-fleet-observatory`
  service), as a new module family under `agentrouter_auto_checker/src/antigravity/`, NOT a
  separate plugin, NOT opencode. Reuse existing observatory Store/DTO/Telegram plumbing.
- Accounts: new table(s) in the observatory sqlite (or new dedicated sqlite file) storing
  per account: id, label(email), refresh token (encrypted at rest? use OS-level secret via
  systemd credential/env; never plaintext in repo; see Security), projectId, fingerprint
  (see gemini_stack fingerprint.ts), lastUsedAt, enabled.
- Cookie/credential migration: gemini_stack stored Google OAuth state under opencode config
  dir on the workstation. If we cannot extract the existing refresh tokens, the fallback is:
  user clicks "Add Antigravity account" in the Observatory dashboard → service opens
  `accounts.google.com` authorize URL with PKCE → user consents in their browser (relay) →
  callback on loopback → exchange → token stored on Xeon. That flow reuses the ported
  oauth.ts + fingerprint code. (State this explicitly to user when OAuth first lands.)
- Onboarding/persistence module names to port (list from gemini_stack):
  - `src/antigravity/oauth.ts` (authorize + exchange + project discovery)
  - `src/plugin/auth.ts` (parse/format refresh parts, token expiry)
  - `src/plugin/token.ts` (refreshAccessToken with Antigravity or CLI headers)
  - `src/plugin/fingerprint.ts` (fingerprint headers per account; needed for probes)
  - `src/plugin/project.ts` (ensureProjectContext)
  - `src/plugin/quota.ts` (fetchAntigravityQuota, fetchAvailableModels, buildModelQuotaMap,
    aggregateQuota/classify pool, fetchGeminiCliQuota, loadCodeAssist tier/credits)
  - `src/plugin/accounts.ts` account manager subset (list/enable/disable) and
    `src/plugin/storage.ts` persistence shape (adapt, do not copy test fixtures with secrets)
  - `src/plugin/model-metadata.ts` (family/pool classification, display names)
- Port as new code with agentrouter naming + style rules (snake_case, c_ classes, etc.);
  vendor only what's needed, keep upstream headers/constants verbatim.

## 4. Data model & API (target)

- Store (observatory DB additions):
  - `antigravity_accounts(id TEXT PK, label TEXT, email TEXT, refresh_token_enc TEXT,
    project_id TEXT, fingerprint_json TEXT, enabled INT, last_probe_at TEXT, created_at, updated_at)`
  - `antigravity_quota_current(account_id, pool TEXT, token_type TEXT, model_count INT,
    remaining_fraction REAL, reset_time TEXT, used_fraction REAL, source TEXT, observed_at)`
  - optional `antigravity_models(account_id, model_id, pool, remaining_fraction,
    reset_time, catalog_remaining, observed_at)`
  - credit/event reuse: existing `observatory_events` + `reset_credit_increased`/
    `quota_reset` + notification policies; add Antigravity availableCredits source.
- API endpoints (dashboard, owner-authed):
  - `POST /api/antigravity/auth/start` → {url} (PKCE challenge stored server-side)
  - `POST /api/antigravity/auth/callback` or browser hit `/api/antigravity/oauth/callback?code=&state=`
  - `GET/POST /api/antigravity/accounts` (list / add / enable / disable / delete)
  - `POST /api/antigravity/probe` (probe one/all accounts now)
  - `GET /api/antigravity/quota` → per-account pool bars + CLI bar + credits + tier
- UI: new "Antigravity" top-level section (or fold into Provider Quotas with a source
  toggle: "Broker (omp)" vs "Direct (Antigravity OAuth)"); account cards with 2 pool bars
  + CLI bar + reset chips + credit badge; "Add Antigravity account" OAuth button; settings
  tab shows connection state.

## 5. Security (non-negotiable)

- No tokens/cookies/emails in repo, logs, or Telegram text beyond owner-private channels.
- Store refresh tokens encrypted at rest (derive key from env secret; never plaintext col).
- Callback endpoint bound loopback + short-lived PKCE; validate state nonce.
- OAuth callback port: choose a stable loopback port for Xeon (e.g., 51730) and instruct
  browser flow via Tailscale relay to localhost; document it.
- Telegram alerts: quota resets/credits only; never echo tokens.
- Existing AGENTS.md rules (no third-party targets, no unsigned kernel drivers, no
  credentials in config repo) still apply. Antigravity/Google accounts are owner-operated
  and added by owner consent only.

## 6. GitHub Copilot + other providers (TODO list for later)

- Research `pi-ai` copilot usage provider (copilot.d.ts exists locally) and Chat
  subscription auth; add account types + quota probes as separate work items.
- Same for ChatGPT: reuse omp Codex 5h/7d path + session import (may need ChatGPT cookies
  and a dedicated probe) — separate spec when started.

## 7. Acceptance criteria for step 1 (Antigravity direct probing)

- Add 1+ Antigravity accounts through the dashboard OAuth flow (workshop with user the
  first time; user consents).
- Service on Xeon probes `retrieveUserQuota` (+ fetchAvailableModels + loadCodeAssist)
  with Antigravity headers using stored refresh tokens, every N minutes (config, default
  5) and on demand.
- UI shows per account: two pool bars (Gemini, Claude+GPT) with real remaining% +
  server reset countdown + used%, and CLI REQUESTS bar if returned; status tints; source
  tag "direct"; last observed. Codex/AgentRouter views unchanged.
- Reset detection alerts on Telegram (existing events) — verify live with a "magic reset"
  if it occurs; otherwise unit-test the discontinuity path.
- Existing agentrouter.org checker + omp observatory keep working (no regressions);
  full suite + typecheck green.

## 8. Questions for user before/at start of implementation

1. Refresh-token migration: OK to try extracting from the workstation opencode config
   (gemini_stack storage) into Xeon encrypted store, or always re-run OAuth consent first?
2. OAuth callback UX: user consents from which machine? (a) their workstation browser with
   Tailscale reaching Xeon loopback, or (b) headless Chromium on Xeon with manual paste of
   authorization code — pick default (b is more reliable headless, but (a) is nicer).
3. Probe cadence per account (5 min default) and whether to also probe on demand from a
   Telegram command (/probe).
4. Where to put the Antigravity section: new top-level nav item or inside Provider Quotas
   with a source toggle — recommend new nav item "Antigravity" for now.


## 9. Decisions (compacted session, owner answers)

1. Token migration: **try extracting first** from the workstation opencode config
   (`C:\Users\thinkpad-win11\.config\opencode\antigravity-accounts.json`, verified:
   schema version 4, 10 accounts, plaintext `refreshToken` + per-account
   `fingerprint {deviceId, sessionToken, userAgent, apiClient, clientMetadata, createdAt}`,
   `verificationRequired`, `subscription {currentTier, paidTier, availableCreditTypes,
   observedAt}`, `cachedQuota {gemini, claude-gpt {remainingFraction, resetTime, modelCount,
   source, observedAt, confidence}}`, per-model `cachedQuotaModels`). Never commit the file;
   redact in docs. Fallback: fresh OAuth consent.
2. OAuth callback UX: **owner's browser via OMP relay**, service loopback callback on Xeon
   (callback port must be reachable via Tailscale; document exact port).
3. Probe cadence: **every 5 min per account + on-demand** (dashboard button + Telegram
   `/probe` later).
4. UI: **new top-level nav item "Antigravity"** (separate from broker/omp Provider Quotas).

## 10. Import shape (first implementation step)

Import tool (one-off `bun` script under `agentrouter_auto_checker/scripts/`) reads the
opencode JSON (path from env or default above), validates schema v4, then writes each
account into the new encrypted observatory table (refresh token encrypted with env key),
with label=email, fingerprint JSON stored, enabled flag preserved. Report imported count +
any accounts missing refresh tokens; do not log token values.
