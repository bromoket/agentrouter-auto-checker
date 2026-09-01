import { randomUUID } from "node:crypto";
import { readBoundedJsonObject } from "../bounded-json";
import type { AppConfig } from "../config";
import type { ObservatoryCoordinator } from "./coordinator";
import {
  parsePolicyTarget,
  resolveEffectivePolicy,
  validatePolicyRule,
  type NotificationPolicyRule,
  type PolicyResolutionContext,
} from "./policies";
import type { ObservatoryStore } from "./store";
import type {
  CurrentQuotaWindow,
  EventSeverity,
  ProviderHealth,
  StoredFleetHost,
  StoredObservatoryEvent,
  StoredProviderIdentity,
  StoredSessionSummary,
} from "./types";

export interface ObservatoryApiContext {
  store: ObservatoryStore;
  coordinator: ObservatoryCoordinator;
  config: AppConfig;
}

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "no-store",
};

function jsonResponse(data: unknown, status = 200): Response {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function policyContext(target: string): PolicyResolutionContext {
  const { scopeType, scopeKey } = parsePolicyTarget(target);
  if (!scopeKey) return {};
  switch (scopeType) {
    case "event": return { eventType: scopeKey };
    case "provider": return { provider: scopeKey };
    case "credential": return { credentialId: scopeKey };
    case "pool": return { poolId: scopeKey };
    case "identity": return { identityId: scopeKey };
    case "account": return { accountId: scopeKey };
    case "host": return { hostId: scopeKey };
    case "session": return { sessionId: scopeKey };
    default: return {};
  }
}

function canonicalPolicyRule(raw: unknown): NotificationPolicyRule {
  const validated = validatePolicyRule(raw);
  const parsed = parsePolicyTarget(validated.target);
  return validatePolicyRule({
    ...validated,
    target: parsed.scopeType === "global" ? "global" : `${parsed.scopeType}:${parsed.scopeKey}`,
    scopeType: parsed.scopeType,
    scopeKey: parsed.scopeKey,
  });
}

function quotaDto(quota: CurrentQuotaWindow) {
  const durationHours = quota.windowDurationMs === null
    ? null
    : Math.max(1, Math.round(quota.windowDurationMs / 3_600_000));
  return {
    identityId: quota.identityId,
    provider: quota.provider,
    windowLabel: durationHours === null ? "Quota window" : `${durationHours} hour window`,
    windowDurationMs: quota.windowDurationMs,
    meter: quota.meter,
    model: quota.model,
    tier: quota.tier,
    hostId: quota.hostId,
    observedAt: quota.lastObservedAt,
    resetsAt: quota.resetsAt,
    usedFraction: quota.usedFraction,
    remainingFraction: quota.remainingFraction,
    usedUnits: quota.usedUnits,
    totalUnits: quota.totalUnits,
    remainingUnits: quota.remainingUnits,
    unit: quota.unit,
    status: quota.status,
  };
}

function identityDto(identity: StoredProviderIdentity) {
  return {
    identityId: identity.identityId,
    kind: identity.kind,
    provider: identity.provider,
    sourceHostId: identity.sourceHostId,
    label: identity.label,
    observedAt: identity.observedAt,
    health: identity.health,
    disabled: identity.disabled,
    blocked: identity.blocked,
    cooldownUntilUtc: identity.cooldownUntilUtc,
    activeModel: identity.activeModel,
    consecutiveFailures: identity.consecutiveFailures,
    updatedAt: identity.updatedAt,
  };
}

function hostDto(host: StoredFleetHost) {
  return {
    hostId: host.hostId,
    hostname: host.operatorLabel || "Fleet host",
    platform: host.platform,
    agentVersion: host.collectorVersion,
    lastSeenAt: host.lastSeenAt,
    observedAt: host.observedAt,
    status: host.status,
    activeSessionsCount: host.activeSessionsCount,
    activeIdentitiesCount: host.activeIdentitiesCount,
  };
}

function sessionDto(session: StoredSessionSummary) {
  return {
    sessionId: session.sessionId,
    hostId: session.hostId,
    identityId: session.identityId,
    status: session.status,
    startedAt: session.startedAt,
    lastActiveAt: session.lastActiveAt,
    closedAt: session.closedAt,
    model: session.model,
    provider: session.provider,
    durationMs: session.durationMs,
    totalTokens: session.totalTokens,
    contextBps: session.contextBps,
    toolCallsCount: session.toolCallsCount,
    errorCount: session.errorCount,
    costEstimate: session.costEstimate,
    costTrust: session.costTrust,
    collectedAt: session.collectedAt,
    updatedAt: session.updatedAt,
  };
}

function eventDto(event: StoredObservatoryEvent) {
  const category = event.eventType.replaceAll("_", " ");
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    severity: event.severity,
    fingerprint: event.fingerprint,
    hostId: event.hostId,
    identityId: event.identityId,
    sessionId: event.sessionId,
    occurredAt: event.occurredAt,
    title: category.replace(/\b\w/g, (letter) => letter.toUpperCase()),
    message: `${event.severity} ${category} event`,
    durable: true,
  };
}

function getReplayEvents(
  store: ObservatoryStore,
  lastEventId: string,
  limit = 100,
): StoredObservatoryEvent[] {
  const target = store.getEvent(lastEventId);
  if (!target) {
    // If exact event not found, return the most recent events
    return store.listEvents({ limit }).reverse();
  }

  // Return events created after target event's creation time
  const events = store.listEvents({
    since: target.createdAt,
    limit: limit + 10,
  });

  // Filter out events that occurred before/at target event
  return events
    .filter((e) => e.eventId !== lastEventId && e.createdAt >= target.createdAt)
    .slice(0, limit)
    .reverse();
}

export async function handleObservatoryApi(
  request: Request,
  url: URL,
  method: string,
  context: ObservatoryApiContext,
): Promise<Response | null> {
  const pathname = url.pathname;

  // 1. Overview
  if (method === "GET" && pathname === "/api/observatory/overview") {
    const hosts = context.store.listHosts();
    const identities = context.store.listIdentities();
    const quotas = context.store.listCurrentQuotaWindows();
    const sessions = context.store.listSessionSummaries({ limit: 50 });
    const events = context.store.listEvents({ limit: 20 });
    const warningQuotas = quotas.filter((w) =>
      ["warning", "critical", "exhausted"].includes(String(w.status)),
    ).length;
    const onlineHosts = hosts.filter((h) => h.status === "online").length;
    const activeSessions = sessions.filter((s) => s.status === "active").length;

    return jsonResponse({
      generatedAt: new Date().toISOString(),
      totals: {
        hosts: hosts.length,
        onlineHosts,
        identities: identities.length,
        activeSessions,
        warningQuotas,
      },
      summary: {
        hosts: hosts.length,
        onlineHosts,
        identities: identities.length,
        activeSessions,
        warningQuotas,
      },
      hosts: hosts.map(hostDto),
      identities: identities.map(identityDto),
      quotas: quotas.map(quotaDto),
      sessions: sessions.map(sessionDto),
      events: events.map(eventDto),
    });
  }

  // 2. Quotas
  if (method === "GET" && pathname === "/api/observatory/quotas") {
    const identityId = url.searchParams.get("identityId") || undefined;
    const provider = url.searchParams.get("provider") || undefined;
    const bucketId = url.searchParams.get("bucketId") || undefined;
    const windowId = url.searchParams.get("windowId") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const limit = Math.min(
      1_000,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100),
    );
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    const matching = context.store.listCurrentQuotaWindows({
      identityId,
      provider,
      bucketId,
      windowId,
    }).filter((quota) => !status || quota.status === status);
    const quotas = matching.slice(offset, offset + limit).map(quotaDto);
    return jsonResponse({ quotas });
  }

  // 3. Identities
  if (method === "GET" && pathname === "/api/observatory/identities") {
    const sourceHostId = url.searchParams.get("sourceHostId") || undefined;
    const provider = url.searchParams.get("provider") || undefined;
    const health = (url.searchParams.get("health") as ProviderHealth) || undefined;
    const limit = Math.min(
      1_000,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100),
    );
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    const identities = context.store.listIdentities({
      sourceHostId,
      provider,
      health,
      limit,
      offset,
    }).map(identityDto);
    return jsonResponse({ identities });
  }

  // 4. Hosts
  if (method === "GET" && pathname === "/api/observatory/hosts") {
    const status = url.searchParams.get("status") || undefined;
    const limit = Math.min(
      1_000,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100),
    );
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    const hosts = context.store.listHosts({ status, limit, offset }).map(hostDto);
    return jsonResponse({ hosts });
  }

  // 5. Sessions
  if (method === "GET" && pathname === "/api/observatory/sessions") {
    const hostId = url.searchParams.get("hostId") || undefined;
    const identityId = url.searchParams.get("identityId") || undefined;
    const status = url.searchParams.get("status") || undefined;
    const since = url.searchParams.get("since") || undefined;
    const limit = Math.min(
      1_000,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100),
    );
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    const sessions = context.store.listSessionSummaries({
      hostId,
      identityId,
      status,
      since,
      limit,
      offset,
    }).map(sessionDto);
    return jsonResponse({ sessions });
  }

  // 6. Events
  if (method === "GET" && pathname === "/api/observatory/events") {
    const eventType = url.searchParams.get("eventType") || undefined;
    const severity = (url.searchParams.get("severity") as EventSeverity) || undefined;
    const hostId = url.searchParams.get("hostId") || undefined;
    const identityId = url.searchParams.get("identityId") || undefined;
    const sessionId = url.searchParams.get("sessionId") || undefined;
    const since = url.searchParams.get("since") || undefined;
    const limit = Math.min(
      1_000,
      Math.max(1, Number.parseInt(url.searchParams.get("limit") || "100", 10) || 100),
    );
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    const matching = context.store.listEvents({
      eventType,
      severity,
      hostId,
      identityId,
      since,
      limit: sessionId ? 1_000 : limit,
      offset: sessionId ? 0 : offset,
    });
    const selected = sessionId
      ? matching.filter((event) => event.sessionId === sessionId).slice(offset, offset + limit)
      : matching;
    const events = selected.map(eventDto);
    const audit = context.store.listAuditEntries({ limit: 100 }).map((entry) => ({
      auditId: entry.auditId,
      action: entry.action,
      actor: entry.actor,
      targetType: entry.targetType,
      targetId: entry.targetId,
      occurredAt: entry.occurredAt,
      details: {},
    }));
    return jsonResponse({ events, audit });
  }

  // 7. Policies (GET & PUT)
  if (method === "GET" && pathname === "/api/observatory/policies") {
    const stored = context.store.listPolicies();
    const effective = stored.map((rule) => {
      const resolved = resolveEffectivePolicy(stored, policyContext(rule.target));
      return { target: rule.target, policy: resolved.policy, provenance: resolved.explanation };
    });
    const deliveries = context.store.listDeliveries({ limit: 100 }).map((delivery) => ({
      deliveryId: delivery.deliveryId,
      eventId: delivery.eventId,
      channel: delivery.channel,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      sentAt: delivery.sentAt,
      lastAttemptAt: delivery.lastAttemptAt,
      errorCategory: delivery.errorCategory,
      errorMessage: delivery.status === "sent" ? "Delivered" : delivery.errorCategory ?? "No details",
    }));
    return jsonResponse({ policies: stored, effective, deliveries });
  }

  if (method === "PUT" && pathname === "/api/observatory/policies") {
    const body = await readBoundedJsonObject(request);
    if (Object.keys(body).length !== 1 || !("policy" in body)) {
      return errorResponse("Request body must contain exactly one policy object.", 400);
    }
    const rule = canonicalPolicyRule(body.policy);
    const existing = context.store.getPolicy(rule.target);
    const result = resolveEffectivePolicy([rule], policyContext(rule.target));
    const effectivePolicy = {
      ...result.policy,
      policyId: existing?.policyId ?? randomUUID().replaceAll("-", ""),
      target: rule.target,
      updatedAt: new Date().toISOString(),
    };
    context.store.withTransaction(() => {
      context.store.upsertPolicy(effectivePolicy);
      context.store.recordAuditEntry({
        action: "upsert_policy",
        actor: "dashboard_owner",
        targetType: "policy",
        targetId: rule.target,
        occurredAt: new Date().toISOString(),
      });
    });
    return jsonResponse({ rule, policy: effectivePolicy, provenance: result.explanation });
  }

  if (method === "DELETE" && pathname.startsWith("/api/observatory/policies/")) {
    let requestedTarget: string;
    try {
      requestedTarget = decodeURIComponent(pathname.slice("/api/observatory/policies/".length));
    } catch {
      return errorResponse("Invalid policy target.", 400);
    }
    const parsed = parsePolicyTarget(requestedTarget);
    const target = parsed.scopeType === "global" ? "global" : `${parsed.scopeType}:${parsed.scopeKey}`;
    const existing = context.store.getPolicy(target);
    if (!existing) return errorResponse("Policy not found.", 404);
    context.store.withTransaction(() => {
      context.store.deletePolicy(existing.policyId);
      context.store.recordAuditEntry({
        action: "delete_policy",
        actor: "dashboard_owner",
        targetType: "policy",
        targetId: target,
        occurredAt: new Date().toISOString(),
      });
    });
    return jsonResponse({ deleted: true, target });
  }

  // 8. Health
  if (method === "GET" && pathname === "/api/observatory/health") {
    const coordStatus = context.coordinator.getStatus();
    const isDegraded = coordStatus.consecutiveProbeFailures > 0;

    return jsonResponse({
      status: isDegraded ? "degraded" : "ok",
      generatedAt: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      schedulerActive: coordStatus.running,
      observatoryActive: true,
      lastProbeAt: coordStatus.lastProbeAt,
      lastProbeStatus: coordStatus.lastProbeStatus,
      lastProbeError: coordStatus.lastProbeError,
      consecutiveProbeFailures: coordStatus.consecutiveProbeFailures,
      services: [
        {
          name: "Observatory API",
          status: "ok",
          message: "Observatory REST endpoints operational",
        },
        {
          name: "Event stream",
          status: "online",
          message: "SSE stream available",
        },
        {
          name: "AgentRouter coordinator",
          status: coordStatus.running ? "active" : "online",
          message: coordStatus.running ? "Quota poller active" : "Idle",
        },
      ],
    });
  }

  // 9. Synthetic test delivery hook (owner-authenticated)
  if (
    method === "POST" &&
    (pathname === "/api/observatory/deliveries/test" ||
      pathname === "/api/observatory/test-delivery")
  ) {
    const body = await readBoundedJsonObject(request);
    const channel = typeof body.channel === "string" ? body.channel : "telegram";
    const eventId = typeof body.eventId === "string" ? body.eventId : undefined;
    const severity = typeof body.severity === "string" ? (body.severity as EventSeverity) : undefined;

    const delivery = await context.coordinator.deliveryManager.sendSyntheticDelivery({
      channel,
      eventId,
      severity,
    });

    return jsonResponse({ delivery }, 201);
  }

  // 10. SSE Stream
  if (method === "GET" && pathname === "/api/observatory/stream") {
    const lastEventId =
      request.headers.get("last-event-id") ||
      url.searchParams.get("lastEventId") ||
      url.searchParams.get("last_event_id") ||
      null;
    if (lastEventId && !/^[A-Za-z0-9._:-]{1,256}$/.test(lastEventId)) {
      return errorResponse("Invalid event cursor.", 400);
    }

    const textEncoder = new TextEncoder();
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(textEncoder.encode(`retry: 5000\n: connected\n\n`));

        if (lastEventId) {
          try {
            const replayed = getReplayEvents(context.store, lastEventId, 100);
            for (const evt of replayed) {
              const data = JSON.stringify(eventDto(evt));
              controller.enqueue(textEncoder.encode(`id: ${evt.eventId}\ndata: ${data}\n\n`));
            }
          } catch {
            console.warn("Observatory SSE replay failed.");
          }
        }

        // Subscribe to live events
        unsubscribe = context.coordinator.subscribe((evt) => {
          try {
            const data = JSON.stringify(eventDto(evt));
            controller.enqueue(textEncoder.encode(`id: ${evt.eventId}\ndata: ${data}\n\n`));
          } catch {
            // Stream cancellation performs cleanup below.
          }
        });

        // 15-second heartbeat
        heartbeatTimer = setInterval(() => {
          try {
            controller.enqueue(textEncoder.encode(`: keepalive\n\n`));
          } catch {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
          }
        }, 15_000);
      },
      cancel() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (unsubscribe) unsubscribe();
      },
    });

    request.signal.addEventListener("abort", () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (unsubscribe) unsubscribe();
    });

    const sseHeaders = new Headers(SECURITY_HEADERS);
    sseHeaders.set("content-type", "text/event-stream; charset=utf-8");
    sseHeaders.set("cache-control", "no-cache, no-transform");
    sseHeaders.set("connection", "keep-alive");
    sseHeaders.set("x-accel-buffering", "no");

    return new Response(stream, {
      status: 200,
      headers: sseHeaders,
    });
  }

  return null;
}
