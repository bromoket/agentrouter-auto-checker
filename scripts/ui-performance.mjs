import { chromium } from "playwright";

const baseUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:3100";
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const views = [
  ["overview", "#overview-nav", "#overview-view"], ["quotas", "#nav-quotas", "#quotas-view"],
  ["credentials", "#nav-credentials", "#credentials-view"], ["accounts", "#nav-accounts", "#accounts-view"],
  ["notifications", "#nav-notifications", "#notifications-view"], ["events", "#nav-events", "#events-view"],
  ["health", "#nav-health", "#health-view"],
];

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    globalThis.__dashboardLongTasks = [];
    globalThis.__apiFetchCredentials = [];
    if (typeof PerformanceObserver !== "undefined") {
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) globalThis.__dashboardLongTasks.push(entry.duration); }).observe({ type: "longtask", buffered: true });
    }
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/")) globalThis.__apiFetchCredentials.push(init.credentials);
      return nativeFetch(input, init);
    };
    class SilentEventSource {
      constructor(url, options = {}) { this.url = String(url); this.withCredentials = Boolean(options.withCredentials); this.closed = false; setTimeout(() => this.onopen?.({ type: "open" }), 0); }
      addEventListener() {}
      close() { this.closed = true; }
    }
    globalThis.EventSource = SilentEventSource;
  });
  const observedAt = new Date().toISOString();
  const identities = [
    { identityId: "identity-openai", kind: "credential", provider: "openai-codex", label: "Primary ChatGPT", health: "healthy", observedAt },
    ...Array.from({ length: 10 }, (_, index) => ({ identityId: `identity-ag-${index}`, kind: "credential", provider: "google-antigravity", label: `Antigravity ${index + 1}`, health: "healthy", observedAt })),
  ];
  const quotaWindows = [
    ...Array.from({ length: 3 }, (_, index) => ({ identityId: "identity-openai", provider: "openai-codex", windowId: `openai-${index}`, resetLabel: `OpenAI ${index + 1}`, usedFraction: .82, remainingFraction: .18, status: "warning", observedAt })),
    ...Array.from({ length: 34 }, (_, index) => ({ identityId: `identity-ag-${index % 10}`, provider: "google-antigravity", windowId: `ag-${index}`, resetLabel: `Antigravity ${index + 1}`, usedFraction: .31, remainingFraction: .69, status: "ok", observedAt })),
  ];
  const fixture = {
    overview: { generatedAt: observedAt, totals: { identities: 11, warningQuotas: 3 } },
    quotas: { quotaWindows },
    identities: { identities },
    events: { events: [{ eventId: "event-perf", eventType: "quota_warning", severity: "warning", occurredAt: observedAt, provider: "openai-codex", windowId: "quota-window-perf" }], audit: [] },
    policies: { policies: [{ policyId: "global-perf", target: "global", enabled: true, silenced: false, telegramImmediate: true, dashboardOnly: false, minSeverity: "warning", thresholds: { warningRemainingFraction: .2, criticalRemainingFraction: .1, exhaustedRemainingFraction: .02, hysteresisFraction: .02 }, cooldownMinutes: 15, throttleIntervalMs: 60000, channels: ["default"], quietHoursEnabled: false, quietHoursTimezone: "UTC", quietHoursStart: null, quietHoursEnd: null, criticalBypassQuietHours: true, digestEnabled: false, digestIntervalMinutes: null, digestSchedule: null, digestTimezone: "UTC", recipient: null, matchEventTypes: [], matchHostIds: [], matchIdentityIds: [], updatedAt: observedAt }], deliveries: [] },
    health: { status: "ok", generatedAt: observedAt, uptimeSeconds: 100, schedulerActive: true, services: [] },
  };
  await page.route("**/api/observatory/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    if (name === "stream") return route.abort();
    if (name === "live") {
      const liveQuotas = quotaWindows.map((quota) => ({ ...quota, usedFraction: .42, remainingFraction: .58, status: "ok" }));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ timestamp: observedAt, totals: { identitiesCount: 11, warningQuotasCount: 0 }, quotas: liveQuotas, identities, agentrouter: [] }) });
    }
    const body = fixture[name]; return route.fulfill({ status: body ? 200 : 404, contentType: "application/json", body: JSON.stringify(body || { error: "Unsupported" }) });
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#overview-money-chart").waitFor({ state: "visible" });
  await page.waitForTimeout(1_100);

  const overview = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const durations = globalThis.__dashboardLongTasks || [];
    return {
      navigationMs: navigation?.duration || 0,
      longTaskCount: durations.length,
      longestTaskMs: Math.max(0, ...durations),
      totalLongTaskMs: durations.reduce((total, value) => total + value, 0),
      activeCharts: Object.keys(globalThis.Chart?.instances || {}).length,
      animatedElements: document.getAnimations().length,
      transferBytes: performance.getEntriesByType("resource").reduce((total, entry) => total + (entry.transferSize || 0), 0),
      credentials: globalThis.__apiFetchCredentials,
    };
  });
  assert(overview.activeCharts === 3, `overview retained ${overview.activeCharts} charts instead of 3`);
  assert(overview.credentials.length > 0 && overview.credentials.every((value) => value === "same-origin"), "API fetches did not preserve same-origin credentials");
  assert(await page.locator("#overview-provider-accounts .provider-account-card").count() === 11, "overview did not render all 11 broker identities");
  assert((await page.locator("#overview-provider-accounts").innerText()).includes("42%"), "overview did not apply the live quota snapshot");

  for (const [name, selector, panel] of views.slice(1)) {
    await page.locator(selector).click();
    await page.locator(panel).waitFor({ state: "visible" });
    const snapshot = await page.evaluate(() => ({
      charts: Object.keys(globalThis.Chart?.instances || {}).length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      raw: document.querySelector(".workspace")?.innerText?.match(/undefined|\[object object\]/i)?.[0] || null,
    }));
    assert(snapshot.charts === 0, `${name} retained ${snapshot.charts} charts behind the view`);
    assert(snapshot.overflow <= 2, `${name} introduced ${snapshot.overflow}px horizontal overflow`);
    assert(!snapshot.raw, `${name} rendered a raw implementation value`);
  }

  await page.locator("#nav-accounts").click();
  await page.locator("#accounts-view").waitFor({ state: "visible" });
  const accountButton = page.locator("#account-list .nav-card").first();
  if (await accountButton.count()) {
    await accountButton.click();
    await page.locator("#account-view").waitFor({ state: "visible" });
    await page.locator("#model-trend-chart").waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    const account = await page.evaluate(() => ({
      activeCharts: Object.keys(globalThis.Chart?.instances || {}).length,
      overviewChartsDestroyed: ["overview-money-chart", "overview-earnings-chart", "overview-accounts-chart"].every((id) => !globalThis.Chart?.getChart(document.getElementById(id))),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    assert(account.activeCharts === 5, `account view retained ${account.activeCharts} charts instead of 5`);
    assert(account.overviewChartsDestroyed, "overview charts remained active behind the account view");
    assert(account.overflow <= 2, `account view introduced ${account.overflow}px horizontal overflow`);
  }

  await page.locator("#brand-home").click();
  await page.locator("#overview-money-chart").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const returned = await page.evaluate(() => ({
    activeCharts: Object.keys(globalThis.Chart?.instances || {}).length,
    accountChartsDestroyed: ["money-chart", "duration-chart", "activity-chart", "performance-chart", "model-trend-chart"].every((id) => !globalThis.Chart?.getChart(document.getElementById(id))),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }));
  assert(returned.activeCharts === 3, `returning to overview retained ${returned.activeCharts} charts instead of 3`);
  assert(returned.accountChartsDestroyed, "account charts remained active behind the overview");
  assert(returned.overflow <= 2, `overview introduced ${returned.overflow}px horizontal overflow after navigation`);
  assert(overview.longestTaskMs < 500, `dashboard produced a ${overview.longestTaskMs.toFixed(1)}ms long task`);

  process.stdout.write(`${JSON.stringify({ overview, returned }, null, 2)}\n`);
} finally {
  await browser.close();
}
