const state = {
  accounts: [],
  historicalAccounts: [],
  settings: null,
  coordinator: null,
  challenges: [],
  overview: null,
  selectedId: null,
  history: [],
  runs: [],
  usage: [],
  activity: [],
  credits: [],
  grants: [],
  charts: new Map(),
  toastTimer: null,
  refreshTimer: null,
  challengeTicker: null,
};

const PALETTE = ["#a855f7", "#d946ef", "#8b5cf6", "#f472b6", "#67e8f9", "#6ee7b7", "#fbbf24"];
const OVERVIEW_CHARTS = ["overview-money-chart", "overview-earnings-chart", "overview-accounts-chart"];
const ACCOUNT_CHARTS = ["money-chart", "duration-chart", "activity-chart", "performance-chart", "model-trend-chart"];
const byId = (id) => document.getElementById(id);

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

async function api(path, options = {}) {
  const init = { method: options.method || "GET", headers: {} };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
  return payload;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatMoney(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) }).format(Number(value));
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
  return [...state.history].reverse().find((item) => item.status === "ok")?.metrics || {};
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
  const canvas = byId(id);
  if (!canvas || typeof Chart === "undefined") return;
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
      animation: { duration: 450, easing: "easeOutQuart" },
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
    button.append(icon, copy, health);
    button.addEventListener("click", () => selectAccount(account.id));
    list.append(button);
  }
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
  byId("dismiss-run").classList.toggle("hidden", Boolean(coordinator.running));

  const consolePanel = byId("run-console");
  const showConsole = Boolean(coordinator.running || coordinator.events?.length);
  consolePanel.classList.toggle("hidden", !showConsole);
  if (showConsole) {
    byId("run-stage").textContent = String(coordinator.currentStage || "idle").replaceAll("-", " ");
    byId("run-percent").textContent = `${finite(coordinator.progressPercent)}%`;
    byId("run-message").textContent = coordinator.currentMessage || "Cycle status ready.";
    byId("run-account-label").textContent = coordinator.currentAccountLabel
      ? `${coordinator.currentAccountLabel} · ${coordinator.completedAccounts}/${coordinator.totalAccounts} completed`
      : `${coordinator.completedAccounts || 0}/${coordinator.totalAccounts || 0} completed`;
    byId("run-progress").style.width = `${Math.min(100, Math.max(0, finite(coordinator.progressPercent)))}%`;
    const timeline = byId("event-timeline");
    timeline.replaceChildren();
    for (const event of [...(coordinator.events || [])].reverse()) {
      const row = element("div", "event-row");
      row.append(element("span", null, formatDate(event.at, true)), element("b", null, event.stage.replaceAll("-", " ")), element("span", null, event.accountLabel ? `${event.accountLabel} · ${event.message}` : event.message));
      timeline.append(row);
    }
  }
}

function renderChallenges() {
  const challenge = state.challenges?.[0];
  byId("mobile-challenge").classList.toggle("hidden", !challenge);
  if (!challenge) return;
  const isWaf = challenge.kind === "agentrouter-waf";
  byId("challenge-eyebrow").textContent = isWaf
    ? "AGENTROUTER · ACCESS VERIFICATION"
    : "GITHUB MOBILE · SECURE APPROVAL";
  byId("challenge-account").textContent = isWaf
    ? `Verify ${challenge.accountLabel}`
    : `Approve ${challenge.accountLabel}`;
  byId("challenge-prompt").textContent = challenge.prompt;
  byId("challenge-code").textContent = challenge.verificationCode || (isWaf ? "SLIDE" : "PUSH");
  byId("challenge-status").textContent = isWaf
    ? "Watching the visible browser"
    : "Listening for GitHub";
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
    metricCard("Combined balance", formatMoney(totals.balance), `${totals.configuredAccounts || 0} configured accounts`, PALETTE[0]),
    metricCard("Confirmed grants", formatMoney(totals.confirmedEarnings), "Direct AgentRouter system evidence", PALETTE[1], "gain"),
    metricCard("Observed increases", formatMoney(totals.observedEarnings), "Balance deltas; correlation only", PALETTE[2], "gain"),
    metricCard("Lifetime spend", formatMoney(totals.consumed), "Across latest snapshots", PALETTE[3]),
    metricCard("Total requests", formatCompact(totals.requests), "Account lifetime count", PALETTE[4]),
    metricCard("7-day tokens", formatCompact(totals.tokens), "Latest collected windows", PALETTE[5]),
  );
  byId("overview-earnings").textContent = formatMoney(totals.confirmedEarnings);
  byId("overview-observed-earnings").textContent = `${formatMoney(totals.observedEarnings)} observed balance increases`;
}

function aggregatePortfolioHistory(accountData) {
  const points = [];
  const accountsWithHistory = new Set();
  for (const item of accountData) {
    const successful = item.history.filter((entry) => entry.status === "ok");
    if (successful.length) accountsWithHistory.add(item.account.id);
    for (const sample of successful) {
      points.push({ at: sample.startedAt, accountId: item.account.id, metrics: sample.metrics });
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
    openInspector("Portfolio snapshot", [["Observed", formatDate(point.startedAt, true)], ["Triggered by", account?.label || point.changedAccount], ["Combined balance", formatMoney(point.balance, 4)], ["Lifetime spend", formatMoney(point.consumed, 4)]]);
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
  renderOverviewMetrics();
  renderOverviewCharts();
  renderHealth();
}

function renderAccountMetrics() {
  const metrics = latestMetrics();
  const grid = byId("metric-grid");
  grid.replaceChildren();
  grid.append(
    metricCard("Available balance", formatMoney(metrics.balance, 4), "Current AgentRouter balance", PALETTE[0]),
    metricCard("Lifetime spend", formatMoney(metrics.consumed, 4), "Account consumption", PALETTE[1]),
    metricCard("Requests", formatCompact(metrics.requestCount), "Account lifetime", PALETTE[2]),
    metricCard("7-day tokens", formatCompact(metrics.statisticalTokens), `${formatCompact(metrics.statisticalCount)} statistical calls`, PALETTE[3]),
    metricCard("Average RPM", formatNumber(metrics.averageRpm, 4), "Collected window", PALETTE[4]),
    metricCard("Average TPM", formatNumber(metrics.averageTpm, 1), Number.isFinite(Number(metrics.availableModels)) ? `${formatNumber(metrics.availableModels)} models available` : "Model count not exposed by Console", PALETTE[5]),
  );
}

function renderAccountCharts() {
  const successful = state.history.filter((item) => item.status === "ok");
  const labels = timeLabels(successful);
  const inspectHistory = (index) => {
    const point = successful[index];
    if (!point) return;
    openInspector("Account snapshot", [["Observed", formatDate(point.startedAt, true)], ["Balance", formatMoney(point.metrics.balance, 4)], ["Lifetime spend", formatMoney(point.metrics.consumed, 4)], ["Requests", formatNumber(point.metrics.requestCount)], ["7-day tokens", formatCompact(point.metrics.statisticalTokens)], ["Logout", point.loggedOut ? "Confirmed" : "Not confirmed"]]);
  };
  createChart("money-chart", { type: "line", data: { labels, datasets: [
    { label: "Balance", data: successful.map((item) => item.metrics.balance), borderColor: PALETTE[0], fill: true },
    { label: "Lifetime spend", data: successful.map((item) => item.metrics.consumed), borderColor: PALETTE[1] },
  ] }, options: { scales: { y: { ticks: { callback: moneyTick } } }, plugins: { tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${formatMoney(item.raw, 4)}` } } } } }, inspectHistory);

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
      element("td", null, item.description || "AgentRouter system event"),
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
    row.append(element("td", null, formatDate(finite(item.created_at) * 1_000, true)), element("td", null, item.token_name || "—"), element("td", null, item.model_name || "—"), element("td", null, formatNumber(item.prompt_tokens)), element("td", null, formatNumber(item.completion_tokens)), element("td", null, formatMoney(finite(item.quota) / quotaPerUnit, 4)), element("td", null, item.group || "—"), element("td", null, item.is_stream ? "Stream" : "Standard"));
    body.append(row);
  }
  if (!activity.length) { const row = element("tr"); const cell = element("td", "muted", "No meaningful usage rows captured yet."); cell.colSpan = 8; row.append(cell); body.append(row); }
}

function conciseError(message) {
  if (!message) return "";
  const first = String(message).split(/\r?\n/)[0].replace(/^Error:\s*/, "");
  return first.length > 110 ? `${first.slice(0, 110)}…` : first;
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
      details.append(element("summary", null, conciseError(run.errorMessage)), element("p", null, run.errorMessage));
      detailCell.append(details);
    } else detailCell.textContent = "—";
    row.append(detailCell);
    const capture = element("td");
    if (run.screenshotPath) {
      const filename = String(run.screenshotPath).replaceAll("\\", "/").split("/").pop();
      if (/^[A-Za-z0-9._-]+\.png$/.test(filename)) { const link = element("a", "capture-link", "Open capture ↗"); link.href = `/screenshots/${encodeURIComponent(filename)}`; link.target = "_blank"; link.rel = "noopener noreferrer"; capture.append(link); }
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
  renderAccountMetrics(); renderAccountCharts(); renderUsage(); renderGrants(); renderCredits(); renderActivity(); renderRuns();
}

function showOverview() {
  state.selectedId = null;
  destroyCharts(ACCOUNT_CHARTS);
  byId("overview-view").classList.remove("hidden");
  byId("account-view").classList.add("hidden");
  renderAccounts(); renderOverview();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function selectAccount(id) {
  state.selectedId = id;
  destroyCharts(OVERVIEW_CHARTS);
  byId("overview-view").classList.add("hidden");
  byId("account-view").classList.remove("hidden");
  renderAccounts();
  try {
    const granularity = byId("usage-granularity").value;
    const [history, runs, usage, activity, credits] = await Promise.all([
      api(`/api/history/${encodeURIComponent(id)}?limit=1000`), api(`/api/runs?accountId=${encodeURIComponent(id)}&limit=200`), api(`/api/usage/${encodeURIComponent(id)}?granularity=${encodeURIComponent(granularity)}`), api(`/api/activity/${encodeURIComponent(id)}`), api(`/api/credits/${encodeURIComponent(id)}?limit=1000`),
    ]);
    if (state.selectedId !== id) return;
    const grants = state.overview?.accounts?.find((item) => item.account.id === id)?.grants || [];
    Object.assign(state, { history, runs, usage, activity, credits, grants });
    renderAccount();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) { showToast(error.message, true); }
}

async function loadCore(refreshView = true) {
  const [bootstrap, overview] = await Promise.all([api("/api/bootstrap"), api("/api/overview")]);
  state.accounts = bootstrap.accounts; state.historicalAccounts = bootstrap.historicalAccounts; state.settings = bootstrap.settings; state.coordinator = bootstrap.coordinator; state.challenges = bootstrap.challenges || []; state.overview = overview;
  const automation = state.settings.automation;
  byId("schedule-label").textContent = automation.schedulerEnabled ? `Every ${automation.intervalMinutes} min · ${automation.accountDelaySeconds}s gap` : "Paused";
  byId("account-file").textContent = state.settings.accountFilePath;
  renderAccounts(); renderCoordinator(); renderChallenges();
  if (refreshView && state.selectedId && state.accounts.some((account) => account.id === state.selectedId)) await selectAccount(state.selectedId);
  else showOverview();
}

async function runChecks(accountId, interactive = false) {
  try {
    await api("/api/checks/run", { method: "POST", body: accountId ? { accountId, interactive } : { interactive } });
    showToast(interactive ? "Visible authentication started." : accountId ? "Account check started." : "Full collection cycle started.");
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
  byId("account-dialog").showModal(); byId("github-username").focus();
}

async function saveAccount(event) {
  event.preventDefault();
  try {
    const result = await api("/api/accounts", { method: "POST", body: { id: byId("account-id").value || undefined, githubUsername: byId("github-username").value, label: byId("account-label").value, githubPassword: byId("github-password").value, enabled: byId("account-enabled").checked, runOrder: Number(byId("account-run-order").value) } });
    byId("account-dialog").close(); state.selectedId = result.account.id; showToast("Account saved in the protected local credential file."); await loadCore(true);
  } catch (error) { byId("form-error").textContent = error.message; }
}

function openSettingsDialog() {
  const automation = state.settings?.automation; if (!automation) return;
  byId("interval-minutes").value = automation.intervalMinutes; byId("account-delay-seconds").value = automation.accountDelaySeconds; byId("two-factor-timeout").value = automation.twoFactorTimeoutMinutes; byId("activity-lookback").value = automation.activityLookbackDays; byId("scheduler-enabled").checked = automation.schedulerEnabled; byId("run-on-start").checked = automation.runOnStart; byId("open-on-start").checked = automation.openDashboardOnStart; byId("browser-headless").checked = automation.browserHeadless; byId("capture-screenshots").checked = automation.captureScreenshots; byId("settings-error").textContent = ""; byId("settings-dialog").showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    const result = await api("/api/settings", { method: "PUT", body: { intervalMinutes: Number(byId("interval-minutes").value), accountDelaySeconds: Number(byId("account-delay-seconds").value), twoFactorTimeoutMinutes: Number(byId("two-factor-timeout").value), activityLookbackDays: Number(byId("activity-lookback").value), schedulerEnabled: byId("scheduler-enabled").checked, runOnStart: byId("run-on-start").checked, openDashboardOnStart: byId("open-on-start").checked, browserHeadless: byId("browser-headless").checked, captureScreenshots: byId("capture-screenshots").checked } });
    state.settings.automation = result.automation; byId("settings-dialog").close(); showToast("Automation settings saved."); await loadCore(false);
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

function bindEvents() {
  byId("brand-home").addEventListener("click", showOverview); byId("overview-nav").addEventListener("click", showOverview); byId("back-overview").addEventListener("click", showOverview);
  for (const id of ["add-account", "rail-add", "onboarding-add"]) byId(id).addEventListener("click", () => openAccountDialog());
  for (const id of ["open-settings", "hero-settings"]) byId(id).addEventListener("click", openSettingsDialog);
  for (const id of ["run-all", "hero-run"]) byId(id).addEventListener("click", () => runChecks());
  for (const id of ["stop-all", "challenge-stop"]) byId(id).addEventListener("click", stopChecks);
  byId("run-account").addEventListener("click", () => runChecks(state.selectedId)); byId("authenticate-account").addEventListener("click", () => runChecks(state.selectedId, true));
  byId("edit-account").addEventListener("click", () => openAccountDialog(selectedAccount())); byId("remove-account").addEventListener("click", removeSelectedAccount); byId("export-account").addEventListener("click", exportSelectedAccount);
  byId("close-dialog").addEventListener("click", () => byId("account-dialog").close()); byId("cancel-dialog").addEventListener("click", () => byId("account-dialog").close()); byId("account-form").addEventListener("submit", saveAccount);
  byId("close-settings").addEventListener("click", () => byId("settings-dialog").close()); byId("cancel-settings").addEventListener("click", () => byId("settings-dialog").close()); byId("settings-form").addEventListener("submit", saveSettings);
  byId("toggle-events").addEventListener("click", () => byId("event-timeline").classList.toggle("hidden")); byId("close-inspector").addEventListener("click", () => byId("data-inspector").classList.add("hidden"));
  byId("dismiss-run").addEventListener("click", () => byId("run-console").classList.add("hidden"));
  byId("usage-granularity").addEventListener("change", () => state.selectedId && selectAccount(state.selectedId));
  for (const tab of document.querySelectorAll(".data-tab")) tab.addEventListener("click", () => { document.querySelectorAll(".data-tab").forEach((item) => item.classList.toggle("active", item === tab)); byId("activity-tab").classList.toggle("hidden", tab.dataset.tab !== "activity"); byId("runs-tab").classList.toggle("hidden", tab.dataset.tab !== "runs"); });
}

async function refresh() {
  try {
    const wasRunning = Boolean(state.coordinator?.running);
    const [coordinator, challenges] = await Promise.all([api("/api/coordinator"), api("/api/challenges")]);
    state.coordinator = coordinator; state.challenges = challenges; renderCoordinator(); renderChallenges();
    if (wasRunning && !coordinator.running) await loadCore(true);
  } catch (error) { showToast(error.message, true); }
  state.refreshTimer = setTimeout(refresh, state.coordinator?.running || state.challenges.length ? 1_000 : 4_000);
}

async function initialize() {
  Chart.defaults.color = "#a99bbd"; Chart.defaults.font.family = getComputedStyle(document.documentElement).fontFamily; Chart.defaults.devicePixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  bindEvents();
  try { await loadCore(false); } catch (error) { showToast(error.message, true); }
  state.challengeTicker = setInterval(updateChallengeCountdown, 1_000);
  refresh();
}

initialize();
