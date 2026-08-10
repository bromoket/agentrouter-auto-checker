import { chromium } from "playwright";

const baseUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:3100";
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    globalThis.__dashboardLongTasks = [];
    if (typeof PerformanceObserver !== "undefined") {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) globalThis.__dashboardLongTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
    }
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator("#overview-money-chart").waitFor({ state: "visible" });
  await page.waitForTimeout(800);

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
    };
  });
  assert(overview.activeCharts === 3, `overview retained ${overview.activeCharts} charts instead of 3`);

  await page.locator("#account-list .nav-card").first().click();
  await page.locator("#account-view").waitFor({ state: "visible" });
  await page.locator("#model-trend-chart").waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  const account = await page.evaluate(() => ({
    activeCharts: Object.keys(globalThis.Chart?.instances || {}).length,
    overviewChartsDestroyed: ["overview-money-chart", "overview-earnings-chart", "overview-accounts-chart"]
      .every((id) => !globalThis.Chart?.getChart(document.getElementById(id))),
  }));
  assert(account.activeCharts === 5, `account view retained ${account.activeCharts} charts instead of 5`);
  assert(account.overviewChartsDestroyed, "overview charts remained active behind the account view");

  await page.locator("#brand-home").click();
  await page.waitForTimeout(300);
  const returned = await page.evaluate(() => ({
    activeCharts: Object.keys(globalThis.Chart?.instances || {}).length,
    accountChartsDestroyed: ["money-chart", "duration-chart", "activity-chart", "performance-chart", "model-trend-chart"]
      .every((id) => !globalThis.Chart?.getChart(document.getElementById(id))),
  }));
  assert(returned.activeCharts === 3, `returning to overview retained ${returned.activeCharts} charts instead of 3`);
  assert(returned.accountChartsDestroyed, "account charts remained active behind the overview");
  assert(overview.longestTaskMs < 500, `dashboard produced a ${overview.longestTaskMs.toFixed(1)}ms long task`);

  process.stdout.write(`${JSON.stringify({ overview, account, returned }, null, 2)}\n`);
} finally {
  await browser.close();
}
