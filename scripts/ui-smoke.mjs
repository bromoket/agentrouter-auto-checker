import { chromium, firefox, webkit } from "playwright";

const baseUrl = process.env.DASHBOARD_URL || "http://127.0.0.1:3100";

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    for (const viewport of [
      { width: 1440, height: 900, label: "desktop" },
      { width: 768, height: 900, label: "tablet" },
      { width: 390, height: 844, label: "mobile" },
    ]) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const response = await page.goto(baseUrl, { waitUntil: "networkidle" });
      assert(response?.ok(), `${name}/${viewport.label}: dashboard failed to load`);
      assert(response.headers()["content-security-policy"]?.includes("default-src 'self'"), `${name}/${viewport.label}: CSP missing`);
      if (name === "chromium" && viewport.label === "desktop") {
        const healthResponse = await context.request.get(`${baseUrl}/api/health`);
        assert(healthResponse.ok(), `health returned ${healthResponse.status()}`);
        const health = await healthResponse.json();
        assert(health.status === "ok", "health response was not ok");
        const rejectedOrigin = await context.request.post(`${baseUrl}/api/not-a-route`, {
          headers: { origin: "https://attacker.invalid", "content-type": "application/json" },
          data: {},
        });
        assert(rejectedOrigin.status() === 403, `mutation with a foreign origin returned ${rejectedOrigin.status()}`);
        const rejectedHost = await context.request.get(baseUrl, { headers: { host: "attacker.invalid" } });
        assert(rejectedHost.status() === 421, `request with a foreign host returned ${rejectedHost.status()}`);
      }
      await page.locator("#overview-view").waitFor({ state: "visible" });
      assert(await page.locator("#overview-money-chart").isVisible(), `${name}/${viewport.label}: overview chart hidden`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert(overflow <= 2, `${name}/${viewport.label}: horizontal overflow is ${overflow}px`);

      const accountButton = page.locator("#account-list .nav-card").first();
      if (await accountButton.count()) {
        await accountButton.click();
        await page.locator("#account-view").waitFor({ state: "visible" });
        await page.locator("#money-chart").waitFor({ state: "visible" });
        const rawText = (await page.locator("#account-view").innerText()).toLowerCase();
        assert(!rawText.includes("null") && !rawText.includes("undefined"), `${name}/${viewport.label}: raw null value rendered`);
        const chartCount = await page.locator("#account-view canvas").count();
        assert(chartCount >= 5, `${name}/${viewport.label}: expected interactive account charts`);

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
      const dialogBox = await page.locator("#settings-dialog").boundingBox();
      assert(dialogBox && dialogBox.width <= viewport.width, `${name}/${viewport.label}: settings dialog overflows`);
      await page.locator("#settings-dialog").evaluate((dialog) => dialog.close());

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator("#rail-add").click();
      await page.locator("#account-dialog").waitFor({ state: "visible" });
      const accountDialogOverflow = await page.locator("#account-dialog").evaluate(
        (dialog) => dialog.scrollWidth - dialog.clientWidth,
      );
      assert(accountDialogOverflow <= 2, `${name}/${viewport.label}: account dialog horizontal overflow is ${accountDialogOverflow}px`);
      await page.locator("#account-dialog").evaluate((dialog) => dialog.close());

      await page.locator("#mobile-challenge").evaluate((challenge) => challenge.classList.remove("hidden"));
      await page.locator("#challenge-code").evaluate((code) => { code.textContent = "42"; });
      await page.evaluate(() => document.styleSheets[0].insertRule(
        "#mobile-challenge { display: grid !important; }",
        document.styleSheets[0].cssRules.length,
      ));
      await page.locator(".challenge-card").waitFor({ state: "visible" });
      const challengeBox = await page.locator(".challenge-card").boundingBox();
      assert(challengeBox && challengeBox.width <= viewport.width, `${name}/${viewport.label}: Mobile approval dialog overflows`);

      assert(errors.length === 0, `${name}/${viewport.label}: browser errors: ${errors.join(" | ")}`);
      await context.close();
      process.stdout.write(`ok ${name}/${viewport.label}\n`);
    }
  } finally {
    await browser.close();
  }
}

for (const [name, browserType] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]]) {
  await validateBrowser(name, browserType);
}
