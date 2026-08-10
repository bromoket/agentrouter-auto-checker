import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AccountStore } from "./accounts";
import { AuthenticationChallengeBroker } from "./challenges";
import { loadConfig } from "./config";
import { CheckCoordinator } from "./coordinator";
import { startDashboard } from "./dashboard";
import { SettingsStore } from "./settings";
import { Store } from "./storage";
import { TelegramNotifier } from "./telegram";

function parseArgs(): Set<string> {
  return new Set(process.argv.slice(2).map((argument) => argument.trim().toLowerCase()));
}

async function prepareDirectories(config: ReturnType<typeof loadConfig>): Promise<void> {
  await Promise.all([
    mkdir(config.dataDir, { recursive: true }),
    mkdir(config.screenshotDir, { recursive: true }),
    mkdir(config.accountStateDir, { recursive: true }),
    mkdir(config.browserProfileDir, { recursive: true }),
    mkdir(dirname(config.accountFilePath), { recursive: true }),
    mkdir(dirname(config.settingsFilePath), { recursive: true }),
    mkdir(dirname(config.dbPath), { recursive: true }),
  ]);
}

function openDashboardInDefaultBrowser(url: string): void {
  const command = process.platform === "win32"
    ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
    : process.platform === "darwin"
      ? ["open", url]
      : ["xdg-open", url];
  const child = Bun.spawn({
    cmd: command,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
  });
  child.unref();
}

async function main(): Promise<void> {
  const config = loadConfig();
  await prepareDirectories(config);

  const store = new Store(config.dbPath);
  const accounts = new AccountStore(config.accountFilePath);
  const settings = new SettingsStore(config.settingsFilePath);
  const challenges = new AuthenticationChallengeBroker();
  let telegram: TelegramNotifier | null = null;
  try {
    telegram = await TelegramNotifier.create(config, store);
    if (telegram) console.log("telegram: verified private recipient; material alerts enabled");
  } catch (error) {
    console.error(`telegram disabled: ${error instanceof Error ? error.message : String(error)}`);
  }
  const coordinator = new CheckCoordinator(store, accounts, config, settings, challenges, telegram);
  const args = parseArgs();
  const runOnce = args.has("--once");
  const dashboardOnly = args.has("--dashboard");

  if (runOnce && dashboardOnly) {
    throw new Error("Use either --once or --dashboard, not both.");
  }

  if (runOnce) {
    const configured = (await accounts.load()).filter((account) => account.enabled);
    if (configured.length === 0) {
      throw new Error(
        `No enabled accounts are configured in ${config.accountFilePath}. ` +
          "Run `bun run dashboard`, open the local UI, and add an account first.",
      );
    }
    await coordinator.runCycle();
    store.close();
    return;
  }

  const server = startDashboard(store, accounts, settings, challenges, coordinator, config);
  console.log(`dashboard: ${server.url}`);
  const automation = await settings.load();
  if (automation.openDashboardOnStart) {
    openDashboardInDefaultBrowser(server.url.toString());
  }
  const configured = (await accounts.load()).filter((account) => account.enabled);
  if (configured.length === 0) {
    console.log("No accounts configured. Open the dashboard to add the first account.");
  }

  if (dashboardOnly) {
    console.log("dashboard-only mode: scheduled checks are paused; use Run now in the UI.");
    return;
  }

  coordinator.startScheduler();
  console.log(`scheduler: controlled from ${config.settingsFilePath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
