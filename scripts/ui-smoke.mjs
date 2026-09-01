import { chromium, firefox, webkit } from "playwright";

const baseUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:3100";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const viewports = [
  { width: 1440, height: 900, label: "desktop" },
  { width: 768, height: 900, label: "tablet" },
  { width: 390, height: 844, label: "mobile" },
];

const views = [
  ["overview", "#overview-nav", "#overview-view"],
  ["quotas", "#nav-quotas", "#quotas-view"],
  ["credentials", "#nav-credentials", "#credentials-view"],
  ["accounts", "#nav-accounts", "#accounts-view"],
  ["sessions", "#nav-sessions", "#sessions-view"],
  ["hosts", "#nav-hosts", "#hosts-view"],
  ["notifications", "#nav-notifications", "#notifications-view"],
  ["events", "#nav-events", "#events-view"],
  ["health", "#nav-health", "#health-view"],
];

async function installBrowserProbes(page) {
  await page.addInitScript(() => {
    globalThis.__apiFetchCredentials = [];
    const nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input, init = {}) => {
      const url = typeof input === "string" ? input : input?.url || "";
      if (url.includes("/api/")) globalThis.__apiFetchCredentials.push(init.credentials);
      return nativeFetch(input, init);
    };

    class FakeEventSource {
      static instances = [];
      constructor(url, options = {}) {
        this.url = String(url);
        this.withCredentials = Boolean(options.withCredentials);
        this.listeners = new Map();
        this.closed = false;
        FakeEventSource.instances.push(this);
        globalThis.__fakeSseLatest = this;
        setTimeout(() => { if (!this.closed) this.onopen?.({ type: "open" }); }, 0);
      }
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }
      emit(type, data, lastEventId = "") {
        const event = { type, data: JSON.stringify(data), lastEventId };
        if (type === "message") this.onmessage?.(event);
        for (const listener of this.listeners.get(type) || []) listener(event);
      }
      fail() { this.onerror?.({ type: "error" }); }
      close() { this.closed = true; }
    }
    globalThis.EventSource = FakeEventSource;
    globalThis.__FakeEventSource = FakeEventSource;
  });
}
async function installObservatoryFixtures(page) {
  const now = new Date().toISOString();
  const capture = { policyPut: null, reads: [] };
  let policies = [{
    policyId: "policy-global", target: "global", enabled: true, silenced: false, telegramImmediate: true, dashboardOnly: false,
    minSeverity: "warning", thresholds: { warningRemainingFraction: .2, criticalRemainingFraction: .1, exhaustedRemainingFraction: .02, hysteresisFraction: .02 },
    consecutiveFailuresThreshold: 3, cooldownMinutes: 15, throttleIntervalMs: 60_000, channels: ["default"], quietHoursEnabled: false,
    quietHoursTimezone: "UTC", quietHoursStart: null, quietHoursEnd: null, criticalBypassQuietHours: true, digestEnabled: false,
    digestIntervalMinutes: null, digestSchedule: null, digestTimezone: "UTC", recipient: null, matchEventTypes: [], matchHostIds: [], matchIdentityIds: [], updatedAt: now,
  }];
  const payloads = {
    overview: { generatedAt: now, totals: { hostCount: 1, onlineHosts: 1, identityCount: 1, activeSessions: 0, warningQuotas: 1 } },
    quotas: { quotaWindows: [{ provider: "openai-codex", windowId: "raw-window-secret-1234", resetLabel: "Five-hour limit", usedFraction: .84, remainingFraction: .16, resetsAt: now, status: "warning", source: "collector", scope: "provider", observedAt: now }] },
    identities: { identities: [{ identityId: "raw-identity-secret-4567", kind: "openai-codex", label: "Primary Codex", hostId: "raw-host-secret-8910", health: "healthy", activeModel: "gpt-public", source: "collector", observedAt: now }] },
    hosts: { hosts: [{ hostId: "raw-host-secret-8910", operatorLabel: "Workstation Alpha", collectorVersion: "2.1.0", status: "online", activeSessionsCount: 0, activeIdentitiesCount: 1, source: "heartbeat", observedAt: now }] },
    sessions: { sessions: [{ sessionId: "raw-session-secret-2468", hostId: "raw-host-secret-8910", identityId: "raw-identity-secret-4567", status: "closed", startedAt: now, closedAt: now, durationMs: 1200, totalTokens: 42, toolCallsCount: 2, errorCount: 0, costMicros: 1200, costTrust: "estimated", source: "omp", collectedAt: now }] },
    events: { events: [{ eventId: "raw-event-secret-1357", eventType: "quota_warning", severity: "warning", occurredAt: now, title: "raw-identity-secret-4567 at C:\\private\\secret", message: "https://token.invalid/raw-session-secret-2468", fingerprint: "raw-fingerprint-secret-1111", provider: "openai-codex", windowId: "raw-window-secret-1234", source: "event-bus" }], audit: [{ auditId: "raw-audit-secret-2222", action: "upsert_policy", actor: "dashboard_owner", targetType: "policy", targetId: "provider:openai-codex", occurredAt: now, details: { path: "C:\\private\\secret" } }] },
    health: { status: "ok", generatedAt: now, uptimeSeconds: 120, schedulerActive: true, services: [{ name: "Observatory API", status: "online", message: "Ready" }] },
  };
  await page.route("**/api/observatory/**", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const name = url.pathname.split("/").pop();
    if (name === "stream") return route.abort();
    if (name === "policies" && request.method() === "PUT") {
      capture.policyPut = request.postDataJSON();
      const rule = capture.policyPut?.policy;
      const valid = capture.policyPut && Object.keys(capture.policyPut).length === 1 && rule && !rule.thresholds && Number.isFinite(rule.warningRemainingFraction) && Number.isFinite(rule.criticalRemainingFraction) && Number.isFinite(rule.exhaustedRemainingFraction);
      if (!valid) return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Invalid canonical single-policy DTO" }) });
      const prior = policies.find((policy) => policy.target === rule.target) || policies[0];
      const effective = { ...prior, ...rule, policyId: prior?.target === rule.target ? prior.policyId : `fixture-${rule.target}`, target: rule.target, thresholds: { warningRemainingFraction: rule.warningRemainingFraction, criticalRemainingFraction: rule.criticalRemainingFraction, exhaustedRemainingFraction: rule.exhaustedRemainingFraction, hysteresisFraction: rule.hysteresisFraction }, updatedAt: now };
      policies = [...policies.filter((policy) => policy.target !== rule.target), effective];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rule, policy: effective, provenance: {} }) });
    }
    capture.reads.push(name);
    const body = name === "policies" ? { policies, deliveries: [{ deliveryId: "delivery-secret-1", eventId: "raw-event-secret-1357", channel: "telegram", status: "failed", attemptCount: 1, errorCategory: "network", lastAttemptAt: now }] } : payloads[name];
    return route.fulfill({ status: body ? 200 : 404, contentType: "application/json", body: JSON.stringify(body || { error: "Unsupported" }) });
  });
  return capture;
}

async function assertNoOverflow(page, contextLabel) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 2, `${contextLabel}: horizontal overflow is ${overflow}px`);
}

async function validateNineViews(page, contextLabel) {
  for (const [name, selector, panel] of views) {
    await page.locator(selector).click();
    await page.locator(panel).waitFor({ state: "visible" });
    assert(await page.locator(`${selector}.active`).count() === 1, `${contextLabel}: ${name} navigation did not become active`);
    const text = (await page.locator(panel).innerText()).toLowerCase();
    assert(!text.includes("undefined") && !text.includes("[object object]"), `${contextLabel}: ${name} rendered a raw implementation value`);
    await assertNoOverflow(page, `${contextLabel}/${name}`);
  }
}

async function validateObservatoryContracts(page, capture, viewport, contextLabel) {
  for (const [nav, panel] of [["#nav-quotas", "#quotas-view"], ["#nav-credentials", "#credentials-view"], ["#nav-sessions", "#sessions-view"], ["#nav-events", "#events-view"]]) {
    await page.locator(nav).click(); await page.locator(panel).waitFor({ state: "visible" });
  }
  const publicText = (await page.locator("body").textContent()).toLowerCase();
  for (const secret of ["raw-window-secret", "raw-identity-secret", "raw-host-secret", "raw-session-secret", "raw-event-secret", "c:\\private", "token.invalid"]) assert(!publicText.includes(secret), `${contextLabel}: rendered protected fixture value ${secret}`);
  await page.locator("#nav-hosts").click();
  assert((await page.locator("#hosts-view").innerText()).includes("Workstation Alpha"), `${contextLabel}: operatorLabel was not rendered`);
  assert((await page.locator("#hosts-view").innerText()).includes("2.1.0"), `${contextLabel}: collectorVersion was not rendered`);
  await page.locator("#nav-sessions").click();
  assert((await page.locator("#sessions-view").innerText()).toLowerCase().includes("completed"), `${contextLabel}: closed session was not normalized`);

  await page.locator("#nav-events").click();
  const eventsTab = page.locator('[role="tab"][aria-controls="events-tab"]');
  await eventsTab.focus(); await eventsTab.press("ArrowRight");
  const auditTab = page.locator('[role="tab"][aria-controls="audit-tab"]');
  assert(await auditTab.getAttribute("aria-selected") === "true", `${contextLabel}: ArrowRight did not activate audit tab`);
  assert(await auditTab.evaluate((node) => node === document.activeElement), `${contextLabel}: roving tab focus did not move`);

  await page.locator("#nav-notifications").click();
  await page.locator("#open-policy-editor-btn").click();
  await page.locator("#policy-dialog").waitFor({ state: "visible" });
  const policyBox = await page.locator("#policy-dialog").boundingBox();
  assert(policyBox && policyBox.width <= viewport.width, `${contextLabel}: policy dialog overflows`);
  await page.locator("#policy-scope-type").selectOption("provider");
  await page.locator("#policy-target").fill("google");
  await page.locator("#policy-warning-threshold").fill("80");
  await page.locator("#policy-critical-threshold").fill("90");
  await page.locator('#policy-form button[type="submit"]').click();
  await page.locator("#policy-dialog").waitFor({ state: "hidden" });
  const policy = capture.policyPut?.policy;
  assert(policy?.target === "provider:google", `${contextLabel}: policy target was not canonical`);
  assert(Math.abs(policy?.warningRemainingFraction - .2) < 1e-9 && Math.abs(policy?.criticalRemainingFraction - .1) < 1e-9 && Math.abs(policy?.exhaustedRemainingFraction - .02) < 1e-9, `${contextLabel}: flat remaining-fraction thresholds are incorrect`);
  assert(policy?.throttleIntervalMs === 60_000 && policy?.digestEnabled === false, `${contextLabel}: unexposed policy fields were not preserved`);
  assert(policy?.thresholds === undefined && policy?.scopeType === undefined && policy?.warningThreshold === undefined, `${contextLabel}: non-canonical policy fields leaked into DTO`);
  assert(await page.locator("#policies-list .policy-card").count() === 2, `${contextLabel}: single-policy upsert removed an untouched policy`);
}

async function validateLegacyWorkflows(page, viewport, contextLabel) {
  await page.locator("#overview-nav").click();
  await page.locator("#overview-view").waitFor({ state: "visible" });
  assert(await page.locator("#overview-money-chart").isVisible(), `${contextLabel}: overview chart hidden`);
  assert(await page.locator("#trace-archive").isVisible(), `${contextLabel}: persistent trace archive hidden`);
  assert(await page.locator("#overview-token-list").isVisible(), `${contextLabel}: API vault hidden`);
  assert(await page.locator("#toggle-console-size").count() === 1, `${contextLabel}: live trace expand control missing`);

  const accountButton = page.locator("#account-list .nav-card").first();
  if (await accountButton.count()) {
    await accountButton.click();
    await page.locator("#account-view").waitFor({ state: "visible" });
    await page.locator("#money-chart").waitFor({ state: "visible" });
    const rawText = (await page.locator("#account-view").innerText()).toLowerCase();
    assert(!rawText.includes("null") && !rawText.includes("undefined"), `${contextLabel}: raw null value rendered`);
    for (const selector of ["#run-account", "#reveal-api-token", "#copy-api-token", "#export-account", "#edit-account", "#remove-account"]) {
      assert(await page.locator(selector).count() === 1, `${contextLabel}: legacy control ${selector} missing`);
    }
    const chartCount = await page.locator("#account-view canvas").count();
    assert(chartCount >= 5, `${contextLabel}: expected legacy account charts`);

    const invokedInspector = await page.evaluate(() => {
      const canvas = document.querySelector("#money-chart");
      const chart = globalThis.Chart?.getChart(canvas);
      const point = chart?.getDatasetMeta(0)?.data?.[0];
      if (!chart || !point) return false;
      chart.options.onClick({}, [{ index: 0, datasetIndex: 0 }], chart);
      return true;
    });
    if (invokedInspector) {
      await page.locator("#data-inspector").waitFor({ state: "visible" });
      await page.locator("#close-inspector").click();
    }
  }

  await page.locator("#open-settings").click();
  await page.locator("#settings-dialog").waitFor({ state: "visible" });
  assert(await page.locator("#settings-dialog").getAttribute("aria-modal") === "true", `${contextLabel}: settings dialog lacks aria-modal`);
  for (const value of ["fireworks", "confetti", "aurora", "spark", "random", "off"]) {
    assert(await page.locator(`#celebration-effect option[value="${value}"]`).count() === 1, `${contextLabel}: ${value} celebration option missing`);
  }
  assert(await page.locator("#celebration-duration").inputValue() === "short", `${contextLabel}: celebration duration is not short by default`);
  assert(await page.locator("#celebration-intensity").inputValue() === "low", `${contextLabel}: celebration intensity is not low by default`);
  const dialogBox = await page.locator("#settings-dialog").boundingBox();
  assert(dialogBox && dialogBox.width <= viewport.width, `${contextLabel}: settings dialog overflows`);
  await page.locator("#close-settings").focus(); await page.keyboard.press("Shift+Tab");
  assert(await page.locator("#settings-dialog").evaluate((dialog) => dialog.contains(document.activeElement)), `${contextLabel}: Shift+Tab escaped settings dialog`);
  await page.keyboard.press("Escape"); await page.locator("#settings-dialog").waitFor({ state: "hidden" });
  assert(await page.locator("#open-settings").evaluate((button) => button === document.activeElement), `${contextLabel}: settings focus was not restored`);

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator("#rail-add").click();
  await page.locator("#account-dialog").waitFor({ state: "visible" });
  assert(await page.locator("#account-dialog").getAttribute("aria-modal") === "true", `${contextLabel}: account dialog lacks aria-modal`);
  const accountDialogOverflow = await page.locator("#account-dialog").evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth);
  assert(accountDialogOverflow <= 2, `${contextLabel}: account dialog horizontal overflow is ${accountDialogOverflow}px`);
  await page.locator("#cancel-dialog").click();

  await page.locator("#mobile-challenge").evaluate((challenge) => challenge.classList.remove("hidden"));
  await page.locator("#challenge-code").evaluate((code) => { code.textContent = "42"; });
  await page.evaluate(() => document.styleSheets[0].insertRule(
    "#mobile-challenge { display: grid !important; }",
    document.styleSheets[0].cssRules.length,
  ));
  await page.locator(".challenge-card").waitFor({ state: "visible" });
  const challengeBox = await page.locator(".challenge-card").boundingBox();
  assert(challengeBox && challengeBox.width <= viewport.width, `${contextLabel}: mobile approval dialog overflows`);
  await page.locator("#mobile-challenge").evaluate((challenge) => { challenge.style.setProperty("display", "none", "important"); challenge.classList.add("hidden"); });
}

async function validateRealtimeAndReducedMotion(page, capture, contextLabel) {
  await page.locator("#sse-state").waitFor({ state: "visible" });
  assert((await page.locator("#sse-state").innerText()).toLowerCase().includes("live"), `${contextLabel}: SSE did not enter live state`);
  const sourceOptions = await page.evaluate(() => ({
    withCredentials: globalThis.__fakeSseLatest?.withCredentials,
    url: globalThis.__fakeSseLatest?.url,
    credentials: globalThis.__apiFetchCredentials,
  }));
  assert(sourceOptions.withCredentials === true, `${contextLabel}: SSE does not include same-origin credentials`);
  assert(sourceOptions.credentials.length > 0 && sourceOptions.credentials.every((value) => value === "same-origin"), `${contextLabel}: API fetch omitted same-origin credentials`);

  await page.evaluate(() => globalThis.__fakeSseLatest.emit("quota_reset", { eventType: "quota_reset" }, ""));
  await page.waitForTimeout(50);
  assert(!(await page.locator("#celebration-canvas").getAttribute("class")).includes("active"), `${contextLabel}: non-durable reset animated`);

  await page.evaluate(() => globalThis.__fakeSseLatest.emit("quota_reset", { eventType: "quota_reset", eventId: "evt-reset-1", durable: true, title: "Quota reset confirmed" }, "evt-reset-1"));
  await page.locator("#toast").waitFor({ state: "visible" });
  const toast = (await page.locator("#toast").innerText()).toLowerCase();
  assert(toast.includes("reduced motion"), `${contextLabel}: reduced-motion reset did not use static feedback`);
  assert(!(await page.locator("#celebration-canvas").getAttribute("class")).includes("active"), `${contextLabel}: reduced-motion reset animated`);

  await page.locator("#preview-celebration-btn").click();
  assert((await page.locator("#toast").innerText()).toLowerCase().includes("reduced motion"), `${contextLabel}: preview ignored reduced motion`);
  const familyReadStart = capture.reads.length;
  await page.evaluate(() => {
    globalThis.__fakeSseLatest.emit("quota_warning", { eventType: "quota_warning", eventId: "evt-warning-2", provider: "openai-codex" }, "evt-warning-2");
    globalThis.__fakeSseLatest.emit("session_started", { eventType: "session_started", eventId: "evt-session-3", sessionId: "raw-session-secret-9999" }, "evt-session-3");
    globalThis.__fakeSseLatest.emit("host_offline", { eventType: "host_offline", eventId: "evt-host-4", hostId: "raw-host-secret-9999" }, "evt-host-4");
    globalThis.__fakeSseLatest.emit("policy_changed", { eventType: "policy_changed", eventId: "evt-policy-5" }, "evt-policy-5");
  });
  await page.waitForTimeout(400);
  const refreshed = new Set(capture.reads.slice(familyReadStart));
  for (const family of ["quotas", "sessions", "hosts", "policies", "events"]) assert(refreshed.has(family), `${contextLabel}: named SSE did not refresh ${family}`);

  const before = await page.evaluate(() => globalThis.__apiFetchCredentials.length);
  await page.evaluate(() => globalThis.__fakeSseLatest.fail());
  await page.waitForTimeout(100);
  assert((await page.locator("#sse-state").innerText()).toLowerCase().includes("reconnecting"), `${contextLabel}: SSE reconnect indicator missing`);
  await page.waitForTimeout(2_200);
  const reconnect = await page.evaluate(() => ({
    count: globalThis.__apiFetchCredentials.length,
    url: globalThis.__fakeSseLatest?.url,
    instances: globalThis.__FakeEventSource.instances.length,
  }));
  assert(reconnect.instances >= 2, `${contextLabel}: SSE did not reconnect`);
  assert(reconnect.url.includes("lastEventId=evt-policy-5"), `${contextLabel}: reconnect omitted latest Last-Event-ID cursor`);
  assert(reconnect.count - before <= 10, `${contextLabel}: polling fallback was unbounded (${reconnect.count - before} requests)`);
}

async function validateSavedOffCelebration(browser) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  await installObservatoryFixtures(page); await installBrowserProbes(page);
  await page.addInitScript(() => localStorage.setItem("ai-fleet-celebration", JSON.stringify({ effect: "off", duration: "long", intensity: "high" })));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  assert(await page.locator("#celebration-effect").inputValue() === "off", "saved Off celebration was not hydrated");
  await page.evaluate(() => globalThis.__fakeSseLatest.emit("quota_reset", { eventType: "quota_reset", eventId: "evt-off-reset", provider: "openai-codex" }, "evt-off-reset"));
  await page.waitForTimeout(100);
  assert(!(await page.locator("#celebration-canvas").getAttribute("class")).includes("active"), "saved Off celebration animated without reduced motion");
  await context.close();
}
async function validateBrowser(name, browserType) {

  let browser;
  try {
    browser = await browserType.launch({ headless: true });
  } catch (error) {
    process.stdout.write(`skip ${name}: ${error instanceof Error ? error.message.split("\n")[0] : error}\n`);
    return;
  }

  try {
    const requestedViewport = process.env.UI_SMOKE_VIEWPORT?.trim().toLowerCase();
    for (const viewport of viewports) {
      if (requestedViewport && requestedViewport !== viewport.label) continue;
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, reducedMotion: "reduce" });
      const page = await context.newPage();
      const capture = await installObservatoryFixtures(page);
      await installBrowserProbes(page);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
      const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
      const contextLabel = `${name}/${viewport.label}`;
      assert(response?.ok(), `${contextLabel}: dashboard failed to load`);
      assert(response.headers()["content-security-policy"]?.includes("default-src 'self'"), `${contextLabel}: CSP missing`);

      if (name === "chromium" && viewport.label === "desktop") {
        const healthResponse = await context.request.get(`${baseUrl}/api/health`);
        assert(healthResponse.ok(), `health returned ${healthResponse.status()}`);
        const rejectedOrigin = await context.request.post(`${baseUrl}/api/not-a-route`, { headers: { origin: "https://attacker.invalid", "content-type": "application/json" }, data: {} });
        assert(rejectedOrigin.status() === 403, `mutation with a foreign origin returned ${rejectedOrigin.status()}`);
        const rejectedHost = await context.request.get(baseUrl, { headers: { host: "attacker.invalid" } });
        assert(rejectedHost.status() === 421, `request with a foreign host returned ${rejectedHost.status()}`);
      }

      await page.locator("#overview-view").waitFor({ state: "visible" });
      await validateNineViews(page, contextLabel);
      await validateObservatoryContracts(page, capture, viewport, contextLabel);
      await validateLegacyWorkflows(page, viewport, contextLabel);
      if (name === "chromium" && viewport.label === "desktop") await validateRealtimeAndReducedMotion(page, capture, contextLabel);
      assert(errors.length === 0, `${contextLabel}: browser errors: ${errors.join(" | ")}`);
      await context.close();
      process.stdout.write(`ok ${contextLabel}\n`);
    }
    if (name === "chromium" && (!requestedViewport || requestedViewport === "desktop")) await validateSavedOffCelebration(browser);
  } finally {
    await browser.close();
  }
}

const requestedBrowser = process.env.UI_SMOKE_BROWSER?.trim().toLowerCase();
for (const [name, browserType] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  if (requestedBrowser && requestedBrowser !== name) continue;
  await validateBrowser(name, browserType);
}
