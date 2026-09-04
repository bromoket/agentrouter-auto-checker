import { access, chmod, lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import path from "node:path";
import { chromium } from "playwright";
import { parseLabeledNumber } from "./agentrouter-money.mjs";

const USAGE_WINDOWS = [
  { granularity: "hour", seconds: 24 * 60 * 60 },
  { granularity: "day", seconds: 7 * 24 * 60 * 60 },
  // AgentRouter rejects spans over one calendar month; 28 days remains valid in every month.
  { granularity: "week", seconds: 28 * 24 * 60 * 60 },
];

let cancellationRequested = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throwIfCancelled() {
  if (cancellationRequested) {
    throw new Error("Check cancelled; cleaning up the authenticated AgentRouter session.");
  }
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function progress(stage, message, percent) {
  emit({
    type: "progress",
    progress: {
      stage,
      message,
      percent,
      at: new Date().toISOString(),
    },
  });
}

function errorText(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

class AgentRouterAccessVerificationRequired extends Error {
  constructor(message) {
    super(message);
    this.name = "AgentRouterAccessVerificationRequired";
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function launchAccountContext(profilePath, config) {
  const launchOptions = {
    channel: config.browserChannel,
    headless: config.browserHeadless,
    args: config.disableWebAuthn
      ? ["--disable-features=WebAuthentication,WebAuthenticationUI,WebAuthenticationConditionalUI"]
      : [],
  };
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return {
        context: await chromium.launchPersistentContext(profilePath, launchOptions),
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /target page, context or browser has been closed|browser closed|failed to launch/i.test(message);
      if (!retryable || attempt === 2) throw error;
      progress("launch-retry", "Chromium exited during launch; retrying the isolated profile once.", 6);
      await wait(1_500);
      throwIfCancelled();
    }
  }
  throw lastError;
}

async function restrictSecretFile(filePath) {
  if (process.platform !== "win32") {
    await chmod(filePath, 0o600);
    return;
  }
  const username = process.env.USERNAME?.trim();
  if (!username) {
    throw new Error("Cannot restrict browser state because USERNAME is unavailable.");
  }
  await new Promise((resolve, reject) => {
    const child = spawn(
      "icacls",
      [
        filePath,
        "/inheritance:r",
        "/grant:r",
        `${username}:(F)`,
        "*S-1-5-18:(F)",
        "*S-1-5-32-544:(F)",
      ],
      { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Failed to restrict browser state ACL: ${stderr.trim()}`));
    });
  });
}

async function restrictSecretDirectory(directoryPath) {
  if (process.platform !== "win32") {
    await chmod(directoryPath, 0o700);
    return;
  }
  const username = process.env.USERNAME?.trim();
  if (!username) {
    throw new Error("Cannot restrict the browser profile because USERNAME is unavailable.");
  }
  await new Promise((resolve, reject) => {
    const child = spawn(
      "icacls",
      [
        directoryPath,
        "/inheritance:r",
        "/grant:r",
        `${username}:(OI)(CI)(F)`,
        "*S-1-5-18:(OI)(CI)(F)",
        "*S-1-5-32-544:(OI)(CI)(F)",
      ],
      { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Failed to restrict browser profile ACL: ${stderr.trim()}`));
    });
  });
}
async function validateScreenshotAncestors(targetPath) {
  if (process.platform === "win32") {
    throw new Error("Screenshot operations are unsupported on Windows.");
  }
  const resolved = path.resolve(targetPath);
  const segments = [];
  let current = resolved;
  while (current && current !== "/" && current !== path.dirname(current)) {
    segments.unshift(current);
    current = path.dirname(current);
  }
  segments.unshift("/");

  for (const segment of segments) {
    try {
      const stats = await lstat(segment);
      if (stats.isSymbolicLink()) {
        throw new Error(`Screenshot path ancestor is a symbolic link: ${segment}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`Screenshot path ancestor is not a directory: ${segment}`);
      }
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
}

async function openSecureScreenshotDirectory(directoryPath) {
  if (process.platform === "win32") {
    throw new Error("Screenshot operations are unsupported on Windows.");
  }
  const resolved = path.resolve(directoryPath);
  await validateScreenshotAncestors(resolved);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  await chmod(resolved, 0o700);

  const stats = await lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Screenshot path is not a directory or is a symbolic link.");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("Screenshot root owner UID does not match process UID.");
  }
  if ((stats.mode & 0o777) !== 0o700) {
    throw new Error("Screenshot root directory mode must be strictly 0700.");
  }

  const handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  const handleStats = await handle.stat();
  if (handleStats.dev !== stats.dev || handleStats.ino !== stats.ino) {
    await handle.close();
    throw new Error("Screenshot root directory identity changed during open.");
  }
  return { handle, rootPath: resolved, dev: handleStats.dev, ino: handleStats.ino };
}

function filterGithubState(state) {
  return {
    cookies: state.cookies.filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, "").toLowerCase();
      return domain === "github.com" || domain.endsWith(".github.com");
    }),
    origins: state.origins.filter((entry) => {
      try {
        const hostname = new URL(entry.origin).hostname.toLowerCase();
        return hostname === "github.com" || hostname.endsWith(".github.com");
      } catch {
        return false;
      }
    }),
  };
}

async function loadGithubState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    const state = filterGithubState({
      cookies: Array.isArray(parsed?.cookies) ? parsed.cookies : [],
      origins: Array.isArray(parsed?.origins) ? parsed.origins : [],
    });
    return state.cookies.length > 0 ? state : null;
  } catch {
    return null;
  }
}

async function persistGithubState(context, statePath) {
  const githubState = filterGithubState(await context.storageState());
  if (githubState.cookies.length === 0) {
    throw new Error("Authenticated GitHub state did not contain reusable cookies.");
  }
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(githubState)}\n`, { mode: 0o600, flag: "wx" });
    await restrictSecretFile(temporaryPath);
    await rename(temporaryPath, statePath);
    await restrictSecretFile(statePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function filterAgentRouterState(state, baseUrl) {
  const host = new URL(baseUrl).hostname.toLowerCase();
  return {
    cookies: state.cookies.filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, "").toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    }),
    origins: state.origins.filter((entry) => entry.origin === baseUrl),
  };
}

async function persistAgentRouterState(context, statePath, baseUrl) {
  const state = filterAgentRouterState(await context.storageState(), baseUrl);
  if (state.cookies.length === 0) {
    throw new Error("Authenticated AgentRouter state did not contain reusable cookies.");
  }
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    await restrictSecretFile(temporaryPath);
    await rename(temporaryPath, statePath);
    await restrictSecretFile(statePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function markProfileReady(profilePath) {
  const markerPath = path.join(profilePath, ".agentrouter-profile-ready");
  await writeFile(markerPath, `${new Date().toISOString()}\n`, { mode: 0o600 });
  await restrictSecretFile(markerPath);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPageAtConfiguredOrigin(page, baseUrl) {
  try {
    return new URL(page.url()).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

function isGitHubPage(page) {
  try {
    return new URL(page.url()).origin === "https://github.com";
  } catch {
    return false;
  }
}

async function isVisible(locator) {
  return locator.isVisible().catch(() => false);
}

async function readStoredUser(page) {
  const value = await page
    .evaluate(() => {
      const raw = localStorage.getItem("user");
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .catch(() => null);

  if (!value || typeof value !== "object") {
    return null;
  }
  const id = Number(value.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  return { ...value, id };
}

async function hasExpectedStoredUser(page, baseUrl, userId) {
  const expectedOrigin = new URL(baseUrl).origin;
  return page.evaluate(({ expectedOrigin, expectedUserId }) => {
    if (location.origin !== expectedOrigin) return false;
    const raw = localStorage.getItem("user");
    if (!raw) return false;
    try {
      return Number(JSON.parse(raw).id) === expectedUserId;
    } catch {
      return false;
    }
  }, { expectedOrigin, expectedUserId: userId });
}

async function clearExpectedStoredUser(page, baseUrl, userId) {
  const expectedOrigin = new URL(baseUrl).origin;
  return page.evaluate(({ expectedOrigin, expectedUserId }) => {
    if (location.origin !== expectedOrigin) return false;
    const raw = localStorage.getItem("user");
    if (raw !== null) {
      try {
        if (Number(JSON.parse(raw).id) !== expectedUserId) return false;
      } catch {
        return false;
      }
      localStorage.removeItem("user");
    }
    return localStorage.getItem("user") === null;
  }, { expectedOrigin, expectedUserId: userId });
}

function apiHeaders(userId) {
  return {
    "New-API-User": String(userId),
    "Cache-Control": "no-store",
  };
}

async function collectJson(request, baseUrl, pathName, timeoutMs, headers, apiCalls) {
  const started = Date.now();
  try {
    const response = await request.get(`${baseUrl}${pathName}`, {
      timeout: timeoutMs,
      headers,
      failOnStatusCode: false,
    });
    const contentType = response.headers()["content-type"] ?? "";
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    const call = {
      path: pathName,
      method: "GET",
      status: response.status(),
      ok: response.ok() && data !== null && (data?.success === undefined || data.success === true),
      latencyMs: Date.now() - started,
      responsePath: (() => {
        try {
          const url = new URL(response.url());
          return `${url.origin}${url.pathname}`;
        } catch {
          return "unknown";
        }
      })(),
      contentType: contentType.slice(0, 120),
    };
    if (!call.ok && typeof data?.message === "string") {
      call.error = data.message.slice(0, 500);
    } else if (!call.ok && contentType.toLowerCase().includes("text/html")) {
      call.error = "Expected JSON but AgentRouter returned an HTML access-verification page.";
    }
    apiCalls.push(call);
    return { ...call, data };
  } catch (error) {
    const call = {
      path: pathName,
      method: "GET",
      status: 0,
      ok: false,
      latencyMs: Date.now() - started,
      error: errorText(error).slice(0, 500),
    };
    apiCalls.push(call);
    return { ...call, data: null };
  }
}

async function collectAuthenticatedUser(request, baseUrl, timeoutMs, headers, apiCalls) {
  const deadline = Date.now() + Math.min(timeoutMs, 12_000);
  let response;
  let lastDiagnostic = "no response";
  do {
    throwIfCancelled();
    response = await collectJson(
      request,
      baseUrl,
      "/api/user/self",
      timeoutMs,
      headers,
      apiCalls,
    );
    if (response.contentType?.toLowerCase().includes("text/html")) {
      throw new AgentRouterAccessVerificationRequired(
        "AgentRouter's /api/user/self endpoint was intercepted by its access-verification page.",
      );
    }
    const wrappedUser = response.data?.data;
    const candidateUser = wrappedUser && typeof wrappedUser === "object"
      ? wrappedUser
      : response.data && typeof response.data === "object"
        ? response.data
        : null;
    if (response.ok && candidateUser && Number.isSafeInteger(Number(candidateUser.id)) && Number(candidateUser.id) > 0) {
      return candidateUser;
    }
    const dataType = response.data?.data === null
      ? "null"
      : Array.isArray(response.data?.data)
        ? "array"
        : typeof response.data?.data;
    const message = typeof response.data?.message === "string"
      ? response.data.message.slice(0, 160)
      : "no message";
    const keys = response.data && typeof response.data === "object"
      ? Object.keys(response.data).slice(0, 12).join(",") || "none"
      : "not-an-object";
    lastDiagnostic = `status ${response.status}, path ${response.responsePath}, type ${response.contentType || "unknown"}, data ${dataType}, keys ${keys}, message: ${message}`;
    await wait(500);
  } while (Date.now() < deadline);
  throw new Error(
    `Authenticated /api/user/self did not become ready after OAuth for user ${headers["New-API-User"]} (${lastDiagnostic}).`,
  );
}

function agentRouterPageRank(page, baseUrl) {
  try {
    const candidate = new URL(page.url());
    const expected = new URL(baseUrl);
    if (candidate.origin !== expected.origin) return Number.POSITIVE_INFINITY;
    if (candidate.pathname === "/console" || candidate.pathname.startsWith("/console/")) return 0;
    if (candidate.pathname === "/oauth/github") return 1;
    if (candidate.pathname === "/login") return 2;
    return 3;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function agentRouterPages(context, baseUrl) {
  return context
    .pages()
    .filter((candidate) => !candidate.isClosed() && agentRouterPageRank(candidate, baseUrl) < Number.POSITIVE_INFINITY)
    .sort((left, right) => agentRouterPageRank(left, baseUrl) - agentRouterPageRank(right, baseUrl));
}

async function clickGithubLogin(page, timeoutMs) {
  const context = page.context();
  const originalPages = new Set(context.pages());
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  const popupPromise = context.waitForEvent("page", { timeout: 30_000 }).catch(() => null);

  let lastClickError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const githubButton = page
      .getByRole("button", { name: /continue with github|使用 github 继续/i })
      .filter({ visible: true })
      .first();
    await githubButton.waitFor({ state: "visible", timeout: timeoutMs });
    try {
      await githubButton.click({ timeout: 5_000, force: attempt > 0 });
      lastClickError = null;
      break;
    } catch (error) {
      lastClickError = error;
      await wait(350);
    }
  }
  if (lastClickError) {
    throw lastClickError;
  }

  const capturedPopup = await Promise.race([
    popupPromise,
    wait(5_000).then(() => null),
  ]);
  if (capturedPopup) {
    await capturedPopup.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
    return capturedPopup;
  }

  const navigationDeadline = Date.now() + 10_000;
  while (Date.now() < navigationDeadline) {
    const currentPages = context.pages().filter((candidate) => !candidate.isClosed());
    const returnedPopup = currentPages.find(
      (candidate) => !originalPages.has(candidate) && candidate.url() !== "about:blank",
    );
    const oauthPage = currentPages.find((candidate) => candidate.url().includes("github.com/"));
    if (oauthPage || returnedPopup) {
      const candidate = oauthPage ?? returnedPopup;
      await candidate.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
      return candidate;
    }
    for (const candidate of currentPages) {
      if (candidate.url().startsWith("https://agentrouter.org") && await readStoredUser(candidate)) {
        return candidate;
      }
    }
    await wait(200);
  }
  return page;
}

async function openGithubOAuthPage(page, baseUrl, timeoutMs) {
  if (!isPageAtConfiguredOrigin(page, baseUrl)) {
    throw new Error("AgentRouter OAuth setup requires the configured origin.");
  }
  const expectedOrigin = new URL(baseUrl).origin;
  const oauth = await page.evaluate(async (expectedOrigin) => {
    if (location.origin !== expectedOrigin) {
      throw new Error("AgentRouter OAuth setup left the configured origin.");
    }
    const statusResponse = await fetch("/api/status", {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (
      new URL(statusResponse.url).origin !== expectedOrigin ||
      !statusResponse.headers.get("content-type")?.toLowerCase().includes("application/json")
    ) {
      throw new Error("AgentRouter status response was not trusted JSON.");
    }
    const statusPayload = await statusResponse.json();
    const status = statusPayload?.data ?? statusPayload ?? {};
    const stateResponse = await fetch("/api/oauth/state?mode=login", {
      credentials: "include",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (
      new URL(stateResponse.url).origin !== expectedOrigin ||
      !stateResponse.headers.get("content-type")?.toLowerCase().includes("application/json")
    ) {
      throw new Error("AgentRouter OAuth state response was not trusted JSON.");
    }
    const statePayload = await stateResponse.json();
    if (!stateResponse.ok || statePayload?.success !== true || typeof statePayload.data !== "string") {
      throw new Error(statePayload?.message || "AgentRouter did not issue a GitHub OAuth state.");
    }
    localStorage.setItem("oauth_mode", "login");
    return {
      clientId: status.github_client_id,
      state: statePayload.data,
    };
  }, expectedOrigin);

  if (typeof oauth.clientId !== "string" || !/^[A-Za-z0-9_-]{5,100}$/.test(oauth.clientId)) {
    throw new Error("AgentRouter did not expose a valid GitHub OAuth client id.");
  }
  if (typeof oauth.state !== "string" || oauth.state.length < 10 || oauth.state.length > 8_000) {
    throw new Error("AgentRouter returned an invalid GitHub OAuth state.");
  }

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", oauth.clientId);
  authorizeUrl.searchParams.set("state", oauth.state);
  authorizeUrl.searchParams.set("scope", "user:email");
  const oauthPage = await page.context().newPage();
  await oauthPage.goto(authorizeUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: timeoutMs,
  });
  if (!isGitHubPage(oauthPage) && !isPageAtConfiguredOrigin(oauthPage, baseUrl)) {
    throw new Error("GitHub OAuth navigated to an unexpected origin.");
  }
  return oauthPage;
}

async function isTwoFactorPrompt(page) {
  const selectors = [
    'input[name="app_otp"]:visible',
    'input[name="otp"]:visible',
    'input[autocomplete="one-time-code"]:visible',
  ];
  for (const selector of selectors) {
    if (await isVisible(page.locator(selector).first())) {
      return true;
    }
  }
  const text = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  return (
    text.includes("two-factor authentication") ||
    text.includes("authentication code") ||
    text.includes("verification code") ||
    text.includes("github mobile")
  );
}

async function activateGithubMobile(page) {
  const pageText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  if (
    pageText.includes("sign-in request on your github mobile") ||
    pageText.includes("approve the request to verify your identity")
  ) {
    return true;
  }
  const mobileOption = page
    .getByRole("button", { name: /github mobile/i })
    .or(page.getByRole("link", { name: /github mobile/i }))
    .filter({ visible: true })
    .first();
  if (await isVisible(mobileOption)) {
    await mobileOption.click({ timeout: 10_000 });
    await wait(500);
    return true;
  }

  const otherMethod = page
    .getByRole("button", { name: /more options|other authentication|different method|other method/i })
    .or(page.getByRole("link", { name: /more options|other authentication|different method|other method/i }))
    .filter({ visible: true })
    .first();
  if (await isVisible(otherMethod)) {
    await otherMethod.click({ timeout: 10_000 });
    await wait(500);
    const revealedMobile = page
      .getByRole("button", { name: /github mobile/i })
      .or(page.getByRole("link", { name: /github mobile/i }))
      .filter({ visible: true })
      .first();
    if (await isVisible(revealedMobile)) {
      await revealedMobile.click({ timeout: 10_000 });
      await wait(500);
      return true;
    }
  }
  return false;
}

async function readGithubMobileCode(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    for (const element of document.querySelectorAll("body *")) {
      if (element.children.length > 0 || !visible(element)) continue;
      const text = element.textContent?.trim() ?? "";
      const context = element.parentElement?.textContent?.toLowerCase() ?? "";
      if (
        /^\d{2}$/.test(text) &&
        /github mobile|verification|sign.?in|authenticate/.test(context)
      ) {
        return text;
      }
    }
    const body = document.body.innerText;
    const patterns = [
      /(?:enter|type)[^\n]{0,120}(?:number|code)[^\d]{0,40}(\d{2})\b/i,
      /(?:number|code)[^\d]{0,40}(\d{2})\b[^\n]{0,120}(?:github mobile|mobile app)/i,
    ];
    for (const pattern of patterns) {
      const match = body.match(pattern);
      if (match) return match[1];
    }
    return null;
  });
}

async function describeGithubPage(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText?.toLowerCase() ?? "";
    return {
      pathname: location.pathname,
      title: document.title.slice(0, 120),
      hasPasskey: /security key|passkey|webauthn/.test(text),
      hasExpired: /request (?:has )?expired|verification (?:has )?expired|try again/.test(text),
      hasCaptcha: /captcha|verify you are human/.test(text),
      hasBadCredentials: /incorrect username or password|incorrect password/.test(text),
    };
  }).catch(() => ({
    pathname: "/unknown",
    title: "GitHub",
    hasPasskey: false,
    hasExpired: false,
    hasCaptcha: false,
    hasBadCredentials: false,
  }));
}

async function completeGithubAuthentication(page, account, config) {
  const context = page.context();
  const deadline = Date.now() + config.loginTimeoutMs + config.authChallengeTimeoutMs;
  const accountName = escapeRegExp(account.githubUsername);
  let credentialsSubmitted = false;
  let twoFactorNoticeShown = false;
  let mobileMethodAttempted = false;
  let activeMobileCode = null;
  let workerChallengeId = null;
  let mobileChallengePublished = false;
  let lastHeartbeatAt = 0;
  let lastPageFingerprint = "";
  const authenticationStartedAt = Date.now();

  while (Date.now() < deadline) {
    throwIfCancelled();
    for (const agentRouterPage of agentRouterPages(context, config.baseUrl)) {
      const authenticatedUser = await readStoredUser(agentRouterPage);
      if (authenticatedUser && agentRouterPageRank(agentRouterPage, config.baseUrl) === 0) {
        if (workerChallengeId) {
          emit({ type: "challenge-complete", workerChallengeId });
        }
        progress(
          "authenticated",
          `GitHub approved the sign-in and AgentRouter reached ${new URL(agentRouterPage.url()).pathname}.`,
          42,
        );
        return { credentialsSubmitted, page: agentRouterPage };
      }
    }

    if (page.isClosed() || !isGitHubPage(page)) {
      const githubPage = [...context.pages()]
        .reverse()
        .find((candidate) => !candidate.isClosed() && isGitHubPage(candidate));
      if (githubPage) {
        page = githubPage;
      } else {
        if (Date.now() - lastHeartbeatAt >= 15_000) {
          progress(
            "oauth-callback",
            "The trusted GitHub popup may have completed too quickly to observe; waiting for AgentRouter's authenticated callback state.",
            30,
          );
          lastHeartbeatAt = Date.now();
        }
        await wait(300);
        continue;
      }
    }

    const accountButton = page
      .getByRole("button", {
        name: new RegExp(`^(?:(?:continue as|select)\\s+)?${accountName}$`, "i"),
      })
      .or(page.getByRole("link", {
        name: new RegExp(`^(?:(?:continue as|select)\\s+)?${accountName}$`, "i"),
      }))
      .filter({ visible: true })
      .first();
    if (await isVisible(accountButton)) {
      log(`[${account.label}] selecting the requested GitHub account`);
      await accountButton.click({ timeout: 10_000 });
      await wait(500);
      continue;
    }

    const passwordMethod = page
      .getByRole("button", { name: /sign in with password|use password|password instead/i })
      .or(page.getByRole("link", { name: /sign in with password|use password|password instead/i }))
      .filter({ visible: true })
      .first();
    if (!credentialsSubmitted && await isVisible(passwordMethod)) {
      progress("github-password", "GitHub offered multiple methods; selecting username and password.", 25);
      await passwordMethod.click({ timeout: 10_000 });
      await wait(500);
      continue;
    }

    const loginInput = page.locator('input[name="login"]:visible, input#login_field:visible').first();
    const passwordInput = page
      .locator('input[name="password"]:visible, input#password:visible')
      .first();
    if (await isVisible(loginInput)) {
      await loginInput.fill(account.githubUsername);
      await passwordInput.waitFor({ state: "visible", timeout: 10_000 });
      await passwordInput.fill(account.githubPassword);
      const loginForm = passwordInput.locator("xpath=ancestor::form[1]");
      const submit = loginForm
        .locator(
          'button[type="submit"]:visible, input[type="submit"][value="Sign in"]:visible',
        )
        .first();
      await submit.click({ timeout: 10_000 });
      credentialsSubmitted = true;
      progress("github-credentials", "GitHub credentials accepted; checking the second factor.", 28);
      await wait(750);
      continue;
    }

    const authorize = page
      .getByRole("button", { name: /authorize agentrouter|authorize/i })
      .filter({ visible: true })
      .first();
    if (await isVisible(authorize)) {
      await authorize.click({ timeout: 10_000 });
      await wait(500);
      continue;
    }

    const postApprovalContinue = page
      .getByRole("button", { name: /^(?:continue|return to agentrouter|authorize agentrouter)$/i })
      .or(page.getByRole("link", { name: /^(?:continue|return to agentrouter)$/i }))
      .filter({ visible: true })
      .first();
    if (mobileChallengePublished && await isVisible(postApprovalContinue)) {
      progress("github-approved", "GitHub Mobile approval was accepted; continuing the OAuth redirect.", 39);
      await postApprovalContinue.click({ timeout: 10_000 });
      await wait(500);
      continue;
    }

    if (await isTwoFactorPrompt(page)) {
      if (!mobileMethodAttempted) {
        await activateGithubMobile(page);
        mobileMethodAttempted = true;
      }
      const verificationCode = await readGithubMobileCode(page);
      if (!mobileChallengePublished || verificationCode !== activeMobileCode) {
        if (workerChallengeId) {
          emit({ type: "challenge-complete", workerChallengeId });
        }
        workerChallengeId = randomUUID();
        activeMobileCode = verificationCode;
        mobileChallengePublished = true;
        emit({
          type: "challenge",
          challenge: {
            workerChallengeId,
            accountId: account.id,
            accountLabel: account.label,
            kind: "github-mobile",
            prompt: verificationCode
              ? "Open GitHub Mobile and enter this two-digit verification number."
              : "Open GitHub Mobile and approve the sign-in request.",
            verificationCode,
            expiresInMs: config.authChallengeTimeoutMs,
          },
        });
        progress(
          "github-mobile",
          verificationCode
            ? `GitHub Mobile is waiting for verification number ${verificationCode}.`
            : "GitHub Mobile is waiting for approval on the phone.",
          34,
        );
        log(`[${account.label}] waiting for GitHub Mobile approval`);
      }
      await wait(750);
      continue;
    }

    const differentAccount = page
      .getByRole("link", { name: /use a different account/i })
      .filter({ visible: true })
      .first();
    if (!credentialsSubmitted && await isVisible(differentAccount)) {
      await differentAccount.click({ timeout: 10_000 });
      await wait(500);
      continue;
    }

    const pageState = await describeGithubPage(page);
    if (pageState.hasBadCredentials) {
      throw new Error("GitHub rejected the configured username or password.");
    }
    if (pageState.hasCaptcha) {
      throw new Error("GitHub requires a human verification challenge in the visible browser.");
    }
    if (pageState.hasExpired && mobileChallengePublished) {
      throw new Error("GitHub Mobile reported that the approval request expired before OAuth completed.");
    }
    const fingerprint = `${pageState.pathname}|${pageState.title}|${pageState.hasPasskey}`;
    if (fingerprint !== lastPageFingerprint || Date.now() - lastHeartbeatAt >= 30_000) {
      const elapsedSeconds = Math.round((Date.now() - authenticationStartedAt) / 1_000);
      const message = pageState.hasPasskey
        ? `GitHub is showing a passkey/security-key route at ${pageState.pathname}; looking for the password or Mobile fallback (${elapsedSeconds}s).`
        : `GitHub OAuth is at ${pageState.pathname} (${pageState.title || "GitHub"}); waiting for the next control (${elapsedSeconds}s).`;
      progress("github-waiting", message, 24);
      lastHeartbeatAt = Date.now();
      lastPageFingerprint = fingerprint;
    }

    await wait(500);
  }

  if (workerChallengeId) {
    emit({ type: "challenge-complete", workerChallengeId });
  }

  if (mobileChallengePublished) {
    throw new Error("GitHub Mobile approval did not complete before the authentication timeout.");
  }
  throw new Error(
    "GitHub authentication did not reach AgentRouter or expose a usable GitHub Mobile challenge before the timeout. " +
      "Confirm the configured account can use username/password and that GitHub Mobile approval is available.",
  );
}

async function waitForAgentRouterUser(context, baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfCancelled();
    for (const candidate of agentRouterPages(context, baseUrl)) {
      if (agentRouterPageRank(candidate, baseUrl) !== 0) continue;
      const user = await readStoredUser(candidate);
      if (user) {
        await candidate.locator("main").waitFor({ state: "visible", timeout: 10_000 });
        await candidate.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        // The deployed callback updates shared storage before the console finishes its own API boot.
        // A short settle prevents us from racing that real, observed post-OAuth transition.
        await wait(2_000);
        return { page: candidate, user };
      }
    }
    await wait(400);
  }
  throw new Error("AgentRouter completed OAuth but did not expose an authenticated user session.");
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function integer(value, fallback = 0) {
  return Math.max(0, Math.trunc(finiteNumber(value, fallback)));
}

function safeUserSnapshot(user) {
  const allowed = [
    "id",
    "username",
    "display_name",
    "role",
    "status",
    "group",
  ];
  return Object.fromEntries(allowed.filter((key) => key in user).map((key) => [key, user[key]]));
}

function safeRecentLogs(payload) {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.items)
      ? payload.items
      : [];
  const allowed = [
    "id",
    "created_at",
    "type",
    "model_name",
    "token_name",
    "prompt_tokens",
    "completion_tokens",
    "quota",
    "response_time",
    "first_response_time",
    "group",
    "is_stream",
    "content",
  ];
  return source
    .filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const hasModel = typeof item.model_name === "string" && item.model_name.trim().length > 0;
      const hasToken = typeof item.token_name === "string" && item.token_name.trim().length > 0;
      const hasUsage =
        finiteNumber(item.prompt_tokens) > 0 ||
        finiteNumber(item.completion_tokens) > 0 ||
        finiteNumber(item.quota) > 0;
      return Number(item.type) === 2 || Number(item.type) === 4 || hasModel || hasToken || hasUsage;
    })
    .slice(0, 100)
    .map((item) => {
      const safe = Object.fromEntries(
        allowed.filter((key) => key in item).map((key) => [key, item[key]]),
      );
      if (typeof safe.content === "string") safe.content = safe.content.slice(0, 500);
      return safe;
    });
}

function creditGrantEvents(logs) {
  const dailySignIn = /(?:每日签到成功|daily\s+(?:sign[ -]?in|check[ -]?in).{0,80})(?:.|\s){0,120}?[＄$]\s*([0-9]+(?:\.[0-9]+)?)/i;
  return logs.flatMap((item) => {
    if (Number(item?.type) !== 4 || typeof item?.content !== "string") return [];
    const match = item.content.match(dailySignIn);
    const amount = Number(match?.[1]);
    if (!Number.isFinite(amount) || amount <= 0) return [];
    const occurredAt = integer(item.created_at);
    const sourceEventId = String(item.id ?? `${occurredAt}:${item.content}`).slice(0, 300);
    return [{
      sourceEventId,
      occurredAt,
      amount,
      classification: "daily-signin",
      description: item.content.slice(0, 500),
    }];
  });
}

function parseUsagePoints(accountId, granularity, payload) {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map((row) => ({
      accountId,
      granularity,
      createdAt: integer(row?.created_at),
      modelName: typeof row?.model_name === "string" ? row.model_name.slice(0, 200) : "unknown",
      requestCount: integer(row?.count),
      tokenUsed: integer(row?.token_used),
      quota: finiteNumber(row?.quota),
    }))
    .filter((row) => row.createdAt > 0);
}

function computeMetrics(user, siteStatus, usagePoints, modelPayload, windowSeconds) {
  const quotaPerUnit = Math.max(1, finiteNumber(siteStatus?.quota_per_unit, 500_000));
  const statisticalCount = usagePoints.reduce((total, point) => total + point.requestCount, 0);
  const statisticalTokens = usagePoints.reduce((total, point) => total + point.tokenUsed, 0);
  const rawStatisticalQuota = usagePoints.reduce((total, point) => total + point.quota, 0);
  // Requests use an end timestamp one hour in the future, matching AgentRouter's dashboard.
  const elapsedMinutes = Math.max(1, windowSeconds / 60 + 60);
  const models = Array.isArray(modelPayload) ? modelPayload : [];

  return {
    siteUserId: integer(user.id),
    siteUsername: typeof user.username === "string" ? user.username : undefined,
    quotaPerUnit,
    balance: finiteNumber(user.quota) / quotaPerUnit,
    consumed: finiteNumber(user.used_quota) / quotaPerUnit,
    requestCount: integer(user.request_count),
    statisticalCount,
    statisticalTokens,
    statisticalQuota: rawStatisticalQuota / quotaPerUnit,
    averageRpm: statisticalCount / elapsedMinutes,
    averageTpm: statisticalTokens / elapsedMinutes,
    availableModels: models.length,
  };
}

function visibleConsoleMetrics(text) {
  return {
    balance: parseLabeledNumber(text, "Current balance"),
    consumed: parseLabeledNumber(text, "Consumption"),
    requestCount: parseLabeledNumber(text, "Number of Requests"),
    statisticalCount: parseLabeledNumber(text, "Statistical count"),
    statisticalQuota: parseLabeledNumber(text, "Statistical quota"),
    statisticalTokens: parseLabeledNumber(text, "Statistical Tokens"),
    averageRpm: parseLabeledNumber(text, "Average RPM"),
    averageTpm: parseLabeledNumber(text, "Average TPM"),
  };
}

function visibleWalletMetrics(text) {
  return {
    balance: parseLabeledNumber(text, "Current balance"),
    consumed: parseLabeledNumber(text, "Consumption"),
  };
}

async function openUiRoute(page, config, route, apiCalls, message) {
  const started = Date.now();
  const response = await page.goto(`${config.baseUrl}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: config.requestTimeoutMs,
  });
  await page.locator("main").waitFor({ state: "visible", timeout: config.requestTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
  await wait(1_500);
  apiCalls.push({
    path: route,
    method: "UI",
    status: response?.status() ?? 0,
    ok: Boolean(response?.ok()),
    latencyMs: Date.now() - started,
    responsePath: page.url(),
    contentType: response?.headers()["content-type"]?.slice(0, 120),
  });
  if (message) progress("refreshing-agentrouter", message, 58);
}

async function readUiMetricsWithRefresh(page, config, route, parse, apiCalls, label) {
  let metrics = {};
  const samples = [];
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    throwIfCancelled();
    await openUiRoute(
      page,
      config,
      route,
      apiCalls,
      attempt > 0
        ? `${label} still showed $0.00 for both money cards; refreshed it (${attempt + 1}/${maxAttempts}).`
        : undefined,
    );
    // AgentRouter renders money cards after client hydration: the first paint almost always
    // shows $0.00. Wait for the SPA to settle before reading, otherwise every sample (including
    // post-refresh ones) catches the pre-hydration placeholder. Never parse the first paint.
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.waitForTimeout(1500);
    const mainText = await page.locator("main").innerText();
    metrics = parse(mainText);
    samples.push({
      attempt: attempt + 1,
      observedAt: new Date().toISOString(),
      balance: Number.isFinite(metrics.balance) ? metrics.balance : null,
      consumed: Number.isFinite(metrics.consumed) ? metrics.consumed : null,
    });
    if (!(metrics.balance === 0 && metrics.consumed === 0)) {
      return { metrics, samples, refreshCount: attempt };
    }
  }
  return { metrics, samples, refreshCount: maxAttempts - 1 };
}

async function readTopLevelJson(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText?.trim() ?? "";
    if (!text.startsWith("{")) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }).catch(() => null);
}

async function completeAgentRouterAccessVerification(context, page, account, config, userId, apiCalls) {
  if (config.browserHeadless) {
    throw new Error(
      "AgentRouter returned its Access Verification slider. Complete it in the server browser so the persistent profile can retain the verification state.",
    );
  }

  const verificationPage = await context.newPage();
  await verificationPage.setExtraHTTPHeaders(apiHeaders(userId));
  await verificationPage.goto(`${config.baseUrl}/api/user/self`, {
    waitUntil: "domcontentloaded",
    timeout: config.requestTimeoutMs,
  });

  const immediatePayload = await readTopLevelJson(verificationPage);
  if (immediatePayload?.success === true && immediatePayload.data?.id) {
    await verificationPage.close().catch(() => undefined);
    return;
  }

  const challengeText = (await verificationPage.locator("body").innerText().catch(() => "")).toLowerCase();
  const challengeTitle = (await verificationPage.title().catch(() => "")).toLowerCase();
  if (!challengeText.includes("access verification") && !challengeText.includes("slide to verify") && challengeTitle !== "verification") {
    throw new Error(
      `AgentRouter returned an unexpected HTML response for /api/user/self (${await verificationPage.title().catch(() => "untitled page")}).`,
    );
  }

  const workerChallengeId = randomUUID();
  emit({
    type: "challenge",
    challenge: {
      workerChallengeId,
      accountId: account.id,
      accountLabel: account.label,
      kind: "agentrouter-waf",
      prompt: "AgentRouter opened its Access Verification slider in the visible browser. Complete the slide there; this cycle will resume automatically.",
      verificationCode: null,
      expiresInMs: config.authChallengeTimeoutMs,
    },
  });
  progress(
    "agentrouter-verification",
    "AgentRouter's WAF returned the verified Access Verification slider for /api/user/self; waiting for it in the visible browser.",
    49,
  );

  const deadline = Date.now() + config.authChallengeTimeoutMs;
  let lastHeartbeatAt = Date.now();
  try {
    while (Date.now() < deadline) {
      throwIfCancelled();
      const payload = await readTopLevelJson(verificationPage);
      if (payload?.success === true && Number(payload.data?.id) === Number(userId)) {
        for (const call of apiCalls) {
          if (call.path === "/api/user/self" && !call.ok && call.contentType?.toLowerCase().includes("text/html")) {
            call.recovered = true;
          }
        }
        progress(
          "agentrouter-verified",
          "AgentRouter Access Verification completed; allowing its WAF state to settle before retrying account data.",
          51,
        );
        await wait(2_000);
        return;
      }
      if (Date.now() - lastHeartbeatAt >= 15_000) {
        progress(
          "agentrouter-verification",
          "Still waiting for the visible AgentRouter Access Verification slider to complete.",
          49,
        );
        lastHeartbeatAt = Date.now();
      }
      await wait(500);
    }
    throw new Error("AgentRouter Access Verification was not completed before the configured authentication timeout.");
  } finally {
    emit({ type: "challenge-complete", workerChallengeId });
    await verificationPage.close().catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
  }
}

async function dismissBlockingOverlays(page) {
  // AgentRouter occasionally leaves a Semi Design notice modal over the console.
  // It intercepts pointer events even though the profile button remains visible.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const modal = page.locator('.semi-modal-wrap, [role="dialog"]');
    if (!(await modal.first().isVisible().catch(() => false))) return;

    const close = page.locator(
      '.semi-modal-wrap button[aria-label*="close" i], ' +
      '.semi-modal-wrap button[aria-label*="关闭"], ' +
      '.semi-modal-wrap button:has-text("Close"), ' +
      '.semi-modal-wrap button:has-text("关闭"), ' +
      '.semi-modal-wrap button:has-text("知道了"), ' +
      '.semi-modal-wrap button:has-text("取消")',
    ).first();
    if (await close.isVisible().catch(() => false)) {
      await close.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    } else {
      await page.locator('body').press('Escape').catch(() => undefined);
    }
    await wait(250);
  }
}

async function logoutViaApi(page, config, userId, apiCalls) {
  const started = Date.now();
  const expectedOrigin = new URL(config.baseUrl).origin;
  const response = await page.evaluate(async ({ numericUserId, expectedOrigin }) => {
    if (location.origin !== expectedOrigin) return null;
    const headers = {
      Accept: 'application/json',
      'Cache-Control': 'no-store',
      'New-API-User': String(numericUserId),
    };
    const result = await fetch('/api/user/logout', {
      method: 'GET',
      credentials: 'include',
      headers,
    });
    const payload = await result.json().catch(() => null);
    const self = await fetch('/api/user/self', {
      method: 'GET',
      credentials: 'include',
      headers,
    });
    const selfContentType = self.headers.get('content-type')?.toLowerCase() ?? '';
    const selfPayload = selfContentType.includes('application/json')
      ? await self.json().catch(() => null)
      : null;
    return {
      status: result.status,
      ok:
        new URL(result.url).origin === expectedOrigin &&
        new URL(self.url).origin === expectedOrigin &&
        result.ok &&
        payload?.success === true &&
        selfContentType.includes('application/json') &&
        [200, 401, 403].includes(self.status) &&
        selfPayload?.success === false,
      contentType: result.headers.get('content-type') ?? '',
    };
  }, { numericUserId: userId, expectedOrigin }).catch(() => null);
  apiCalls.push({
    path: '/api/user/logout',
    status: response?.status ?? 0,
    ok: response?.ok === true,
    contentType: response?.contentType ?? '',
    durationMs: Date.now() - started,
    source: 'api-logout',
  });
  if (!response?.ok) return false;
  const storageCleared = await clearExpectedStoredUser(page, config.baseUrl, userId);
  if (!storageCleared) return false;
  await page.goto(`${config.baseUrl}/login`, {
    waitUntil: 'domcontentloaded',
    timeout: config.requestTimeoutMs,
  }).catch(() => undefined);
  const loginUrl = new URL(page.url());
  return loginUrl.origin === expectedOrigin && loginUrl.pathname === '/login';
}

async function isServerSessionLoggedOut(page, userId, baseUrl) {
  const expectedOrigin = new URL(baseUrl).origin;
  const observation = await page.evaluate(async ({ numericUserId, expectedOrigin }) => {
    if (location.origin !== expectedOrigin) return null;
    const response = await fetch('/api/user/self', {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'New-API-User': String(numericUserId),
      },
    });
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : null;
    return {
      loggedOut:
        new URL(response.url).origin === expectedOrigin &&
        contentType.includes('application/json') &&
        [200, 401, 403].includes(response.status) &&
        payload?.success === false,
    };
  }, { numericUserId: userId, expectedOrigin }).catch(() => null);
  return observation?.loggedOut === true;
}

async function captureAgentRouterApiToken(page, config, userId, apiCalls) {
  const started = Date.now();
  const response = await page.evaluate(async (numericUserId) => {
    const result = await fetch('/api/token/?p=0&size=100', {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Cache-Control': 'no-store',
        'New-API-User': String(numericUserId),
      },
    });
    const contentType = result.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) {
      return {
        status: result.status,
        ok: false,
        contentType,
        error: 'Expected a JSON token response.',
        payload: null,
      };
    }
    const payload = await result.json().catch(() => null);
    if (!payload) {
      return {
        status: result.status,
        ok: false,
        contentType,
        error: 'Token response was not valid JSON.',
        payload: null,
      };
    }
    return {
      status: result.status,
      ok: result.ok && payload.success === true,
      contentType,
      error: result.ok && payload.success === true
        ? undefined
        : `Token endpoint returned HTTP ${result.status} or a failed response envelope.`,
      payload,
    };
  }, userId).catch(() => null);
  apiCalls.push({
    path: '/api/token/?p=0&size=100',
    method: 'GET',
    status: response?.status ?? 0,
    ok: response?.ok === true,
    latencyMs: Date.now() - started,
    contentType: response?.contentType ?? '',
    ...(response?.error ? { error: response.error } : {}),
  });
  if (!response?.ok) return null;
  const items = Array.isArray(response.payload?.data?.items) ? response.payload.data.items : [];
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const candidates = items
    .filter((item) => item && Number(item.status) === 1)
    .filter((item) => Number(item.expired_time) <= 0 || Number(item.expired_time) > nowSeconds)
    .filter((item) => typeof item.key === 'string' && /^[A-Za-z0-9_-]{20,256}$/.test(item.key.trim()))
    .sort((left, right) => Number(right.accessed_time || right.created_time || 0) - Number(left.accessed_time || left.created_time || 0));
  return candidates[0]?.key.trim() || null;
}


// Authoritative money source: the console money cards render from /api/user/self but are
// subject to the site's known "$0 until refresh" gating. Reading the API directly (same-origin
// cookies, in-page fetch) returns quota/used_quota/request_count that map 1:1 to the displayed
// $ amounts at quotaPerUnit. Only the derived numbers are used; the raw access_token in the
// payload is never read, logged, or persisted.
async function readAuthoritativeMoneyPayload(context, config, userId) {
  try {
    const probePage = await context.newPage();
    let payload = null;
    try {
      await probePage.setExtraHTTPHeaders(apiHeaders(userId));
      await probePage.goto(`${config.baseUrl}/api/user/self`, {
        waitUntil: "domcontentloaded",
        timeout: config.requestTimeoutMs,
      });
      const text = await probePage.locator("body").innerText().catch(() => "");
      payload = text.trim().startsWith("{") ? JSON.parse(text) : null;
    } finally {
      await probePage.close().catch(() => undefined);
    }
    const data = payload && payload.success === true && payload.data ? payload.data : null;
    if (!data) return null;
    const quota = Number(data.quota);
    const used = Number(data.used_quota);
    const requests = Number(data.request_count);
    if (![quota, used, requests].every(Number.isFinite)) return null;
    return {
      balance: quota / 500_000,
      consumed: used / 500_000,
      requestCount: requests,
      apiRequestCount: requests,
    };
  } catch {
    return null;
  }
}

async function logoutAndPersist(context, page, config, userId, statePath, apiCalls) {
  const started = Date.now();
  let redirectedToLogin = false;
  let storageCleared = false;
  let uiError = "";
  let logoutMethod = "api";
  if (page.isClosed() || !(await hasExpectedStoredUser(page, config.baseUrl, userId))) {
    return false;
  }
  if (!page.isClosed()) {
    // The endpoint is the same operation used by the UI and avoids waiting on
    // Semi Design hover/menu animations that are not reliable on the server.
    redirectedToLogin = await logoutViaApi(page, config, userId, apiCalls);
    storageCleared = redirectedToLogin;
  }
  if (!redirectedToLogin && !page.isClosed()) {
    logoutMethod = "visible-quit-fallback";
    let protectedConsoleExpiredRedirect = false;
    try {
      await page.goto(`${config.baseUrl}/console`, {
        waitUntil: "domcontentloaded",
        timeout: config.requestTimeoutMs,
      });
      const consoleProbeUrl = new URL(page.url());
      if (consoleProbeUrl.origin !== new URL(config.baseUrl).origin) {
        throw new Error("AgentRouter protected Console navigation left the configured origin.");
      }
      protectedConsoleExpiredRedirect = (
        consoleProbeUrl.pathname === "/login" &&
        consoleProbeUrl.searchParams.get("expired") === "true"
      );
      if (new URL(page.url()).pathname !== "/login") {
        await page.locator("main").waitFor({ state: "visible", timeout: config.requestTimeoutMs });
        await dismissBlockingOverlays(page);
        const profileButton = page.locator('button[aria-haspopup="menu"]').first();
        await profileButton.hover().catch(() => undefined);
        await profileButton.click({ timeout: 10_000 }).catch(async () => {
          await dismissBlockingOverlays(page);
          await profileButton.click({ force: true, timeout: 5_000 });
        });
        const quit = page.getByRole("menuitem", { name: /Quit/i }).first();
        await quit.waitFor({ state: "visible", timeout: 10_000 });
        await quit.click({ timeout: 10_000 });
        await page.waitForURL(/\/login(?:[?#]|$)/, { timeout: 15_000 });
      }
    } catch (error) {
      uiError = errorText(error);
    }
    if (!page.isClosed()) {
      const loginUrl = new URL(page.url());
      const isAgentRouterLogin = (
        loginUrl.origin === new URL(config.baseUrl).origin &&
        loginUrl.pathname === "/login"
      );
      if (isAgentRouterLogin) {
        const serverLoggedOut = await isServerSessionLoggedOut(page, userId, config.baseUrl);
        const expiredSessionRedirect = protectedConsoleExpiredRedirect;
        if (serverLoggedOut || expiredSessionRedirect) {
          storageCleared = await clearExpectedStoredUser(page, config.baseUrl, userId);
          redirectedToLogin = storageCleared;
          if (storageCleared) uiError = "";
        } else if (!uiError) {
          uiError = "AgentRouter showed /login without confirming that the browser session ended.";
        }
      }
    }
  }
  const loggedOut = redirectedToLogin && storageCleared;
  if (loggedOut) {
    const failedApiLogout = [...apiCalls].reverse().find(
      (call) => call.source === "api-logout" && !call.ok && !call.recovered,
    );
    if (failedApiLogout) failedApiLogout.recovered = true;
  }
  apiCalls.push({
    path: logoutMethod === "api" ? "/api/user/logout → /login" : "/console → profile menu → Quit",
    method: logoutMethod === "api" ? "GET" : "UI",
    status: loggedOut ? 200 : 0,
    ok: loggedOut,
    latencyMs: Date.now() - started,
    responsePath: page.url(),
    contentType: "text/html",
    ...(uiError ? { uiError } : {}),
    ...(!loggedOut ? { error: "Neither the logout endpoint nor the visible Quit fallback reached /login." } : {}),
  });
  await persistGithubState(context, statePath);
  return loggedOut;
}

async function runWorker({ account, config }) {
  const startedAt = new Date().toISOString();
  const statePath = path.join(config.accountStateDir, `${account.id}.json`);
  const monitorStatePath = path.join(config.accountStateDir, `${account.id}.monitor.json`);
  const profilePath = path.join(config.browserProfileDir, account.id);
  const profileMarkerPath = path.join(profilePath, ".agentrouter-profile-ready");
  const result = {
    accountId: account.id,
    accountLabel: account.label,
    startedAt,
    endedAt: startedAt,
    status: "ok",
    loginMs: 0,
    dashboardMs: 0,
    totalMs: 0,
    summary: {},
    metrics: {},
    usagePoints: [],
    apiCalls: [],
    loggedOut: false,
    sessionReused: false,
    errorMessage: undefined,
    screenshotPath: undefined,
  };

  let context;
  let launchAttempts = 0;
  let activePage;
  let authenticatedUserId;
  let preflightLoggedOut = false;
  if (config.captureScreenshots) {
    if (process.platform === "win32") {
      log(`[${account.label}] screenshots are unsupported on Windows; skipping`);
    } else {
      const root = await openSecureScreenshotDirectory(config.screenshotDir);
      await root.handle.close();
    }
  }

  try {
    await mkdir(config.accountStateDir, { recursive: true });
    const profileAvailable = await fileExists(profileMarkerPath);
    await mkdir(profilePath, { recursive: true });
    await restrictSecretDirectory(profilePath);
    log(`[${account.label}] launching dedicated persistent ${config.browserChannel} profile`);
    progress("launching", `Launching the account's dedicated persistent ${config.browserChannel} profile.`, 6);
    const launched = await launchAccountContext(profilePath, config);
    context = launched.context;
    launchAttempts = launched.attempts;

    const stateAvailable = await fileExists(statePath);
    const storedGithubState = stateAvailable ? await loadGithubState(statePath) : null;
    if (!profileAvailable && storedGithubState) {
      await context.addCookies(storedGithubState.cookies);
      log(`[${account.label}] migrated the previous GitHub cookie backup into the persistent profile`);
    }
    if (config.disableWebAuthn) {
      await context.addInitScript(() => {
        const credentials = navigator.credentials;
        if (!credentials) return;
        const originalGet = credentials.get.bind(credentials);
        const originalCreate = credentials.create.bind(credentials);
        credentials.get = (options) => {
          if (options && typeof options === "object" && "publicKey" in options) {
            return Promise.reject(
              new DOMException("WebAuthn is disabled in this automation session.", "NotAllowedError"),
            );
          }
          return originalGet(options);
        };
        credentials.create = (options) => {
          if (options && typeof options === "object" && "publicKey" in options) {
            return Promise.reject(
              new DOMException("WebAuthn is disabled in this automation session.", "NotAllowedError"),
            );
          }
          return originalCreate(options);
        };
      });
    }
    activePage = context.pages().find((candidate) => !candidate.isClosed()) ?? await context.newPage();

    const loginStarted = Date.now();
    progress(
      "agentrouter-login",
      profileAvailable || storedGithubState
        ? "Opening AgentRouter with the account's saved browser session."
        : "Opening AgentRouter for a fresh GitHub sign-in.",
      14,
    );
    await activePage.goto(`${config.baseUrl}/login`, {
      waitUntil: "domcontentloaded",
      timeout: config.requestTimeoutMs,
    });
    throwIfCancelled();
    if (!isPageAtConfiguredOrigin(activePage, config.baseUrl)) {
      throw new Error("AgentRouter login navigation left the configured origin.");
    }
    const staleAgentRouterUser = await readStoredUser(activePage);
    if (staleAgentRouterUser) {
      progress(
        "preflight-logout",
        "A stale AgentRouter session was found; logging it out before starting this cycle.",
        17,
      );
      let staleLogout = await logoutAndPersist(
        context,
        activePage,
        config,
        staleAgentRouterUser.id,
        statePath,
        result.apiCalls,
      );
      if (!staleLogout) {
        // Transient WAF or navigation races can fail the first confirm.
        log(`[${account.label}] preflight logout did not confirm; retrying once.`);
        await wait(2_500);
        staleLogout = await logoutAndPersist(
          context,
          activePage,
          config,
          staleAgentRouterUser.id,
          statePath,
          result.apiCalls,
        );
      }
      if (!staleLogout) {
        // The agentrouter session may already be dead server-side while its cookies linger
        // (site invalidated sessions). A failed logout confirm must not block a fresh login:
        // drop the agentrouter-domain cookies from the profile and continue to OAuth.
        log(`[${account.label}] preflight logout failed after retry; clearing agentrouter cookies and continuing.`);
        const agentRouterOrigin = new URL(config.baseUrl).origin;
        const cleared = await context.clearCookies({ domain: new URL(agentRouterOrigin).hostname }).catch(() => 0);
        log(`[${account.label}] agentrouter cookies cleared (${cleared ?? "n/a"})`);
        for (const call of result.apiCalls) {
          if (call.source === "api-logout" && !call.ok && !call.recovered) call.recovered = true;
        }
        await activePage.goto(`${config.baseUrl}/login`, {
          waitUntil: "domcontentloaded",
          timeout: config.requestTimeoutMs,
        }).catch(() => undefined);
      }
      preflightLoggedOut = true;
      await activePage.goto(`${config.baseUrl}/login`, {
        waitUntil: "domcontentloaded",
        timeout: config.requestTimeoutMs,
      });
      if (!isPageAtConfiguredOrigin(activePage, config.baseUrl)) {
        throw new Error("AgentRouter post-logout login navigation left the configured origin.");
      }
    }
    const oauthPage = await openGithubOAuthPage(
      activePage,
      config.baseUrl,
      config.requestTimeoutMs,
    );
    activePage = oauthPage;
    log(`[${account.label}] GitHub OAuth opened; completing username-based authentication`);
    progress("github-oauth", "GitHub OAuth opened; selecting the configured username.", 22);
    const authentication = await completeGithubAuthentication(oauthPage, account, config);
    throwIfCancelled();
    await persistGithubState(context, statePath);
    await markProfileReady(profilePath);
    const authenticated = await waitForAgentRouterUser(
      context,
      config.baseUrl,
      config.loginTimeoutMs,
    );
    activePage = authenticated.page;
    authenticatedUserId = authenticated.user.id;
    result.loginMs = Date.now() - loginStarted;
    result.sessionReused = Boolean(profileAvailable || storedGithubState) && !authentication.credentialsSubmitted;
    log(`[${account.label}] authenticated in ${result.loginMs}ms`);
    progress("collecting-account", "Authenticated. Collecting balance and account details.", 52);

    const dashboardStarted = Date.now();
    progress("collecting-console", "Reading the visible AgentRouter /console cards.", 58);
    const consoleReading = await readUiMetricsWithRefresh(
      activePage,
      config,
      "/console/",
      visibleConsoleMetrics,
      result.apiCalls,
      "AgentRouter Console",
    );
    const consoleMetrics = consoleReading.metrics;
    result.dashboardMs = Date.now() - dashboardStarted;

    progress("collecting-wallet", "Reading /console/topup and refreshing suspicious $0.00 values.", 72);
    const walletReading = await readUiMetricsWithRefresh(
      activePage,
      config,
      "/console/topup",
      visibleWalletMetrics,
      result.apiCalls,
      "AgentRouter Wallet",
    );
    const walletMetrics = walletReading.metrics;
    const consoleMoneyValid = Number.isFinite(consoleMetrics.balance) && Number.isFinite(consoleMetrics.consumed);
    const walletMoneyValid = Number.isFinite(walletMetrics.balance) && Number.isFinite(walletMetrics.consumed);
    if (!consoleMoneyValid && !walletMoneyValid) {
      const diagnostic = (metrics) =>
        `balance=${Number.isFinite(metrics.balance) ? metrics.balance : "unparseable"}, ` +
        `consumption=${Number.isFinite(metrics.consumed) ? metrics.consumed : "unparseable"}`;
      throw new Error(
        "AgentRouter's visible Console and Wallet cards did not expose parseable money values " +
        `(Console: ${diagnostic(consoleMetrics)}; Wallet: ${diagnostic(walletMetrics)}).`,
      );
    }
    const requiredActivity = [
      consoleMetrics.requestCount,
      consoleMetrics.statisticalCount,
      consoleMetrics.statisticalQuota,
      consoleMetrics.statisticalTokens,
      consoleMetrics.averageRpm,
      consoleMetrics.averageTpm,
    ];
    if (!requiredActivity.every(Number.isFinite)) {
      throw new Error("AgentRouter's visible Console did not expose all required usage and performance cards.");
    }
    const hasVisibleActivity = [
      consoleMetrics.requestCount,
      consoleMetrics.statisticalCount,
      consoleMetrics.statisticalTokens,
    ].some((value) => Number.isFinite(value) && value > 0);
    // Console is the reliable money source (user-verified); /console/topup needs an extra
    // refresh and is only used as a fallback when the console cards are missing/invalid.
    const consoleHasRealMoney = consoleMoneyValid && !(consoleMetrics.balance === 0 && consoleMetrics.consumed === 0);
    const money = consoleHasRealMoney ? consoleMetrics : walletMetrics;
    // Prefer the authoritative /api/user/self numbers (site money cards can show a gated
    // $0.00 until a manual refresh; the API is never gated this way).
    // The post-OAuth user payload (authenticated.user) IS /api/user/self and already carries
    // quota/used_quota — capture money from it before anything else can go stale or gated.
    const authQuota = Number(authenticated?.user?.quota);
    const authUsed = Number(authenticated?.user?.used_quota);
    const authRequests = Number(authenticated?.user?.request_count);
    const authMoney =
      Number.isFinite(authQuota) && Number.isFinite(authUsed) && Number.isFinite(authRequests) &&
      (authQuota > 0 || authUsed > 0 || authRequests > 0)
        ? { balance: authQuota / 500_000, consumed: authUsed / 500_000, requestCount: authRequests }
        : null;
    const apiMoney = authMoney ?? await readAuthoritativeMoneyPayload(context, config, authenticatedUserId);
    const moneySource = authMoney
      ? "api-user-auth"
      : apiMoney
        ? "api-user-self"
        : consoleHasRealMoney
          ? "/console"
          : "/console/topup";
    const finalMoney = (authMoney ?? apiMoney) ?? money;
    const finalRequestCount = authMoney
      ? Math.round(authMoney.requestCount)
      : apiMoney
        ? Math.round(apiMoney.requestCount)
        : consoleMetrics.requestCount;
    if (authMoney) {
      progress("money-api", `Authoritative balance from the authenticated user payload ($${finalMoney.balance.toFixed(2)} balance, $${finalMoney.consumed.toFixed(2)} consumed).`, 78);
    } else if (apiMoney) {
      progress("money-api", `Authoritative balance from /api/user/self ($${finalMoney.balance.toFixed(2)} balance, $${finalMoney.consumed.toFixed(2)} consumed).`, 78);
    }
    if (
      hasVisibleActivity &&
      Number.isFinite(money.balance) && money.balance === 0 &&
      Number.isFinite(money.consumed) && money.consumed === 0
    ) {
      throw new Error(
        `AgentRouter still showed $0.00 for both balance and consumption on the selected money source after ${consoleReading.refreshCount + 1} settled page load(s) while usage cards show activity; refusing to save false money values.`,
      );
    }
    result.metrics = {
      siteUserId: authenticatedUserId,
      siteUsername: typeof authenticated.user?.username === "string"
        ? authenticated.user.username
        : undefined,
      quotaPerUnit: 500_000,
      balance: finalMoney.balance,
      consumed: finalMoney.consumed,
      requestCount: finalRequestCount,
      statisticalCount: consoleMetrics.statisticalCount,
      statisticalTokens: consoleMetrics.statisticalTokens,
      statisticalQuota: consoleMetrics.statisticalQuota,
      averageRpm: consoleMetrics.averageRpm,
      averageTpm: consoleMetrics.averageTpm,
    };
    result.summary = {
      user: safeUserSnapshot(authenticated.user),
      collectionSource: "agentrouter-visible-ui",
      launchAttempts,
      visitedRoutes: ["/console/", "/console/topup"],
      moneyCollection: {
        selectedSource: moneySource,
        authoritativeSource: moneySource,
        refreshPolicy: "refresh-up-to-three-times",
        console: consoleReading,
        wallet: walletReading,
      },
    };

    progress("capturing-token", "Data captured. Capturing the active AgentRouter API token.", 86);
    result.capturedApiToken = await captureAgentRouterApiToken(
      activePage,
      config,
      authenticatedUserId,
      result.apiCalls,
    ) ?? undefined;

    await persistAgentRouterState(context, monitorStatePath, config.baseUrl);

    const failedCall = result.apiCalls.find((call) => !call.ok && !call.recovered);
    if (failedCall) {
      throw new Error(`AgentRouter UI step failed: ${failedCall.path} returned ${failedCall.status}.`);
    }
    result.loggedOut = preflightLoggedOut;
    result.summary.authentication = "retained-authenticated-session";
    log(
      `[${account.label}] data saved and authenticated minute-poll session retained` +
      (preflightLoggedOut ? " (prior session logged out)" : ""),
    );
    progress(
      "complete",
      preflightLoggedOut
        ? "Snapshot saved. Prior session logged out; the fresh authenticated session now feeds minute polling."
        : "Snapshot saved. Authenticated session retained to feed minute polling.",
      100,
    );
  } catch (error) {
    result.status = "error";
    result.errorMessage = errorText(error);
    progress("error", result.errorMessage.slice(0, 300), 100);
    if (activePage && !activePage.isClosed() && config.captureScreenshots && process.platform !== "win32") {
      let root;
      let leafPath;
      try {
        root = await openSecureScreenshotDirectory(config.screenshotDir);
        const screenshotBuffer = await activePage.screenshot({ fullPage: true });
        const failureFilename = `${account.id}-failure-${Date.now()}.png`;
        leafPath = existsSync("/proc/self/fd")
          ? `/proc/self/fd/${root.handle.fd}/${failureFilename}`
          : path.resolve(root.rootPath, failureFilename);

        const fileHandle = await open(
          leafPath,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
          0o600,
        );
        try {
          const fileStats = await fileHandle.stat();
          if (!fileStats.isFile() || (typeof process.getuid === "function" && fileStats.uid !== process.getuid()) || fileStats.dev !== root.dev || (fileStats.mode & 0o777) !== 0o600) {
            throw new Error("Invalid screenshot target file security state.");
          }
          await fileHandle.writeFile(screenshotBuffer);
          result.screenshotPath = path.resolve(root.rootPath, failureFilename);
        } finally {
          await fileHandle.close();
        }
      } catch (captureError) {
        log(`[${account.label}] screenshot capture failed: ${errorText(captureError)}`);
        if (leafPath) {
          try {
            await unlink(leafPath);
          } catch (unlinkErr) {
            if (unlinkErr.code !== "ENOENT") {
              log(`[${account.label}] failed to clean up partial screenshot: ${errorText(unlinkErr)}`);
            }
          }
        }
      } finally {
        if (root) {
          await root.handle.close().catch(() => undefined);
        }
      }
    }

    if (context && !result.loggedOut) {
      let cleanupPage = (
        activePage &&
        !activePage.isClosed() &&
        isPageAtConfiguredOrigin(activePage, config.baseUrl)
      ) ? activePage : null;
      let cleanupUserId = authenticatedUserId;
      for (const candidate of context.pages()) {
        if (candidate.isClosed() || !isPageAtConfiguredOrigin(candidate, config.baseUrl)) continue;
        const candidateUser = await readStoredUser(candidate);
        if (candidateUser) {
          cleanupPage = candidate;
          cleanupUserId = candidateUser.id;
          break;
        }
      }
      if (cleanupPage && cleanupUserId) {
        progress("cleanup-logout", "A failure occurred after authentication; forcing AgentRouter logout before closing the browser.", 98);
        result.loggedOut = await logoutAndPersist(
          context,
          cleanupPage,
          config,
          cleanupUserId,
          statePath,
          result.apiCalls,
        ).catch(() => false);
      }
    }
  } finally {
    await context?.close().catch(() => undefined);
  }

  result.endedAt = new Date().toISOString();
  result.totalMs = Math.max(0, Date.parse(result.endedAt) - Date.parse(result.startedAt));
  return result;
}

async function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const iterator = input[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value.trim()) {
    throw new Error("No worker payload was provided.");
  }
  const message = JSON.parse(first.value);
  if (message?.type !== "start" || !message.payload) {
    throw new Error("Worker start message is invalid.");
  }
  void (async () => {
    for await (const line of iterator) {
      if (!line.trim()) continue;
      try {
        const control = JSON.parse(line);
        if (control?.type === "cancel") {
          cancellationRequested = true;
        }
      } catch {
        // Ignore malformed control messages after the validated start payload.
      }
    }
  })();
  const result = await runWorker(message.payload);
  input.close();
  emit({ type: "result", result });
}

main().catch((error) => {
  process.stderr.write(`worker error: ${errorText(error)}\n`);
  process.exitCode = 1;
});
