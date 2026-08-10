# AgentRouter live route and API audit

Verified against the deployed `https://agentrouter.org` frontend on 2026-08-09 with an authenticated browser session and the site's current JavaScript bundles.

## Console routes

| Route | Screen |
| --- | --- |
| `/login` | Login |
| `/console` | Dashboard |
| `/console/token` | API Token |
| `/console/log` | Usage log |
| `/console/topup` | Wallet |
| `/console/personal` | Personal Settings |

The successful GitHub OAuth callback currently lands on a `/console/*` route; `/console/token` was observed during the real automation cycle. Authentication is represented by the `user` object stored by AgentRouter's own frontend.

## Authentication flow

1. `GET /api/oauth/state?mode=login`
2. GitHub authorization page
3. `GET /api/oauth/github?code=<code>&state=<state>&mode=<mode>`
4. AgentRouter stores the returned user and enters `/console/*`

Authenticated frontend requests send `New-API-User: <AgentRouter user id>` and `Cache-Control: no-store`.

## Read-only collection endpoints

| Endpoint | Purpose |
| --- | --- |
| `/api/user/self` | Account identity, balance, consumption, and request totals |
| `/api/status` | Site configuration including `quota_per_unit` |
| `/api/user/models` | Available model list |
| `/api/data/self/?start_timestamp=...&end_timestamp=...&default_time=...` | Per-model usage series |
| `/api/log/self/stat?start_timestamp=...&end_timestamp=...&type=0` | Usage summary |
| `/api/log/self/?p=...&page_size=...&type=0&start_timestamp=...&end_timestamp=...` | Detailed user and system log events |
| `/api/uptime/status` | Service uptime data used by the console |

The monitor intentionally never calls `/api/user/token`, because that endpoint resets the user's API token.

## Logout

Opening the top-right profile menu exposes the visible menu item **Quit**. A completed automation cycle clicks that exact control and requires both conditions:

1. AgentRouter redirects to `/login`;
2. AgentRouter's frontend no longer exposes its local `user` object.

The reusable GitHub profile remains separate and persists after AgentRouter logout.

## Verified `错误` root cause

`/api/user/self` can return an Aliyun Access Verification document with HTTP 200 and `text/html` instead of JSON. The page title is `Verification` and the visible control says `Please slide to verify`.

The deployed dashboard callback reads `response.data.message` without first validating that the response is JSON. The HTML response therefore produces an undefined message and a JavaScript error (`Cannot read properties of undefined (reading 'message')`), surfaced by the site as only `错误`.

The monitor no longer drives collection through that endpoint. It reads the visible `/console/` and `/console/topup` cards, refreshes double-zero money values up to three times, and refuses to save a suspicious all-zero result for an active account. It does not attempt to automate the anti-bot control.

## Verified credit semantics

The usage log contains type-4 `System` records. A live record was observed with the content:

`每日签到成功，增加额度 ＄25.000000 额度`

This identifies the event as a **daily sign-in grant** of `$25`, not a generic logout bonus. The monitor preserves sanitized type-4 content, parses the amount, deduplicates it by the AgentRouter log id, and stores it as confirmed evidence. Positive balance deltas are retained separately as correlation data.

The deployed Console notice independently states that login check-in gives `$25 Credit`. Current automation snapshots use visible balance changes for ongoing observations; already captured system-log grants remain stored as confirmed historical evidence.

AgentRouter log types in the deployed frontend are:

- `1`: recharge
- `2`: consumption
- `3`: management
- `4`: system
- `5`: error
