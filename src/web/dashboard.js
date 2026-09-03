const state = {
  accounts: [],
  historicalAccounts: [],
  settings: null,
  coordinator: null,
  challenges: [],
  capabilities: { collectorSessions: false },
  overview: null,
  selectedId: null,
  activeView: "overview",
  history: [],
  runs: [],
  usage: [],
  activity: [],
  credits: [],
  grants: [],
  endpointObservations: [],
  observatory: { overview: null, quotas: null, identities: null, events: null, policies: null, health: null },
  observatoryErrors: new Map(),
  charts: new Map(),
  chartTimers: new Map(),
  chartRenderDelay: 0,
  viewRequest: 0,
  toastTimer: null,
  refreshTimer: null,
  refreshInFlight: false,
  fallbackTimer: null,
  fallbackInFlight: false,
  challengeTicker: null,
  liveConsoleHideTimer: null,
  liveConsoleFadeTimer: null,
  liveConsoleCompletedKey: null,
  liveConsoleDismissedKey: null,
  liveConsoleExpanded: false,
  revealedTokens: new Map(),
  sseSource: null,
  sseRetryTimer: null,
  sseRetryCount: 0,
  sseLastEventId: "",
  sseConnectedAt: null,
  sseLastMessageAt: null,
  pendingRefreshFamilies: new Set(),
  policyEditingTarget: null,
  policyEditingRule: null,
  previousFocus: new WeakMap(),
};

const PALETTE = ["#a855f7", "#d946ef", "#8b5cf6", "#f472b6", "#67e8f9", "#6ee7b7", "#fbbf24"];
const OVERVIEW_CHARTS = ["overview-money-chart", "overview-earnings-chart", "overview-accounts-chart"];
const ACCOUNT_CHARTS = ["money-chart", "duration-chart", "activity-chart", "performance-chart", "model-trend-chart"];
const MATERIAL_BALANCE_EVENT_USD = 25;
const byId = (id) => document.getElementById(id);
const dashboardBasePath = (() => {
  const path = window.location.pathname;
  if (path.endsWith("/dashboard.html") || path.endsWith("/index.html") || path.endsWith("/login.html")) {
    return path.slice(0, path.lastIndexOf("/") + 1);
  }
  return `${path.replace(/\/+$/, "")}/`;
})();
const dashboardUrl = (path) => new URL(
  `${dashboardBasePath}${path.replace(/^\//, "")}`,
  window.location.origin,
);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

async function api(path, options = {}) {
  const init = {
    method: options.method || "GET",
    headers: { accept: "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    cache: "no-store",
    signal: options.signal,
  };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(dashboardUrl(path), init);
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const authentication = response.status === 401 ? "Authentication required. Please sign in with your API key." : null;
    const error = new Error(payload?.error || authentication || `Request failed (${response.status}).`);
    error.status = response.status;
    if (response.status === 401) {
      window.location.replace(dashboardUrl("").toString());
    }
    throw error;
  }
  return payload;
}

async function optionalApi(name, path) {
  try {
    const payload = await api(path);
    state.observatoryErrors.delete(name);
    return payload;
  } catch (error) {
    state.observatoryErrors.set(name, error);
    return null;
  }
}

function listFrom(payload, keys = []) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function valueOrUnavailable(value, formatter = String) {
  return value === null || value === undefined || value === "" ? "Unavailable" : formatter(value);
}

function safeLabel(value, fallback = "Unlabelled") {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()
    .replace(/\bhttps?:\/\/\S+/gi, "[redacted URL]")
    .replace(/\b(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|etc|opt|private)\/)\S+/g, "[redacted path]")
    .replace(/\b(?:sk|ghp|github_pat|bearer)[-_ ]?[A-Za-z0-9._-]{8,}\b/gi, "[redacted credential]");
  return text ? text.slice(0, 120) : fallback;
}

function maskedIdentifier(value, prefix = "ID") {
  const text = String(value ?? "").trim();
  if (!text) return `${prefix} unavailable`;
  return `${prefix} ••••${text.slice(-4).replace(/[^A-Za-z0-9_-]/g, "•")}`;
}

function numericOrNull(value) {
  const number = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(number) ? null : number;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatMoney(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits }).format(Number(value));
}

function formatCompact(value, digits = 1) {
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: digits }).format(Number(value));
}


function formatNumber(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(Number(value));
}

function formatDate(value, withSeconds = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  }).format(date);
}

function formatDuration(ms) {
  const value = finite(ms);
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function formatInterval(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) {
    return "First captured grant";
  }
  const value = Number(minutes);
  if (value < 60) return `${formatNumber(value, 1)} min`;
  if (value < 1_440) return `${formatNumber(value / 60, 2)} hr`;
  return `${formatNumber(value / 1_440, 2)} days`;
}

function formatRelative(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "never";
  const seconds = Math.round((time - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  return formatter.format(Math.round(minutes / 60), "hour");
}

function showToast(message, isError = false) {
  const toast = byId("toast");
  toast.textContent = message;
  toast.className = `toast${isError ? " error" : ""}`;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.add("hidden"), 4_500);
}

function selectedAccount() {
  return state.accounts.find((account) => account.id === state.selectedId) || null;
}

function latestMetrics() {
  const browser = [...state.history].reverse().find((item) => item.status === "ok");
  const endpoint = state.endpointObservations.find((item) => item.status === "ok");
  if (!endpoint || (browser && Date.parse(browser.startedAt) >= Date.parse(endpoint.observedAt))) {
    return browser?.metrics || {};
  }
  return {
    ...(browser?.metrics || {}),
    balance: endpoint.balance,
    consumed: endpoint.consumed,
    requestCount: endpoint.requestCount,
  };
}

function sampleSeries(points, maximum = 360) {
  if (points.length <= maximum) return points;
  const sampled = [];
  const stride = (points.length - 1) / (maximum - 1);
  for (let index = 0; index < maximum; index += 1) {
    sampled.push(points[Math.round(index * stride)]);
  }
  return sampled;
}

function financialPoints(history, endpointObservations) {
  const points = [
    ...history.filter((item) => item.status === "ok").map((item) => ({
      at: item.startedAt,
      balance: item.metrics.balance,
      consumed: item.metrics.consumed,
      requestCount: item.metrics.requestCount,
      source: "Browser cycle",
      loggedOut: item.loggedOut,
    })),
    ...endpointObservations.filter((item) => item.status === "ok").map((item) => ({
      at: item.observedAt,
      balance: item.balance,
      consumed: item.consumed,
      requestCount: item.requestCount,
      source: "Minute poll",
    })),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  return sampleSeries(points);
}

function metricCard(label, value, note, color = PALETTE[0], extraClass = "") {
  const card = element("article", `metric-card ${extraClass}`.trim());
  card.style.setProperty("--card-color", color);
  card.append(element("span", null, label), element("strong", null, value), element("small", null, note));
  return card;
}

function chartGradient(context, color, alpha = .32) {
  const gradient = context.createLinearGradient(0, 0, 0, context.canvas.height || 300);
  gradient.addColorStop(0, `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`);
  gradient.addColorStop(1, `${color}00`);
  return gradient;
}

function destroyChart(id) {
  clearTimeout(state.chartTimers.get(id));
  state.chartTimers.delete(id);
  const chart = state.charts.get(id);
  if (chart) chart.destroy();
  state.charts.delete(id);
}

function destroyCharts(ids) {
  for (const id of ids) destroyChart(id);
}

function openInspector(title, rows) {
  byId("inspector-title").textContent = title;
  const content = byId("inspector-content");
  content.replaceChildren();
  for (const [label, value] of rows) {
    const row = element("div", "inspector-row");
    row.append(element("span", null, label), element("strong", null, value));
    content.append(row);
  }
  byId("data-inspector").classList.remove("hidden");
}

function createChart(id, config, inspectPoint) {
  destroyChart(id);
  const delay = state.chartRenderDelay;
  const request = state.viewRequest;
  state.chartRenderDelay += 45;
  const timer = setTimeout(() => {
    state.chartTimers.delete(id);
    if (request !== state.viewRequest) return;
    buildChart(id, config, inspectPoint, request);
  }, delay);
  state.chartTimers.set(id, timer);
}

function buildChart(id, config, inspectPoint, request = state.viewRequest) {
  destroyChart(id);
  const canvas = byId(id);
  if (request !== state.viewRequest || !canvas?.isConnected || canvas.closest(".hidden") || typeof Chart === "undefined") return;
  const context = canvas.getContext("2d");
  const datasets = (config.data.datasets || []).map((dataset, index) => ({
    borderColor: dataset.borderColor || PALETTE[index % PALETTE.length],
    backgroundColor: dataset.backgroundColor || chartGradient(context, dataset.borderColor || PALETTE[index % PALETTE.length]),
    borderWidth: 2.25,
    pointRadius: dataset.pointRadius ?? 3,
    pointHoverRadius: 7,
    pointBorderWidth: 0,
    tension: .34,
    fill: dataset.fill ?? false,
    ...dataset,
  }));
  const chart = new Chart(context, {
    ...config,
    data: { ...config.data, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      onHover(event, active) { event.native.target.style.cursor = active.length ? "pointer" : "default"; },
      onClick(_event, active, instance) {
        if (!active.length || !inspectPoint) return;
        inspectPoint(active[0].index, active[0].datasetIndex, instance);
      },
      plugins: {
        legend: { labels: { color: "#b9a8cc", usePointStyle: true, pointStyle: "circle", padding: 18, font: { size: 10, weight: 700 } } },
        tooltip: {
          backgroundColor: "rgba(15,7,26,.96)", titleColor: "#f5f3ff", bodyColor: "#d8b4fe", borderColor: "rgba(192,132,252,.32)", borderWidth: 1,
          padding: 12, cornerRadius: 12, displayColors: true, usePointStyle: true,
          ...config.options?.plugins?.tooltip,
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: "#756987", maxTicksLimit: 7, maxRotation: 0, font: { size: 9 } } },
        y: { grid: { color: "rgba(192,132,252,.09)" }, border: { display: false }, ticks: { color: "#756987", maxTicksLimit: 6, font: { size: 9 } } },
        ...config.options?.scales,
      },
      ...config.options,
      plugins: {
        legend: { labels: { color: "#b9a8cc", usePointStyle: true, pointStyle: "circle", padding: 18, font: { size: 10, weight: 700 } }, ...config.options?.plugins?.legend },
        tooltip: { backgroundColor: "rgba(15,7,26,.96)", titleColor: "#f5f3ff", bodyColor: "#d8b4fe", borderColor: "rgba(192,132,252,.32)", borderWidth: 1, padding: 12, cornerRadius: 12, displayColors: true, usePointStyle: true, ...config.options?.plugins?.tooltip },
      },
    },
  });
  state.charts.set(id, chart);
}

function moneyTick(value) { return formatMoney(value, 0); }
function timeLabels(items) { return items.map((item) => formatDate(item.startedAt)); }

function renderAccounts() {
  const list = byId("account-list");
  list.replaceChildren();
  byId("onboarding").classList.toggle("hidden", state.accounts.length > 0);
  byId("overview-nav").classList.toggle("active", state.selectedId === null);
  const historical = new Map(state.historicalAccounts.map((item) => [item.accountId, item]));
  for (const account of state.accounts) {
    const history = historical.get(account.id);
    const button = element("button", `nav-card${state.selectedId === account.id ? " active" : ""}`);
    button.type = "button";
    button.dataset.accountId = account.id;
    const icon = element("span", "nav-icon", account.label.slice(0, 1).toUpperCase());
    const copy = element("span");
    copy.append(element("strong", null, account.label), element("small", null, history?.lastRunAt ? `${account.githubUsername} · ${formatRelative(history.lastRunAt)}` : `${account.githubUsername} · no data`));
    const health = element("b", `health-dot ${history?.lastStatus || "neutral"}`);
    health.setAttribute("aria-hidden", "true");
    button.append(icon, copy, health);
    button.addEventListener("click", () => selectAccount(account.id));
    list.append(button);
  }
}

function traceCycleKey(coordinator) {
  const events = coordinator.events || [];
  return String(events[0]?.at || events.at(-1)?.at || coordinator.nextScheduledRunAt || "idle");
}

function clearLiveConsoleTimers() {
  clearTimeout(state.liveConsoleHideTimer);
  clearTimeout(state.liveConsoleFadeTimer);
  state.liveConsoleHideTimer = null;
  state.liveConsoleFadeTimer = null;
}

function renderTraceRows(container, rows) {
  container.replaceChildren();
  for (const rowData of rows) {
    const row = element("div", rowData.className || "terminal-line");
    const time = element("time", null, formatDate(rowData.at, true));
    const stageLabel = safeLabel(rowData.stage, "status").replaceAll("-", " ");
    const stage = element("b", null, stageLabel);
    const safeMessage = rowData.className === "trace-archive-line" ? safeLabel(rowData.message, "Recorded event") : rowData.stage === "error" ? conciseError(rowData.message) : `${stageLabel} status update`;
    const accountLabel = rowData.accountLabel ? safeLabel(rowData.accountLabel) : null;
    const message = element("span", null, accountLabel ? `${accountLabel} · ${safeMessage}` : safeMessage);
    row.append(time, stage, message); container.append(row);
  }
}

function materialChange(delta) {
  const threshold = finite(state.overview?.materialBalanceEventUsd, MATERIAL_BALANCE_EVENT_USD);
  return Math.abs(finite(delta)) >= threshold;
}

function balanceEventRows(accountLabel, credits = [], grants = [], endpointObservations = []) {
  const rows = [];
  const grantsByRun = new Map();
  for (const grant of grants) {
    const matched = grantsByRun.get(grant.runId) || [];
    matched.push(grant);
    grantsByRun.set(grant.runId, matched);
  }
  const representedGrantRuns = new Set();
  for (const credit of credits) {
    const matchingGrants = grantsByRun.get(credit.runId) || [];
    const delta = finite(credit.balanceDelta);
    if (!materialChange(delta) && !matchingGrants.length) continue;
    if (matchingGrants.length) representedGrantRuns.add(credit.runId);
    const grantTotal = matchingGrants.reduce((sum, grant) => sum + finite(grant.amount), 0);
    const grantDetail = matchingGrants.length ? ` · confirmed grant ${formatMoney(grantTotal)}` : "";
    rows.push({
      at: credit.observedAt,
      stage: delta < 0 ? "decrease" : "increase",
      accountLabel,
      message: `Verified browser balance ${delta >= 0 ? "+" : ""}${formatMoney(delta)}${grantDetail}`,
      className: "trace-archive-line",
    });
  }
  for (const grant of grants) {
    if (representedGrantRuns.has(grant.runId)) continue;
    rows.push({
      at: grant.occurredAt,
      stage: "grant",
      accountLabel,
      message: `Confirmed ${grant.classification.replaceAll("-", " ")} grant ${formatMoney(grant.amount)}`,
      className: "trace-archive-line",
    });
  }
  const successfulEndpointObservations = endpointObservations
    .filter((item) => item.status === "ok")
    .slice()
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  for (let index = 1; index < successfulEndpointObservations.length; index += 1) {
    const previous = successfulEndpointObservations[index - 1];
    const current = successfulEndpointObservations[index];
    const delta = finite(current.balance) - finite(previous.balance);
    if (!materialChange(delta)) continue;
    rows.push({
      at: current.observedAt,
      stage: delta < 0 ? "decrease" : "increase",
      accountLabel,
      message: `Minute-poll balance ${delta >= 0 ? "+" : ""}${formatMoney(delta)} · needs browser grant confirmation`,
      className: "trace-archive-line",
    });
  }
  return rows;
}

function materialArchiveRows() {
  const rows = [];
  if (state.selectedId) {
    const account = selectedAccount();
    if (account) rows.push(...balanceEventRows(account.label, state.credits, state.grants, state.endpointObservations));
    for (const run of state.runs.filter((item) => item.status === "error")) {
      rows.push({
        at: run.startedAt,
        stage: "error",
        accountLabel: account?.label || maskedIdentifier(run.accountId, "Account"),
        message: conciseError(run.errorMessage || "Check did not complete."),
        className: "trace-archive-line",
      });
    }
  } else {
    for (const item of state.overview?.accounts || []) {
      rows.push(...balanceEventRows(item.account.label, item.credits, item.grants, item.endpointObservations));
    }
    for (const run of state.overview?.recentRuns || []) {
      if (run.status !== "error") continue;
      rows.push({
        at: run.startedAt,
        stage: "error",
        accountLabel: run.accountLabel,
        message: conciseError(run.errorMessage || "Check did not complete."),
        className: "trace-archive-line",
      });
    }
  }
  return rows.sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 40);
}

function renderTraceArchive() {
  const archive = byId("trace-archive-list");
  const archiveState = byId("trace-archive-state");
  const rows = materialArchiveRows();
  if (!rows.length) {
    archiveState.textContent = "No actionable events";
    const threshold = finite(state.overview?.materialBalanceEventUsd, MATERIAL_BALANCE_EVENT_USD);
    archive.replaceChildren(element("p", "trace-archive-empty", `Routine samples are stored for charts and export. This feed only shows ${formatMoney(threshold)}+ movements, confirmed grants, and errors.`));
    return;
  }
  archiveState.textContent = "Material events";
  renderTraceRows(archive, rows);
}

function renderCoordinator() {
  const coordinator = state.coordinator || {};
  const automation = state.settings?.automation;
  const chip = byId("scheduler-state");
  chip.className = "status-chip neutral";
  chip.replaceChildren(element("i"));
  const text = document.createTextNode("Loading automation");
  chip.append(text);
  if (coordinator.running) {
    chip.className = "status-chip running";
    text.nodeValue = "Cycle running";
  } else if (coordinator.lastCycleError) {
    chip.className = "status-chip error";
    text.nodeValue = "Last cycle had errors";
  } else if (automation?.schedulerEnabled) {
    chip.className = "status-chip ok";
    text.nodeValue = "Automation healthy";
  } else {
    text.nodeValue = "Scheduler paused";
  }
  byId("overview-health").className = `health-dot ${coordinator.lastCycleError ? "error" : automation?.schedulerEnabled ? "ok" : "neutral"}`;
  byId("next-run-label").textContent = coordinator.nextScheduledRunAt ? `Next cycle ${formatRelative(coordinator.nextScheduledRunAt)}` : "No cycle scheduled";
  byId("run-all").disabled = Boolean(coordinator.running);
  byId("hero-run").disabled = Boolean(coordinator.running);
  byId("run-account").disabled = Boolean(coordinator.running);
  byId("stop-all").classList.toggle("hidden", !coordinator.canStop);
  const consolePanel = byId("run-console");
  const events = coordinator.events || [];
  const cycleKey = traceCycleKey(coordinator);
  const lastEventAt = Date.parse(events.at(-1)?.at || "");
  const freshCompletion = Number.isFinite(lastEventAt) && Date.now() - lastEventAt < 10_000;
  const completionVisible = events.length && state.liveConsoleCompletedKey === cycleKey && !consolePanel.classList.contains("hidden");
  const showConsole = Boolean(coordinator.running || completionVisible || (freshCompletion && state.liveConsoleCompletedKey !== cycleKey && state.liveConsoleDismissedKey !== cycleKey));
  if (coordinator.running) {
    clearLiveConsoleTimers();
    state.liveConsoleCompletedKey = null;
    state.liveConsoleDismissedKey = null;
  } else if (freshCompletion && state.liveConsoleCompletedKey !== cycleKey) {
    state.liveConsoleCompletedKey = cycleKey;
    clearLiveConsoleTimers();
    state.liveConsoleHideTimer = setTimeout(() => {
      consolePanel.classList.add("fading");
      state.liveConsoleFadeTimer = setTimeout(() => {
        consolePanel.classList.add("hidden");
        consolePanel.classList.remove("fading");
        document.body.classList.remove("trace-active");
      }, 600);
    }, 5_000);
  }
  consolePanel.classList.toggle("hidden", !showConsole);
  consolePanel.classList.toggle("complete", showConsole && !coordinator.running);
  consolePanel.classList.remove("fading");
  document.body.classList.toggle("trace-active", showConsole);
  byId("dismiss-run").classList.toggle("hidden", Boolean(coordinator.running));
  if (showConsole) {
    byId("run-stage").textContent = String(coordinator.currentStage || "idle").replaceAll("-", " ");
    byId("run-percent").textContent = `${finite(coordinator.progressPercent)}%`;
    byId("run-message").textContent = `${safeLabel(coordinator.currentStage, "Collection").replaceAll("-", " ")} status update.`;
    byId("run-account-label").textContent = coordinator.currentAccountLabel
      ? `${coordinator.currentAccountLabel} · ${coordinator.completedAccounts}/${coordinator.totalAccounts} completed`
      : `${coordinator.completedAccounts || 0}/${coordinator.totalAccounts || 0} completed`;
    byId("run-progress").style.width = `${Math.min(100, Math.max(0, finite(coordinator.progressPercent)))}%`;
    renderTraceRows(byId("terminal-events"), events.filter((event) => event.stage === "error").slice(-40));
  }
  byId("toggle-console-size").textContent = state.liveConsoleExpanded ? "Compact" : "Expand";
  byId("toggle-console-size").setAttribute("aria-expanded", String(state.liveConsoleExpanded));
  consolePanel.classList.toggle("expanded", state.liveConsoleExpanded);
  renderTraceArchive();
}

function renderChallenges() {
  const challenge = state.challenges?.[0];
  const modal = byId("mobile-challenge");
  const wasHidden = modal.classList.contains("hidden");
  modal.classList.toggle("hidden", !challenge);
  if (!challenge) {
    if (!wasHidden) { const previous = state.previousFocus.get(modal); if (previous?.isConnected) previous.focus(); }
    return;
  }
  if (wasHidden) { state.previousFocus.set(modal, document.activeElement); requestAnimationFrame(() => byId("challenge-stop").focus()); }
  const isWaf = challenge.kind === "agentrouter-waf";
  byId("challenge-eyebrow").textContent = isWaf ? "AGENTROUTER · ACCESS VERIFICATION" : "GITHUB MOBILE · SECURE APPROVAL";
  const accountLabel = safeLabel(challenge.accountLabel, "account");
  byId("challenge-account").textContent = isWaf ? `Verify ${accountLabel}` : `Approve ${accountLabel}`;
  byId("challenge-prompt").textContent = isWaf ? "Complete the access verification in the visible browser." : "Open GitHub Mobile and approve the request.";
  byId("challenge-code").textContent = safeLabel(challenge.verificationCode, isWaf ? "SLIDE" : "PUSH");
  byId("challenge-status").textContent = isWaf ? "Watching the visible browser" : "Listening for GitHub";
  updateChallengeCountdown();
}

function updateChallengeCountdown() {
  const challenge = state.challenges?.[0];
  if (!challenge) return;
  const seconds = Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - Date.now()) / 1_000));
  const label = challenge.kind === "agentrouter-waf" ? "Verification window" : "Secure request";
  byId("challenge-expiry").textContent = seconds > 0
    ? `${label} expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    : `${label} expired · waiting for the worker to close it`;
}

function renderOverviewMetrics() {
  const metrics = byId("overview-metrics");
  metrics.replaceChildren();
  const totals = state.overview?.totals || {};
  metrics.append(
    metricCard("Combined balance", formatMoney(totals.balance), `${totals.configuredAccounts || 0} active accounts`, PALETTE[0]),
    metricCard("Daily $25 Grants", formatMoney(totals.confirmedEarnings), "Automated daily login rewards", PALETTE[1], "gain"),
    metricCard("Observed increases", formatMoney(totals.observedEarnings), "Confirmed credit awards", PALETTE[2], "gain"),
    metricCard("Total Usage (Spent)", formatMoney(totals.consumed), "Lifetime token & API consumption", PALETTE[3]),
    metricCard("Total requests", formatCompact(totals.requests), "Account lifetime requests", PALETTE[4]),
    metricCard("7-day tokens", formatCompact(totals.tokens), "Latest collected windows", PALETTE[5]),
  );
  byId("overview-earnings").textContent = formatMoney(totals.confirmedEarnings);
  byId("overview-observed-earnings").textContent = `${formatMoney(totals.observedEarnings)} confirmed awards`;
}

function aggregatePortfolioHistory(accountData) {
  const points = [];
  const accountsWithHistory = new Set();
  for (const item of accountData) {
    const successful = financialPoints(item.history, item.endpointObservations || []);
    if (successful.length) accountsWithHistory.add(item.account.id);
    for (const sample of successful) {
      points.push({ at: sample.at, accountId: item.account.id, metrics: sample });
    }
  }
  points.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const latestByAccount = new Map();
  const portfolio = [];
  for (const point of points) {
    latestByAccount.set(point.accountId, point.metrics);
    if (latestByAccount.size < accountsWithHistory.size) continue;
    let balance = 0;
    let consumed = 0;
    for (const metrics of latestByAccount.values()) {
      balance += finite(metrics.balance);
      consumed += finite(metrics.consumed);
    }
    portfolio.push({ startedAt: point.at, balance, consumed, changedAccount: point.accountId });
  }
  return portfolio;
}

function renderOverviewCharts() {
  const accountData = state.overview?.accounts || [];
  const portfolio = aggregatePortfolioHistory(accountData);
  createChart("overview-money-chart", {
    type: "line",
    data: { labels: timeLabels(portfolio), datasets: [
      { label: "Combined balance", data: portfolio.map((point) => point.balance), borderColor: PALETTE[0], fill: true },
      { label: "Lifetime spend", data: portfolio.map((point) => point.consumed), borderColor: PALETTE[1] },
    ] },
    options: { scales: { y: { ticks: { callback: moneyTick } } }, plugins: { tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${formatMoney(item.raw)}` } } } },
  }, (index) => {
    const point = portfolio[index];
    if (!point) return;
    const account = state.accounts.find((item) => item.id === point.changedAccount);
    openInspector("Portfolio snapshot", [["Observed", formatDate(point.startedAt, true)], ["Triggered by", account?.label || maskedIdentifier(point.changedAccount, "Account")], ["Combined balance", formatMoney(point.balance, 4)], ["Lifetime spend", formatMoney(point.consumed, 4)]]);
  });

  const confirmedPoints = accountData.flatMap((item) => {
    const grants = [...(item.grants || [])].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    return grants.map((grant, index) => ({
      ...grant,
      kind: "confirmed",
      label: item.account.label,
      minutesSincePrior: index === 0 ? null : (Date.parse(grant.occurredAt) - Date.parse(grants[index - 1].occurredAt)) / 60_000,
    }));
  });
  const observedPoints = accountData.flatMap((item) => (item.credits || [])
    .filter((credit) => finite(credit.balanceDelta) > 0)
    .map((credit) => ({ ...credit, kind: "observed", label: item.account.label, occurredAt: credit.observedAt, amount: credit.balanceDelta })));
  const creditPoints = [...confirmedPoints, ...observedPoints]
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  createChart("overview-earnings-chart", {
    type: "bar",
    data: { labels: creditPoints.map((point) => formatDate(point.occurredAt)), datasets: [
      { label: "Confirmed grant", data: creditPoints.map((point) => point.kind === "confirmed" ? point.amount : null), backgroundColor: PALETTE[1], borderRadius: 8, borderWidth: 0 },
      { type: "line", label: "Observed increase", data: creditPoints.map((point) => point.kind === "observed" ? point.amount : null), borderColor: PALETTE[4], backgroundColor: PALETTE[4], spanGaps: false, pointRadius: 5 },
    ] },
    options: { plugins: { tooltip: { callbacks: { label: (item) => `${item.dataset.label}: +${formatMoney(item.raw)}` } } }, scales: { y: { beginAtZero: true, ticks: { callback: moneyTick } } } },
  }, (index) => {
    const point = creditPoints[index];
    if (!point) return;
    if (point.kind === "confirmed") openInspector("Confirmed AgentRouter grant", [["Account", point.label], ["Granted", formatDate(point.occurredAt, true)], ["Amount", `+${formatMoney(point.amount, 4)}`], ["Since prior grant", formatInterval(point.minutesSincePrior)], ["Evidence", point.description]]);
    else openInspector("Observed balance increase", [["Account", point.label], ["Observed", formatDate(point.occurredAt, true)], ["Balance change", `+${formatMoney(point.amount, 4)}`], ["Since prior sample", formatInterval(point.minutesSincePrevious)], ["Evidence", "Measured balance delta; not treated as proof of a grant."]]);
  });

  const current = accountData.map((item) => ({ label: item.account.label, metrics: item.latest?.metrics || {} }));
  createChart("overview-accounts-chart", {
    type: "bar",
    data: { labels: current.map((item) => item.label), datasets: [
      { label: "Balance", data: current.map((item) => finite(item.metrics.balance)), backgroundColor: PALETTE[0], borderRadius: 9, borderWidth: 0 },
      { label: "Spent", data: current.map((item) => finite(item.metrics.consumed)), backgroundColor: PALETTE[1], borderRadius: 9, borderWidth: 0 },
    ] },
    options: { scales: { y: { beginAtZero: true, ticks: { callback: moneyTick } } }, plugins: { tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${formatMoney(item.raw)}` } } } },
  }, (index) => { if (accountData[index]) selectAccount(accountData[index].account.id); });
}

function renderHealth() {
  const runs = state.overview?.recentRuns || [];
  const success = runs.filter((run) => run.status === "ok").length;
  const rate = runs.length ? (success / runs.length) * 100 : 0;
  const summary = byId("health-summary");
  summary.replaceChildren();
  const ring = element("div", "health-ring");
  ring.style.setProperty("--value", `${rate * 3.6}deg`);
  ring.append(element("strong", null, `${Math.round(rate)}%`));
  const copy = element("div", "health-copy");
  copy.append(element("strong", null, runs.length ? "Recorded reliability" : "Awaiting data"), element("p", null, runs.length ? `${success} of ${runs.length} recent checks completed successfully.` : "Run a collection cycle to establish a health baseline."));
  summary.append(ring, copy);
  const comparison = byId("account-comparison");
  comparison.replaceChildren();
  for (const item of state.overview?.accounts || []) {
    const row = element("div", "comparison-row");
    row.append(element("span", null, item.account.label), element("strong", null, item.latest ? `${formatMoney(item.latest.metrics.balance)} · ${formatRelative(item.latest.startedAt)}` : "No successful snapshot"));
    comparison.append(row);
  }
}

function renderOverview() {
  state.chartRenderDelay = 0;
  renderOverviewMetrics();
  renderOverviewCharts();
  renderHealth();
  renderOverviewTokenVault();
}

function tokenStatus(account) {
  return account.hasApiToken ? "API token captured" : "API token pending";
}

function renderOverviewTokenVault() {
  const list = byId("overview-token-list");
  list.replaceChildren();
  if (!state.accounts.length) {
    list.append(element("p", "trace-archive-empty", "Add an account, then complete one browser cycle to capture its API access."));
    return;
  }
  for (const account of state.accounts) {
    const row = element("article", "vault-row");
    const identity = element("div");
    identity.append(element("h3", null, account.label), element("p", null, `GitHub · ${account.githubUsername}`));
    const status = element("span", `token-status${account.hasApiToken ? " ready" : ""}`, tokenStatus(account));
    const actions = element("div", "vault-actions");
    const revealed = state.revealedTokens.get(account.id);
    if (account.hasApiToken) {
      const reveal = element("button", "trace-button", revealed ? "Hide" : "Reveal");
      reveal.type = "button";
      reveal.addEventListener("click", () => revealed ? hideApiToken(account.id) : revealApiToken(account.id));
      const copy = element("button", "trace-button", "Copy");
      copy.type = "button";
      copy.addEventListener("click", () => copyApiToken(account.id));
      actions.append(reveal, copy);
    }
    row.append(identity, status, actions);
    if (revealed) row.append(element("code", "vault-token", revealed));
    list.append(row);
  }
}

function renderAccountMetrics() {
  const metrics = latestMetrics();
  const grid = byId("metric-grid");
  grid.replaceChildren();
  grid.append(
    metricCard("Available balance", formatMoney(metrics.balance, 2), "Current AgentRouter balance", PALETTE[0]),
    metricCard("Total Usage (Spent)", formatMoney(metrics.consumed, 2), "Account consumption", PALETTE[1]),
    metricCard("Requests", formatCompact(metrics.requestCount), "Account lifetime", PALETTE[2]),
    metricCard("7-day tokens", formatCompact(metrics.statisticalTokens), `${formatCompact(metrics.statisticalCount)} statistical calls`, PALETTE[3]),
    metricCard("Average RPM", formatNumber(metrics.averageRpm, 4), "Collected window", PALETTE[4]),
    metricCard("Average TPM", formatNumber(metrics.averageTpm, 1), Number.isFinite(Number(metrics.availableModels)) ? `${formatNumber(metrics.availableModels)} models available` : "Model count not exposed by Console", PALETTE[5]),
  );
}

function renderAccountCharts() {
  const successful = state.history.filter((item) => item.status === "ok");
  const financial = financialPoints(state.history, state.endpointObservations);
  const labels = timeLabels(successful);
  const inspectHistory = (index) => {
    const point = successful[index];
    if (!point) return;
    openInspector("Account snapshot", [["Observed", formatDate(point.startedAt, true)], ["Balance", formatMoney(point.metrics.balance, 4)], ["Lifetime spend", formatMoney(point.metrics.consumed, 4)], ["Requests", formatNumber(point.metrics.requestCount)], ["7-day tokens", formatCompact(point.metrics.statisticalTokens)], ["Logout", point.loggedOut ? "Confirmed" : "Not confirmed"]]);
  };
  createChart("money-chart", { type: "line", data: { labels: financial.map((item) => formatDate(item.at)), datasets: [
    { label: "Balance", data: financial.map((item) => item.balance), borderColor: PALETTE[0], fill: true },
    { label: "Lifetime spend", data: financial.map((item) => item.consumed), borderColor: PALETTE[1] },
  ] }, options: { scales: { y: { ticks: { callback: moneyTick } } }, plugins: { tooltip: { callbacks: { afterBody: (items) => financial[items[0]?.dataIndex]?.source || "", label: (item) => `${item.dataset.label}: ${formatMoney(item.raw, 4)}` } } } } }, (index) => {
    const point = financial[index];
    if (point) openInspector("Financial observation", [["Observed", formatDate(point.at, true)], ["Source", point.source], ["Balance", formatMoney(point.balance, 4)], ["Lifetime spend", formatMoney(point.consumed, 4)], ["Requests", formatNumber(point.requestCount)], ["Logout", point.loggedOut === undefined ? "Not applicable" : point.loggedOut ? "Confirmed" : "Not confirmed"]]);
  });

  createChart("duration-chart", { type: "line", data: { labels: timeLabels(state.history), datasets: [
    { label: "Login", data: state.history.map((item) => finite(item.loginMs) / 1_000), borderColor: PALETTE[4] },
    { label: "Total", data: state.history.map((item) => finite(item.totalMs) / 1_000), borderColor: PALETTE[1], fill: true },
  ] }, options: { scales: { y: { beginAtZero: true, ticks: { callback: (value) => `${value}s` } } }, plugins: { tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${formatDuration(item.raw * 1_000)}` } } } } }, (index) => {
    const point = state.history[index];
    if (point) openInspector("Automation timing", [["Started", formatDate(point.startedAt, true)], ["Status", point.status], ["Login", formatDuration(point.loginMs)], ["Dashboard", formatDuration(point.dashboardMs)], ["Total", formatDuration(point.totalMs)]]);
  });

  createChart("activity-chart", { type: "bar", data: { labels, datasets: [
    { type: "line", label: "Requests", data: successful.map((item) => finite(item.metrics.statisticalCount)), borderColor: PALETTE[0], yAxisID: "y", pointRadius: 3 },
    { label: "Tokens", data: successful.map((item) => finite(item.metrics.statisticalTokens)), backgroundColor: PALETTE[1], borderRadius: 7, borderWidth: 0, yAxisID: "y1" },
  ] }, options: { scales: { y: { position: "left", beginAtZero: true }, y1: { position: "right", beginAtZero: true, grid: { display: false }, ticks: { color: "#756987", callback: (value) => formatCompact(value) } } } } }, inspectHistory);

  createChart("performance-chart", { type: "line", data: { labels, datasets: [
    { label: "RPM", data: successful.map((item) => finite(item.metrics.averageRpm)), borderColor: PALETTE[4], yAxisID: "y", fill: true },
    { label: "TPM", data: successful.map((item) => finite(item.metrics.averageTpm)), borderColor: PALETTE[1], yAxisID: "y1" },
  ] }, options: { scales: { y: { position: "left", beginAtZero: true }, y1: { position: "right", beginAtZero: true, grid: { display: false }, ticks: { color: "#756987", callback: (value) => formatCompact(value) } } } } }, inspectHistory);
}

function renderUsage() {
  const quotaPerUnit = finite(latestMetrics().quotaPerUnit, 500_000) || 500_000;
  const byModel = new Map();
  const byTime = new Map();
  for (const point of state.usage) {
    byModel.set(point.modelName, finite(byModel.get(point.modelName)) + finite(point.quota));
    const time = byTime.get(point.createdAt) || new Map();
    time.set(point.modelName, finite(time.get(point.modelName)) + finite(point.quota) / quotaPerUnit);
    byTime.set(point.createdAt, time);
  }
  const models = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
  const share = byId("model-share");
  share.replaceChildren();
  const maximum = Math.max(1, ...models.map(([, value]) => value));
  for (const [model, raw] of models.slice(0, 10)) {
    const row = element("div", "model-row");
    row.append(element("strong", null, model), element("span", null, formatMoney(raw / quotaPerUnit, 4)));
    const track = element("div", "model-track");
    const fill = element("i"); fill.style.width = `${Math.max(2, raw / maximum * 100)}%`; track.append(fill); row.append(track); share.append(row);
  }
  if (!models.length) share.append(element("p", "muted", "No model usage captured yet."));
  const timestamps = [...byTime.keys()].sort((a, b) => a - b);
  createChart("model-trend-chart", { type: "line", data: { labels: timestamps.map((time) => formatDate(time * 1_000)), datasets: models.slice(0, 6).map(([model], index) => ({ label: model, data: timestamps.map((time) => finite(byTime.get(time)?.get(model))), borderColor: PALETTE[index % PALETTE.length], fill: index === 0 })) }, options: { scales: { y: { beginAtZero: true, ticks: { callback: moneyTick } } }, plugins: { tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${formatMoney(item.raw, 4)}` } } } } }, (index, datasetIndex, chart) => {
    const model = chart.data.datasets[datasetIndex]?.label;
    openInspector("Model usage point", [["Model", model || "—"], ["Window", chart.data.labels[index]], ["Spend", formatMoney(chart.data.datasets[datasetIndex].data[index], 4)]]);
  });
}

function renderCredits() {
  const body = byId("credits-body"); body.replaceChildren();
  const increases = state.credits.filter((item) => finite(item.balanceDelta) > 0);
  const total = increases.reduce((sum, item) => sum + finite(item.balanceDelta), 0);
  byId("credit-summary").textContent = `${increases.length} increase${increases.length === 1 ? "" : "s"} · ${formatMoney(total)}`;
  for (const item of state.credits) {
    const row = element("tr");
    row.append(element("td", null, formatDate(item.observedAt, true)));
    const signalCell = element("td"); signalCell.append(element("span", `signal ${item.classification}`, item.classification.replace("credit-", ""))); row.append(signalCell);
    row.append(element("td", null, formatMoney(item.balance, 4)));
    row.append(element("td", null, item.balanceDelta == null ? "—" : `${item.balanceDelta > 0 ? "+" : ""}${formatMoney(item.balanceDelta, 4)}`));
    row.append(element("td", null, item.consumedDelta == null ? "—" : `${item.consumedDelta > 0 ? "+" : ""}${formatMoney(item.consumedDelta, 4)}`));
    row.append(element("td", null, item.minutesSincePrevious == null ? "—" : `${formatNumber(item.minutesSincePrevious, 1)} min`));
    row.append(element("td", null, item.sessionReused ? "Reused" : "Fresh auth"));
    row.append(element("td", null, item.loggedOut ? "Confirmed" : "No"));
    body.append(row);
  }
  if (!state.credits.length) {
    const row = element("tr"); const cell = element("td", "muted", "No successful balance observations stored yet."); cell.colSpan = 8; row.append(cell); body.append(row);
  }
}

function renderGrants() {
  const body = byId("grants-body"); body.replaceChildren();
  const total = state.grants.reduce((sum, item) => sum + finite(item.amount), 0);
  const chronological = [...state.grants].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const withIntervals = chronological.map((item, index) => ({
    ...item,
    minutesSincePrior: index === 0 ? null : (Date.parse(item.occurredAt) - Date.parse(chronological[index - 1].occurredAt)) / 60_000,
  })).reverse();
  const intervals = withIntervals.map((item) => item.minutesSincePrior).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  const median = intervals.length
    ? intervals.length % 2
      ? intervals[Math.floor(intervals.length / 2)]
      : (intervals[intervals.length / 2 - 1] + intervals[intervals.length / 2]) / 2
    : null;
  byId("grant-summary").textContent = `${state.grants.length} confirmed · ${formatMoney(total)}${median == null ? "" : ` · median ${formatInterval(median)}`}`;
  for (const item of withIntervals) {
    const row = element("tr");
    row.append(
      element("td", null, formatDate(item.occurredAt, true)),
      element("td", null, formatInterval(item.minutesSincePrior)),
      element("td", null, "Daily sign-in"),
      element("td", "status-ok", `+${formatMoney(item.amount, 4)}`),
      element("td", null, "Confirmed AgentRouter grant evidence"),
    );
    body.append(row);
  }
  if (!state.grants.length) {
    const row = element("tr");
    const cell = element("td", "muted", "No confirmed grant event has been captured yet.");
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }
}

function meaningfulActivity(item) {
  return Boolean(item?.model_name || item?.token_name || finite(item?.prompt_tokens) || finite(item?.completion_tokens) || finite(item?.quota));
}

function renderActivity() {
  const body = byId("activity-body"); body.replaceChildren();
  const quotaPerUnit = finite(latestMetrics().quotaPerUnit, 500_000) || 500_000;
  const activity = state.activity.filter(meaningfulActivity);
  for (const item of activity) {
    const row = element("tr");
    row.append(element("td", null, formatDate(finite(item.created_at) * 1_000, true)), element("td", null, item.token_name ? maskedIdentifier(item.token_name, "Credential") : "Unavailable"), element("td", null, safeLabel(item.model_name, "Unavailable")), element("td", null, formatNumber(item.prompt_tokens)), element("td", null, formatNumber(item.completion_tokens)), element("td", null, formatMoney(finite(item.quota) / quotaPerUnit, 4)), element("td", null, item.group ? maskedIdentifier(item.group, "Group") : "Unavailable"), element("td", null, item.is_stream ? "Stream" : "Standard"));
    body.append(row);
  }
  if (!activity.length) { const row = element("tr"); const cell = element("td", "muted", "No meaningful usage rows captured yet."); cell.colSpan = 8; row.append(cell); body.append(row); }
}

function conciseError(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return "No public error detail";
  if (/cancel/.test(text)) return "Collection cancelled";
  if (/timeout|timed out/.test(text)) return "Operation timed out";
  if (/auth|login|credential|unauthor/.test(text)) return "Authentication failed";
  if (/network|fetch|connect|socket|dns/.test(text)) return "Network request failed";
  if (/challenge|approval|two.?factor|2fa/.test(text)) return "Approval challenge incomplete";
  if (/parse|schema|invalid response/.test(text)) return "Provider response was invalid";
  return "Collection failed";
}

function renderRuns() {
  const body = byId("runs-body"); body.replaceChildren();
  for (const run of state.runs) {
    const row = element("tr");
    const cancelled = /cancelled/i.test(run.errorMessage || "");
    row.append(element("td", null, formatDate(run.startedAt, true)), element("td", run.status === "ok" ? "status-ok" : cancelled ? "muted" : "status-error", run.status === "ok" ? "Success" : cancelled ? "Cancelled" : "Error"), element("td", null, formatDuration(run.loginMs)), element("td", null, formatDuration(run.dashboardMs)), element("td", null, formatDuration(run.totalMs)), element("td", null, run.loggedOut ? "Confirmed" : "No"));
    const detailCell = element("td");
    if (run.errorMessage) {
      const details = element("details", "error-details");
      const publicError = conciseError(run.errorMessage);
      details.append(element("summary", null, publicError), element("p", null, `${publicError}. Sensitive runtime details are available only in protected server logs.`));
      detailCell.append(details);
    } else detailCell.textContent = "—";
    row.append(detailCell);
    const capture = element("td");
    if (run.screenshotPath) {
      const filename = String(run.screenshotPath).replaceAll("\\", "/").split("/").pop();
      if (/^[A-Za-z0-9._-]+\.png$/.test(filename)) { const link = element("a", "capture-link", "Open capture ↗"); link.href = dashboardUrl(`screenshots/${encodeURIComponent(filename)}`).toString(); link.target = "_blank"; link.rel = "noopener noreferrer"; capture.append(link); }
    } else capture.textContent = "—";
    row.append(capture); body.append(row);
  }
}

function renderAccount() {
  const account = selectedAccount();
  if (!account) return;
  const historical = state.historicalAccounts.find((item) => item.accountId === account.id);
  byId("selected-username").textContent = `GITHUB · ${account.githubUsername}`;
  byId("selected-label").textContent = account.label;
  byId("selected-last-run").textContent = historical?.lastRunAt ? `Last check ${formatDate(historical.lastRunAt, true)} · ${historical.lastStatus}` : "No checks stored yet";
  byId("api-token-status").textContent = tokenStatus(account);
  byId("api-token-status").classList.toggle("ready", account.hasApiToken);
  byId("copy-api-token").disabled = !account.hasApiToken;
  byId("reveal-api-token").disabled = !account.hasApiToken;
  const token = state.revealedTokens.get(account.id);
  byId("reveal-api-token").textContent = token ? "API token revealed" : "Reveal API token";
  byId("selected-token-reveal").classList.toggle("hidden", !token);
  byId("selected-api-token").textContent = token || "";
  state.chartRenderDelay = 0;
  renderAccountMetrics(); renderAccountCharts(); renderUsage(); renderGrants(); renderCredits(); renderActivity(); renderRuns(); renderTraceArchive();
}

function statusClass(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function statusBadge(value, fallback = "unknown") {
  const label = safeLabel(value, fallback).replaceAll("_", " ");
  return element("span", `obs-badge ${statusClass(value || fallback)}`, label);
}

function observedAtOf(item) {
  return item?.observedAt || item?.occurredAt || item?.collectedAt || item?.lastObservedAt || item?.lastActiveAt || item?.updatedAt || item?.createdAt || item?.generatedAt || null;
}

function isStale(value, thresholdMs = 10 * 60_000) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) && Date.now() - parsed > thresholdMs;
}

function metadataBadges(item, defaultSource, defaultScope) {
  const row = element("div", "obs-badges");
  const source = item?.source || defaultSource;
  const scope = item?.scope || defaultScope;
  const observedAt = observedAtOf(item);
  if (source) row.append(element("span", "obs-badge source", `Source · ${safeLabel(source)}`));
  if (scope) row.append(element("span", "obs-badge scope", `Scope · ${safeLabel(scope)}`));
  const ageValue = item?.age;
  if (ageValue !== null && ageValue !== undefined && !observedAt) {
    const ageSeconds = typeof ageValue === "number" ? ageValue : Number.parseFloat(ageValue);
    const staleAge = Number.isFinite(ageSeconds) && ageSeconds > 600;
    const ageText = typeof ageValue === "number" ? (ageValue < 120 ? `${Math.round(ageValue)}s` : `${Math.round(ageValue / 60)}m`) : safeLabel(ageValue);
    row.append(element("span", `obs-badge ${staleAge ? "stale" : "age"}`, `${staleAge ? "Stale" : "Age"} · ${ageText}`));
  } else if (observedAt) {
    const stale = isStale(observedAt);
    const age = element("span", `obs-badge ${stale ? "stale" : "age"}`, stale ? `Stale · ${formatRelative(observedAt)}` : `Observed ${formatRelative(observedAt)}`);
    age.title = `Observed ${formatDate(observedAt, true)}`;
    row.append(age);
  } else row.append(element("span", "obs-badge stale", "Observation age unavailable"));
  return row;
}

function stateCard(kind, title, description) {
  const card = element("div", `state-card ${kind || ""}`.trim());
  const icons = { error: "△", empty: "◇", stale: "◷", offline: "⊘", loading: "◌" };
  card.append(element("span", "state-icon", icons[kind] || "◇"), element("h3", null, title), element("p", null, description));
  return card;
}

function renderEndpointState(container, endpoint, emptyCopy) {
  const error = state.observatoryErrors.get(endpoint);
  if (error) {
    container.replaceChildren(stateCard("error", `${safeLabel(endpoint)} telemetry unavailable`, error.status === 404 ? "This observatory capability is unsupported by the connected server." : safeLabel(error.message, "The endpoint could not be reached.")));
    return true;
  }
  const payload = state.observatory[endpoint];
  if (payload === null) {
    container.replaceChildren(stateCard("loading", "Loading observatory telemetry", "Waiting for the first authenticated response."));
    return true;
  }
  if (emptyCopy && listFrom(payload, emptyCopy.keys).length === 0) {
    container.replaceChildren(stateCard("empty", emptyCopy.title, emptyCopy.description));
    return true;
  }
  return false;
}

function renderObservatoryOverview() {
  const metrics = byId("observatory-summary-metrics");
  metrics.replaceChildren();
  const data = state.observatory.overview;
  const quotas = listFrom(state.observatory.quotas, ["quotas", "quotaWindows", "windows"]);
  const identities = listFrom(state.observatory.identities, ["identities", "credentials"]);
  if (!data && state.observatoryErrors.has("overview")) {
    metrics.append(metricCard("Broker quotas", "Unavailable", "Overview endpoint unavailable", PALETTE[6], "stale"));
  } else {
    const totals = data?.totals || data?.summary || data || {};
    const identityTotal = numericOrNull(totals.identityCount ?? totals.identities) ?? (state.observatory.identities ? identities.length : null);
    const warningQuotas = numericOrNull(totals.warningQuotas ?? totals.warningQuotasCount) ?? (state.observatory.quotas ? quotas.filter((item) => ["warning", "critical", "exhausted"].includes(String(item.status))).length : null);
    const latestObservedAt = quotas.map(observedAtOf).filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0];

    let providerBreakdown = "Observed provider identities";
    if (identities.length) {
      const counts = new Map();
      for (const id of identities) {
        const p = id.provider === "openai-codex" ? "OpenAI" : id.provider === "google-antigravity" ? "Antigravity" : safeLabel(id.provider, "Provider");
        counts.set(p, (counts.get(p) || 0) + 1);
      }
      providerBreakdown = [...counts.entries()].map(([p, count]) => `${count} ${p}`).join(" + ");
    }

    const lastSyncCard = metricCard("Last quota sync", latestObservedAt ? formatRelative(latestObservedAt) : "Unavailable", latestObservedAt ? formatDate(latestObservedAt, true) : "Waiting for broker usage", PALETTE[5]);
    if (latestObservedAt) {
      lastSyncCard.title = `Last observed at ${formatDate(latestObservedAt, true)}`;
    }

    metrics.append(
      metricCard("Quota accounts", valueOrUnavailable(identityTotal, formatNumber), identityTotal === null ? "Identity endpoint unavailable" : providerBreakdown, PALETTE[0]),
      metricCard("Quota windows", state.observatory.quotas ? formatNumber(quotas.length) : "Unavailable", "Broker usage refreshed every minute", PALETTE[4]),
      metricCard("Quota alerts", state.observatory.quotas ? formatNumber(warningQuotas) : "Unavailable", state.observatory.quotas ? "Warning, critical, or exhausted" : "Quota endpoint unavailable", warningQuotas ? PALETTE[6] : PALETTE[5]),
      lastSyncCard,
    );
  }
  renderProviderAccountOverview();
}

function renderProviderAccountOverview() {
  const container = byId("overview-provider-accounts");
  if (!container) return;
  if (state.observatoryErrors.has("overview") || (state.observatoryErrors.has("identities") && state.observatoryErrors.has("quotas"))) {
    const error = state.observatoryErrors.get("overview") || state.observatoryErrors.get("quotas");
    container.replaceChildren(stateCard("error", "Broker quota accounts unavailable", error?.status === 404 ? "Observatory is disabled or unsupported by the server." : safeLabel(error?.message, "The endpoint could not be reached.")));
    return;
  }
  const identities = listFrom(state.observatory.identities, ["identities", "credentials"]);
  const quotas = listFrom(state.observatory.quotas, ["quotas", "quotaWindows", "windows"]);
  if (!state.observatory.identities && !state.observatory.quotas) {
    container.replaceChildren(stateCard("loading", "Loading broker quota accounts", "Waiting for the authenticated OMP usage response."));
    return;
  }
  if (!identities.length && !quotas.length) {
    container.replaceChildren(stateCard("empty", "No broker quotas available", "OMP reported no usable OpenAI or Antigravity quota windows."));
    return;
  }
  container.replaceChildren();
  const severity = { ok: 0, warning: 1, critical: 2, exhausted: 3 };
  const identitiesById = new Map(identities.map((id) => [id.identityId, id]));
  const allIdentityIds = new Set([
    ...identities.map((i) => i.identityId),
    ...quotas.map((q) => q.identityId).filter(Boolean),
  ]);

  for (const identityId of allIdentityIds) {
    const identity = identitiesById.get(identityId);
    const windows = quotas.filter((quota) => quota.identityId === identityId);
    const worst = [...windows].sort((a, b) => (severity[quotaStatus(b)] || 0) - (severity[quotaStatus(a)] || 0) || finite(b.usedFraction) - finite(a.usedFraction))[0];
    const status = worst ? quotaStatus(worst) : identity?.health || "unknown";
    const observedAt = observedAtOf(worst || identity);
    const card = element("article", `provider-account-card ${statusClass(status)}${isStale(observedAt) ? " stale" : ""}`);
    const heading = element("div", "entity-heading");
    const copy = element("div");
    const provider = identity?.provider || worst?.provider || "unknown";
    const providerName = provider === "openai-codex" ? "OpenAI Codex / ChatGPT" : provider === "google-antigravity" ? "Google Antigravity" : safeLabel(provider, "Provider");
    const safeIdentityLabel = identity?.label ? safeLabel(identity.label) : maskedIdentifier(identityId, "Quota account");
    copy.append(element("h3", null, safeIdentityLabel), element("p", null, providerName));
    const badgesBox = element("div", "entity-badges");
    const resetCredits = Number(
      (identity && typeof identity.resetCredits === "number") ? identity.resetCredits
        : (windows.find((w) => typeof w.resetCredits === "number" && w.resetCredits > 0)?.resetCredits ?? 0)
    );
    if (resetCredits > 0) {
      const creditsBadge = element("span", "obs-badge info reset-credits-badge", `⚡ ${formatNumber(resetCredits)} reset credits`);
      creditsBadge.title = `${formatNumber(resetCredits)} on-demand reset credits available`;
      badgesBox.append(creditsBadge);
    }
    badgesBox.append(statusBadge(status, "unknown"));
    heading.append(copy, badgesBox);

    const used = numericOrNull(worst?.usedFraction);
    const meter = element("div", "quota-meter");
    const meterCopy = element("div", "quota-meter-copy");
    const windowName = worst ? safeLabel(worst.resetLabel || worst.windowLabel || worst.meter || worst.model || worst.windowId, "highest window") : "No window";
    meterCopy.append(
      element("strong", null, used === null ? "Unavailable" : `${Math.round(used * 100)}%`),
      element("span", null, windowName),
    );
    const track = element("div", "quota-track");
    const fill = element("i", "quota-fill");
    fill.style.width = used === null ? "0%" : `${Math.min(100, Math.max(0, used * 100))}%`;
    track.append(fill);
    meter.append(meterCopy, track);

    const stats = element("div", "entity-stats");
    const windowCount = element("div", "entity-stat");
    windowCount.append(element("span", null, "Tracked windows"), element("strong", null, formatNumber(windows.length)));

    const remainingStat = element("div", "entity-stat");
    let remText = "Unavailable";
    if (worst && Number.isFinite(Number(worst.remainingFraction))) {
      remText = `${Math.round(Number(worst.remainingFraction) * 100)}%`;
    } else if (worst && worst.remainingUnits !== null && worst.remainingUnits !== undefined) {
      remText = `${formatCompact(worst.remainingUnits)} ${safeLabel(worst.unit || "units")}`;
    } else if (used !== null) {
      remText = `${Math.max(0, Math.round((1 - used) * 100))}%`;
    }
    remainingStat.append(element("span", null, "Remaining"), element("strong", null, remText));

    const reset = element("div", "entity-stat");
    const resetEl = element("strong", null, worst ? resetCopy(worst, used) : "Unavailable");
    if (worst?.resetsAt) {
      resetEl.title = formatDate(worst.resetsAt, true);
    }
    reset.append(element("span", null, "Next reset"), resetEl);
    stats.append(windowCount, remainingStat, reset);

    card.append(heading, meter, stats, metadataBadges(worst || identity, "Observatory broker", providerName));
    container.append(card);
  }
}

function quotaStatus(item) {
  const used = Number(item?.usedFraction);
  if (String(item?.status).toLowerCase() === "exhausted" || (Number.isFinite(used) && used >= 1)) return "exhausted";
  if (String(item?.status).toLowerCase() === "critical" || (Number.isFinite(used) && used >= .95)) return "critical";
  if (String(item?.status).toLowerCase() === "warning" || (Number.isFinite(used) && used >= .8)) return "warning";
  return item?.status || "ok";
}

function renderQuotaSummary(items) {
  const container = byId("quotas-summary-metrics"); container.replaceChildren();
  const available = state.observatory.quotas !== null && !state.observatoryErrors.has("quotas");
  const value = (number) => available ? formatNumber(number) : "Unavailable";
  container.append(
    metricCard("Tracked windows", value(items.length), available ? "Current provider quota windows" : "Quota endpoint unavailable", PALETTE[0]),
    metricCard("Normal", value(items.filter((item) => quotaStatus(item) === "ok").length), available ? "Below warning threshold" : "Quota endpoint unavailable", PALETTE[5]),
    metricCard("Warning", value(items.filter((item) => quotaStatus(item) === "warning").length), available ? "80–95% utilized" : "Quota endpoint unavailable", PALETTE[6]),
    metricCard("Critical", value(items.filter((item) => ["critical", "exhausted"].includes(quotaStatus(item))).length), available ? "At risk or exhausted" : "Quota endpoint unavailable", PALETTE[3]),
  );
}

function windowPeriodMinutes(item) {
  if (item.windowDurationMs && Number.isFinite(item.windowDurationMs) && item.windowDurationMs > 0) {
    return Math.round(item.windowDurationMs / 60_000);
  }
  const wid = String(item.windowId || "").toLowerCase();
  if (wid === "5h" || wid.includes("5h")) return 300;
  if (wid === "7d" || wid === "weekly") return 10_080;
  if (wid === "daily") return 1_440;
  return 0;
}
function humanPeriod(minutes) {
  const m = Math.max(1, Math.round(minutes));
  if (m < 90) return `${m}m`;
  if (m < 2_880) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1_440)}d`;
}
function resetCopy(item, usedFraction) {
  if (!item || !item.resetsAt) {
    return item && item.resetLabel ? safeLabel(item.resetLabel) : "No scheduled reset";
  }
  const target = Date.parse(item.resetsAt);
  if (!Number.isFinite(target)) return "Reset unavailable";
  const diffMs = target - Date.now();
  const used = usedFraction ?? numericOrNull(item.usedFraction) ?? 0;
  if (diffMs <= 0) {
    const overdueMin = Math.max(1, Math.round(Math.abs(diffMs) / 60_000));
    if (used >= 0.98) {
      return `Overdue ${humanPeriod(overdueMin)} · reset pending`;
    }
    return `Rolled ${humanPeriod(overdueMin)} ago`;
  }
  if (diffMs < 60_000) return "Resets any moment";
  return `Resets in ${humanPeriod(diffMs / 60_000)}`;
}

function createQuotaRow(item, rowLabel, options = {}) {
  const status = quotaStatus(item);
  const row = element("div", `quota-row ${options.primary ? "quota-row-primary " : ""}${options.compact ? "quota-row-compact " : ""}${statusClass(status)}`);
  const header = element("div", "quota-row-header");
  const labelEl = element("span", "quota-row-label", rowLabel);
  const used = numericOrNull(item.usedFraction);
  const usageEl = element("span", "quota-row-usage");
  usageEl.append(
    element("strong", null, used === null ? "Unavailable" : `${Math.round(used * 100)}%`),
    element("span", null, used === null ? "" : " utilized")
  );
  header.append(labelEl, usageEl);

  const track = element("div", "quota-track");
  const fill = element("i", "quota-fill");
  fill.style.width = used === null ? "0%" : `${Math.min(100, Math.max(0, used * 100))}%`;
  track.append(fill);

  const meta = element("div", "quota-row-meta");
  let remDisplay = "Unavailable";
  const unit = String(item.unit || "").toLowerCase();
  if (Number.isFinite(Number(item.remainingFraction))) {
    const remPct = `${Math.round(Number(item.remainingFraction) * 100)}%`;
    if (unit === "percent") {
      remDisplay = `${remPct} remaining`;
    } else if (item.remainingUnits !== null && item.remainingUnits !== undefined) {
      remDisplay = `${remPct} (${formatCompact(item.remainingUnits)} ${item.unit || "units"})`;
    } else {
      remDisplay = `${remPct} remaining`;
    }
  } else if (item.remainingUnits !== null && item.remainingUnits !== undefined && unit !== "percent") {
    remDisplay = `${formatCompact(item.remainingUnits)} ${item.unit || "units"}`;
  } else if (used !== null) {
    remDisplay = `${Math.max(0, Math.round((1 - used) * 100))}% remaining`;
  }
  const remSpan = element("span", "quota-row-remaining", remDisplay);

  const resetDisplay = resetCopy(item, used);
  const resetSpan = element("span", "quota-row-reset", resetDisplay);
  if (item.resetsAt) resetSpan.title = formatDate(item.resetsAt, true);

  meta.append(remSpan, resetSpan);
  row.append(header, track, meta);
  return row;
}

function renderQuotas() {
  const container = byId("quotas-container");
  const items = listFrom(state.observatory.quotas, ["quotas", "quotaWindows", "windows"]);
  const identities = listFrom(state.observatory.identities, ["identities", "credentials"]);
  const identitiesById = new Map(identities.map((id) => [id.identityId, id]));

  renderQuotaSummary(items);
  if (renderEndpointState(container, "quotas", {
    keys: ["quotas", "quotaWindows", "windows"],
    title: "No provider quota windows",
    description: "No provider has reported a quota observation yet. Values are intentionally unavailable rather than shown as zero.",
  })) return;

  const providerFilter = byId("quota-provider-filter").value;
  const statusFilter = byId("quota-status-filter").value;
  const severity = { ok: 0, warning: 1, critical: 2, exhausted: 3 };

  const allIdentityIds = new Set([
    ...identities.map((i) => i.identityId),
    ...items.map((q) => q.identityId).filter(Boolean),
  ]);
  if (items.some((q) => !q.identityId)) {
    allIdentityIds.add(null);
  }

  container.replaceChildren();
  let renderedCardCount = 0;

  for (const identityId of allIdentityIds) {
    const identity = identityId ? identitiesById.get(identityId) : null;
    const accountWindows = items.filter((q) => identityId ? q.identityId === identityId : !q.identityId);
    const provider = identity?.provider || accountWindows[0]?.provider || "unknown";
    const providerLower = String(provider).toLowerCase();

    // Provider filter
    if (providerFilter !== "all") {
      const matchesProvider = providerLower.includes(providerFilter) || accountWindows.some((w) => String(w.provider || "").toLowerCase().includes(providerFilter));
      if (!matchesProvider) continue;
    }

    const worst = [...accountWindows].sort((a, b) => (severity[quotaStatus(b)] || 0) - (severity[quotaStatus(a)] || 0) || finite(b.usedFraction) - finite(a.usedFraction))[0];
    const accountStatus = worst ? quotaStatus(worst) : identity?.health || "ok";

    // Status filter
    const matchingWindows = statusFilter === "all" ? accountWindows : accountWindows.filter((w) => quotaStatus(w) === statusFilter);
    if (statusFilter !== "all" && matchingWindows.length === 0 && accountStatus !== statusFilter) {
      continue;
    }

    const observedAt = observedAtOf(worst || identity);
    const card = element("article", `quota-card grouped-quota-card ${statusClass(accountStatus)}${isStale(observedAt) ? " stale" : ""}`);
    const heading = element("div", "entity-heading");
    const copy = element("div");

    const providerName = provider === "openai-codex" ? "OpenAI Codex" : provider === "google-antigravity" ? "Google Antigravity" : safeLabel(provider, "Provider");
    const safeIdentityLabel = identity?.label ? safeLabel(identity.label) : (identityId ? maskedIdentifier(identityId, "Identity") : "Global Quota Pool");

    const shortIdentity = String(safeIdentityLabel).split("(")[0].trim() || safeIdentityLabel;
    copy.append(
      element("h3", null, shortIdentity),
      element("p", null, `${providerName} · ${matchingWindows.length} tracked quota ${matchingWindows.length === 1 ? "window" : "windows"}`),
    );

    const badgesBox = element("div", "entity-badges");
    const resetCredits = Number(
      (identity && typeof identity.resetCredits === "number") ? identity.resetCredits
        : (accountWindows.find((w) => typeof w.resetCredits === "number" && w.resetCredits > 0)?.resetCredits ?? 0)
    );
    if (resetCredits > 0) {
      const creditsBadge = element("span", "obs-badge info reset-credits-badge", `⚡ ${formatNumber(resetCredits)} reset credits`);
      creditsBadge.title = `${formatNumber(resetCredits)} on-demand reset credits available`;
      badgesBox.append(creditsBadge);
    }
    badgesBox.append(statusBadge(accountStatus, "unknown"));
    heading.append(copy, badgesBox);

    const rowsContainer = element("div", "quota-rows-container");

    const isCodex = provider === "openai-codex" || providerLower.includes("codex") || providerLower.includes("openai");
    const isAntigravity = provider === "google-antigravity" || providerLower.includes("antigravity");

    const windowSuffix = (w) => {
      const wid = String(w.windowId || "").toLowerCase();
      const short = { "5h": "5h", "7d": "7d", daily: "Daily", weekly: "Weekly" }[wid];
      if (short) return short;
      return safeLabel(w.resetLabel || w.windowLabel || wid, "window");
    };
    const bucketTier = (bucket) => {
      if (bucket === "openai-codex:primary") return "Codex";
      if (String(bucket || "").includes(":spark:primary")) return "Spark";
      if (String(bucket || "").includes(":spark:secondary")) return "Spark";
      return "";
    };
    const FAMILY_NAMES = { google: "Gemini", anthropic: "Claude", openai: "GPT" };

    if (isCodex) {
      const bucketOrder = ["openai-codex:primary", "openai-codex:spark:primary", "openai-codex:spark:secondary"];
      const codexRows = [...matchingWindows].sort((a, b) => {
        const ai = bucketOrder.indexOf(String(a.bucketId || ""));
        const bi = bucketOrder.indexOf(String(b.bucketId || ""));
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
      const primaryCodex = codexRows.find((w) => String(w.bucketId || "") === "openai-codex:primary");
      const otherCodex = codexRows.filter((w) => w !== primaryCodex);
      if (primaryCodex) {
        rowsContainer.append(createQuotaRow(primaryCodex, "Codex \u00b7 7d", { primary: true }));
      }
      for (const w of otherCodex) {
        const tier = bucketTier(w.bucketId);
        const isSparkSecondary = String(w.bucketId || "").includes(":spark:secondary");
        const usedValue = numericOrNull(w.usedFraction) ?? 0;
        // The duplicate Spark 7d row is shown only when it carries real usage.
        if (isSparkSecondary && usedValue <= 0) continue;
        rowsContainer.append(createQuotaRow(w, `${tier} \u00b7 ${windowSuffix(w)}`, { compact: true }));
      }
    } else if (isAntigravity) {
      const families = new Map();
      for (const w of matchingWindows) {
        let familyName = "Default";
        if (w.meter && !["default", "window", "daily", "weekly"].includes(w.meter.toLowerCase())) {
          familyName = w.meter;
        } else if (w.bucketId) {
          const parts = w.bucketId.split(":");
          if (parts.length >= 2 && !["google-antigravity", "daily", "weekly", "default"].includes(parts[1])) {
            familyName = parts[1];
          }
        } else if (w.model) {
          familyName = w.model;
        } else {
          const match = /\(([^)]+)\)/.exec(w.resetLabel || w.windowLabel || "");
          if (match) familyName = match[1];
        }

        const familyKey = familyName.toLowerCase();
        if (!families.has(familyKey)) {
          families.set(familyKey, {
            daily: null,
            weekly: null,
            others: [],
            display: FAMILY_NAMES[familyKey] || (familyName.charAt(0).toUpperCase() + familyName.slice(1)),
          });
        }

        const fam = families.get(familyKey);
        const wid = String(w.windowId || "").toLowerCase();
        const dur = w.windowDurationMs;
        const label = String(w.resetLabel || w.windowLabel || "").toLowerCase();

        if (!fam.daily && (wid === "daily" || dur === 86_400_000 || wid.includes("daily") || label.includes("daily"))) {
          fam.daily = w;
        } else if (!fam.weekly && (wid === "weekly" || wid === "7d" || dur === 604_800_000 || wid.includes("weekly") || wid.includes("7d") || label.includes("weekly") || label.includes("7 day") || label.includes("7-day"))) {
          fam.weekly = w;
        } else {
          fam.others.push(w);
        }
      }

      for (const famData of families.values()) {
        const display = famData.display;
        if (famData.weekly) {
          rowsContainer.append(createQuotaRow(famData.weekly, `${display} \u00b7 Weekly`, { primary: true }));
        }
        if (famData.daily) {
          rowsContainer.append(createQuotaRow(famData.daily, `${display} \u00b7 Daily`, { compact: true }));
        }
        for (const other of famData.others) {
          rowsContainer.append(createQuotaRow(other, `${display} \u00b7 ${windowSuffix(other)}`, { compact: true }));
        }
      }
    } else {
      for (const w of matchingWindows) {
        rowsContainer.append(createQuotaRow(w, safeLabel(w.resetLabel || w.windowLabel || w.meter || w.model || w.windowId, "Quota window")));
      }
    }

    if (!rowsContainer.children.length) {
      rowsContainer.append(element("p", "muted", "No quota windows match the current filter."));
    }

    card.append(heading, rowsContainer, metadataBadges(worst || identity, "Observatory broker", providerName));
    container.append(card);
    renderedCardCount += 1;
  }

  if (renderedCardCount === 0) {
    container.append(stateCard("empty", "No matching quota windows", "Adjust the provider or status filter to inspect other windows."));
  }
}
function renderCredentials() {
  const container = byId("credentials-container");
  const items = listFrom(state.observatory.identities, ["identities", "credentials"]);
  const metrics = byId("credentials-summary-metrics");
  const available = state.observatory.identities !== null && !state.observatoryErrors.has("identities");
  const value = (number) => available ? formatNumber(number) : "Unavailable";
  metrics.replaceChildren(
    metricCard("Identities", value(items.length), available ? "Observed provider credentials" : "Identity endpoint unavailable", PALETTE[0]),
    metricCard("Healthy", value(items.filter((item) => item.health === "healthy").length), available ? "Last provider check successful" : "Identity endpoint unavailable", PALETTE[5]),
    metricCard("Degraded", value(items.filter((item) => ["degraded", "rate_limited"].includes(item.health)).length), available ? "Degraded or rate limited" : "Identity endpoint unavailable", PALETTE[6]),
    metricCard("Unhealthy", value(items.filter((item) => ["unhealthy", "exhausted"].includes(item.health)).length), available ? "Needs intervention" : "Identity endpoint unavailable", PALETTE[3]),
  );
  if (renderEndpointState(container, "identities", { keys: ["identities", "credentials"], title: "No provider identities", description: "No credential metadata has been observed. Secret values are never displayed here." })) return;
  const filter = byId("credential-health-filter").value;
  const filtered = items.filter((item) => filter === "all" || item.health === filter);
  container.replaceChildren();
  if (!filtered.length) { container.append(stateCard("empty", "No matching credentials", "Change the health filter to inspect other identities.")); return; }
  for (const item of filtered) {
    const observedAt = observedAtOf(item);
    const card = element("article", `identity-card ${statusClass(item.health)}${isStale(observedAt) ? " stale" : ""}`);
    const heading = element("div", "entity-heading");
    const identity = element("div");
    identity.append(element("h3", null, safeLabel(item.label, "Provider identity")), element("p", "identity-safe-id", `${safeLabel(item.kind, "Provider")} · ${maskedIdentifier(item.identityId, "Credential")}`));
    heading.append(identity, statusBadge(item.health, "unknown"));
    const stats = element("div", "entity-stats");
    const model = element("div", "entity-stat"); model.append(element("span", null, "Active model"), element("strong", null, valueOrUnavailable(item.activeModel)));
    const failures = element("div", "entity-stat"); failures.append(element("span", null, "Consecutive failures"), element("strong", null, item.consecutiveFailures === null || item.consecutiveFailures === undefined ? "Unavailable" : formatNumber(item.consecutiveFailures)));
    stats.append(model, failures);
    const message = item.statusMessage ? element("p", "muted", `${safeLabel(item.health, "Unknown").replaceAll("_", " ")} provider state reported.`) : null;
    card.append(heading, stats);
    if (message) card.append(message);
    card.append(metadataBadges(item, "Credential collector", safeLabel(item.kind, "provider")));
    container.append(card);
  }
}

function policyRules() {
  return listFrom(state.observatory.policies, ["policies", "rules"])
    .filter((rule) => !/^(host|session):/.test(String(rule.target || "")));
}

function defaultPolicy() {
  return {
    target: "global", enabled: true, silenced: false, telegramImmediate: true, dashboardOnly: false,
    minSeverity: "warning", thresholds: { warningRemainingFraction: .2, criticalRemainingFraction: .1, exhaustedRemainingFraction: .02, hysteresisFraction: .02 },
    consecutiveFailuresThreshold: 3, cooldownMinutes: 15, throttleIntervalMs: 60_000, channels: ["default"],
    quietHoursEnabled: false, quietHoursTimezone: "UTC", quietHoursStart: null, quietHoursEnd: null, criticalBypassQuietHours: true,
    digestEnabled: false, digestIntervalMinutes: null, digestSchedule: null, digestTimezone: "UTC", recipient: null,
    matchEventTypes: [], matchHostIds: [], matchIdentityIds: [],
  };
}

function parsePolicyTargetClient(target) {
  const value = String(target || "global").trim();
  if (value === "global" || value === "*") return { scopeType: "global", scopeKey: "", target: "global" };
  const colon = value.indexOf(":");
  if (colon < 1) return { scopeType: "provider", scopeKey: value, target: `provider:${value}` };
  return { scopeType: value.slice(0, colon).toLowerCase(), scopeKey: value.slice(colon + 1), target: value };
}

function globalPolicy() {
  return policyRules().find((rule) => parsePolicyTargetClient(rule.target).scopeType === "global") || defaultPolicy();
}

function canonicalPolicyTarget(scopeType, scopeKey) {
  if (scopeType === "global") return "global";
  const key = String(scopeKey || "").trim().replace(new RegExp(`^${scopeType}:`, "i"), "");
  return key ? `${scopeType}:${key}` : "";
}

function resolvePolicy(target) {
  const base = { ...defaultPolicy(), ...globalPolicy(), thresholds: { ...defaultPolicy().thresholds, ...(globalPolicy().thresholds || {}) } };
  const requested = policyRules().find((rule) => rule.target === target);
  const resolved = { ...base, thresholds: { ...base.thresholds } };
  const overridden = new Set();
  if (requested && requested !== globalPolicy()) {
    for (const [key, value] of Object.entries(requested)) {
      if (value !== null && value !== undefined) { resolved[key] = key === "thresholds" ? { ...resolved.thresholds, ...value } : value; overridden.add(key); }
    }
  }
  return { resolved, overridden, requested };
}

function previewValue(key, value) {
  if (key === "warningUtilization") return `${Math.round((1 - Number(value)) * 100)}% used`;
  if (key === "criticalUtilization") return `${Math.round((1 - Number(value)) * 100)}% used`;
  if (Array.isArray(value)) return value.length ? value.map((item) => safeLabel(item)).join(", ") : "None";
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  return valueOrUnavailable(value);
}

function renderEffectivePreview(container, resolvedPolicy) {
  container.replaceChildren();
  const { resolved, overridden } = resolvedPolicy;
  const thresholdValues = resolved.thresholds || {};
  const fields = [
    ["minSeverity", "Minimum severity", resolved.minSeverity], ["silenced", "Notifications silenced", resolved.silenced], ["cooldownMinutes", "Cooldown minutes", resolved.cooldownMinutes],
    ["channels", "Delivery channels", resolved.channels], ["warningUtilization", "Warning threshold", thresholdValues.warningRemainingFraction], ["criticalUtilization", "Critical threshold", thresholdValues.criticalRemainingFraction],
    ["quietHoursTimezone", "Quiet hours timezone", resolved.quietHoursTimezone], ["criticalBypassQuietHours", "Critical bypass", resolved.criticalBypassQuietHours],
  ];
  for (const [key, label, rawValue] of fields) {
    const row = element("div", "effective-row");
    row.append(element("span", null, label));
    const provenanceKey = key.endsWith("Utilization") ? "thresholds" : key;
    const value = element("strong", null, previewValue(key, rawValue));
    value.append(element("small", `inheritance-mark${overridden.has(provenanceKey) ? " override" : ""}`, overridden.has(provenanceKey) ? "override" : "inherited"));
    row.append(value); container.append(row);
  }
}

function policyTargetLabel(target) {
  const parsed = parsePolicyTargetClient(target);
  if (parsed.scopeType === "global") return "Global policy";
  if (["provider", "event"].includes(parsed.scopeType)) return `${safeLabel(parsed.scopeType)} · ${safeLabel(parsed.scopeKey).replaceAll("_", " ")}`;
  return `${safeLabel(parsed.scopeType)} · ${maskedIdentifier(parsed.scopeKey, "Target")}`;
}

function renderPolicies() {
  const container = byId("policies-list");
  const rules = policyRules();
  if (renderEndpointState(container, "policies", { keys: ["policies", "rules"], title: "No notification policies", description: "No server policy rules are configured. Create a global policy to establish defaults." })) {
    renderEffectivePreview(byId("effective-policy-preview"), resolvePolicy(byId("policy-preview-scope").value));
    return;
  }
  container.replaceChildren();
  for (const rule of rules) {
    const card = element("article", "policy-card");
    const copy = element("div");
    const parsedTarget = parsePolicyTargetClient(rule.target);
    copy.append(element("h3", null, policyTargetLabel(rule.target)), element("p", null, `${safeLabel(parsedTarget.scopeType, "global")} scope · ${safeLabel(rule.minSeverity, "warning")}+ · ${Array.isArray(rule.channels) && rule.channels.length ? rule.channels.map((item) => safeLabel(item)).join(", ") : "inherited channels"}`));
    copy.append(metadataBadges(rule, "Policy engine", safeLabel(parsedTarget.scopeType, "global")));
    const actions = element("div", "policy-card-actions");
    const edit = element("button", "trace-button", "Edit"); edit.type = "button"; edit.addEventListener("click", () => openPolicyDialog(rule)); actions.append(edit);
    card.append(copy, actions); container.append(card);
  }
  renderEffectivePreview(byId("effective-policy-preview"), resolvePolicy(byId("policy-preview-scope").value));
}

function eventPayload() {
  return state.observatory.events || {};
}

function eventPresentation(item) {
  const type = safeLabel(item?.eventType, "observatory_event").toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const labels = {
    quota_warning: "Quota warning", quota_critical: "Quota critical", quota_exhausted: "Quota exhausted", quota_reset: "Quota reset confirmed",
    reset_credit_increased: "Reset credit increased", reset_credit_decreased: "Reset credit decreased", provider_degraded: "Provider degraded",
    provider_down: "Provider unavailable", provider_recovered: "Provider recovered", credential_blocked: "Credential blocked",
    credential_disabled: "Credential disabled", credential_cooldown: "Credential cooling down", credential_recovered: "Credential recovered",
    collector_failure: "Collector failure", collector_recovered: "Collector recovered", host_offline: "Fleet host offline", host_recovered: "Fleet host recovered",
    agentrouter_large_balance_drop: "AgentRouter balance drop", agentrouter_balance_low: "AgentRouter balance low", agentrouter_grant_received: "AgentRouter grant received",
    agentrouter_challenge_required: "AgentRouter challenge required", agentrouter_login_required: "AgentRouter login required", agentrouter_login_failed: "AgentRouter login failed",
    agentrouter_endpoint_failed: "AgentRouter endpoint failed", session_context_warning: "Session context warning", session_context_critical: "Session context critical",
    session_failed: "Session failed", session_started: "Session started", session_closed: "Session closed", digest_ready: "Notification digest ready",
    policy_changed: "Notification policy changed", import_completed: "Import completed",
  };
  const context = [];
  if (item?.provider) context.push(safeLabel(item.provider));
  if (item?.meter) context.push(safeLabel(item.meter));
  else if (item?.model) context.push(safeLabel(item.model));
  if (item?.windowId) context.push(maskedIdentifier(item.windowId, "Window"));
  else if (item?.sessionId) {
    context.push(maskedIdentifier(item.sessionId, "Session"));
    if (item?.hostId) context.push(maskedIdentifier(item.hostId, "Host"));
  }
  else if (item?.hostId) context.push(maskedIdentifier(item.hostId, "Host"));
  else if (item?.identityId) context.push(maskedIdentifier(item.identityId, "Identity"));
  return { type, title: labels[type] || "Observatory state changed", detail: context.length ? context.join(" · ") : "Public event details unavailable" };
}

function renderEvents() {
  const events = listFrom(eventPayload(), ["events"]);
  const body = byId("events-body");
  body.replaceChildren();
  const filter = byId("event-severity-filter").value;
  const filtered = events.filter((item) => filter === "all" || item.severity === filter);
  for (const item of filtered) {
    const row = element("tr");
    const presentation = eventPresentation(item);
    const severity = element("td"); severity.append(statusBadge(item.severity, "info"));
    const source = element("td", "meta-cell"); source.append(metadataBadges(item, "Observatory event bus", item.hostId ? "Host" : "Fleet"));
    const message = element("td", "wrap-cell"); message.append(element("strong", null, presentation.title), element("div", "muted", presentation.detail));
    row.append(element("td", null, valueOrUnavailable(item.occurredAt, (value) => formatDate(value, true))), severity, element("td", null, presentation.type.replaceAll("_", " ")), source, message, element("td", "identity-safe-id", maskedIdentifier(item.eventId || item.fingerprint, "Event")));
    body.append(row);
  }
  if (!filtered.length) { const row = element("tr"); const cell = element("td", "muted", state.observatoryErrors.has("events") ? "Event telemetry is unavailable or unsupported." : "No matching observatory events."); cell.colSpan = 6; row.append(cell); body.append(row); }

  const auditBody = byId("audit-body"); auditBody.replaceChildren();
  const audit = listFrom(eventPayload(), ["audit", "auditEntries"]);
  for (const item of audit) {
    const detailCount = Object.keys(item.details || {}).length;
    const details = element("td", "meta-cell", detailCount ? `${formatNumber(detailCount)} protected detail field${detailCount === 1 ? "" : "s"}` : "No public details");
    const row = element("tr");
    auditBody.append(row);
    const actor = /^(system|dashboard_owner|collector|scheduler)$/i.test(String(item.actor || "")) ? safeLabel(item.actor, "System") : maskedIdentifier(item.actor, "Actor");
    row.append(element("td", null, valueOrUnavailable(item.occurredAt, (value) => formatDate(value, true))), element("td", null, actor), element("td", null, safeLabel(item.action, "Observed").replaceAll("_", " ")), element("td", null, safeLabel(item.targetType, "Unknown")), element("td", "identity-safe-id", maskedIdentifier(item.targetId, "Target")), details);
  }
  if (!audit.length) { const row = element("tr"); const cell = element("td", "muted", "No audit entries are available for this observation window."); cell.colSpan = 6; row.append(cell); auditBody.append(row); }

  const deliveries = listFrom(state.observatory.policies, ["deliveries", "notificationDeliveries"]);
  const deliveryBody = byId("deliveries-body"); deliveryBody.replaceChildren();
  for (const item of deliveries) {
    const status = element("td"); status.append(statusBadge(item.status));
    const row = element("tr");
    deliveryBody.append(row);
    const deliveryDetail = item.errorCategory ? safeLabel(item.errorCategory, "Delivery failed").replaceAll("_", " ") : item.status === "sent" ? "Delivered" : "No public details";
    row.append(element("td", "identity-safe-id", maskedIdentifier(item.eventId, "Event")), element("td", null, safeLabel(item.channel, "Unknown")), status, element("td", null, valueOrUnavailable(item.attemptCount, formatNumber)), element("td", null, valueOrUnavailable(item.sentAt || item.lastAttemptAt, (value) => formatDate(value, true))), element("td", "wrap-cell", deliveryDetail));
  }
  if (!deliveries.length) { const row = element("tr"); const cell = element("td", "muted", "No notification delivery records are available."); cell.colSpan = 6; row.append(cell); deliveryBody.append(row); }
}

function renderHealthView() {
  const payload = state.observatory.health;
  const summary = byId("health-summary-metrics");
  const data = payload?.health || payload || {};
  const generatedAt = data.generatedAt || data.observedAt;
  summary.replaceChildren(
    metricCard("Overall status", state.observatoryErrors.has("health") ? "Unavailable" : safeLabel(data.status, "Unknown"), state.observatoryErrors.has("health") ? "Health endpoint unsupported" : generatedAt ? `Observed ${formatRelative(generatedAt)}` : "Observation age unavailable", data.status === "ok" || data.status === "healthy" ? PALETTE[5] : PALETTE[6]),
    metricCard("Uptime", data.uptimeSeconds === null || data.uptimeSeconds === undefined ? "Unavailable" : formatDuration(Number(data.uptimeSeconds) * 1000), "Server process uptime", PALETTE[4]),
    metricCard("SSE stream", state.sseSource && state.sseConnectedAt ? "Live" : "Fallback", state.sseLastMessageAt ? `Last event ${formatRelative(state.sseLastMessageAt)}` : "No stream event observed", PALETTE[0]),
    metricCard("Scheduler", data.schedulerActive === undefined ? "Unavailable" : data.schedulerActive ? "Active" : "Paused", "Automation coordinator", PALETTE[1]),
  );
  const services = byId("services-health-container"); services.replaceChildren();
  const serviceItems = listFrom(data, ["services", "components"]);
  const defaults = serviceItems.length ? serviceItems : [
    { name: "Observatory API", status: state.observatoryErrors.has("health") ? "unavailable" : data.status || "unknown", message: state.observatoryErrors.has("health") ? "Endpoint unavailable" : "Health endpoint response" },
    { name: "Event stream", status: state.sseSource && state.sseConnectedAt ? "online" : "degraded", message: state.sseSource ? "SSE reconnecting" : "Polling fallback active" },
    { name: "AgentRouter coordinator", status: state.coordinator?.running ? "active" : state.coordinator?.lastCycleError ? "degraded" : "online", message: state.coordinator?.running ? "Collection cycle running" : "Coordinator ready" },
  ];
  for (const item of defaults) {
    const row = element("div", "service-health-row"); const copy = element("div"); const serviceStatus = safeLabel(item.status, "unknown").replaceAll("_", " "); copy.append(element("strong", null, safeLabel(item.name || item.label, "Service")), element("p", null, `${serviceStatus} service state reported.`)); row.append(copy, statusBadge(item.status)); services.append(row);
  }
  const stream = byId("stream-telemetry-container"); stream.replaceChildren();
  for (const [label, value] of [["Connection mode", state.sseConnectedAt ? "Server-Sent Events" : "Bounded polling fallback"], ["Last event", state.sseLastMessageAt ? formatDate(state.sseLastMessageAt, true) : "Unavailable"], ["Reconnect attempt", formatNumber(state.sseRetryCount)], ["Last Event ID", state.sseLastEventId ? maskedIdentifier(state.sseLastEventId, "Event") : "Unavailable"]]) {
    const cell = element("div", "telemetry-cell"); cell.append(element("span", null, label), element("strong", null, value)); stream.append(cell);
  }
  const storage = byId("storage-telemetry-container"); storage.replaceChildren();
  const storageData = data.storage || data.database || {};
  const publicPairs = Object.entries(storageData).filter(([, value]) => typeof value === "number" || typeof value === "boolean").slice(0, 10);
  const pairs = publicPairs.length ? publicPairs : [["Retention state", "Unavailable"], ["Database status", "Unavailable"]];
  for (const [key, value] of pairs) { const cell = element("div", "telemetry-cell"); cell.append(element("span", null, safeLabel(key)), element("strong", null, valueOrUnavailable(value, String))); storage.append(cell); }
}

function renderAccountsRoster() {
  const container = byId("accounts-roster-cards"); container.replaceChildren();
  if (!state.accounts.length) { container.append(stateCard("empty", "No AgentRouter accounts", "Add an account to begin protected browser collection.")); return; }
  const historical = new Map(state.historicalAccounts.map((item) => [item.accountId, item]));
  for (const account of state.accounts) {
    const item = historical.get(account.id);
    const card = element("article", "account-roster-card");
    const heading = element("div", "entity-heading"); const copy = element("div"); copy.append(element("h3", null, safeLabel(account.label)), element("p", null, `GitHub · ${safeLabel(account.githubUsername)}`)); heading.append(copy, statusBadge(item?.lastStatus || (account.enabled ? "active" : "paused")));
    const stats = element("div", "entity-stats");
    const last = element("div", "entity-stat"); last.append(element("span", null, "Last check"), element("strong", null, item?.lastRunAt ? formatRelative(item.lastRunAt) : "No data"));
    const token = element("div", "entity-stat"); token.append(element("span", null, "API access"), element("strong", null, account.hasApiToken ? "Captured" : "Pending")); stats.append(last, token);
    const open = element("button", "button ghost", "Open account observatory"); open.type = "button"; open.addEventListener("click", () => selectAccount(account.id));
    card.append(heading, stats, open); container.append(card);
  }
}

function renderActiveView() {
  if (state.activeView === "overview") { renderObservatoryOverview(); renderOverview(); }
  else if (state.activeView === "quotas") renderQuotas();
  else if (state.activeView === "credentials") renderCredentials();
  else if (state.activeView === "accounts") renderAccountsRoster();
  else if (state.activeView === "notifications") { renderPolicies(); renderEvents(); }
  else if (state.activeView === "events") renderEvents();
  else if (state.activeView === "health") renderHealthView();
}

async function loadObservatory() {
  const entries = [
    ["overview", "/api/observatory/overview"], ["quotas", "/api/observatory/quotas"], ["identities", "/api/observatory/identities"],
    ["events", "/api/observatory/events"], ["policies", "/api/observatory/policies"], ["health", "/api/observatory/health"],
  ];
  const values = await Promise.all(entries.map(([name, path]) => optionalApi(name, path)));
  entries.forEach(([name], index) => {
    if (values[index] !== null) {
      state.observatory[name] = values[index];
      if (values[index]?.capabilities) {
        state.capabilities = { ...(state.capabilities || {}), ...values[index].capabilities };
      }
    }
  });
  renderActiveView();
}

function updateSseStatus(mode) {
  const chip = byId("sse-state");
  const labels = { live: "Live stream", connecting: "Connecting", reconnecting: "Reconnecting", polling: "Polling fallback", offline: "Offline" };
  chip.className = `status-chip ${mode === "live" ? "ok" : mode === "reconnecting" ? "warning" : mode === "offline" ? "error" : "neutral"}`;
  chip.replaceChildren(element("i"), element("span", null, labels[mode] || "Stream unavailable"));
}

function parseStreamData(event) {
  if (typeof event.data !== "string" || event.data.length > 65_536) return null;
  try { const data = JSON.parse(event.data); return data && typeof data === "object" && !Array.isArray(data) ? data : null; } catch { return null; }
}

const OBSERVATORY_EVENT_TYPES = [
  "quota_warning", "quota_critical", "quota_exhausted", "quota_reset", "reset_credit_increased", "reset_credit_decreased",
  "provider_degraded", "provider_down", "provider_recovered", "credential_blocked", "credential_disabled", "credential_cooldown", "credential_recovered",
  "collector_failure", "collector_recovered", "host_offline", "host_recovered", "agentrouter_large_balance_drop", "agentrouter_balance_low",
  "agentrouter_grant_received", "agentrouter_challenge_required", "agentrouter_login_required", "agentrouter_login_failed", "agentrouter_endpoint_failed",
  "session_context_warning", "session_context_critical", "session_failed", "session_started", "session_closed", "digest_ready", "policy_changed", "import_completed",
];

function eventRefreshFamilies(type) {
  if (/^quota_|^reset_credit_/.test(type)) return ["overview", "quotas", "events"];
  if (/^provider_|^credential_/.test(type)) return ["overview", "identities", "events"];
  if (/^collector_|^host_/.test(type)) return ["overview", "health", "events"];
  if (/^session_/.test(type)) return ["overview", "events"];
  if (/^agentrouter_/.test(type)) return ["overview", "events"];
  if (/policy|digest/.test(type)) return ["policies", "events"];
  return ["overview", "quotas", "identities", "events", "policies", "health"];
}

async function refreshObservatoryFamilies(families) {
  const endpoints = { overview: "/api/observatory/overview", quotas: "/api/observatory/quotas", identities: "/api/observatory/identities", events: "/api/observatory/events", policies: "/api/observatory/policies", health: "/api/observatory/health" };
  const names = [...new Set(families)].filter((name) => endpoints[name]);
  const values = await Promise.all(names.map((name) => optionalApi(name, endpoints[name])));
  names.forEach((name, index) => {
    if (values[index] !== null) {
      state.observatory[name] = values[index];
      if (values[index]?.capabilities) {
        state.capabilities = { ...(state.capabilities || {}), ...values[index].capabilities };
      }
    }
  });
  renderActiveView();
}

function scheduleObservatoryRefresh(families = Object.keys(state.observatory), delay = 30_000) {
  for (const family of families) state.pendingRefreshFamilies.add(family);
  clearTimeout(state.fallbackTimer);
  state.fallbackTimer = setTimeout(async () => {
    if (state.fallbackInFlight) { scheduleObservatoryRefresh([], 1_000); return; }
    const pending = state.pendingRefreshFamilies.size ? [...state.pendingRefreshFamilies] : Object.keys(state.observatory);
    state.pendingRefreshFamilies.clear(); state.fallbackInFlight = true;
    try { await refreshObservatoryFamilies(pending); }
    finally { state.fallbackInFlight = false; scheduleObservatoryRefresh([], 30_000); }
  }, Math.max(0, Math.min(delay, 30_000)));
}

function handleStreamEvent(event) {
  const data = parseStreamData(event);
  if (!data) return;
  if (event.lastEventId) state.sseLastEventId = event.lastEventId;
  else if (typeof data.eventId === "string") state.sseLastEventId = data.eventId;
  state.sseLastMessageAt = new Date().toISOString();
  const type = safeLabel(data.eventType || data.type || event.type, "observatory_event").toLowerCase().replaceAll("-", "_");
  scheduleObservatoryRefresh(eventRefreshFamilies(type), 250);
  if (state.activeView === "health") renderHealthView();
}

function scheduleSseReconnect() {
  clearTimeout(state.sseRetryTimer); state.sseRetryCount += 1;
  state.sseRetryTimer = setTimeout(connectObservatoryStream, Math.min(30_000, 1_000 * (2 ** Math.min(state.sseRetryCount, 5))));
}

function connectObservatoryStream() {
  clearTimeout(state.sseRetryTimer);
  if (state.sseSource) state.sseSource.close();
  state.sseSource = null;
  if (typeof EventSource === "undefined") { updateSseStatus("polling"); scheduleObservatoryRefresh([], 0); return; }
  updateSseStatus(state.sseRetryCount ? "reconnecting" : "connecting");
  const url = dashboardUrl("api/observatory/stream");
  if (state.sseLastEventId) url.searchParams.set("lastEventId", state.sseLastEventId);
  const source = new EventSource(url.toString(), { withCredentials: true }); state.sseSource = source;
  source.onopen = () => { if (state.sseSource !== source) return; state.sseConnectedAt = new Date().toISOString(); state.sseRetryCount = 0; updateSseStatus("live"); scheduleObservatoryRefresh([], 30_000); };
  source.onmessage = handleStreamEvent;
  for (const type of [...OBSERVATORY_EVENT_TYPES, "confirmed_reset", "confirmed-reset"]) source.addEventListener(type, handleStreamEvent);
  source.onerror = () => { if (state.sseSource !== source) return; source.close(); state.sseSource = null; state.sseConnectedAt = null; updateSseStatus("reconnecting"); scheduleObservatoryRefresh([], 0); scheduleSseReconnect(); };
}


let liveTickerTimer = null;
let liveTickerInFlight = false;

function updateLiveCountdowns() {
  document.querySelectorAll("[data-countdown-to]").forEach((node) => {
    const targetIso = node.getAttribute("data-countdown-to");
    if (!targetIso) return;
    const target = Date.parse(targetIso);
    if (!Number.isFinite(target)) return;
    const diffMs = target - Date.now();
    if (diffMs <= 0) {
      node.textContent = "due now";
      return;
    }
    const totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 24) {
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      node.textContent = `${days}d ${remHours}h`;
    } else if (hours > 0) {
      node.textContent = `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
    } else {
      node.textContent = `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    }
  });
}

function applyLiveSnapshot(live) {
  if (!live || typeof live !== "object") return;
  state.lastLiveSnapshot = live;
  if (Array.isArray(live.quotas)) state.observatory.quotas = { quotas: live.quotas };
  if (Array.isArray(live.identities)) state.observatory.identities = { identities: live.identities };
  if (live.totals) {
    state.observatory.overview = { totals: {
      identities: live.totals.identitiesCount,
      warningQuotas: live.totals.warningQuotasCount,
    } };
    const sseChip = byId("sse-state");
    if (sseChip && !sseChip.classList.contains("error")) {
      const label = sseChip.querySelector("span");
      if (label) label.textContent = "Live: 1s sync";
    }
  }
  if (state.activeView === "overview") renderObservatoryOverview();
  else if (state.activeView === "quotas") renderQuotas();
  else if (state.activeView === "credentials") renderCredentials();
}
function startLiveTicker() {
  if (liveTickerTimer) clearInterval(liveTickerTimer);
  liveTickerTimer = setInterval(async () => {
    updateLiveCountdowns();

    if (!liveTickerInFlight) {
      liveTickerInFlight = true;
      try {
        const live = await api("/api/observatory/live");
        if (live) applyLiveSnapshot(live);
      } catch {
        // Quiet fallback
      } finally {
        liveTickerInFlight = false;
      }
    }
  }, 1000);
}

function focusableIn(dialog) {
  return [...dialog.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter((node) => !node.closest(".hidden"));
}

function showModal(dialog, focusTarget) {
  state.previousFocus.set(dialog, document.activeElement);
  dialog.showModal(); requestAnimationFrame(() => (focusTarget || focusableIn(dialog)[0])?.focus());
}

function closeModal(dialog) {
  if (dialog.open) dialog.close();
  const previous = state.previousFocus.get(dialog); if (previous?.isConnected) previous.focus();
}

function bindDialogFocus(dialog) {
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeModal(dialog); return; }
    if (event.key !== "Tab") return;
    const focusable = focusableIn(dialog); if (!focusable.length) return;
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  dialog.addEventListener("close", () => { const previous = state.previousFocus.get(dialog); if (previous?.isConnected) previous.focus(); });
}

function updatePolicyTargetField() {
  const scope = byId("policy-scope-type").value;
  const editing = Boolean(state.policyEditingTarget);
  byId("policy-scope-type").disabled = editing;
  byId("policy-target").disabled = editing || scope === "global";
  byId("policy-target").required = scope !== "global";
  if (scope === "global" && !editing) byId("policy-target").value = "";
}

function openPolicyDialog(rule = null) {
  const parsed = parsePolicyTargetClient(rule?.target || "provider:");
  const policy = rule || resolvePolicy("global").resolved;
  state.policyEditingTarget = rule?.target || null;
  state.policyEditingRule = rule ? { ...rule, thresholds: { ...(rule.thresholds || {}) } } : null;
  const targetDisplay = rule ? (["provider", "event"].includes(parsed.scopeType) ? parsed.scopeKey : parsed.scopeType === "global" ? "" : maskedIdentifier(parsed.scopeKey, "Target")) : "";
  byId("policy-id").value = rule?.policyId || ""; byId("policy-scope-type").value = rule ? parsed.scopeType : "provider"; byId("policy-target").value = targetDisplay; byId("policy-min-severity").value = policy.minSeverity || "warning";
  const thresholds = { ...defaultPolicy().thresholds, ...(policy.thresholds || {}) };
  byId("policy-cooldown").value = String(policy.cooldownMinutes ?? 15); byId("policy-warning-threshold").value = String(Math.round((1 - thresholds.warningRemainingFraction) * 100)); byId("policy-critical-threshold").value = String(Math.round((1 - thresholds.criticalRemainingFraction) * 100)); byId("policy-channels").value = (policy.channels || ["default"]).join(", ");
  byId("policy-quiet-tz").value = policy.quietHoursTimezone || "UTC"; byId("policy-quiet-start").value = policy.quietHoursStart || ""; byId("policy-quiet-end").value = policy.quietHoursEnd || ""; byId("policy-silenced").checked = Boolean(policy.silenced); byId("policy-quiet-enabled").checked = Boolean(policy.quietHoursEnabled); byId("policy-critical-bypass").checked = policy.criticalBypassQuietHours !== false; byId("policy-error").textContent = "";
  updatePolicyTargetField(); renderPolicyDialogPreview(); showModal(byId("policy-dialog"), rule ? byId("policy-min-severity") : byId("policy-scope-type"));
}

function draftPolicy() {
  const scopeType = byId("policy-scope-type").value;
  const target = state.policyEditingTarget || canonicalPolicyTarget(scopeType, byId("policy-target").value);
  const warningUtilization = Number(byId("policy-warning-threshold").value) / 100;
  const criticalUtilization = Number(byId("policy-critical-threshold").value) / 100;
  const base = state.policyEditingRule || resolvePolicy(target || "global").resolved;
  return {
    target, warningUtilization, criticalUtilization, base,
    changes: {
      silenced: byId("policy-silenced").checked, minSeverity: byId("policy-min-severity").value,
      cooldownMinutes: Number(byId("policy-cooldown").value), channels: byId("policy-channels").value.split(",").map((value) => value.trim()).filter(Boolean),
      quietHoursEnabled: byId("policy-quiet-enabled").checked, quietHoursTimezone: byId("policy-quiet-tz").value.trim(), quietHoursStart: byId("policy-quiet-start").value || null,
      quietHoursEnd: byId("policy-quiet-end").value || null, criticalBypassQuietHours: byId("policy-critical-bypass").checked,
      thresholds: { ...defaultPolicy().thresholds, ...(base.thresholds || {}), warningRemainingFraction: 1 - warningUtilization, criticalRemainingFraction: 1 - criticalUtilization },
    },
  };
}

function canonicalPolicyRuleDto(draft) {
  const merged = { ...defaultPolicy(), ...draft.base, ...draft.changes, target: draft.target };
  const thresholds = { ...defaultPolicy().thresholds, ...(draft.base.thresholds || {}), ...(draft.changes.thresholds || {}) };
  const rule = {
    target: draft.target, enabled: merged.enabled, silenced: merged.silenced, telegramImmediate: merged.telegramImmediate, dashboardOnly: merged.dashboardOnly,
    minSeverity: merged.minSeverity, cooldownMinutes: merged.cooldownMinutes, throttleIntervalMs: merged.throttleIntervalMs, channels: merged.channels,
    recipient: merged.recipient, quietHoursEnabled: merged.quietHoursEnabled, quietHoursTimezone: merged.quietHoursTimezone, quietHoursStart: merged.quietHoursStart,
    quietHoursEnd: merged.quietHoursEnd, criticalBypassQuietHours: merged.criticalBypassQuietHours, digestEnabled: merged.digestEnabled,
    digestSchedule: merged.digestSchedule, digestTimezone: merged.digestTimezone, matchEventTypes: merged.matchEventTypes, matchHostIds: merged.matchHostIds,
    matchIdentityIds: merged.matchIdentityIds, warningRemainingFraction: thresholds.warningRemainingFraction, criticalRemainingFraction: thresholds.criticalRemainingFraction,
    exhaustedRemainingFraction: thresholds.exhaustedRemainingFraction, hysteresisFraction: thresholds.hysteresisFraction, consecutiveFailuresThreshold: merged.consecutiveFailuresThreshold,
  };
  return Object.fromEntries(Object.entries(rule).filter(([, value]) => value !== undefined));
}

function renderPolicyDialogPreview() {
  const draft = draftPolicy();
  renderEffectivePreview(byId("policy-dialog-effective-preview"), { resolved: { ...draft.base, ...draft.changes }, overridden: new Set(Object.keys(draft.changes)) });
}

async function savePolicy(event) {
  event.preventDefault(); const draft = draftPolicy();
  if (!draft.target || draft.target.length > 160 || !draft.changes.channels.length) { byId("policy-error").textContent = "A canonical target and at least one delivery channel are required."; return; }
  if (!(draft.warningUtilization > 0 && draft.warningUtilization <= draft.criticalUtilization && draft.criticalUtilization <= 1)) { byId("policy-error").textContent = "Utilization thresholds must be ordered between 1% and 100%."; return; }
  try {
    await api("/api/observatory/policies", { method: "PUT", body: { policy: canonicalPolicyRuleDto(draft) } });
    state.observatory.policies = await api("/api/observatory/policies"); closeModal(byId("policy-dialog")); state.policyEditingTarget = null; state.policyEditingRule = null; showToast("Notification policy saved."); renderPolicies();
  } catch (error) { byId("policy-error").textContent = error.message; }
}

function setActiveViewNavigation(name) {
  document.querySelectorAll(".views-nav [data-view]").forEach((button) => {
    const active = button.dataset.view === name || (name === "credentials" && button.dataset.view === "quotas");
    button.classList.toggle("active", active);
    if (active) {
      button.setAttribute("aria-current", "page");
    } else {
      button.removeAttribute("aria-current");
    }
  });
}

function showView(name, options = {}) {
  const valid = new Set(["overview", "quotas", "credentials", "accounts", "notifications", "events", "health"]);
  if (!valid.has(name)) name = "overview";
  if (state.selectedId !== null) state.revealedTokens.clear();
  state.selectedId = null;
  state.activeView = name;
  state.viewRequest += 1;
  destroyCharts([...OVERVIEW_CHARTS, ...ACCOUNT_CHARTS]);
  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.toggle("hidden", panel.id !== `${name}-view`));
  byId("account-view").classList.add("hidden");
  renderAccounts();
  setActiveViewNavigation(name);
  renderActiveView();
  renderTraceArchive();
  if (!options.preserveScroll) window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

function showOverview() {
  showView("overview");
}

async function selectAccount(id) {
  if (state.selectedId !== id) state.revealedTokens.clear();
  state.selectedId = id;
  state.activeView = "accounts";
  state.viewRequest += 1;
  destroyCharts(OVERVIEW_CHARTS);
  document.querySelectorAll(".view-panel").forEach((panel) => panel.classList.add("hidden"));
  byId("account-view").classList.remove("hidden");
  setActiveViewNavigation("accounts");
  renderAccounts();
  const request = state.viewRequest;
  try {
    const granularity = byId("usage-granularity").value;
    const [history, runs, usage, activity, credits, endpointObservations] = await Promise.all([
      api(`/api/history/${encodeURIComponent(id)}?limit=1000`), api(`/api/runs?accountId=${encodeURIComponent(id)}&limit=200`), api(`/api/usage/${encodeURIComponent(id)}?granularity=${encodeURIComponent(granularity)}`), api(`/api/activity/${encodeURIComponent(id)}`), api(`/api/credits/${encodeURIComponent(id)}?limit=1000`), api(`/api/endpoint-observations/${encodeURIComponent(id)}?limit=5000`),
    ]);
    if (state.selectedId !== id || state.viewRequest !== request) return;
    const grants = state.overview?.accounts?.find((item) => item.account.id === id)?.grants || [];
    Object.assign(state, { history, runs, usage, activity, credits, grants, endpointObservations });
    renderAccount();
    window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  } catch (error) { showToast(error.message, true); }
}

async function loadCore(refreshView = true) {
  const [bootstrap, overview] = await Promise.all([api("/api/bootstrap"), api("/api/overview")]);
  state.accounts = bootstrap.accounts; state.historicalAccounts = bootstrap.historicalAccounts; state.settings = bootstrap.settings; state.coordinator = bootstrap.coordinator; state.challenges = bootstrap.challenges || []; state.capabilities = bootstrap.capabilities || { collectorSessions: false }; state.overview = overview;
  const automation = state.settings.automation;
  byId("schedule-label").textContent = automation.schedulerEnabled ? `Every ${automation.intervalMinutes} min · ${automation.accountDelaySeconds}s gap` : "Paused";
  byId("account-file").textContent = "Protected local vault";
  renderAccounts(); renderCoordinator(); renderChallenges();
  if (refreshView && state.selectedId && state.accounts.some((account) => account.id === state.selectedId)) await selectAccount(state.selectedId);
  else showView(state.activeView || "overview", { preserveScroll: true });
}

async function runChecks(accountId) {
  try {
    await api("/api/checks/run", { method: "POST", body: accountId ? { accountId } : {} });
    showToast(accountId ? "Account check started." : "Full collection cycle started.");
    await new Promise((resolve) => setTimeout(resolve, 250));
    state.coordinator = await api("/api/coordinator"); renderCoordinator();
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refresh, 250);
  } catch (error) { showToast(error.message, true); }
}

async function stopChecks() {
  try { await api("/api/checks/stop", { method: "POST" }); showToast("Cancellation requested. The browser worker is shutting down."); state.coordinator = await api("/api/coordinator"); renderCoordinator(); clearTimeout(state.refreshTimer); state.refreshTimer = setTimeout(refresh, 250); }
  catch (error) { showToast(error.message, true); }
}

function openAccountDialog(account = null) {
  byId("dialog-title").textContent = account ? "Edit account" : "Add account";
  byId("account-id").value = account?.id || ""; byId("github-username").value = account?.githubUsername || ""; byId("account-label").value = account?.label || ""; byId("github-password").value = ""; byId("github-password").required = !account; byId("password-help").textContent = account ? "Leave blank to keep the saved password." : "Required for a new account."; byId("account-enabled").checked = account?.enabled ?? true; byId("account-run-order").value = String(account?.runOrder ?? state.accounts.length); byId("form-error").textContent = "";
  showModal(byId("account-dialog"), byId("github-username"));
}

async function saveAccount(event) {
  event.preventDefault();
  try {
    const result = await api("/api/accounts", { method: "POST", body: { id: byId("account-id").value || undefined, githubUsername: byId("github-username").value, label: byId("account-label").value, githubPassword: byId("github-password").value, enabled: byId("account-enabled").checked, runOrder: Number(byId("account-run-order").value) } });
    closeModal(byId("account-dialog")); state.selectedId = result.account.id; showToast("Account saved in the protected local credential file."); await loadCore(true);
  } catch (error) { byId("form-error").textContent = error.message; }
}

function openSettingsDialog() {
  const automation = state.settings?.automation; if (!automation) return;
  byId("interval-minutes").value = automation.intervalMinutes; byId("endpoint-poll-interval").value = automation.endpointPollIntervalMinutes; byId("account-delay-seconds").value = automation.accountDelaySeconds; byId("two-factor-timeout").value = automation.twoFactorTimeoutMinutes; byId("activity-lookback").value = automation.activityLookbackDays; byId("scheduler-enabled").checked = automation.schedulerEnabled; byId("endpoint-polling-enabled").checked = automation.endpointPollingEnabled; byId("run-on-start").checked = automation.runOnStart; byId("open-on-start").checked = automation.openDashboardOnStart; byId("capture-screenshots").checked = automation.captureScreenshots; byId("settings-error").textContent = ""; showModal(byId("settings-dialog"), byId("interval-minutes"));
}

function settingsTab(name) {
  for (const tab of document.querySelectorAll(".settings-tab")) {
    const active = tab.dataset.pane === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  }
  const auto = byId("settings-pane-automation");
  const obs = byId("settings-pane-observatory");
  const tel = byId("settings-pane-telegram");
  auto.classList.toggle("hidden", name !== "automation");
  obs.classList.toggle("hidden", name !== "observatory");
  tel.classList.toggle("hidden", name !== "telegram");
  if (name === "observatory") populateObservatorySettings();
}

function populateObservatorySettings() {
  const content = byId("settings-observatory-content");
  if (!content) return;
  const items = listFrom(state.observatory.quotas, ["quotas", "quotaWindows", "windows"]);
  const identities = listFrom(state.observatory.identities, ["identities", "credentials"]);
  const cells = content.querySelectorAll(".info-cell strong");
  const severity = { ok: 0, warning: 1, critical: 2, exhausted: 3 };
  const statusFn = (q) => {
    const used = Number(q && q.usedFraction);
    if (!Number.isFinite(used)) return "ok";
    if (used >= 1) return "exhausted";
    if (used >= 0.95) return "critical";
    if (used >= 0.8) return "warning";
    return "ok";
  };
  const warnings = items.filter((q) => statusFn(q) === "warning").length;
  const critical = items.filter((q) => ["critical", "exhausted"].includes(statusFn(q))).length;
  const values = [
    formatNumber(identities.length),
    formatNumber(items.length),
    formatNumber(warnings),
    formatNumber(critical),
    state.capabilities && state.capabilities.collectorSessions ? "Enabled (collector)" : "Off (broker only)",
  ];
  cells.forEach((cell, index) => { if (values[index] !== undefined) cell.textContent = values[index]; });
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    const result = await api("/api/settings", { method: "PUT", body: { intervalMinutes: Number(byId("interval-minutes").value), endpointPollIntervalMinutes: Number(byId("endpoint-poll-interval").value), accountDelaySeconds: Number(byId("account-delay-seconds").value), twoFactorTimeoutMinutes: Number(byId("two-factor-timeout").value), activityLookbackDays: Number(byId("activity-lookback").value), schedulerEnabled: byId("scheduler-enabled").checked, endpointPollingEnabled: byId("endpoint-polling-enabled").checked, runOnStart: byId("run-on-start").checked, openDashboardOnStart: byId("open-on-start").checked, browserHeadless: state.settings.automation.browserHeadless, captureScreenshots: byId("capture-screenshots").checked } });
    state.settings.automation = result.automation; closeModal(byId("settings-dialog")); showToast("Automation settings saved."); await loadCore(false);
  } catch (error) { byId("settings-error").textContent = error.message; }
}

async function removeSelectedAccount() {
  const account = selectedAccount(); if (!account) return;
  if (!confirm(`Remove ${account.label} and its saved GitHub session? Historical analytics remain available.`)) return;
  try { await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" }); state.selectedId = null; showToast("Account credentials and reusable GitHub session removed."); await loadCore(false); showOverview(); } catch (error) { showToast(error.message, true); }
}

async function exportSelectedAccount() {
  const account = selectedAccount(); if (!account) return;
  try { const payload = await api(`/api/export/${encodeURIComponent(account.id)}`); const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const link = element("a"); link.href = url; link.download = `${account.id}-agentrouter-analysis.json`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); } catch (error) { showToast(error.message, true); }
}

async function copySelectedApiToken() {
  const account = selectedAccount();
  if (account) await copyApiToken(account.id);
}

async function copyApiToken(id) {
  const account = state.accounts.find((candidate) => candidate.id === id);
  if (!account?.hasApiToken) return;
  try {
    const { token } = await api(`/api/account-token/${encodeURIComponent(id)}`);
    await navigator.clipboard.writeText(token);
    showToast("AgentRouter API token copied to the clipboard.");
  } catch (error) {
    showToast(error.message, true);
  }
}

async function revealApiToken(id) {
  const account = state.accounts.find((candidate) => candidate.id === id);
  if (!account?.hasApiToken) return;
  try {
    const { token } = await api(`/api/account-token/${encodeURIComponent(id)}`);
    state.revealedTokens.set(id, token);
    if (state.selectedId === id) renderAccount(); else renderOverviewTokenVault();
    showToast("API token revealed for this browser session.");
  } catch (error) {
    showToast(error.message, true);
  }
}

function hideApiToken(id) {
  state.revealedTokens.delete(id);
  if (state.selectedId === id) renderAccount(); else renderOverviewTokenVault();
}

function activateTab(tab, focus = false) {
  const list = tab.closest(".tab-list");
  list.querySelectorAll('[role="tab"]').forEach((item) => {
    const active = item === tab; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); item.tabIndex = active ? 0 : -1;
    const panel = byId(item.getAttribute("aria-controls")); if (panel) { panel.classList.toggle("hidden", !active); panel.setAttribute("aria-labelledby", item.id); }
  });
  if (focus) tab.focus();
}

function initializeTabs() {
  document.querySelectorAll(".tab-list").forEach((list, listIndex) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    tabs.forEach((tab, index) => { if (!tab.id) tab.id = `observatory-tab-${listIndex}-${index}`; });
    activateTab(tabs.find((tab) => tab.getAttribute("aria-selected") === "true") || tabs[0]);
  });
}

function handleTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.closest(".tab-list").querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(event.currentTarget); let next = index;
  if (event.key === "Home") next = 0; else if (event.key === "End") next = tabs.length - 1; else next = (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); activateTab(tabs[next], true);
}

function bindEvents() {
  byId("brand-home").addEventListener("click", showOverview); byId("back-overview").addEventListener("click", showOverview);
  document.querySelectorAll(".views-nav [data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
  for (const id of ["add-account", "rail-add", "onboarding-add", "accounts-add-btn"]) byId(id).addEventListener("click", () => openAccountDialog());
  byId("close-settings").addEventListener("click", () => closeModal(byId("settings-dialog"))); byId("cancel-settings").addEventListener("click", () => closeModal(byId("settings-dialog"))); byId("settings-form").addEventListener("submit", saveSettings);
  document.querySelectorAll(".settings-tab").forEach((tab) => tab.addEventListener("click", () => settingsTab(tab.dataset.pane)));
  for (const id of ["open-settings", "hero-settings"]) byId(id).addEventListener("click", () => { openSettingsDialog(); settingsTab("automation"); });
  byId("overview-open-quotas").addEventListener("click", () => showView("quotas"));
  for (const id of ["run-all", "hero-run"]) byId(id).addEventListener("click", () => runChecks());
  for (const id of ["stop-all", "challenge-stop"]) byId(id).addEventListener("click", stopChecks);
  byId("run-account").addEventListener("click", () => runChecks(state.selectedId)); byId("copy-api-token").addEventListener("click", copySelectedApiToken); byId("reveal-api-token").addEventListener("click", () => revealApiToken(state.selectedId)); byId("hide-api-token").addEventListener("click", () => hideApiToken(state.selectedId));
  byId("edit-account").addEventListener("click", () => openAccountDialog(selectedAccount())); byId("remove-account").addEventListener("click", removeSelectedAccount); byId("export-account").addEventListener("click", exportSelectedAccount);
  byId("close-dialog").addEventListener("click", () => closeModal(byId("account-dialog"))); byId("cancel-dialog").addEventListener("click", () => closeModal(byId("account-dialog"))); byId("account-form").addEventListener("submit", saveAccount);
  byId("open-policy-editor-btn").addEventListener("click", () => openPolicyDialog()); byId("close-policy-dialog").addEventListener("click", () => { closeModal(byId("policy-dialog")); state.policyEditingTarget = null; state.policyEditingRule = null; }); byId("cancel-policy-dialog").addEventListener("click", () => { closeModal(byId("policy-dialog")); state.policyEditingTarget = null; state.policyEditingRule = null; }); byId("policy-form").addEventListener("submit", savePolicy);
  byId("policy-preview-scope").addEventListener("change", renderPolicies);
  byId("policy-scope-type").addEventListener("change", updatePolicyTargetField);
  for (const id of ["policy-scope-type", "policy-target", "policy-min-severity", "policy-cooldown", "policy-warning-threshold", "policy-critical-threshold", "policy-channels", "policy-quiet-tz", "policy-quiet-start", "policy-quiet-end", "policy-silenced", "policy-quiet-enabled", "policy-critical-bypass"]) { byId(id).addEventListener("input", renderPolicyDialogPreview); byId(id).addEventListener("change", renderPolicyDialogPreview); }
  byId("toggle-console-size").addEventListener("click", () => { state.liveConsoleExpanded = !state.liveConsoleExpanded; renderCoordinator(); }); byId("close-inspector").addEventListener("click", () => byId("data-inspector").classList.add("hidden"));
  byId("dismiss-run").addEventListener("click", () => { const coordinator = state.coordinator || {}; state.liveConsoleDismissedKey = traceCycleKey(coordinator); clearLiveConsoleTimers(); byId("run-console").classList.add("hidden"); document.body.classList.remove("trace-active"); });
  byId("usage-granularity").addEventListener("change", () => state.selectedId && selectAccount(state.selectedId));
  for (const tab of document.querySelectorAll(".data-tab")) { tab.addEventListener("click", () => activateTab(tab)); tab.addEventListener("keydown", handleTabKeydown); }
  for (const [id, render] of [["quota-provider-filter", renderQuotas], ["quota-status-filter", renderQuotas], ["credential-health-filter", renderCredentials], ["event-severity-filter", renderEvents]]) byId(id).addEventListener("change", render);
  for (const [id, endpoint] of [["refresh-quotas-btn", "quotas"], ["refresh-credentials-btn", "identities"], ["refresh-events-btn", "events"], ["refresh-health-btn", "health"]]) byId(id).addEventListener("click", async () => {
    const payload = await optionalApi(endpoint, `/api/observatory/${endpoint}`); if (payload !== null) state.observatory[endpoint] = payload; renderActiveView();
  });
  for (const dialog of document.querySelectorAll("dialog")) bindDialogFocus(dialog);
  const logoutBtn = byId("logout-btn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } finally {
        window.location.replace(dashboardUrl("").toString());
      }
    });
  }
  byId("mobile-challenge").addEventListener("keydown", (event) => { if (event.key === "Tab") { event.preventDefault(); byId("challenge-stop").focus(); } });
  window.addEventListener("pagehide", () => { clearTimeout(state.refreshTimer); clearTimeout(state.fallbackTimer); clearTimeout(state.sseRetryTimer); if (state.sseSource) state.sseSource.close(); destroyCharts([...OVERVIEW_CHARTS, ...ACCOUNT_CHARTS]); });
}

async function refresh() {
  clearTimeout(state.refreshTimer);
  if (state.refreshInFlight) { state.refreshTimer = setTimeout(refresh, 1_000); return; }
  state.refreshInFlight = true;
  try {
    const wasRunning = Boolean(state.coordinator?.running);
    const [coordinator, challenges] = await Promise.all([api("/api/coordinator"), api("/api/challenges")]);
    state.coordinator = coordinator; state.challenges = challenges; renderCoordinator(); renderChallenges();
    if (wasRunning && !coordinator.running) { await loadCore(true); await loadObservatory(); }
  } catch (error) { if (error.status === 401) updateSseStatus("offline"); }
  finally {
    state.refreshInFlight = false;
    const delay = state.coordinator?.running || state.challenges.length ? 1_000 : 10_000;
    state.refreshTimer = setTimeout(refresh, Math.max(1_000, Math.min(delay, 10_000)));
  }
}

async function initialize() {
  if (typeof Chart !== "undefined") {
    Chart.defaults.color = "#c5b8d5";
    Chart.defaults.font.family = getComputedStyle(document.documentElement).fontFamily;
    Chart.defaults.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    Chart.defaults.plugins.legend.labels = Object.assign({}, Chart.defaults.plugins.legend.labels, { usePointStyle: true, pointStyle: "circle", boxWidth: 7, padding: 16 });
    Chart.defaults.plugins.tooltip = Object.assign({}, Chart.defaults.plugins.tooltip, { backgroundColor: "rgba(20, 11, 36, 0.94)", titleColor: "#e9d5ff", bodyColor: "#d8cde4", padding: 12, cornerRadius: 10, boxPadding: 5 });
    Chart.defaults.datasets.line = Object.assign({}, Chart.defaults.datasets.line, { tension: 0.35, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, pointBackgroundColor: "#e879f9" });
    Chart.defaults.datasets.bar = Object.assign({}, Chart.defaults.datasets.bar, { borderRadius: 7, borderSkipped: false, maxBarThickness: 26 });
    Chart.defaults.scale = Object.assign({}, Chart.defaults.scale, { grid: { color: "rgba(216, 180, 254, 0.08)" }, ticks: { color: "#a89ac0" } });
  }
  initializeTabs(); bindEvents();
  try { await loadCore(false); } catch (error) { showToast(error.message, true); }
  await loadObservatory();
  connectObservatoryStream();
  state.challengeTicker = setInterval(updateChallengeCountdown, 1_000);
  refresh();
  startLiveTicker();
}

initialize();
