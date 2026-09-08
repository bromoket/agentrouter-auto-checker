import { randomUUID } from "node:crypto";
import { createDeterministicFingerprint } from "./events";
import type { ObservatoryStore } from "./store";
import type {
  DeliveryErrorCategory,
  EventSeverity,
  ObservatoryEventCandidate,
  StoredNotificationDelivery,
  StoredObservatoryEvent,
} from "./types";
import type { AppConfig } from "../config";
import { escapeHtml, observedAt, type TelegramNotifier } from "../telegram";

export function formatObservatoryEventMessage(
  event: StoredObservatoryEvent,
  dashboardUrl?: string,
  detail?: { provider?: string | null; windowId?: string | null; usedUnits?: number | null; totalUnits?: number | null; remainingFraction?: number | null; resetAt?: string | null; remainingUnits?: number | null },
): string {
  const emoji =
    event.severity === "critical"
      ? "🚨"
      : event.severity === "error"
        ? "🛑"
        : event.severity === "warning"
          ? "⚠️"
          : event.eventType === "quota_reset"
            ? "🎉"
            : "ℹ️";
  const category = event.eventType.replaceAll("_", " ");
  const safeTitle = category.replace(/\b\w/g, (letter) => letter.toUpperCase());
  const providerLabel = detail?.provider
    ? detail.provider === "openai-codex"
      ? "OpenAI Codex / ChatGPT"
      : detail.provider === "google-antigravity"
        ? "Google Antigravity"
        : detail.provider === "commandcode"
          ? "Command Code"
          : safeLabel(String(detail.provider))
    : null;
  const windowLabel = detail?.windowId
    ? detail.windowId === "weekly"
      ? "Weekly window"
      : detail.windowId === "5h"
        ? "5-hour window"
        : safeLabel(String(detail.windowId))
    : null;

  const lines: string[] = [
    `${emoji} <b>${escapeHtml(safeTitle)}</b>`,
    "",
  ];

  if (providerLabel) lines.push(`<b>Provider:</b> ${escapeHtml(providerLabel)}`);
  if (windowLabel) lines.push(`<b>Window:</b> ${escapeHtml(windowLabel)}`);
  if (detail && detail.totalUnits && detail.totalUnits > 0) {
    const used = detail.usedUnits ?? 0;
    const remaining = detail.remainingUnits ?? Math.max(0, detail.totalUnits - used);
    const pct =
      detail.remainingFraction !== null && detail.remainingFraction !== undefined
        ? Math.round(detail.remainingFraction * 100)
        : Math.round((remaining / detail.totalUnits) * 100);
    lines.push(`<b>Used:</b> ${escapeHtml(String(used))} / ${escapeHtml(String(detail.totalUnits))}`);
    lines.push(`<b>Remaining:</b> ${escapeHtml(String(remaining))} (${pct}%)`);
    if (detail.resetAt) {
      lines.push(`<b>Resets:</b> ${escapeHtml(observedAt(detail.resetAt))}`);
    }
  }

  if (event.identityId) lines.push(`<b>Identity:</b> ${escapeHtml(event.identityId)}`);
  if (event.hostId) lines.push(`<b>Host:</b> ${escapeHtml(event.hostId)}`);
  if (event.sessionId) lines.push(`<b>Session:</b> ${escapeHtml(event.sessionId)}`);
  if (event.windowId && !windowLabel) lines.push(`<b>Window:</b> ${escapeHtml(safeLabel(event.windowId))}`);
  if (event.meter) lines.push(`<b>Meter:</b> ${escapeHtml(safeLabel(event.meter))}`);
  if (event.severity) lines.push(`<b>Severity:</b> ${escapeHtml(event.severity.toUpperCase())}`);
  lines.push(`<b>Observed:</b> ${escapeHtml(observedAt(event.occurredAt))}`);

  if (dashboardUrl) {
    lines.push("");
    lines.push(`<a href="${escapeHtml(dashboardUrl)}">Open Fleet Observatory</a>`);
  }

  return lines.join("\n");
}

function safeLabel(value: string): string {
  return value.replace(/[_\-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function categorizeDeliveryError(error: unknown): DeliveryErrorCategory {
  if (!error) return "unknown";
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("retry_after")) {
    return "rate_limit";
  }
  if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("forbidden") || msg.includes("bot token") || msg.includes("chat not found")) {
    return "auth";
  }
  if (msg.includes("invalid") || msg.includes("bad request") || msg.includes("parse_mode") || msg.includes("format")) {
    return "invalid_payload";
  }
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("server error")) {
    return "server_error";
  }
  if (msg.includes("timeout") || msg.includes("network") || msg.includes("econnrefused") || msg.includes("econnreset") || msg.includes("abort") || msg.includes("fetch failed")) {
    return "network";
  }
  if (msg.includes("400") || msg.includes("client error")) {
    return "client_error";
  }
  return "unknown";
}

export class ObservatoryDeliveryManager {
  private readonly leaseDurationMs: number;
  private readonly maxRetries: number;
  /** Monotonically increasing pass boundary so consecutive passes never collide. */
  private lastPassBoundaryMs = 0;

  constructor(
    private readonly store: ObservatoryStore,
    private readonly telegram: TelegramNotifier | null,
    private readonly config: AppConfig,
    options?: { leaseDurationMs?: number; maxRetries?: number },
  ) {
    this.leaseDurationMs = options?.leaseDurationMs ?? config.observatory.deliveryLeaseDurationMs;
    this.maxRetries = options?.maxRetries ?? config.observatory.deliveryMaxRetries;
  }

  async processOutboxOnce(maxItems = 20): Promise<{ processed: number; sent: number; failed: number }> {
    let processed = 0;
    let sent = 0;
    let failed = 0;

    // A pass boundary that is strictly later than any prior pass, so a delivery
    // failed in a previous processOutboxOnce call is always reclaimable on the
    // next call even when both land within the same wall-clock millisecond. The
    // same-pass guard (a row failed during THIS call) still holds because the
    // boundary is fixed for the whole call.
    const nowMs = Date.now();
    const boundaryMs = this.lastPassBoundaryMs >= nowMs ? this.lastPassBoundaryMs + 1 : nowMs;
    this.lastPassBoundaryMs = boundaryMs;
    const failedBefore = new Date(boundaryMs).toISOString();
    for (let i = 0; i < maxItems; i++) {
      const lease = this.store.claimDeliveryLease("telegram", this.leaseDurationMs, this.maxRetries, failedBefore);
      if (!lease) break;
      const leaseToken = lease.leaseToken;
      if (!leaseToken) {
        failed++;
        continue;
      }
      processed++;

      const event = this.store.getEvent(lease.eventId);
      if (!event) {
        this.store.markDeliveryFailed(lease.deliveryId, leaseToken, {
          errorCategory: "invalid_payload",
          retryable: false,
        });
        failed++;
        continue;
      }

      if (!this.telegram) {
        this.store.markDeliveryFailed(lease.deliveryId, leaseToken, {
          errorCategory: "auth",
          retryable: true,
        });
        failed++;
        continue;
      }

      const detail = this.lookupEventDetail(event);
      const html = formatObservatoryEventMessage(event, this.config.telegram.dashboardUrl, detail);
      try {
        const result = await this.telegram.sendObservatoryMessage(html);
        const acknowledged = this.store.markDeliverySent(lease.deliveryId, leaseToken, {
          sentAt: new Date().toISOString(),
          providerMessageId: result?.messageId,
        });
        if (!acknowledged) {
          failed++;
          continue;
        }
        sent++;
      } catch (error) {
        const errorCategory = categorizeDeliveryError(error);
        this.store.markDeliveryFailed(lease.deliveryId, leaseToken, {
          errorCategory,
          retryable: true,
        });
        failed++;
      }
    }

    return { processed, sent, failed };
  }

  /** Look up quota-window detail for quota-type events to enrich the Telegram message. */
  private lookupEventDetail(
    event: StoredObservatoryEvent,
  ): { provider?: string | null; windowId?: string | null; usedUnits?: number | null; totalUnits?: number | null; remainingFraction?: number | null; resetAt?: string | null; remainingUnits?: number | null } | undefined {
    if (!event.identityId || !event.windowId) return undefined;
    if (!event.eventType.startsWith("quota") && event.eventType !== "reset_credit_increased" && event.eventType !== "reset_credit_decreased") {
      return undefined;
    }
    const window = this.store.getCurrentQuotaWindow(event.identityId, event.windowId, event.bucketId ?? undefined);
    if (!window) return undefined;
    return {
      provider: event.provider ?? null,
      windowId: event.windowId,
      usedUnits: window.usedUnits,
      totalUnits: window.totalUnits,
      remainingFraction: window.remainingFraction,
      resetAt: window.resetsAt,
      remainingUnits: window.remainingUnits,
    };
  }

  async sendSyntheticDelivery(params: {
    channel?: string;
    eventId?: string;
    severity?: EventSeverity;
  }): Promise<StoredNotificationDelivery> {
    let eventId: string;
    if (params.eventId) {
      const existing = this.store.getEvent(params.eventId);
      if (!existing) throw new Error(`Observatory event not found: ${params.eventId}`);
      eventId = existing.eventId;
    } else {
      const now = new Date().toISOString();
      const nonce = randomUUID();
      const candidate: ObservatoryEventCandidate = {
        eventType: "policy_changed",
        severity: params.severity ?? "info",
        fingerprint: createDeterministicFingerprint("policy_changed", "synthetic_test", nonce),
        occurredAt: now,
      };
      const { event } = this.store.recordEvent(candidate);
      eventId = event.eventId;
    }

    const channel = params.channel ?? "telegram";
    const fingerprint = createDeterministicFingerprint("delivery", eventId, channel, randomUUID());
    const { delivery } = this.store.recordDeliveryAttempt({
      eventId,
      channel,
      status: "pending",
      fingerprint,
    });

    await this.processOutboxOnce(1);
    return this.store.getDelivery(delivery.deliveryId) ?? delivery;
  }
}
