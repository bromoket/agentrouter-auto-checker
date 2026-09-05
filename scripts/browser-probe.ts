import { runSingleAccountCheck } from "../src/account-checker";
import { AccountStore } from "../src/accounts";
import { AuthenticationChallengeBroker } from "../src/challenges";
import { loadConfig } from "../src/config";
import { SettingsStore } from "../src/settings";

const config = loadConfig();
const selector = process.argv[2]?.trim();
if (!selector) {
  throw new Error("Usage: bun run probe:browser <account-id-or-github-username>");
}

const accountStore = new AccountStore(config.accountFilePath);
const account = (await accountStore.load()).find(
  (candidate) => candidate.id === selector || candidate.githubUsername.toLowerCase() === selector.toLowerCase(),
);
if (!account) {
  throw new Error(`No configured account matches ${selector}.`);
}

const savedSettings = await new SettingsStore(config.settingsFilePath).load();
const settings = {
  ...savedSettings,
  captureScreenshots: true,
};
const challenges = new AuthenticationChallengeBroker();

process.stdout.write(`Native browser probe starting for ${account.label}; production SQLite will not be modified.\n`);
const result = await runSingleAccountCheck(account, config, settings, challenges, {
  onProgress(progress) {
    process.stdout.write(`[${progress.percent}%] ${progress.stage}: ${progress.message}\n`);
  },
});

process.stdout.write(`${JSON.stringify({
  accountId: result.accountId,
  status: result.status,
  startedAt: result.startedAt,
  endedAt: result.endedAt,
  loginMs: result.loginMs,
  dashboardMs: result.dashboardMs,
  totalMs: result.totalMs,
  loggedOut: result.loggedOut,
  sessionReused: result.sessionReused,
  metrics: result.metrics,
  moneyCollection: result.summary.moneyCollection,
  launchAttempts: result.summary.launchAttempts,
  screenshotPath: result.screenshotPath,
  errorMessage: result.errorMessage,
}, null, 2)}\n`);
if (result.status !== "ok" || !result.loggedOut) {
  process.exitCode = 1;
}
