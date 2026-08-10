import { loadConfig } from "../src/config";
import { Store } from "../src/storage";
import { TelegramNotifier } from "../src/telegram";

const config = loadConfig();
const store = new Store(config.dbPath);
try {
  const notifier = await TelegramNotifier.create(config, store);
  if (!notifier) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and TELEGRAM_ALLOWED_USERNAME must be configured.",
    );
  }
  const replayIndex = process.argv.indexOf("--run");
  if (replayIndex >= 0) {
    const runId = Number(process.argv[replayIndex + 1]);
    await notifier.sendObservationAlert(runId);
    console.log(`Telegram observation alert sent for run ${runId}.`);
  } else {
    await notifier.sendTestMessage();
    console.log("Telegram test notification sent.");
  }
} finally {
  store.close();
}
