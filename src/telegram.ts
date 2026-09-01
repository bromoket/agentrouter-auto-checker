import { chmod, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChartWorkerEnv } from "./child-environment";
import type { AppConfig, TelegramConfig } from "./config";
import type { AccountStore } from "./accounts";
import type { OmpQuotaObservation, OmpQuotaTransitionEvent } from "./omp-quota";
import type { ObservatoryCoordinator } from "./observatory/coordinator";
import type { ObservatoryStore } from "./observatory/store";
import type {
  CreditGrantEvent,
  CreditObservation,
  EndpointBalanceObservation,
  RunSnapshot,
} from "./storage";
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

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function money(value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const prefix = value < 0 ? "-" : signed && value > 0 ? "+" : "";
  return `${prefix}$${Math.abs(value).toFixed(2)}`;
}

export function signedInteger(value: number): string {
  if (!Number.isSafeInteger(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US")}`;
}

export function elapsed(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return "first verified sample";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 1_440) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1_440).toFixed(1)} d`;
}

export function observedAt(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Budapest",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function compactError(value: string | undefined): string {
  if (!value) return "Unknown account-check failure";
  return value.replace(/\u001B\[[0-9;]*m/g, "").replace(/\s+/g, " ").slice(0, 500);
}
export function formatProgressBar(usedPct: number, length = 10): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(usedPct) ? usedPct : 0));
  const filled = Math.round((clamped / 100) * length);
  const empty = length - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

export function formatCountdown(isoTime: string | null | undefined): string {
  if (!isoTime) return "unknown";
  const target = Date.parse(isoTime);
  if (!Number.isFinite(target)) return "unknown";
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "now";
  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  if (days > 0) {
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${mins}m`;
  }
  return `${mins}m`;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number | string;
  type: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export function buildHelpMessage(allowedUsername: string, dashboardUrl?: string): string {
  const dashUrl = dashboardUrl || "https://bkserver.tailbbaa91.ts.net/observatory/";
  return [
    `🛸 <b>AI Fleet Observatory Bot</b>`,
    ``,
    `Welcome, <b>@${escapeHtml(allowedUsername)}</b>! Live controls:`,
    ``,
    `📊 /status — Full fleet overview & account health`,
    `🤖 /quotas — Live OMP quotas (OpenAI & Antigravity)`,
    `💰 /balance — AgentRouter balances & daily $25 grants`,
    `🌐 /dashboard — Direct web dashboard link`,
    `🏓 /ping — Check connectivity & response time`,
    ``,
    `👉 <a href="${escapeHtml(dashUrl)}">Open Fleet Observatory</a>`,
    ``,
    `<i>⚡ Real-time updates polling every 1 minute on Xeon.</i>`,
  ].join("\n");
}

export function buildStatusMessage(params: {
  agentrouterAccounts: Array<{
    label: string;
    balance: number | null;
    consumed: number | null;
    requestCount: number | null;
    status: string;
  }>;
  totalBalance: number;
  totalConsumed: number;
  quotasSummary: {
    totalWindows: number;
    warningCount: number;
    identitiesCount: number;
  };
  openAiWindows?: Array<{
    name: string;
    usedPct: number;
    resetsIn: string;
  }>;
  hostsOnline: number;
  dashboardUrl?: string;
}): string {
  const dashUrl = params.dashboardUrl || "https://bkserver.tailbbaa91.ts.net/observatory/";
  const healthEmoji = params.quotasSummary.warningCount === 0 ? "🟢" : "🟡";
  const lines: string[] = [
    `📊 <b>AI Fleet Status</b> • ${healthEmoji} <b>Operational</b>`,
    ``,
    `💼 <b>AgentRouter Portfolio:</b>`,
  ];

  for (const acc of params.agentrouterAccounts) {
    const bal = acc.balance !== null ? `$${acc.balance.toFixed(2)}` : "—";
    const usage = acc.consumed !== null ? `$${acc.consumed.toFixed(2)}` : "—";
    const reqs = acc.requestCount !== null ? acc.requestCount.toLocaleString() : "—";
    const dot = acc.status === "ok" ? "🟢" : "🔴";
    lines.push(`• ${dot} <b>${escapeHtml(acc.label)}</b>: <b>${bal}</b> | Usage: ${usage} (${reqs} reqs)`);
  }
  lines.push(`💰 <b>Total Balance:</b> <b>$${params.totalBalance.toFixed(2)}</b> (Usage: $${params.totalConsumed.toFixed(2)})`);
  lines.push(``);

  lines.push(`🤖 <b>AI Provider Quotas:</b>`);
  lines.push(`• <b>Identities:</b> ${params.quotasSummary.identitiesCount} active (${params.quotasSummary.totalWindows} monitored windows)`);
  if (params.openAiWindows && params.openAiWindows.length > 0) {
    for (const w of params.openAiWindows) {
      lines.push(`  └ <b>${escapeHtml(w.name)}:</b> <code>[${formatProgressBar(w.usedPct, 8)}]</code> ${Math.round(w.usedPct)}% (${w.resetsIn})`);
    }
  }
  lines.push(`• <b>Warnings / High Usage:</b> ${params.quotasSummary.warningCount === 0 ? "None (All nominal)" : `${params.quotasSummary.warningCount} active`}`);
  lines.push(``);
  lines.push(`🖥 <b>Fleet Hosts:</b> ${params.hostsOnline} online`);
  lines.push(``);
  lines.push(`👉 <a href="${escapeHtml(dashUrl)}">Open Fleet Observatory</a>`);
  return lines.join("\n");
}

export function buildQuotasMessage(params: {
  quotas: Array<{
    provider: string;
    identityLabel: string;
    windowName: string;
    usedPct: number;
    resetsAt?: string;
    status: string;
  }>;
  dashboardUrl?: string;
}): string {
  const dashUrl = params.dashboardUrl || "https://bkserver.tailbbaa91.ts.net/observatory/";
  const lines: string[] = [
    `🤖 <b>AI Provider Quotas & Utilization</b>`,
    ``,
  ];

  const byProvider: Record<string, typeof params.quotas> = {};
  for (const q of params.quotas) {
    byProvider[q.provider] = byProvider[q.provider] || [];
    byProvider[q.provider].push(q);
  }

  for (const [provider, items] of Object.entries(byProvider)) {
    const provName = provider === "openai-codex" ? "OpenAI Codex / ChatGPT" : provider === "google-antigravity" ? "Google Antigravity" : provider;
    lines.push(`<b>${escapeHtml(provName)}:</b>`);
    for (const item of items) {
      const bar = formatProgressBar(item.usedPct, 10);
      const resets = item.resetsAt ? `resets in ${formatCountdown(item.resetsAt)}` : "rolling";
      const statusEmoji = item.status === "ok" ? "🟢" : item.status === "warning" ? "🟡" : "🔴";
      const label = item.identityLabel ? `${item.identityLabel} · ` : "";
      lines.push(`${statusEmoji} ${escapeHtml(label)}${escapeHtml(item.windowName)}: <code>[${bar}]</code> <b>${Math.round(item.usedPct)}%</b> (${resets})`);
    }
    lines.push(``);
  }

  lines.push(`👉 <a href="${escapeHtml(dashUrl)}">Open Fleet Observatory</a>`);
  return lines.join("\n");
}

export function buildBalancesMessage(params: {
  accounts: Array<{
    label: string;
    balance: number | null;
    consumed: number | null;
    requestCount: number | null;
    status: string;
    lastObservedAt: string;
    dailyGrantConfirmed?: boolean;
  }>;
  totalBalance: number;
  totalConsumed: number;
  dashboardUrl?: string;
}): string {
  const dashUrl = params.dashboardUrl || "https://bkserver.tailbbaa91.ts.net/observatory/";
  const lines: string[] = [
    `💰 <b>AgentRouter Portfolio Balances</b>`,
    ``,
  ];

  params.accounts.forEach((acc, idx) => {
    const bal = acc.balance !== null ? `$${acc.balance.toFixed(2)}` : "—";
    const usage = acc.consumed !== null ? `$${acc.consumed.toFixed(2)}` : "—";
    const reqs = acc.requestCount !== null ? acc.requestCount.toLocaleString() : "—";
    const dot = acc.status === "ok" ? "🟢" : "🔴";
    const grantStatus = acc.dailyGrantConfirmed ? "✅ Confirmed ($25.00 daily grant)" : "⏳ Pending daily grant";
    lines.push(`<b>${idx + 1}. ${escapeHtml(acc.label)}</b> ${dot}`);
    lines.push(`• Live Balance: <b>${bal}</b>`);
    lines.push(`• Consumed / Usage: <b>${usage}</b>`);
    lines.push(`• Total Requests: <b>${reqs}</b>`);
    lines.push(`• Daily Grant: ${grantStatus}`);
    lines.push(`• Last Polled: ${observedAt(acc.lastObservedAt)}`);
    lines.push(``);
  });

  lines.push(`💵 <b>Combined Fleet Balance:</b> <b>$${params.totalBalance.toFixed(2)}</b>`);
  lines.push(`📈 <b>Total Fleet Usage:</b> $${params.totalConsumed.toFixed(2)}`);
  lines.push(``);
  lines.push(`👉 <a href="${escapeHtml(dashUrl)}">Open Fleet Observatory</a>`);
  return lines.join("\n");
}

export function buildDashboardMessage(dashboardUrl?: string): string {
  const dashUrl = dashboardUrl || "https://bkserver.tailbbaa91.ts.net/observatory/";
  return [
    `🌐 <b>AI Fleet Observatory Dashboard</b>`,
    ``,
    `👉 <a href="${escapeHtml(dashUrl)}">${escapeHtml(dashUrl)}</a>`,
    ``,
    `<i>Private tailnet access with persistent 7-day session.</i>`,
  ].join("\n");
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

  async sendMessage(html: string): Promise<{ messageId?: string }> {
    const res = await this.request("sendMessage", {
      chat_id: this.config.chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    const msgId = (res.result as { message_id?: number | string } | undefined)?.message_id;
    return { messageId: msgId ? String(msgId) : undefined };
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
  async getUpdates(offset: number, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (timeoutSeconds + 10) * 1_000);
    try {
      const response = await this.fetcher(
        `https://api.telegram.org/bot${this.config.botToken}/getUpdates`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            offset,
            timeout: timeoutSeconds,
            allowed_updates: ["message"],
          }),
          signal: controller.signal,
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: TelegramUpdate[];
      };
      if (response.ok && result.ok && Array.isArray(result.result)) {
        return result.result;
      }
      return [];
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
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
  async sendObservatoryMessage(html: string): Promise<{ messageId?: string }> {
    return await this.transport.sendMessage(html);
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
      `<b>Rules:</b> ${money(this.config.telegram.largeDropUsd)}+ balance movements · confirmed grants · balance below ${money(this.config.telegram.lowBalanceUsd)} · ${this.config.telegram.repeatedFailureCount} repeated failures`,
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

  /**
   * Endpoint polling has no browser run or grant-log evidence. It can still
   * report a material balance movement promptly, but always labels it as an
   * observed change rather than claiming a grant.
   */
  async processEndpointObservation(observation: EndpointBalanceObservation): Promise<void> {
    try {
      const state = accountState(this.state, observation.accountId);
      const low = this.config.telegram.lowBalanceUsd > 0 &&
        observation.balance < this.config.telegram.lowBalanceUsd;
      const enteredLow = low && !state.lowBalanceActive;
      const positiveDelta = (observation.balanceDelta ?? 0) > 0;
      const materialIncrease = positiveDelta && (
        this.config.telegram.largeDropUsd <= 0 ||
        (observation.balanceDelta ?? 0) >= this.config.telegram.largeDropUsd
      );
      const largeDrop = this.config.telegram.largeDropUsd > 0 &&
        (observation.balanceDelta ?? 0) <= -this.config.telegram.largeDropUsd;

      if (!enteredLow && !materialIncrease && !largeDrop) {
        if (state.lowBalanceActive && observation.balance >= this.config.telegram.lowBalanceUsd * 1.1) {
          state.lowBalanceActive = false;
        }
        await this.stateStore.save(this.state);
        return;
      }

      const title = materialIncrease
        ? "💜 <b>AgentRouter balance increased</b>"
        : enteredLow && largeDrop
          ? "⚠️ <b>Low balance after a large decrease</b>"
          : enteredLow
            ? "⚠️ <b>AgentRouter balance is low</b>"
            : "📉 <b>Large AgentRouter balance decrease</b>";
      const requestLine = observation.requestCount === undefined
        ? []
        : [
            `<b>Requests:</b> ${observation.requestCount.toLocaleString("en-US")}`,
            ...(observation.requestCountDelta === null
              ? []
              : [`<b>Request change:</b> ${signedInteger(observation.requestCountDelta)}`]),
          ];
      const lines = [
        title,
        "",
        `<b>Account:</b> ${escapeHtml(observation.accountLabel)}`,
        `<b>Balance:</b> ${money(observation.balance)}`,
        `<b>Previous balance:</b> ${money(observation.previousBalance)}`,
        `<b>Balance change:</b> ${money(observation.balanceDelta, true)}`,
        `<b>Consumed:</b> ${money(observation.consumed)}`,
        `<b>Consumption change:</b> ${money(observation.consumedDelta, true)}`,
        ...requestLine,
        `<b>Interval:</b> ${escapeHtml(elapsed(observation.minutesSincePrevious))}`,
        "<b>Evidence:</b> read-only endpoint observation; a later browser cycle confirms any grant log.",
        ...(enteredLow ? [`<b>Low-balance threshold:</b> ${money(this.config.telegram.lowBalanceUsd)}`] : []),
        `<b>Observed:</b> ${escapeHtml(observedAt(observation.observedAt))}`,
        "",
        `<a href="${escapeHtml(this.config.telegram.dashboardUrl)}">Open full analytics</a>`,
      ];
      await this.sendRich(observation.accountId, observation.accountLabel, lines.join("\n"));
      if (low) state.lowBalanceActive = true;
      await this.stateStore.save(this.state);
    } catch (error) {
      console.error(`Telegram endpoint notification skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    const materialIncrease = positiveDelta && (
      this.config.telegram.largeDropUsd <= 0 ||
      (observation.balanceDelta ?? 0) >= this.config.telegram.largeDropUsd
    );
    const largeDrop = this.config.telegram.largeDropUsd > 0 &&
      (observation.balanceDelta ?? 0) <= -this.config.telegram.largeDropUsd;
    const capturedGrantAmount = grants.reduce((sum, grant) => sum + grant.amount, 0);

    if (!enteredLow && !largeDrop && !materialIncrease && grants.length === 0) {
      if (
        state.lowBalanceActive &&
        observation.balance >= this.config.telegram.lowBalanceUsd * 1.1
      ) state.lowBalanceActive = false;
      await this.stateStore.save(this.state);
      return false;
    }

    const title = positiveDelta && grants.length > 0
      ? "🎉 <b>Grant evidence and a balance increase observed</b>"
      : materialIncrease
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
    const browserHistory = this.store.listMetricHistory(accountId, 120)
      .filter((item) => item.status === "ok")
      .map((item) => ({
        at: item.startedAt,
        balance: Number(item.metrics.balance),
        consumed: Number(item.metrics.consumed),
      }))
      .filter((item) => Number.isFinite(item.balance) && Number.isFinite(item.consumed));
    const endpointHistory = this.store.listEndpointObservations(accountId, 5_000)
      .filter((item) => item.status === "ok")
      .map((item) => ({
        at: item.observedAt,
        balance: Number(item.balance),
        consumed: Number(item.consumed),
      }))
      .filter((item) => Number.isFinite(item.balance) && Number.isFinite(item.consumed));
    const allHistory = [...browserHistory, ...endpointHistory]
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
    const history = allHistory.length <= 720
      ? allHistory
      : Array.from({ length: 720 }, (_, index) =>
        allHistory[Math.round(index * (allHistory.length - 1) / 719)]
      );
    if (history.length < 2) throw new Error("not enough verified history for a graph");

    const directory = await mkdtemp(join(tmpdir(), "agentrouter-telegram-chart-"));
    const output = join(directory, "balance.png");
    try {
      const nodeBinary = process.env.NODE_BINARY?.trim() || "node";
      const proc = Bun.spawn({
        cmd: [nodeBinary, CHART_SCRIPT, output],
        cwd: process.cwd(),
        env: buildChartWorkerEnv(),
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

  async sendOmpQuotaReset(observation: OmpQuotaObservation): Promise<void> {
    const lines = [
      "⚡ <b>OMP ChatGPT quota reset</b>",
      "",
      `<b>Remaining:</b> ${observation.remainingPct}%`,
      `<b>Resets at:</b> ${escapeHtml(observedAt(observation.resetAt))}`,
      `<b>Observed:</b> ${escapeHtml(observedAt(observation.observedAt))}`,
    ];
    await this.transport.sendMessage(lines.join("\n"));
  }

  async sendOmpQuotaLow(observation: OmpQuotaObservation, thresholdPct: number): Promise<void> {
    const lines = [
      "⚠️ <b>OMP ChatGPT quota low</b>",
      "",
      `<b>Remaining:</b> ${observation.remainingPct}% (threshold: ${thresholdPct}%)`,
      `<b>Resets at:</b> ${escapeHtml(observedAt(observation.resetAt))}`,
      `<b>Observed:</b> ${escapeHtml(observedAt(observation.observedAt))}`,
    ];
    await this.transport.sendMessage(lines.join("\n"));
  }

  async sendOmpQuotaFailure(consecutiveFailures: number, errorCategory: string): Promise<void> {
    const lines = [
      "🛑 <b>OMP quota monitoring is failing</b>",
      "",
      `<b>Consecutive failures:</b> ${consecutiveFailures}`,
      `<b>Error:</b> ${escapeHtml(errorCategory)}`,
      `<b>Observed:</b> ${escapeHtml(observedAt(new Date().toISOString()))}`,
    ];
    await this.transport.sendMessage(lines.join("\n"));
  }

  async sendOmpQuotaRecovery(observation: OmpQuotaObservation): Promise<void> {
    const lines = [
      "✅ <b>OMP quota monitoring recovered</b>",
      "",
      `<b>Remaining:</b> ${observation.remainingPct}%`,
      `<b>Resets at:</b> ${escapeHtml(observedAt(observation.resetAt))}`,
      `<b>Observed:</b> ${escapeHtml(observedAt(observation.observedAt))}`,
    ];
    await this.transport.sendMessage(lines.join("\n"));
  }

  async processOmpQuotaTransition(event: OmpQuotaTransitionEvent): Promise<void> {
    switch (event.type) {
      case "reset":
        await this.sendOmpQuotaReset(event.observation);
        break;
      case "low_remaining":
        await this.sendOmpQuotaLow(event.observation, event.thresholdPct);
        break;
      case "repeated_failure":
        await this.sendOmpQuotaFailure(event.consecutiveFailures, event.errorCategory);
        break;
      case "recovery":
        await this.sendOmpQuotaRecovery(event.observation);
        break;
    }
  }
  startCommandListener(context: {
    store: Store;
    accounts?: AccountStore;
    observatoryStore?: ObservatoryStore | null;
    observatoryCoordinator?: ObservatoryCoordinator | null;
  }): () => void {
    let running = true;
    let lastOffset = 0;

    const listenerLoop = async () => {
      while (running) {
        try {
          const updates = await this.transport.getUpdates(lastOffset, 20);
          if (!running) break;

          for (const update of updates) {
            if (update.update_id >= lastOffset) {
              lastOffset = update.update_id + 1;
            }

            const message = update.message;
            if (!message || typeof message.text !== "string") continue;

            const chatId = String(message.chat.id);
            const username = message.from?.username?.toLowerCase() || "";

            // Verify caller identity strictly
            if (
              chatId !== this.config.telegram.chatId ||
              (this.config.telegram.allowedUsername && username !== this.config.telegram.allowedUsername)
            ) {
              continue;
            }

            const command = message.text.trim().split(/\s+/)[0].toLowerCase().split("@")[0];

            try {
              if (command === "/start" || command === "/help") {
                await this.transport.sendMessage(buildHelpMessage(this.config.telegram.allowedUsername || "owner", this.config.telegram.dashboardUrl));
              } else if (command === "/dashboard" || command === "/link") {
                await this.transport.sendMessage(buildDashboardMessage(this.config.telegram.dashboardUrl));
              } else if (command === "/ping") {
                await this.transport.sendMessage(`🏓 <b>Pong!</b> Fleet Observatory operational.\n⏱ Uptime: ${Math.floor(process.uptime())}s`);
              } else if (command === "/balance" || command === "/balances" || command === "/accounts") {
                const accountsData: Array<{
                  label: string;
                  balance: number | null;
                  consumed: number | null;
                  requestCount: number | null;
                  status: string;
                  lastObservedAt: string;
                  dailyGrantConfirmed?: boolean;
                }> = [];

                if (context.observatoryStore) {
                  const obsAccounts = context.observatoryStore.listAgentRouterAccounts();
                  for (const acc of obsAccounts) {
                    const endpoints = context.observatoryStore.listAgentRouterEndpointObservations({ accountId: acc.accountId, limit: 1 });
                    const runs = context.observatoryStore.listAgentRouterRuns({ accountId: acc.accountId, limit: 1 });
                    const grants = context.observatoryStore.listAgentRouterGrantEvents({ accountId: acc.accountId, limit: 1 });
                    const latestEndpoint = endpoints[0] ?? null;
                    const latestRun = runs[0] ?? null;
                    const balance = latestEndpoint?.balance ?? latestRun?.balance ?? null;
                    const consumed = latestEndpoint?.consumed ?? latestRun?.consumed ?? null;
                    const requestCount = latestEndpoint?.requestCount ?? latestRun?.requestCount ?? null;
                    const status = latestEndpoint?.status ?? latestRun?.status ?? "ok";
                    const lastObservedAt = latestEndpoint?.observedAt ?? latestRun?.startedAt ?? acc.updatedAt;
                    const hasGrantToday = grants.length > 0;
                    accountsData.push({
                      label: acc.accountLabel,
                      balance,
                      consumed,
                      requestCount,
                      status,
                      lastObservedAt,
                      dailyGrantConfirmed: hasGrantToday,
                    });
                  }
                }

                const totalBalance = accountsData.reduce((s, a) => s + (a.balance || 0), 0);
                const totalConsumed = accountsData.reduce((s, a) => s + (a.consumed || 0), 0);
                await this.transport.sendMessage(buildBalancesMessage({
                  accounts: accountsData,
                  totalBalance,
                  totalConsumed,
                  dashboardUrl: this.config.telegram.dashboardUrl,
                }));
              } else if (command === "/quotas") {
                const quotasData: Array<{
                  provider: string;
                  identityLabel: string;
                  windowName: string;
                  usedPct: number;
                  resetsAt?: string;
                  status: string;
                }> = [];

                if (context.observatoryStore) {
                  const windows = context.observatoryStore.listCurrentQuotaWindows();
                  for (const w of windows) {
                    const identity = context.observatoryStore.getIdentity(w.identityId);
                    quotasData.push({
                      provider: w.provider,
                      identityLabel: identity?.label || "",
                      windowName: `${w.bucketId} (${w.windowId})`,
                      usedPct: w.remainingFraction !== null ? (1 - w.remainingFraction) * 100 : 0,
                      resetsAt: w.resetsAt ?? undefined,
                      status: w.status,
                    });
                  }
                }

                await this.transport.sendMessage(buildQuotasMessage({
                  quotas: quotasData,
                  dashboardUrl: this.config.telegram.dashboardUrl,
                }));
              } else if (command === "/status" || command === "/overview") {
                const accountsData: Array<{
                  label: string;
                  balance: number | null;
                  consumed: number | null;
                  requestCount: number | null;
                  status: string;
                }> = [];

                let identitiesCount = 0;
                let totalWindows = 0;
                let warningCount = 0;
                let hostsOnline = 1;
                const openAiWindows: Array<{ name: string; usedPct: number; resetsIn: string }> = [];

                if (context.observatoryStore) {
                  const obsAccounts = context.observatoryStore.listAgentRouterAccounts();
                  for (const acc of obsAccounts) {
                    const endpoints = context.observatoryStore.listAgentRouterEndpointObservations({ accountId: acc.accountId, limit: 1 });
                    const runs = context.observatoryStore.listAgentRouterRuns({ accountId: acc.accountId, limit: 1 });
                    const latestEndpoint = endpoints[0] ?? null;
                    const latestRun = runs[0] ?? null;
                    const balance = latestEndpoint?.balance ?? latestRun?.balance ?? null;
                    const consumed = latestEndpoint?.consumed ?? latestRun?.consumed ?? null;
                    const requestCount = latestEndpoint?.requestCount ?? latestRun?.requestCount ?? null;
                    const status = latestEndpoint?.status ?? latestRun?.status ?? "ok";
                    accountsData.push({
                      label: acc.accountLabel,
                      balance,
                      consumed,
                      requestCount,
                      status,
                    });
                  }

                  const windows = context.observatoryStore.listCurrentQuotaWindows();
                  totalWindows = windows.length;
                  warningCount = windows.filter((w) => ["warning", "critical", "exhausted"].includes(String(w.status))).length;
                  identitiesCount = context.observatoryStore.listIdentities().length;
                  hostsOnline = context.observatoryStore.listHosts().filter((h) => h.status === "online").length;

                  for (const w of windows) {
                    if (w.provider === "openai-codex") {
                      openAiWindows.push({
                        name: `${w.bucketId} (${w.windowId})`,
                        usedPct: w.remainingFraction !== null ? (1 - w.remainingFraction) * 100 : 0,
                        resetsIn: w.resetsAt ? `resets in ${formatCountdown(w.resetsAt)}` : "rolling",
                      });
                    }
                  }
                }

                const totalBalance = accountsData.reduce((s, a) => s + (a.balance || 0), 0);
                const totalConsumed = accountsData.reduce((s, a) => s + (a.consumed || 0), 0);

                await this.transport.sendMessage(buildStatusMessage({
                  agentrouterAccounts: accountsData,
                  totalBalance,
                  totalConsumed,
                  quotasSummary: {
                    totalWindows,
                    warningCount,
                    identitiesCount,
                  },
                  openAiWindows,
                  hostsOnline,
                  dashboardUrl: this.config.telegram.dashboardUrl,
                }));
              } else if (command.startsWith("/")) {
                await this.transport.sendMessage(
                  `❓ Unknown command <code>${escapeHtml(command)}</code>.\n\nAvailable commands:\n/status — Fleet overview\n/quotas — Provider quotas\n/balance — AgentRouter balances\n/dashboard — Dashboard link\n/help — Command list`
                );
              }
            } catch (cmdError) {
              console.error(`Telegram command ${command} handler failed:`, cmdError);
            }
          }
        } catch (pollError) {
          if (!running) break;
          await Bun.sleep(5_000);
        }
        await Bun.sleep(1_000);
      }
    };

    void listenerLoop();

    return () => {
      running = false;
    };
  }
}
