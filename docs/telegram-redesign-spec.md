# Telegram Message Redesign — Fleet Observatory Bot

Status: approved plan. Owner: bromoket. Target: every message the observatory bot sends.
Scope: `/status`, `/quotas`, `/balances`, alerts (`formatObservatoryEventMessage` and
per-run/run-cycle notifications), `/dashboard`, `/help`, digest messages, and the interactive
menu attached to every response. This spec is deliberately copy-exact so implementation is
mechanical; nothing here is left to taste.

## 1. Problems with the current messages (from screenshots)

Reference: message #1 (AI Fleet Status, wide ~540px), #2 (AI Provider Quotas), #3 (Portfolio
Balances, phone ~360px).

1. **No visual hierarchy.** Section headers (`💼 AgentRouter Portfolio:`) are the same weight
   as rows; the whole message reads as one paragraph. There is no grouping whitespace rhythm.
2. **Inline bars fight the text.** `openai-codex:primary (7d): [████████░░] 86% (resets in 3d 20h)`
   puts label, bar, percent, and countdown on one line; on phone width the line wraps mid-bar
   or pushes the countdown to its own ragged line. Bars must own their line.
3. **Cramped spacing.** Rows sit adjacent with `•` prefixes of inconsistent visual width
   (emoji dots align differently from ASCII), so columns look misaligned. Right-side values
   (balances, percents) should be right-aligned on their own column, but Telegram HTML collapses
   spaces, so alignment must be built from measured `<code>` segments or `nbsp` padding.
4. **Status dot + label duplication.** `🟢 bromoket: $3.93 | Usage: $2695.79 (8,694 reqs)` mixes
   three facts into one line; on phone the `|` fences wrap ugly. Rows should be two-line: label
   line and detail line, or a tight table with aligned columns when the client is wide.
5. **Alerts lack shape.** Current alert body (`formatObservatoryEventMessage`) is title +
   `severity category event` + loose fields. No consistent layout, no per-event field template,
   no footer hint beyond the dashboard link.
6. **No reset/credit visual affordance.** `reset in 4h 56m` and `resets in 3d 20h` are buried in
   parentheses with inconsistent wording (`reset` vs `resets`, `in` vs `at`). Consolidate copy.
7. **Counts wording** ("Identities: 21 active", "Warnings / High Usage: 4 active") is fine but
   must follow the merge model (canonical counts) and live under a grouped header.

## 2. Design system

Telegram limitations (final, non-negotiable):
- HTML parse mode only: `<b> <i> <code> <a> <pre> <s> <u> <tg-spoiler>`. No colors, no images
  inside chat text (photo messages exist only for the balance graph variant and stay as-is).
- Multiple spaces collapse unless inside `<code>` or using `&nbsp;`/zero-width — alignment is
  built with measured `<code>` spans and `&nbsp;`.
- Long lines wrap; a `<code>` block longer than ~46 cells wraps mid-block and looks broken.
  Therefore: nothing in a `<code>` span may exceed 40 monospace cells; anything longer must be
  split on explicit boundaries.
- Emoji render ~2 cells wide in most clients; use them at line starts, not mid-alignment.

### Tokens

| Token | Value | Notes |
| --- | --- | --- |
| Bar width | 12 cells | wide enough to read level; short enough for phone |
| Filled/empty | `▰` / `▱` | visually lighter than `█`/`░`, friendlier at 12 cells |
| Narrow phone text width | ~36 cells | assume worst-case wrap at 36; never place a hard dependency on >36 cells for meaning |
| Message max chars | 3,500 per message (HTML counts) | split pages below; Telegram cap 4,096 |
| Section divider | `─` x 14 inside `<code>`? | instead: a blank line + uppercase eyebrow + rules below |
| Accent | `›` for sub-rows, `▸` for expandable hints | single char, wraps safely |
| Status emoji | `🟢` ok · `🟡` warning/degraded · `🔴` critical/exhausted · `⚪` unknown · `🟣` direct-probe only row · `🔵` broker-only row | documented legend at the end of /help only, not every message |
| Source chip | `[fleet oauth]` / `[broker]` | in `<code>`, 12 cells, never emoji |

### Layout primitives (shared helpers in `src/telegram.ts`, new file `src/telegram/layout.ts`)

1. `eyebrow(text)` → `<code>╭─ {TEXT} ─╮</code>`? No — keep two-space indent free. Use:
   `‹{text}›` uppercase row + thin rule `▔▔▔▔▔` optional. Concrete:
   - Group header: `\n\n<b>‹ {TEXT} ›</b>\n` then rows.
2. `bar12(fraction)` → `<code>` + `▰`*n + `▱`*(12-n) + `</code>` where n = round(fraction*12),
   clamped [0,12]; 0% shows `▱`*12 (never a misleading sliver), 100% shows `▰`*12.
3. `kv(label, value)` → two-column row built from measured cells:
   `label` (≤ 20 cells, `<code>` when contains digits), `nbsp` pad to 24 cells, `value`
   right-aligned in a 12-cell `<code>` when numeric — see §4 measurement rule.
4. `countdown(iso)` copy table (single source of truth replacing `formatCountdown`):
   - future ≤ 1 min: `resets now`
   - future ≤ 60 min: `resets in Nm`
   - future ≤ 24 h: `resets in Nh Nm`
   - future ≤ 7 d: `resets in Nd Nh`
   - future > 7 d: `resets in Nd`
   - past (≤ 5 min): `reset just now`
   - past: `reset overdue Nd` (only for windows that show no reset pending)
   - unknown: `no reset window`
   Never mix `in/at`; never add "(s)".
5. `splitPages(messages, max=3500)` keeps provider groups atomic (§5.3).

### Measurement rule (must be implemented exactly)

- Visible width of a text run = Σ over chars of (emoji/wide glyph: 2, else 1). Use
  `charWidth(ch)` with a compact emoji-range table (U+1F000–U+1FAFF, U+2600–U+27BF, U+2B00–U+2BFF,
  U+FE0F variation selectors, ZWJ sequences counted as 2 + sequence). Keep a helper
  `visualWidth(str)` with unit tests (e.g. `visualWidth("🟢 12%") === 2+1+2+1 = 6? define:
  emoji 2, space 1, digits 1 → "🟢 12%" = 2+1+1+1 = 5`).
- Builders assemble rows into cells then pad with `&nbsp;` so columns align *within the same
  message* (never assume alignment across separate messages).
- For numeric columns: right-align by prefixing `&nbsp;`s; test snapshots assert exact HTML for
  representative rows on both 36-cell and 60-cell clients (wrap happens client-side; our
  guarantee is no meaningful token crosses the 36-cell boundary).

## 3. Message blueprints (copy-exact)

Footer on every message (except `/key` and `/help` which keep their own):
```
\n\n👉 <a href="{dashboardUrl}">Open Fleet Observatory</a>
```
Menu: unchanged buttons + order (Status / Quotas / Balances / Dashboard / API key / Help),
attached as inline keyboard to every reply via the existing reply-markup plumbing.

### 3.1 /status — "AI Fleet Status" (replaces `buildStatusMessages`)

Layout:
```
📊 <b>AI FLEET STATUS</b>   {🟡 if any warning · 🔴 if any critical · 🟢 otherwise}
━━━ separators are not used; blank-line rhythm instead

💼 <b>AgentRouter Portfolio</b>
🟢 <b>bromoket</b>
   Balance $3.93 · usage $2695.79
   Requests 8,694 · grant pending
🟢 <b>cookieayy</b>
   Balance $402.56 · usage $896.32
   Requests 1,797 · grant pending

💰 <b>Fleet totals</b>
   Balance   $406.48
   Usage     $3592.11

🤖 <b>AI Provider Quotas</b>
   Sources: 10 fleet oauth · 2 broker-only
   Windows: 59 monitored
   ⚠ 4 high-usage · 0 exhausted
{per-provider compact rows from §3.2, deepest 1 line each, "·" grouped}
```
Rules: each account is a 3-line block (status-dot+name; balance/usage line; requests/grant
line) with `&nbsp;` indentation `   ` for continuation lines so the block reads as one unit.
Never `|`-separate facts on one line. Grant state copy: `grant pending` / `grant <time>` /
`grant received` (align with existing semantics elsewhere; wording table in §4).

### 3.2 /quotas — "AI Provider Quotas" (replaces `buildQuotasMessages`)

Per provider group, canonical rows (see account-merge spec §4). Row template:

Group header (one per provider):
```
🤖 <b>OpenAI Codex / ChatGPT</b>      ← provider display name
```
Row (two lines per window):
```
{status-dot} <b>{window-title}</b>  {source-chip}   {86% · reset 3d 20h already on the bar line}
<code>▰▰▰▰▰▰▰▰▰▰▱▱</code> {86%} · <code>reset 3d 20h</code>
```
Concretely per window line:
```
Line 1: {dot} <b>{label}</b>  <code>[{source}]</code>
Line 2: <code>{bar12}</code>  <b>{pct}%</b> · {countdown}
```
Where `{label}` keeps the bucket's human meaning, e.g.
- `primary · weekly (7d)` for openai-codex:primary
- `spark · 5h` for openai-codex:spark:primary
- `spark · weekly (7d)` for openai-codex:spark:secondary
- `gemini pool · rolling` / `claude + gpt · rolling` for direct WTUS pools
- broker family windows `daily` / `weekly` keep their bucket suffix `google:default:daily`.

Warnings summary before the first group:
```
⚠ 4 windows ≥ 80% used · 1 exhausted (details at the dashboard)
```
Then groups. A window whose status is `critical`/`exhausted` prepends `🔴` instead of the dot
and the countdown copy switches to `exhausted — resets in Nh` (never hide the reset info).

### 3.3 /balances — "AgentRouter Portfolio Balances" (replaces `buildBalancesMessages`)

Keep numbered list? No — use the same 3-line blocks as /status but fuller:
```
💰 <b>AgentRouter Portfolio Balances</b>

1. 🟢 <b>bromoket</b>
   Live balance   $3.93
   Consumed       $2695.79
   Requests       8,694
   Daily grant    ⏳ pending
   Last polled    3 Sept 2026, 07:56

2. 🟢 <b>cookieayy</b>
   Live balance   $402.56
   ...
```
Alignment: `Live balance` etc are fixed labels in `<code>`; numeric column right-aligned to the
largest value width in the message (per-message alignment, not global).
Summary block:
```
💵 Combined balance   $406.48
📈 Total usage        $3592.11
```
Then footer. Numbering is fine to keep; or drop numbers since blocks are delimited — keep them
(users reference "account 2" in chat).

### 3.4 Alerts (replaces the body of `formatObservatoryEventMessage` in `src/observatory/delivery.ts`)

Every alert follows:
```
{event emoji} <b>{subject}</b>  <code>[{source chip}]</code>

{field rows, two per fact max}

👉 <a href="{dashboardUrl}">Open Fleet Observatory</a>
```
Event emoji table (single source in delivery.ts):
- quota_reset → `🔄`
- reset_credit_increased → `🎟️` (or `🎫`; pick `🎫`, red-free)
- reset_credit_decreased → `📉`
- quota_warning → `🟡` (no extra emoji)
- quota_critical → `🔴`
- quota_exhausted → `⛔`
- provider_degraded → `🟠`
- provider_down → `🛑`
- provider_recovered / credential_recovered → `✅`
- credential_blocked → `🔒`
- agentrouter_balance_low → `💸`
- agentrouter_large_balance_drop → `💥`
- agentrouter_grant_received → `🎁`
- collector_failure / session_failed / host_offline → `⚠️` + subject verb
- default → `ℹ️`
Subject templates (copy-exact, per type; merge-aware labels per account-merge §4.3):
- reset: `<b>Quota reset · {label} · {window-title}</b>` body: `used {usedPct}% → {newPct}% · {countdown}`
- credit gained: `<b>Reset credit available · {label}</b>` body: `credits {count} · window {window-title}`
- exhausted: `<b>Quota exhausted · {label}</b>` body `{window-title} at 0% — resets {countdown}`
- warning/critical: `<b>Quota {warning|critical} · {label}</b>` body `{window-title} {pct}% used · {countdown}`
- auth/credential: `<b>{credential blocked|recovered|disabled} · {label}</b>` + one-line reason
- failure families: `<b>{collector|session|host} {failed|offline}</b>` + one-line context
Body rows are `  {k}   {v}` aligned per §2.4, max two rows, then dashboard footer.
Severity line no longer says "info severity event" — subject already encodes it.

### 3.5 /dashboard, /help, /key, digest

- `/dashboard`: unchanged content, restyled with eyebrow + footer (no menu change).
- `/help`: keep, add the status-dot/source-chip legend block (§2 tokens) at the end.
- Digest (observatory digest_ready payload): reuse alert subject templates in a single grouped
  digest message: one eyebrow per day-section; max 3,500 chars; overflow splits on section
  boundaries (never mid-section).

## 4. Copy table (single source of truth, new module `src/telegram/copy.ts`)

- countdown: §2.4 table
- grant state: `grant pending` · `grant received` · `grant {h}h {m}m ago`
- status: `ok` `warning` `critical` `exhausted` `unknown`
- window titles per bucket: mapping table in §3.2
- sources: `fleet oauth` `broker` (in `<code>` chips)
- empty states: quotas → `No monitored quota windows yet`; balances → `No accounts`
- footer line constant + menu order constant (shared with existing menu builder)
Unit-test the copy table: no two phrases for the same state, no mixed tense (`resets`/`reset`
is resolved to `reset` for headers, `resets` never used in copy).

## 5. Structural requirements

### 5.1 Where code lives
- `src/telegram/layout.ts` (new): visualWidth, bar12, padRow, kv, section helpers — pure,
  fully unit-tested with HTML snapshot assertions.
- `src/telegram/copy.ts` (new): every copy string + emoji table + subject templates — pure.
- `src/telegram.ts`: refactor `buildStatusMessages` / `buildQuotasMessages` /
  `buildBalancesMessages` / `buildHelpMessage` / `buildDashboardMessage` and the
  alert-page callers to consume layout/copy. Keep exported function signatures stable where
  tests exist; add new pure builders + snapshot tests; route `/status /quotas /balances`
  handlers to the new builders.
- `src/observatory/delivery.ts`: replace `formatObservatoryEventMessage` body with the alert
  blueprint (same signature, same callers).

### 5.2 Pagination / split policy
- `splitPages` operates on **section blocks**: a block is a group header + its rows (per
  provider for quotas, per account for balances, per severity for alerts). Never split inside
  a block. If one block exceeds 3,500 chars (unlikely; guards exist) split by rows and emit a
  `…continued` marker line as its own row at block end.
- Page suffix: `(1/3)` first-line eyebrow for multi-page responses (e.g. `📊 AI FLEET STATUS (1/3)`)
  so a re-sent page is identifiable.

### 5.3 Phone vs desktop
- Every message must convey all meaning when wrapped at 36 cells: i.e., no `<code>` span longer
  than 40 cells and no token (bar, pct, countdown, balance, chip) split by an artificial break —
  the HTML builder inserts zero forced breaks; the client wraps between tokens because each
  token is separated by real spaces. Bars and values are atomic (no spaces inside their spans
  except padding that is dropped before a wrap? padding `&nbsp;` prevents wrap!). Correct rule:
  numeric right-alignment padding uses `&nbsp;` **only** up to 4 cells and only for the final
  column; column gutters between tokens are normal spaces so the client can wrap gracefully.
- Provide a `WIDTH`-aware smoke test using a headless client? Can't measure wrap headlessly for
  Telegram; instead unit-test the builders at 36-cell and 60-cell "virtual widths" by rendering
  tokens sequentially and asserting no token's intrinsic width pushes a line past 36/60 without
  a real space to break at (pure tokenizer check). Document in README of layout module.

## 6. Verification

1. New pure tests: visualWidth vectors, bar12 clamp cases, copy table uniqueness, countdown
   boundary table (0/1/59/60 min, 23/24/47/48h, 6/7d, past windows), splitPages block
   atomicity, snapshot HTML of each blueprint at 36-cell and 60-cell tokenizer widths.
2. Existing telegram tests updated to new expected strings (all copy changes are deliberate;
   old strings asserted must be replaced, never kept as aliases).
3. Live smoke: send /status /quotas /balances /dashboard /help + one synthetic alert to the
   owner chat; owner reviews on phone and desktop; screenshot both and attach to this spec's
   review record (design-review-plan doc).
4. No message exceeds 4,096 raw chars post-HTML (assert in send path; log a warning otherwise).
