import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AccountStore } from "./accounts";
import { AuthenticationChallengeBroker } from "./challenges";
import { loadCollectorProxyCredential, loadCollectorRegistry } from "./collector-registry";
import {
  CollectorAdmissionController,
  createProductionCollectorHandler,
  DEFAULT_MAX_BATCH_BYTES,
} from "./collector/server";
import type { AppConfig } from "./config";
import { loadConfig } from "./config";
import { CheckCoordinator } from "./coordinator";
import { startDashboard } from "./dashboard";
import { ObservatoryCoordinator } from "./observatory/coordinator";
import { ObservatoryStore } from "./observatory/store";
import { ensureSecureScreenshotDirectory, ScreenshotRetentionManager } from "./screenshot-retention";
import { SettingsStore } from "./settings";
import { Store } from "./storage";
import { TelegramNotifier } from "./telegram";
function parseArgs(): Set<string> {
  return new Set(process.argv.slice(2).map((argument) => argument.trim().toLowerCase()));
}

async function prepareDirectories(config: AppConfig): Promise<void> {
  const dirs = [
    mkdir(config.dataDir, { recursive: true }),
    process.platform !== "win32"
      ? ensureSecureScreenshotDirectory(config.screenshotDir).then((root) => root.close())
      : Promise.resolve(),
    mkdir(config.accountStateDir, { recursive: true }),
    mkdir(config.browserProfileDir, { recursive: true }),
    mkdir(dirname(config.accountFilePath), { recursive: true }),
    mkdir(dirname(config.settingsFilePath), { recursive: true }),
    mkdir(dirname(config.dbPath), { recursive: true }),
    mkdir(dirname(config.telegram.stateFilePath), { recursive: true }),
    mkdir(dirname(config.ompQuota.stateFilePath), { recursive: true }),
  ];
  if (config.observatory.enabled && config.observatory.dbPath !== ":memory:") {
    dirs.push(mkdir(dirname(config.observatory.dbPath), { recursive: true }));
  }
  await Promise.all(dirs);
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

async function startCollectorListener(config: AppConfig, store: ObservatoryStore) {
  const registryFilePath = config.collector.registryFilePath;
  const executablePath = config.collector.tailscaleExecutablePath;
  const proxyTokenFilePath = config.collector.proxyTokenFilePath;
  if (!registryFilePath || !executablePath || !proxyTokenFilePath) {
    throw new Error("Collector registry, proxy credential, and Tailscale executable are required.");
  }
  const loaded = await loadCollectorRegistry(registryFilePath);
  const proxyCredential = await loadCollectorProxyCredential(proxyTokenFilePath);
  try {
    const handler = await createProductionCollectorHandler({
      executablePath,
      registry: loaded.registry,
      keyLoader: loaded.keyLoader,
      proxyTokenLoader: proxyCredential.proxyTokenLoader,
      admission: new CollectorAdmissionController(),
      store,
      maxBatchBytes: DEFAULT_MAX_BATCH_BYTES,
    });
    const server = Bun.serve({
      hostname: config.collector.host,
      port: config.collector.port,
      maxRequestBodySize: DEFAULT_MAX_BATCH_BYTES,
      fetch(request, bunServer) {
        return handler(request, bunServer);
      },
    });
    return {
      server,
      close() {
        server.stop(true);
        proxyCredential.close();
      },
    };
  } catch (error) {
    proxyCredential.close();
    throw error;
  }
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
  } catch {
    console.error("telegram disabled: private recipient verification failed");
  }

  let observatoryStore: ObservatoryStore | null = null;
  let observatoryCoordinator: ObservatoryCoordinator | null = null;
  if (config.observatory.enabled) {
    observatoryStore = new ObservatoryStore(config.observatory.dbPath);
    observatoryCoordinator = new ObservatoryCoordinator(observatoryStore, config, telegram);
    console.log("observatory: enabled with separate durable storage");
  }

  const retention = new ScreenshotRetentionManager({
    screenshotDir: config.screenshotDir,
  });
  await retention.pruneOnce().catch(() => {
    console.warn("screenshot retention: startup prune failed closed");
  });

  const coordinator = new CheckCoordinator(
    store,
    accounts,
    config,
    settings,
    challenges,
    telegram,
    null,
    observatoryCoordinator,
  );
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
        "No enabled accounts are configured. Run `bun run dashboard` and add an account first.",
      );
    }
    await coordinator.runCycle();
    store.close();
    observatoryStore?.close();
    return;
  }

  const observatoryContext =
    observatoryStore && observatoryCoordinator
      ? { store: observatoryStore, coordinator: observatoryCoordinator }
      : null;
  const collectorServer = config.collector.enabled && observatoryStore
    ? await startCollectorListener(config, observatoryStore)
    : null;
  if (collectorServer) console.log("collector: listening on registered loopback ingestion port");
  const server = startDashboard(store, accounts, settings, challenges, coordinator, config, observatoryContext);
  console.log(`dashboard: ${server.url}`);
  const automation = await settings.load();
  if (automation.openDashboardOnStart) {
    openDashboardInDefaultBrowser(server.url.toString());
  }
  const configured = (await accounts.load()).filter((account) => account.enabled);
  if (configured.length === 0) {
    console.log("No accounts configured. Open the dashboard to add the first account.");
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    coordinator.stopScheduler();
    collectorServer?.close();
    server.stop(true);
    await retention.close();
    observatoryStore?.close();
    store.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (dashboardOnly) {
    retention.startScheduler();
    console.log("dashboard-only mode: scheduled account checks are paused");
    return;
  }

  coordinator.startScheduler();
  retention.startScheduler();
  console.log("scheduler: active");
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
