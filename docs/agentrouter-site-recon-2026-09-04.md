# AgentRouter.org Site Recon — 2026-09-04

Owner-authorized read-only inspection via the OMP browser relay (user's Chrome) + Xeon
headless runs. Purpose: adapt the worker to the current site DOM and re-establish working
sessions.

## Console money cards (`/console`)

Real, first-load accurate once the session is warm. Tailwind-ish leaf structure:

| Field | Leaf classes | Example |
| --- | --- | --- |
| Label | `text-xs text-gray-500` (or `semi-typography … tertiary`) | `Current balance` |
| Value | `text-lg font-semibold` | `$28.93` |
| Label | `text-xs text-gray-500` | `Consumption` |
| Value | `text-lg font-semibold` | `$2695.79` |
| Label | `text-xs text-gray-500` | `Statistical quota` |
| Value | `text-lg font-semibold` | `$10.90` |

- Site shows its own notice on `/console` when the zero-state quirk applies:
  `额度显示0 | Balance shows $0` — the site acknowledges first-load `$0` until a refresh.
- Observed live: `Current balance $28.93 · Consumption $2695.79` (bromoket, post-$25 grant).

## `/console/topup`

- Shows the same `Current balance` / `Consumption` cards (classes `semi-typography … tertiary`
  label + `text-xl font-semibold mt-2` value) plus referral/transfer blocks
  (`Transfer to balance` Semi button). First load can show `$0.00` placeholder; an extra
  reload settles it (matches the user's description).
- Worker conclusion: **read money from `/console`** (reliable), refresh-settle before parsing,
  and treat `/console/topup` as a secondary/fallback read only.

## Login / OAuth / logout (to document further during a live Xeon login)

- Login = GitHub OAuth (`/api/oauth/state?mode=login` → `github.com/login/oauth/authorize`).
  GitHub can present: stored-account selection, username/password, TOTP input
  (`input[name="app_otp"]` / `input[name="otp"]`), **GitHub Mobile** two-digit verification,
  passkey route, or human verification.
- Logout: API `GET /api/user/logout` → `/login`; visible fallback = profile menu
  (`button[aria-haspopup="menu"]` hover → `menuitem "Quit"`). Since ~2026-09-03 15:34Z the
  stale-session clear fails ("Unable to clear the stale AgentRouter session before login") —
  logout endpoint/UI changed or sessions were invalidated site-wide; a fresh Xeon login run is
  the ground truth for what GitHub presents now.
- Relay inspection of the GitHub screens was intentionally NOT performed (would log the user
  out of their authenticated relay session); capture them during the Xeon headful run instead.

## Actions taken / pending

- [x] Money source: console-primary (worker selection flipped; topup = fallback).
- [x] Settle-wait before money reads (networkidle + 1.5 s, up to 4 settled loads).
- [x] False-zero guard keyed on the selected money source (errored run instead of `ok $0.00`).
- [ ] Re-establish sessions via fresh GitHub OAuth run on Xeon (challenge pipeline
      github-mobile / agentrouter-waf already exists; OTP code entry + Telegram/dashboard
      challenge surfacing to be added once the live flow is observed).
