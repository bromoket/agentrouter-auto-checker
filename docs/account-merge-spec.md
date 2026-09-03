# Account Merging — Fleet OAuth (direct) + OMP Auth-Bearer Identities

Status: approved plan. Owner: bromoket. Repos: `agentrouter_auto_checker` (implementation),
`gemini_stack` (source of direct-probe logic, already ported). This spec governs how the
Observatory stops showing the same login twice (once as an OMP auth-bearer identity, once as
a fleet-OAuth direct account) and instead renders one canonical, most-up-to-date row per
login.

## 1. Problem

Today two independent collectors write into the same observatory store for the same underlying
Google account:

- **Broker (OMP auth-bearer)** — `ObservatoryCoordinator` polls `omp usage` every 1 minute.
  Identities: provider `google-antigravity` (and `openai-codex`), `identityId` = opaque
  SHA-256-HMAC of email/accountId (see `src/observatory/omp-usage.ts`), label masked to
  `Google Antigravity (920c1b71)`. Quota windows are the broker family windows
  (`google-antigravity:openai|anthropic|google:default:daily|weekly`) and Codex 5h/7d buckets.
- **Direct (fleet OAuth)** — `AntigravityCollector` probes every 5 minutes with real
  refresh tokens + fingerprints. Identities: same provider `google-antigravity`,
  `identityId` = the antigravity account uuid, label masked to `Google Antigravity (<id8>)`.
  Quota windows are the authoritative WTUS pools (`antigravity-gemini`, `antigravity-claude-gpt`,
  `antigravity-cli`) with per-model server resetTimes.

The same 10 accounts therefore appear twice in the dashboard identities/quota lists and in
Telegram counts (`Identities: 21 active (59 monitored windows)` double-counts the 10 direct
accounts against the broker's ~10 antigravity identities), and two independent trackers exist
for the same login with different windows and different freshness.

## 2. Goals and non-goals

Goals
1. One canonical dashboard row per login (keyed by the underlying Google account), for every
   page that lists identities/quotas: Provider Quotas, Credentials, Antigravity view, Overview
   counts, Telegram `/quotas`.
2. Direct (fleet OAuth) data is authoritative whenever a direct account exists: it is probed
   from the real refresh token with per-model WTUS buckets. Broker rows/windows for the same
   login remain stored (they are real telemetry and drive their own alerts) but are visually
   folded into the canonical row as a secondary, collapsible "broker mirror" group.
3. Every canonical row must be truthful about what produced each number (source chip:
   `direct` vs `broker`), never merge numbers across sources.
4. Counts everywhere (overview metrics, status chips, Telegram headers) use canonical rows.

Non-goals (for this pass)
- Not merging balances/AgentRouter portfolio (bromoket/cookieayy are agentrouter accounts,
  unrelated to Antigravity).
- Not de-duplicating events history (events keep their real per-source trackers; only
  presentation and alert copy are de-duplicated where they would otherwise duplicate).
- Not yet adding ChatGPT OAuth accounts; the merge machinery must be provider-agnostic so
  `openai-codex` direct accounts slot in later with zero structural change.

## 3. Identity-linking rules (the merge key)

Constraint: `identityId` in the observatory is deliberately opaque and never reversible, so a
direct account (which stores `email`, plaintext-ish inside the encrypted antigravity store)
cannot "look up" its broker twin by string compare. We therefore need a deterministic,
secret-safe link key computed on both sides.

### 3.1 Canonical link key `loginRef`

Define `loginRef = sha256_hex(hmacKey, "antigravity-login\0" + provider + "\0" + normalizedEmail)`
where `hmacKey` is `OBSERVATORY_HMAC_KEY` (32+ bytes, already required) and `normalizedEmail`
is `email.trim().toLowerCase()`.

- Stored on the direct account row: `login_ref TEXT` (computed at import time and at each
  successful probe from the stored email). Column added by migration to
  `antigravity_accounts` (nullable — set later for accounts whose email is missing).
- Never logged, never shown in UI, never returned by APIs (an opaque 64-hex value is safe to
  expose only internally; keep it out of API payloads anyway).

### 3.2 Matching broker identities to `loginRef`

Broker identities do not carry email. Two-phase matcher (both must be implemented):

1. **Recompute candidate identityId (primary).** Replicate the broker's identity derivation
   for `google-antigravity` with the stored email as the email component and the same
   `OBSERVATORY_HMAC_KEY`, using the exported helpers in `src/observatory/omp-usage.ts`
   (`generateOpaqueIdentityId`, plus the exact component precedence used by
   `normalizeOmpUsage` for provider `google-antigravity`: accountId → email → projectId).
   Probe all 10 live accounts and record for the spec which component the broker actually used
   (expected: email for consumer logins; projectId is `aicode-consumers` for all of these, so
   projectId-derived ids can never disambiguate and must be treated as unmatchable).
2. **Broker-side link annotation (robustness).** Extend the normalization envelope so each
   normalized broker identity optionally carries `loginRef` when the raw report exposes an
   email (email is already present pre-normalization; the value is discarded at the collector
   boundary today). Compute `loginRef` the same way inside `normalizeOmpUsage` and attach it to
   the identity observation only when derivable. This survives any future change to component
   precedence and works for `openai-codex` too.
3. Match rule: a broker identity equals a direct account iff both have a `loginRef` and they
   are equal. If only phase-1 recomputation succeeds, use it; if the two phases disagree for
   an account, log a one-line masked warning and prefer the broker-annotated match.

Implementation notes
- `generateOpaqueIdentityId` and the component builders are pure and already exported; the
  spec requires a small pure module `src/observatory/identity-link.ts` owning `computeLoginRef`
  and `candidateBrokerIdentityIds` with unit tests locked to known vectors (compute expected
  ids in tests via the same helper, plus one golden vector captured from a live broker run).
- Store the successful link on the direct account (`broker_identity_id TEXT NULL` after the
  first confirmed match) so later polls are O(1); re-validate weekly or whenever the broker
  identity list changes (`observatory` retention prune already rescans identities).
- Accounts that cannot be matched (no email on direct side, or broker used projectId-only id)
  remain listed separately with a `unlinked` chip and a note in Settings: "N accounts could not
  be linked to their broker twin". This must never silently drop either side's data.

## 4. Merge model and precedence

### 4.1 Canonical view builder

One pure function builds the presentation model for every surface:

```
buildCanonicalProviderRows({ brokerIdentities, brokerQuotaWindows, directAccounts, directSnapshots })
  -> CanonicalProviderRow[]
```

Each `CanonicalProviderRow`:
- `loginRef: string | null`
- `primarySource: "direct" | "broker"`
- `displayLabel` (email shown when direct account exists — owner-facing surfaces only; masked
  `Google Antigravity (<id8>)` everywhere public/Telegram)
- `direct?: { accountId, pools[], tier, credits, verificationRequired, lastProbedAt, consecutiveFailures }`
- `broker?: { identityId, windows[], lastSeenAt, health }`
- `merged: boolean` (both present)
- `alertSummary` for status chips.

Rules:
1. A direct account always wins the row: `primarySource = "direct"`. The broker identity for
   the same login is folded under `broker` (collapsed by default in UI).
2. Broker-only rows stay as-is (`primarySource = "broker"`), unchanged behavior.
3. Direct-only rows (no broker twin) render with `broker = null`; the UI already shows them.
4. Ordering of the canonical list: by provider, then direct accounts first, then broker-only.

### 4.2 Which numbers are shown where (no mixing)

- **Quota bars on the canonical card**: direct pools (gemini/claude-gpt/cli) are the primary
  bars, labelled with their real meter + resetTime countdown and a `fleet OAuth` source chip.
- **Broker mirror group** (collapsed by default; `show broker mirror` per card and a global
  default in Settings): lists the broker windows for that login (daily/weekly family buckets)
  with a `broker` chip. This is telemetry-only information; it is not merged into the direct
  bars and never averaged.
- If the direct side has no pools yet (fresh account, first probe pending) the card must show
  the broker windows as fallback with a clear `awaiting first direct probe` note, so the row
  is never blank.
- Never average/combine remaining fractions across sources; never invent a window that only
  the other source exposes.

### 4.3 Event/alert de-duplication

- Quota trackers stay keyed per real observation (unchanged). Both sources may fire
  `quota_reset`/`reset_credit_increased`; that is correct and stays.
- Alert COPY in Telegram for a merged login should label the source in the subject line
  (`Google Antigravity · direct` vs `Google Antigravity · broker mirror`) so two alerts about
  the same login are distinguishable, not confusing.
- If in practice the broker daily/weekly windows merely mirror the direct WTUS resets and
  produce noisy duplicates for the owner, a later pass may suppress broker-mirror alerts when
  the login is direct-merged (config flag `suppressBrokerMirrorAlertsForMerged=true` default
  false). Do not implement suppression in this pass; record the decision in Settings docs.

## 5. Storage changes

Migration (antigravity store, additive, idempotent):
```
ALTER TABLE antigravity_accounts ADD COLUMN login_ref TEXT;
ALTER TABLE antigravity_accounts ADD COLUMN broker_identity_id TEXT;
CREATE INDEX IF NOT EXISTS idx_antigravity_login_ref ON antigravity_accounts(login_ref);
```
- Set `login_ref` for existing rows from stored email in the import/migration step; recompute
  on every successful probe (email may be corrected later).
- Snapshot JSON unchanged.

Broker normalization envelope (`src/observatory/omp-usage.ts`):
- `NormalizedOmpUsage.identities[]` entries gain optional `loginRef: string | null`
  (computed only when an email component exists; never the raw email).
- Validation of `ProviderIdentityObservation` untouched (loginRef travels in the normalized
  envelope, not in the stored observation) unless a store column is desired — do not add a
  store column in this pass; matching uses the in-memory broker identity list plus the
  recomputed ids.

## 6. Surface-by-surface behavior

### Dashboard
- **Provider Quotas**: replace the raw identity list with canonical rows (see 4.1). Card shows
  label, source chips, direct pool bars (primary), collapsed broker mirror.
- **Antigravity view**: unchanged cards, but add per-card `merged with broker` chip and the
  broker mirror toggle; footer shows broker twin `lastSeenAt` when merged (stale broker data is
  a hint, not an error).
- **Credentials view**: canonical rows; a merged row shows `identityKind` of the primary source
  and a `+1 broker mirror` chip.
- **Overview metrics**: `Identities active` = canonical row count. Keep a separate
  `telemetry sources` line (direct probes N · broker identities M) in the System page only.
- **Events / audit**: unchanged (real events), but the event list filters can pre-bundle a
  `loginRef` group filter for merged logins (cosmetic, optional).

### Telegram
- `/quotas`, `/status`, `/balances` headers: counts come from canonical rows. The status
  message's `Identities: N active (M monitored windows)` line must use canonical counts; when
  direct accounts are merged the windows count = direct pools + (broker windows only for
  broker-only identities). See the Telegram redesign spec for exact copy.

### APIs
- `GET /api/observatory/identities` and `/quotas` keep their current contract (some tooling
  relies on raw rows) but gain an optional `?canonical=true` returning canonical rows. The
  dashboard UI switches to `?canonical=true`; old callers keep raw rows.
- `GET /api/antigravity/overview` gains per-account `mergedWithBroker: boolean` and
  `brokerLastSeenAt`.
- New `GET /api/observatory/canonical` returns the canonical list (provider filter, limit,
  offset) for future surfaces.

## 7. Verification plan (no guessing)

1. Unit: identity-link golden vectors (recompute broker id from a captured live report email;
   assert equality with the observed broker identityId for ≥ 8 of the 10 live accounts).
   Capture the mismatch set and record the exact component precedence used by the broker.
2. Unit: canonical builder — direct wins, broker-only unchanged, no-number-mixing invariant,
   awaiting-probe fallback, unmatchable accounts surfaced.
3. Integration: run broker collector + antigravity collector against an in-memory pair of
   stores; assert canonical rows == 10 direct + (any extra broker-only) and that Overview count
   matches; assert both sources' events still record.
4. UI smoke (playwright/chrome): Provider Quotas + Credentials show 10 canonical rows (not 20),
   each merged card shows direct bars and a collapsed broker mirror; no layout shift on refresh.
5. Telegram smoke: `/quotas` headers/counts match canonical counts; sample message inspected on
   phone and desktop widths.
6. Regression: existing dashboard tests that assert raw identity counts (Overview metrics) must
   be updated to canonical semantics deliberately, not silently.

## 8. Acceptance criteria

- The same login is never rendered twice on any page or count after the merge lands.
- Direct pools are always the primary bars when a direct account exists; broker windows are
  explicitly secondary/collapsed with source chips.
- Broker-only and direct-only rows behave exactly as before.
- No event is lost or merged across sources; alert copy distinguishes direct vs broker mirror.
- Migration is additive; rollback = revert commit (data untouched).
- Full suite + typecheck green; UI smoke on phone and desktop widths for the touched pages.
