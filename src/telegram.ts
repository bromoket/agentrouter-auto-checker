import { chmod, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig, TelegramConfig } from "./config";
import type { CreditGrantEvent, CreditObservation, RunSnapshot } from "./storage";
import { Store } from "./storage";

const CHART_SCRIPT = fileURLToPath(new URL("../scripts/telegram-chart.mjs", import.meta.url));

interface AccountNotificationState {
  lowBalanceActive: boolean;
  consecutiveFailures: number;
  failureAlerted: boolean;
  lastProcessedRunId: number;
}

interface TelegramState {
  version: 1;
  initializedAt: string;
  lastGrantId: number;
  accounts: Record<string, AccountNotificationState>;
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
  result?: unknown;
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function accountState(state: TelegramState, accountId: string): AccountNotificationState {
  return state.accounts[accountId] ??= {
    lowBalanceActive: false,
    consecutiveFailures: 0,
    failureAlerted: false,
    lastProcessedRunId: 0,
  };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function money(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const prefix = value < 0 ? "-" : signed && value > 0 ? "+" : "";
  return `${prefix}$${Math.abs(value).toFixed(2)}`;
}

function elapsed(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "first verified sample";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1_440) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1_440).toFixed(1)} d`;
}

function observedAt(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Budapest",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function compactError(value: string | undefined): string {
  if (!value) return "Unknown account-check failure";
  return value.replace(/\u001B\[[0-9;]*m/g, "").replace(/\s+/g, " ").slice(0, 500);
}

class TelegramStateStore {
  constructor(private readonly path: string) {}

  async load(initialGrantId: number): Promise<TelegramState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("state must be an object");
      }
      const candidate = parsed as Partial<TelegramState>;
      if (
        candidate.version !== 1 ||
        typeof candidate.initializedAt !== "string" ||
        !Number.isSafeInteger(candidate.lastGrantId) ||
        !candidate.accounts ||
        typeof candidate.accounts !== "object" ||
        Array.isArray(candidate.accounts)
      ) {
        throw new Error("state schema is invalid");
      }
      for (const [accountId, rawState] of Object.entries(candidate.accounts)) {
        if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {
          throw new Error(`state for ${accountId} is invalid`);
        }
        const account = rawState as Partial<AccountNotificationState>;
        if (
          typeof account.lowBalanceActive !== "boolean" ||
          typeof account.failureAlerted !== "boolean" ||
          !Number.isSafeInteger(account.consecutiveFailures) ||
          (account.consecutiveFailures ?? -1) < 0 ||
          !Number.isSafeInteger(account.lastProcessedRunId) ||
          (account.lastProcessedRunId ?? -1) < 0
        ) {
          throw new Error(`state for ${accountId} is invalid`);
        }
      }
      return candidate as TelegramState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Unable to load Telegram notification state: ${
          error instanceof Error ? error.message : String(error)
        }`);
      }
      const state: TelegramState = {
        version: 1,
        initializedAt: new Date().toISOString(),
        lastGrantId: initialGrantId,
        accounts: {},
      };
      await this.save(state);
      return state;
    }
  }

  async save(state: TelegramState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => {});
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

class TelegramTransport {
  constructor(
    private readonly config: TelegramConfig,
    private readonly fetcher: Fetcher,
  ) {}

  async verifyRecipient(): Promise<void> {
    const response = await this.request("getChat", { chat_id: this.config.chatId });
    const chat = response.result as { id?: number; type?: string; username?: string } | undefined;
    if (
      String(chat?.id) !== this.config.chatId ||
      chat?.type !== "private" ||
      chat.username?.toLowerCase() !== this.config.allowedUsername
    ) {
      throw new Error("Telegram recipient did not match the configured private chat and username.");
    }
  }

  async sendMessage(html: string): Promise<void> {
    await this.request("sendMessage", {
      chat_id: this.config.chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  }

  async sendPhoto(photo: Uint8Array, caption: string): Promise<void> {
    const form = new FormData();
    const photoBuffer = new ArrayBuffer(photo.byteLength);
    new Uint8Array(photoBuffer).set(photo);
    form.set("chat_id", this.config.chatId!);
    form.set("caption", caption.slice(0, 1_024));
    form.set("parse_mode", "HTML");
    form.set("photo", new Blob([photoBuffer], { type: "image/png" }), "agentrouter-balance.png");
    await this.request("sendPhoto", form);
  }

  private async request(
    method: "getChat" | "sendMessage" | "sendPhoto",
    body: object | FormData,
  ): Promise<TelegramApiResponse> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        const isForm = body instanceof FormData;
        const response = await this.fetcher(
          `https://api.telegram.org/bot${this.config.botToken}/${method}`,
          {
            method: "POST",
            headers: isForm ? undefined : { "content-type": "application/json" },
            body: isForm ? body : JSON.stringify(body),
            signal: controller.signal,
          },
        );
        const result = await response.json().catch(() => ({})) as TelegramApiResponse;
        if (response.ok && result.ok) return result;

        const retryAfter = Math.min(15, Math.max(1, Number(result.parameters?.retry_after) || attempt));
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 3) {
          throw new Error(`Telegram rejected ${method}: ${result.description?.slice(0, 200) || response.status}`);
        }
        await Bun.sleep(retryAfter * 1_000);
      } catch (error) {
        if (attempt === 3 || (error instanceof Error && error.message.startsWith("Telegram rejected"))) {
          if (error instanceof Error && error.message.startsWith("Telegram rejected")) throw error;
          throw new Error(`Telegram ${method} failed after three attempts.`);
        }
        await Bun.sleep(attempt * 1_000);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error(`Telegram ${method} failed.`);
  }
}

export class TelegramNotifier {
  private readonly stateStore: TelegramStateStore;
  private readonly transport: TelegramTransport;
  private state!: TelegramState;

  private constructor(
    private readonly config: AppConfig,
    private readonly store: Store,
    fetcher: Fetcher,
  ) {
    this.stateStore = new TelegramStateStore(config.telegram.stateFilePath);
    this.transport = new TelegramTransport(config.telegram, fetcher);
  }

  static async create(
    config: AppConfig,
    store: Store,
    fetcher: Fetcher = fetch,
  ): Promise<TelegramNotifier | null> {
    if (
      !config.telegram.botToken ||
      !config.telegram.chatId ||
      !config.telegram.allowedUsername
    ) return null;
    const notifier = new TelegramNotifier(config, store, fetcher);
    await notifier.transport.verifyRecipient();
    notifier.state = await notifier.stateStore.load(store.getLatestCreditGrantEventId());
    return notifier;
  }

  async processRun(runId: number, snapshot: RunSnapshot): Promise<void> {
    const state = accountState(this.state, snapshot.accountId);
    if (runId <= state.lastProcessedRunId) return;
    try {
      if (snapshot.status === "error") {
        await this.processFailure(snapshot);
        return;
      }

      await this.processRecovery(snapshot);
      const observation = this.store.getCreditObservationForRun(runId);
      await this.processFinancialNotifications(
        runId,
        snapshot.accountLabel,
        observation,
      );
    } catch (error) {
      console.error(`Telegram notification skipped: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      state.lastProcessedRunId = runId;
      await this.stateStore.save(this.state).catch((error) => {
        console.error(`Telegram state update failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  async sendTestMessage(): Promise<void> {
    const accounts = this.store.listHistoricalAccounts();
    const rows = accounts.map((account) => {
      const latest = this.store.listMetricHistory(account.accountId, 1).at(-1)?.metrics;
      return `• <b>${escapeHtml(account.label)}</b>: ${money(latest?.balance)} balance · ${money(latest?.consumed)} consumed`;
    });
    const grants = accounts.flatMap((account) => this.store.listCreditGrantEvents(account.accountId, 5_000));
    const total = grants.reduce((sum, grant) => sum + grant.amount, 0);
    const message = [
      "💜 <b>AgentRouter alerts are ready</b>",
      "",
      ...rows,
      "",
      `<b>Confirmed grants:</b> ${grants.length} · ${money(total)}`,
      `<b>Rules:</b> positive deltas · grants · balance below ${money(this.config.telegram.lowBalanceUsd)} · drops of ${money(this.config.telegram.largeDropUsd)}+ · ${this.config.telegram.repeatedFailureCount} repeated failures`,
      `<a href="${escapeHtml(this.config.telegram.dashboardUrl)}">Open dashboard</a>`,
    ].join("\n");
    const chartAccount = accounts.at(0);
    if (chartAccount && this.config.telegram.graphsEnabled) {
      await this.sendRich(
        chartAccount.accountId,
        `${chartAccount.label} · setup check`,
        message,
      );
      return;
    }
    await this.transport.sendMessage(message);
  }

  async sendObservationAlert(runId: number): Promise<void> {
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      throw new Error("Telegram observation replay requires a positive run id.");
    }
    const observation = this.store.getCreditObservationForRun(runId);
    if (!observation) throw new Error(`Run ${runId} has no verified credit observation.`);
    const account = this.store
      .listHistoricalAccounts()
      .find((item) => item.accountId === observation.accountId);
    const sent = await this.processBalanceAlert(
      account?.label || observation.accountId,
      observation,
      [],
    );
    if (!sent) throw new Error(`Run ${runId} does not contain a material balance event.`);
  }

  private async processFailure(snapshot: RunSnapshot): Promise<void> {
    const state = accountState(this.state, snapshot.accountId);
    state.consecutiveFailures += 1;
    await this.stateStore.save(this.state);
    if (
      state.failureAlerted ||
      state.consecutiveFailures < this.config.telegram.repeatedFailureCount
    ) return;

    await this.transport.sendMessage([
      "🛑 <b>Repeated AgentRouter checks are failing</b>",
      "",
      `<b>Account:</b> ${escapeHtml(snapshot.accountLabel)}`,
      `<b>Consecutive failures:</b> ${state.consecutiveFailures}`,
      `<b>Last attempt:</b> ${(snapshot.totalMs / 1_000).toFixed(1)} s`,
      `<b>Reason:</b> ${escapeHtml(compactError(snapshot.errorMessage))}`,
      `<b>Observed:</b> ${escapeHtml(observedAt(snapshot.endedAt))}`,
      "",
      `<a href="${escapeHtml(this.config.telegram.dashboardUrl)}">Open diagnostics</a>`,
    ].join("\n"));
    state.failureAlerted = true;
    await this.stateStore.save(this.state);
  }

  private async processRecovery(snapshot: RunSnapshot): Promise<void> {
    const state = accountState(this.state, snapshot.accountId);
    const shouldNotify = state.failureAlerted;
    state.consecutiveFailures = 0;
    if (!shouldNotify) {
      await this.stateStore.save(this.state);
      return;
    }
    await this.transport.sendMessage([
      "✅ <b>AgentRouter monitoring recovered</b>",
      "",
      `<b>Account:</b> ${escapeHtml(snapshot.accountLabel)}`,
      `<b>Balance:</b> ${money(snapshot.metrics.balance)}`,
      `<b>Check duration:</b> ${(snapshot.totalMs / 1_000).toFixed(1)} s`,
      `<b>Logout:</b> ${snapshot.loggedOut ? "confirmed" : "not confirmed"}`,
      `<b>Observed:</b> ${escapeHtml(observedAt(snapshot.endedAt))}`,
    ].join("\n"));
    state.failureAlerted = false;
    await this.stateStore.save(this.state);
  }

  private async processFinancialNotifications(
    runId: number,
    label: string,
    observation: CreditObservation | null,
  ): Promise<void> {
    const groups = new Map<number, CreditGrantEvent[]>();
    for (const grant of this.store.listCreditGrantEventsAfterId(this.state.lastGrantId)) {
      const grants = groups.get(grant.runId) ?? [];
      grants.push(grant);
      groups.set(grant.runId, grants);
    }

    for (const [grantRunId, grants] of groups) {
      if (grantRunId === runId) continue;
      const grantObservation = this.store.getCreditObservationForRun(grantRunId);
      const account = this.store
        .listHistoricalAccounts()
        .find((item) => item.accountId === grants[0].accountId);
      if (grantObservation) {
        await this.processBalanceAlert(
          account?.label || grants[0].accountId,
          grantObservation,
          grants,
        );
      } else {
        await this.sendGrantWithoutObservation(account?.label || grants[0].accountId, grants);
      }
      this.state.lastGrantId = grants.at(-1)!.id;
      await this.stateStore.save(this.state);
    }

    const currentGrants = groups.get(runId) ?? [];
    if (observation) {
      await this.processBalanceAlert(label, observation, currentGrants);
    } else if (currentGrants.length > 0) {
      await this.sendGrantWithoutObservation(label, currentGrants);
    }
    if (currentGrants.length > 0) {
      this.state.lastGrantId = currentGrants.at(-1)!.id;
      await this.stateStore.save(this.state);
    }
  }

  private async sendGrantWithoutObservation(
    label: string,
    grants: CreditGrantEvent[],
  ): Promise<void> {
    const amount = grants.reduce((sum, grant) => sum + grant.amount, 0);
    await this.transport.sendMessage([
      "🎉 <b>AgentRouter credit grant confirmed</b>",
      "",
      `<b>Account:</b> ${escapeHtml(label)}`,
      `<b>Captured grants:</b> ${money(amount, true)} · ${grants.length} event${grants.length === 1 ? "" : "s"}`,
      `<b>Grant time:</b> ${escapeHtml(observedAt(grants.at(-1)!.occurredAt))}`,
      `<b>Balance evidence:</b> no matching verified observation was available`,
      "",
      `<a href="${escapeHtml(this.config.telegram.dashboardUrl)}">Open full analytics</a>`,
    ].join("\n"));
  }

  private async processBalanceAlert(
    label: string,
    observation: CreditObservation,
    grants: CreditGrantEvent[],
  ): Promise<boolean> {
    const state = accountState(this.state, observation.accountId);
    const low = this.config.telegram.lowBalanceUsd > 0 &&
      observation.balance < this.config.telegram.lowBalanceUsd;
    const enteredLow = low && !state.lowBalanceActive;
    const positiveDelta = (observation.balanceDelta ?? 0) > 0;
    const largeDrop = this.config.telegram.largeDropUsd > 0 &&
      (observation.balanceDelta ?? 0) <= -this.config.telegram.largeDropUsd;
    const capturedGrantAmount = grants.reduce((sum, grant) => sum + grant.amount, 0);

    if (!enteredLow && !largeDrop && !positiveDelta && grants.length === 0) {
      if (
        state.lowBalanceActive &&
        observation.balance >= this.config.telegram.lowBalanceUsd * 1.1
      ) state.lowBalanceActive = false;
      await this.stateStore.save(this.state);
      return false;
    }

    const title = positiveDelta && grants.length > 0
      ? "🎉 <b>Grant evidence and a balance increase observed</b>"
      : positiveDelta
        ? "💜 <b>AgentRouter balance increased</b>"
        : grants.length > 0
          ? "🎉 <b>AgentRouter credit grant confirmed</b>"
          : enteredLow && largeDrop
            ? "⚠️ <b>Low balance after a large decrease</b>"
            : enteredLow
              ? "⚠️ <b>AgentRouter balance is low</b>"
              : "📉 <b>Large AgentRouter balance decrease</b>";
    const confirmedGrantTotal = this.store
      .listCreditGrantEvents(observation.accountId, 5_000)
      .reduce((sum, grant) => sum + grant.amount, 0);
    const observedIncreaseTotal = this.store
      .listCreditObservations(observation.accountId, 5_000)
      .reduce((sum, item) => sum + Math.max(0, item.balanceDelta ?? 0), 0);
    const lines = [
      title,
      "",
      `<b>Account:</b> ${escapeHtml(label)}`,
      `<b>Balance:</b> ${money(observation.balance)}`,
      `<b>Previous balance:</b> ${money(observation.previousBalance)}`,
      `<b>Balance change:</b> ${money(observation.balanceDelta, true)}`,
      `<b>Consumed:</b> ${money(observation.consumed)}`,
      `<b>Consumption change:</b> ${money(observation.consumedDelta, true)}`,
      `<b>Interval:</b> ${escapeHtml(elapsed(observation.minutesSincePrevious))}`,
      ...(grants.length > 0
        ? [
            `<b>Captured grant logs:</b> ${money(capturedGrantAmount, true)} · ${grants.length} confirmed event${grants.length === 1 ? "" : "s"}`,
            ...(positiveDelta && Math.abs((observation.balanceDelta ?? 0) - capturedGrantAmount) >= 0.01
              ? [`<b>Unattributed balance difference:</b> ${money((observation.balanceDelta ?? 0) - capturedGrantAmount, true)}`]
              : []),
          ]
        : positiveDelta
          ? ["<b>Captured grant logs:</b> none — this is an observed balance increase, not a confirmed grant"]
          : []),
      `<b>Observed positive deltas:</b> ${money(observedIncreaseTotal)} total`,
      `<b>Confirmed grant logs:</b> ${money(confirmedGrantTotal)} total`,
      ...(enteredLow ? [`<b>Low-balance threshold:</b> ${money(this.config.telegram.lowBalanceUsd)}`] : []),
      `<b>Session:</b> ${observation.sessionReused ? "reused" : "fresh"} · logout ${observation.loggedOut ? "confirmed" : "not confirmed"}`,
      `<b>Observed:</b> ${escapeHtml(observedAt(observation.observedAt))}`,
      "",
      `<a href="${escapeHtml(this.config.telegram.dashboardUrl)}">Open full analytics</a>`,
    ];
    await this.sendRich(observation.accountId, label, lines.join("\n"));
    if (low) state.lowBalanceActive = true;
    await this.stateStore.save(this.state);
    return true;
  }

  private async sendRich(accountId: string, label: string, html: string): Promise<void> {
    if (!this.config.telegram.graphsEnabled) {
      await this.transport.sendMessage(html);
      return;
    }
    try {
      const chart = await this.renderChart(accountId, label);
      await this.transport.sendPhoto(chart, html);
    } catch (error) {
      console.error(`Telegram graph unavailable; sending text only: ${
        error instanceof Error ? error.message : String(error)
      }`);
      await this.transport.sendMessage(html);
    }
  }

  private async renderChart(accountId: string, label: string): Promise<Uint8Array> {
    const history = this.store.listMetricHistory(accountId, 30)
      .filter((item) => item.status === "ok")
      .map((item) => ({
        at: item.startedAt,
        balance: Number(item.metrics.balance),
        consumed: Number(item.metrics.consumed),
      }))
      .filter((item) => Number.isFinite(item.balance) && Number.isFinite(item.consumed));
    if (history.length < 2) throw new Error("not enough verified history for a graph");

    const directory = await mkdtemp(join(tmpdir(), "agentrouter-telegram-chart-"));
    const output = join(directory, "balance.png");
    try {
      const nodeBinary = process.env.NODE_BINARY?.trim() || "node";
      const proc = Bun.spawn({
        cmd: [nodeBinary, CHART_SCRIPT, output],
        cwd: process.cwd(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      });
      proc.stdin.write(JSON.stringify({ label, history }));
      proc.stdin.end();
      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error(`chart renderer exited with ${exitCode}: ${stderr.trim().slice(0, 200)}`);
      }
      return new Uint8Array(await readFile(output));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
