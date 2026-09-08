// Synthetic quota-warning demo: records a quota_warning event for the Command Code
// GOAT account and delivers it to Telegram, to demonstrate the rich message format
// (provider, window, used/cap, remaining %, reset countdown).
import { loadConfig } from "../src/config";
import { createDashboardAuth } from "../src/dashboard-auth";
import { ObservatoryStore } from "../src/observatory/store";
import { ObservatoryDeliveryManager } from "../src/observatory/delivery";
import { createDeterministicFingerprint } from "../src/observatory/events";
import type { TelegramNotifier } from "../src/telegram";

const config = loadConfig();
const store = new ObservatoryStore(config.observatory.dbPath);

// Use the Command Code GOAT identity + its real weekly window reset.
const GOAT_ID = "6fbb6481-5f82-428b-bfd8-99b676718f4d";
const windowId = "weekly";
const now = new Date().toISOString();

// Seed a current quota window so lookupEventDetail can enrich the message.
const weekly = store.getCurrentQuotaWindow(GOAT_ID, "commandcode-weekly", windowId);
const used = weekly?.usedUnits ?? 20;
const total = weekly?.totalUnits ?? 35;
const resetAt = weekly?.resetsAt ?? new Date(Date.now() + 6 * 24 * 3600_000).toISOString();

store.recordQuotaObservation({
  identityId: GOAT_ID,
  provider: "commandcode",
  bucketId: "commandcode-weekly",
  windowId,
  windowDurationMs: 7 * 24 * 3600_000,
  meter: "credits",
  tier: "individual-goat",
  hostId: config.observatory.sourceHostId,
  observedAt: now,
  resetsAt: resetAt,
  usedFraction: Math.round((used / total) * 1_000_000) / 1_000_000,
  remainingFraction: Math.round(((total - used) / total) * 1_000_000) / 1_000_000,
  usedUnits: used,
  totalUnits: total,
  remainingUnits: total - used,
  resetCredits: null,
  unit: "credits",
  status: "warning",
  source: "commandcode-direct",
  sourceVersion: "commandcode-direct",
});

const { event } = store.recordEvent({
  eventType: "quota_warning",
  severity: "warning",
  fingerprint: createDeterministicFingerprint("quota_warning", GOAT_ID, windowId, "demo-" + Date.now()),
  occurredAt: now,
  hostId: config.observatory.sourceHostId,
  identityId: GOAT_ID,
  provider: "commandcode",
  windowId: windowId,
  meter: "credits",
  tier: "individual-goat",
});

const delivery = store.recordDeliveryAttempt({
  eventId: event.eventId,
  channel: "telegram",
  status: "pending",
  fingerprint: createDeterministicFingerprint("delivery", event.eventId, "telegram", "demo"),
});

// Inject the real TelegramNotifier like the service does.
import { TelegramNotifier } from "../src/telegram";
const telegram = await TelegramNotifier.create(config, store);
if (!telegram) {
  console.log("TELEGRAM_NOT_CONFIGURED");
  process.exit(0);
}
const manager = new ObservatoryDeliveryManager(store, telegram, config);
const result = await manager.processOutboxOnce(1);
console.log("SYNTHETIC_DELIVERY processed=" + result.processed + " sent=" + result.sent + " failed=" + result.failed);
store.close();
