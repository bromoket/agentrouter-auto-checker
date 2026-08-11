# AgentRouter Monitor

A Bun + TypeScript service that continuously checks any number of AgentRouter accounts, records verified account data in SQLite, and presents combined and per-account analytics in a private web dashboard.

Each cycle uses a dedicated persistent Chromium profile, signs in through GitHub, reads the visible `/console/` and `/console/topup` pages, retries suspicious double-zero money values, saves the result, and confirms logout through the visible **Quit** action. Saved browser profiles retain GitHub device trust while AgentRouter is logged out between checks.

Balances are stored as signed USD values: a legitimate negative balance is retained and alerted as low credit instead of being discarded as malformed data. Consumption remains non-negative.

Telegram notifications are intentionally quiet: every positive balance delta, confirmed credit grants, low-balance crossings, large balance decreases, repeated failures, and recovery. A grant log and its matching balance delta are merged into one event; unexplained increases remain clearly labeled as observations rather than grants. Financial alerts include timing, session/logout evidence, totals, and an account-history graph. Delivery is locked to one verified private Telegram chat and username.

## Install and run

Requirements: Bun 1.3+, Node.js 20+, and Playwright Chromium.

```bash
bun install --frozen-lockfile
bunx playwright install --with-deps chromium
cp accounts.example.json data/accounts.json
cp settings.example.json data/settings.json
bun run start
```

On Windows, use `bun run install:browsers` instead of the Playwright `--with-deps` command. The dashboard defaults to <http://127.0.0.1:3100>; accounts and schedules can be managed entirely from its UI. Credentials, cookies, profiles, SQLite, and Telegram state under `data/` are ignored by Git and must be protected as secrets.

Useful commands:

```bash
bun run once              # one complete account cycle
bun run dashboard         # UI without the scheduler
bun run probe:headless ID # non-persisting headless compatibility probe
bun run telegram:test     # one controlled Telegram setup message
bun run typecheck
bun test
bun run audit:db
```

## Telegram

Set these together in the service environment:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ALLOWED_USERNAME=
TELEGRAM_LOW_BALANCE_USD=50
TELEGRAM_LARGE_DROP_USD=25
TELEGRAM_REPEATED_FAILURE_COUNT=3
TELEGRAM_GRAPHS_ENABLED=true
TELEGRAM_DASHBOARD_URL=http://100.127.29.78:8456
```

The bot verifies that the numeric destination is a private chat whose username exactly matches `TELEGRAM_ALLOWED_USERNAME` before enabling notifications. Branding assets for BotFather are in [`assets/telegram`](assets/telegram).

## Ubuntu service

The production layout uses a dedicated hardened systemd user and binds to one exact Tailscale address. Installation, upgrades, logs, health checks, backups, and the headed recovery route are documented in [`docs/ubuntu-deployment.md`](docs/ubuntu-deployment.md).
