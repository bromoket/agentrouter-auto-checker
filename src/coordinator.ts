import type { GitHubAccount } from "./accounts";
import { AccountStore } from "./accounts";
import { AuthenticationChallengeBroker } from "./challenges";
import type { AppConfig } from "./config";
import { runSingleAccountCheck } from "./account-checker";
import type { WorkerProgress } from "./account-checker";
import type { AutomationSettings } from "./settings";
import { SettingsStore } from "./settings";
import type { RunSnapshot } from "./storage";
import { Store } from "./storage";
import type { TelegramNotifier } from "./telegram";
import { hasMonitorSession, pollAccountEndpoints } from "./endpoint-poller";

export interface CoordinatorStatus {
  running: boolean;
  currentAccountId: string | null;
  currentAccountLabel: string | null;
  cycleStartedAt: string | null;
  lastCycleStartedAt: string | null;
  lastCycleEndedAt: string | null;
  lastCycleError: string | null;
  completedAccounts: number;
  totalAccounts: number;
  schedulerActive: boolean;
  schedulerEnabled: boolean;
  nextScheduledRunAt: string | null;
  currentStage: string | null;
  currentMessage: string | null;
  progressPercent: number;
  cancellationRequested: boolean;
  canStop: boolean;
  events: CoordinatorEvent[];
}

export interface CoordinatorEvent extends WorkerProgress {
  accountId: string | null;
  accountLabel: string | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failedSnapshot(account: GitHubAccount, startedAt: string, error: unknown): RunSnapshot {
  const endedAt = new Date().toISOString();
  return {
    accountId: account.id,
    accountLabel: account.label,
    startedAt,
    endedAt,
    status: "error",
    loginMs: 0,
    dashboardMs: 0,
    totalMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    summary: {},
    metrics: {},
    usagePoints: [],
    apiCalls: [],
    loggedOut: false,
    sessionReused: false,
    errorMessage: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
}

export class CheckCoordinator {
  private cycleClaimed = false;
  private status: CoordinatorStatus = {
    running: false,
    currentAccountId: null,
    currentAccountLabel: null,
    cycleStartedAt: null,
    lastCycleStartedAt: null,
    lastCycleEndedAt: null,
    lastCycleError: null,
    completedAccounts: 0,
    totalAccounts: 0,
    schedulerActive: false,
    schedulerEnabled: false,
    nextScheduledRunAt: null,
    currentStage: null,
    currentMessage: null,
    progressPercent: 0,
    cancellationRequested: false,
    canStop: false,
    events: [],
  };
  private schedulerStarted = false;
  private endpointPollerStarted = false;
  private activeAbortController: AbortController | null = null;

  constructor(
    private readonly store: Store,
    private readonly accounts: AccountStore,
    private readonly config: AppConfig,
    private readonly settings: SettingsStore,
    private readonly challenges: AuthenticationChallengeBroker,
    private readonly telegram: TelegramNotifier | null = null,
  ) {}

  getStatus(): CoordinatorStatus {
    return { ...this.status, events: [...this.status.events] };
  }

  stopCycle(): boolean {
    if (!this.status.running || !this.activeAbortController) {
      return false;
    }
    this.status.cancellationRequested = true;
    this.status.canStop = false;
    this.status.currentStage = "cancelling";
    this.status.currentMessage = "Stopping the active browser worker and cancelling the remaining accounts.";
    this.appendEvent({
      stage: "cancelling",
      message: this.status.currentMessage,
      percent: this.status.progressPercent,
      at: new Date().toISOString(),
    });
    this.activeAbortController.abort();
    return true;
  }

  private appendEvent(progress: WorkerProgress): void {
    this.status.events = [
      ...this.status.events,
      {
        ...progress,
        accountId: this.status.currentAccountId,
        accountLabel: this.status.currentAccountLabel,
      },
    ].slice(-40);
  }

  startScheduler(): void {
    if (this.schedulerStarted) return;
    this.schedulerStarted = true;
    this.status.schedulerActive = true;
    void this.schedulerLoop();
    if (!this.endpointPollerStarted) {
      this.endpointPollerStarted = true;
      void this.endpointPollingLoop();
    }
  }

  private async endpointPollingLoop(): Promise<void> {
    let nextPollAt = Date.now();
    while (this.endpointPollerStarted) {
      try {
        const settings = await this.settings.load();
        if (!settings.endpointPollingEnabled || this.status.running) {
          await delay(1_000);
          continue;
        }
        if (Date.now() >= nextPollAt) {
          const accounts = (await this.accounts.load()).filter(
            (account) => account.enabled && Boolean(account.agentRouterApiToken),
          );
          for (const account of accounts) {
            if (!await hasMonitorSession(account, this.config)) {
              // The first browser cycle creates this short-lived, private
              // session snapshot. Until then there is nothing read-only to
              // poll, and an error observation would be misleading.
              continue;
            }
            const observation = await pollAccountEndpoints(account, this.config);
            this.store.saveEndpointObservation(observation);
            if (observation.status === "error") {
              console.warn(`[endpoint-poll:${account.label}] ${observation.errorMessage}`);
            }
          }
          nextPollAt = Date.now() + settings.endpointPollIntervalMinutes * 60_000;
        }
      } catch (error) {
        console.error(`endpoint poller: ${error instanceof Error ? error.message : String(error)}`);
        nextPollAt = Date.now() + 60_000;
      }
      await delay(1_000);
    }
  }

  private async schedulerLoop(): Promise<void> {
    let firstEvaluation = true;
    let nextRunAt: number | null = null;
    let previousIntervalMinutes: number | null = null;

    while (this.schedulerStarted) {
      try {
        const settings = await this.settings.load();
        this.status.schedulerEnabled = settings.schedulerEnabled;
        if (!settings.schedulerEnabled) {
          nextRunAt = null;
          this.status.nextScheduledRunAt = null;
          firstEvaluation = false;
          await delay(1_000);
          continue;
        }

        const intervalMs = settings.intervalMinutes * 60_000;
        if (nextRunAt === null) {
          nextRunAt = firstEvaluation && settings.runOnStart ? Date.now() : Date.now() + intervalMs;
        } else if (previousIntervalMinutes !== settings.intervalMinutes) {
          nextRunAt = Math.min(nextRunAt, Date.now() + intervalMs);
        }
        previousIntervalMinutes = settings.intervalMinutes;
        firstEvaluation = false;
        this.status.nextScheduledRunAt = new Date(nextRunAt).toISOString();

        if (Date.now() >= nextRunAt) {
          await this.runCycle();
          nextRunAt = Date.now() + intervalMs;
          this.status.nextScheduledRunAt = new Date(nextRunAt).toISOString();
        }
      } catch (error) {
        this.status.lastCycleError = `Scheduler: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      await delay(1_000);
    }
  }

  async runCycle(
    accountId?: string,
    options: { browserHeadless?: boolean } = {},
  ): Promise<boolean> {
    if (this.cycleClaimed) {
      return false;
    }
    this.cycleClaimed = true;

    try {
      const automation = await this.settings.load();
      const configured = (await this.accounts.load())
        .filter((account) => account.enabled)
        .sort((left, right) => left.runOrder - right.runOrder || left.label.localeCompare(right.label));
      const selected = accountId
        ? configured.filter((account) => account.id === accountId)
        : configured;
      if (accountId && selected.length === 0) {
        throw new Error(`Enabled account not found: ${accountId}`);
      }
      if (selected.length === 0) {
        return false;
      }

      const cycleStartedAt = new Date().toISOString();
      this.status = {
        ...this.status,
        running: true,
        currentAccountId: null,
        currentAccountLabel: null,
        cycleStartedAt,
        lastCycleStartedAt: cycleStartedAt,
        lastCycleError: null,
        completedAccounts: 0,
        totalAccounts: selected.length,
        currentStage: "queued",
        currentMessage: "Preparing the account queue.",
        progressPercent: 0,
        cancellationRequested: false,
        canStop: true,
        events: [],
      };
      this.activeAbortController = new AbortController();
      this.appendEvent({
        stage: "queued",
        message: `Prepared ${selected.length} account${selected.length === 1 ? "" : "s"} for this cycle.`,
        percent: 0,
        at: cycleStartedAt,
      });
      console.log(`[${cycleStartedAt}] starting check cycle (${selected.length} account(s))`);
      const runSettings: AutomationSettings = options.browserHeadless === undefined
        ? automation
        : { ...automation, browserHeadless: options.browserHeadless };

      for (const [accountIndex, account] of selected.entries()) {
        if (this.activeAbortController.signal.aborted) break;
        this.status.currentAccountId = account.id;
        this.status.currentAccountLabel = account.label;
        this.status.currentStage = "starting-account";
        this.status.currentMessage = `Starting ${account.label}.`;
        this.status.progressPercent = Math.round((accountIndex / selected.length) * 100);
        this.appendEvent({
          stage: "starting-account",
          message: this.status.currentMessage,
          percent: this.status.progressPercent,
          at: new Date().toISOString(),
        });
        const accountStartedAt = new Date().toISOString();
        let snapshot: RunSnapshot;
        try {
          snapshot = await runSingleAccountCheck(
            account,
            this.config,
            runSettings,
            this.challenges,
            {
              signal: this.activeAbortController.signal,
              onProgress: (progress) => {
                const accountShare = 100 / selected.length;
                const cyclePercent = accountIndex * accountShare + (progress.percent / 100) * accountShare;
                this.status.currentStage = progress.stage;
                this.status.currentMessage = progress.message;
                this.status.progressPercent = Math.min(100, Math.round(cyclePercent));
                this.appendEvent(progress);
              },
            },
          );
        } catch (error) {
          snapshot = failedSnapshot(account, accountStartedAt, error);
        }

        const capturedApiToken = snapshot.capturedApiToken;
        if (capturedApiToken) {
          delete snapshot.capturedApiToken;
          try {
            await this.accounts.setApiToken(account.id, capturedApiToken);
          } catch (error) {
            this.appendEvent({
              stage: "token-save-warning",
              message: `Data captured, but the AgentRouter API token could not be saved: ${error instanceof Error ? error.message : "unknown error"}`,
              percent: this.status.progressPercent,
              at: new Date().toISOString(),
            });
          }
        }
        const runId = this.store.saveRun(snapshot);
        await this.telegram?.processRun(runId, snapshot);
        this.status.completedAccounts += 1;
        const reason = snapshot.errorMessage ? `: ${snapshot.errorMessage}` : "";
        console.log(
          `[${new Date().toISOString()}] ${account.label} ${snapshot.status} in ${snapshot.totalMs}ms${reason}`,
        );
        if (snapshot.status === "error" && !this.activeAbortController.signal.aborted) {
          this.status.lastCycleError = snapshot.errorMessage ?? "Unknown account check error";
        }
        if (this.activeAbortController.signal.aborted) {
          break;
        }
        if (accountIndex < selected.length - 1 && automation.accountDelaySeconds > 0) {
          await delay(automation.accountDelaySeconds * 1_000);
        }
      }
      return true;
    } finally {
      this.cycleClaimed = false;
      const wasCancelled = this.status.cancellationRequested;
      this.activeAbortController = null;
      if (this.status.running) {
        this.status.running = false;
        this.status.currentAccountId = null;
        this.status.currentAccountLabel = null;
        this.status.cycleStartedAt = null;
        this.status.lastCycleEndedAt = new Date().toISOString();
        this.status.currentStage = wasCancelled ? "cancelled" : "complete";
        this.status.currentMessage = wasCancelled
          ? "Cycle cancelled. No further accounts will run."
          : "Cycle finished.";
        this.status.progressPercent = wasCancelled ? this.status.progressPercent : 100;
        this.status.canStop = false;
        this.appendEvent({
          stage: this.status.currentStage,
          message: this.status.currentMessage,
          percent: this.status.progressPercent,
          at: this.status.lastCycleEndedAt,
        });
      }
    }
  }
}
