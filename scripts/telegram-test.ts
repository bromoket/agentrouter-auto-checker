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
  await notifier.sendTestMessage();
  console.log("Telegram test notification sent.");
} finally {
  store.close();
}
