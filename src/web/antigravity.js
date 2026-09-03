/* Antigravity direct-account page logic. Loaded after dashboard.js. */
(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Mirror dashboard.js mount detection: pages live under /observatory/ (session cookie
  // is Path=/observatory/), so API calls must be prefixed with that mount.
  const AG_BASE_PATH = (() => {
    const path = window.location.pathname;
    if (path.endsWith("/dashboard.html") || path.endsWith("/index.html") || path.endsWith("/login.html")) {
      return path.slice(0, path.lastIndexOf("/") + 1);
    }
    return `${path.replace(/\/+$/, "")}/`;
  })();
  const API = `${AG_BASE_PATH}api/antigravity`;
  const POOL_LABEL = {
    gemini: "Gemini pool",
    "claude-gpt": "Claude + GPT",
    cli: "Gemini CLI (REQUESTS)",
  };
  const POOL_ICON = { gemini: "◆", "claude-gpt": "✳", cli: "⌘" };

  const state = {
    overview: null,
    active: false,
    lastFetch: 0,
    fetching: false,
    oauthPending: null,
  };

  function esc(value) {
    return String(value ?? "")
      .replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function fmtTime(iso) {
    if (!iso) return "never";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  function countdown(iso) {
    if (!iso) return "no reset window";
    const target = new Date(iso).getTime();
    if (Number.isNaN(target)) return "no reset window";
    const delta = target - Date.now();
    if (delta <= 0) return "reset pending";
    const hours = Math.floor(delta / 3_600_000);
    const minutes = Math.floor((delta % 3_600_000) / 60_000);
    if (hours > 24) return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
    if (hours > 0) return `in ${hours}h ${minutes}m`;
    return `in ${minutes}m`;
  }

  function poolStatus(remaining) {
    if (remaining <= 0.02) return "ag-exhausted";
    if (remaining <= 0.1) return "ag-critical";
    if (remaining <= 0.2) return "ag-warn";
    return "ag-ok";
  }

  function accountCard(account) {
    const snapshot = account.snapshot;
    const pools = snapshot?.pools ?? [];
    const hasError = Boolean(snapshot?.lastError);
    const sub = snapshot?.subscription ?? null;
    const tierLabel = sub?.currentTierName || sub?.currentTierId || "unknown tier";

    const chips = `
      <span class="status-chip ${account.enabled ? "ok" : "neutral"}">${account.enabled ? "enabled" : "paused"}</span>
      <span class="status-chip neutral" title="Current subscription tier">${esc(tierLabel)}</span>
      ${
        sub?.availableCredits
          ? `<span class="status-chip violet" title="Available quota-reset credits">reset credits: ${sub.availableCredits}</span>`
          : ""
      }
      ${snapshot?.verificationRequired ? `<span class="status-chip warn">verification required</span>` : ""}
    `;

    const bars = pools
      .sort((a, b) => (a.pool === "cli" ? 1 : 0) - (b.pool === "cli" ? 1 : 0))
      .map((pool) => {
        const remaining = pool.remainingFraction;
        const cls = poolStatus(remaining);
        const meter = pool.meter === "REQUESTS" ? "REQUESTS" : "WTUS";
        return `
          <div class="ag-meter">
            <div class="ag-meter-head">
              <strong>${POOL_ICON[pool.pool] ?? "•"} ${esc(POOL_LABEL[pool.pool] ?? pool.pool)}</strong>
              <span class="ag-meta">${Math.round(remaining * 100)}% remaining · ${esc(meter)} · ${pool.modelCount} models · <span data-countdown="${esc(pool.resetTime ?? "")}">${esc(countdown(pool.resetTime))}</span></span>
            </div>
            <div class="ag-bar"><i class="${cls}" style="width:${Math.round(remaining * 100)}%"></i></div>
          </div>`;
      })
      .join("");

    const emptyState = pools.length === 0 && !hasError
      ? `<p class="muted" style="margin-top:10px">No quota windows yet — waiting for the first successful probe.</p>`
      : "";
    const errorBlock = hasError
      ? `<p class="ag-err">⚠ ${esc(snapshot.lastError)}${snapshot.consecutiveFailures > 1 ? ` (${snapshot.consecutiveFailures} consecutive failures)` : ""}</p>`
      : "";

    const project = snapshot?.projectId || account.projectId || null;
    const probed = snapshot?.probedAt ?? account.updatedAt;

    return `
      <article class="panel glass ag-account-card" data-ag-id="${esc(account.id)}">
        <header class="panel-heading">
          <div>
            <p class="eyebrow">GOOGLE ANTIGRAVITY · DIRECT</p>
            <h2>${esc(account.label)}</h2>
            <p class="muted">${esc(account.email ?? "")}${project ? ` · project ${esc(project)}` : ""}</p>
          </div>
          <div class="ag-chip-row">${chips}</div>
        </header>
        ${bars}
        ${emptyState}
        ${errorBlock}
        <div class="ag-foot">
          <span>Probed ${esc(fmtTime(probed))}</span>
          <span>Probe interval ${esc(state.overview?.probeIntervalMinutes ?? 5)} min</span>
          <span>Fingerprint ${account.hasFingerprint ? "stored" : "randomized"}</span>
        </div>
        <div class="ag-actions">
          <button class="btn ghost ag-probe" type="button" data-ag-id="${esc(account.id)}">Probe now</button>
          <button class="btn ghost ag-toggle" type="button" data-ag-id="${esc(account.id)}" data-next="${account.enabled ? "false" : "true"}">${account.enabled ? "Pause" : "Resume"}</button>
          <button class="btn danger ag-delete" type="button" data-ag-id="${esc(account.id)}">Remove</button>
        </div>
      </article>`;
  }

  function renderStatusStrip() {
    const status = state.overview?.status ?? null;
    const strip = byId("ag-status-strip");
    if (!status) {
      strip.hidden = true;
      return;
    }
    strip.hidden = false;
    const dot = status.running ? "ok" : "neutral";
    strip.innerHTML = `
      <span class="status-chip ${dot}">collector ${status.running ? "running" : "stopped"}</span>
      <span class="status-chip neutral">${status.accountCount} accounts · ${status.enabledAccountCount} enabled</span>
      <span class="status-chip ${status.lastProbeStatus === "error" ? "warn" : "neutral"}">last probe ${esc(fmtTime(status.lastProbeAt))} · ${esc(status.lastProbeError ?? "ok")}</span>
      <span class="status-chip neutral">next ${status.nextProbeAt ? esc(fmtTime(status.nextProbeAt)) : "on demand"}</span>
    `;
  }

  function renderAccounts() {
    const container = byId("ag-accounts");
    const accounts = state.overview?.accounts ?? [];
    if (accounts.length === 0) {
      container.innerHTML = `
        <div class="panel glass">
          <header class="panel-heading"><div><p class="eyebrow">FIRST ACCOUNT</p><h2>No Antigravity accounts yet</h2><p class="muted">Add your first Google Antigravity account through OAuth. Credentials stay encrypted on the server; only quota numbers are stored by the observatory.</p></div></header>
          <div class="ag-actions"><button class="btn primary" type="button" id="ag-empty-add">Add Antigravity account</button></div>
        </div>`;
      byId("ag-empty-add")?.addEventListener("click", () => openOauthPanel());
      return;
    }
    container.innerHTML = `<div class="ag-account-grid">${accounts.map(accountCard).join("")}</div>`;
    $$(".ag-probe", container).forEach((btn) => btn.addEventListener("click", () => probeOne(btn.dataset.agId)));
    $$(".ag-toggle", container).forEach((btn) => btn.addEventListener("click", () => toggleAccount(btn.dataset.agId, btn.dataset.next)));
    $$(".ag-delete", container).forEach((btn) => btn.addEventListener("click", () => deleteAccount(btn.dataset.agId)));
    updateCountdowns();
  }

  function updateCountdowns() {
    $$("[data-countdown]").forEach((node) => {
      const target = node.dataset.countdown;
      node.textContent = target ? countdown(target) : "no reset window";
    });
  }

  async function refresh(force = false) {
    const now = Date.now();
    if (!force && now - state.lastFetch < 8_000) return;
    if (state.fetching) return;
    state.fetching = true;
    try {
      const response = await fetch(`${API}/overview`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.overview = await response.json();
      state.lastFetch = now;
      if (state.active) {
        renderStatusStrip();
        renderAccounts();
      }
    } catch (error) {
      byId("ag-accounts").innerHTML = `<div class="panel glass"><p class="muted">Antigravity API unavailable: ${esc(error.message)}</p></div>`;
    } finally {
      state.fetching = false;
    }
  }

  async function apiPost(path, body) {
    const response = await fetch(`${API}${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? `HTTP ${response.status}`);
    }
    return data;
  }

  async function probeOne(accountId) {
    try {
      await apiPost("/probe", { accountId });
    } catch (error) {
      window.alert(`Probe failed: ${error.message}`);
    }
    await refresh(true);
  }

  async function probeAll() {
    try {
      const result = await apiPost("/probe", {});
      const summary = `${result.probedAccounts ?? 0} accounts probed, ${result.failures ?? 0} failures`;
      console.log(`[antigravity] ${summary}`);
    } catch (error) {
      window.alert(`Probe failed: ${error.message}`);
    }
    await refresh(true);
  }

  async function toggleAccount(accountId, nextEnabled) {
    const response = await fetch(`${API}/accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: nextEnabled === "true" }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      window.alert(`Update failed: ${data.error ?? response.status}`);
    }
    await refresh(true);
  }

  async function deleteAccount(accountId) {
    if (!window.confirm("Remove this Antigravity account? Its stored refresh token will be deleted.")) return;
    const response = await fetch(`${API}/accounts/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      window.alert(`Remove failed: ${data.error ?? response.status}`);
    }
    await refresh(true);
  }

  function setOauthMessage(text, kind = "info") {
    const msg = byId("ag-oauth-msg");
    msg.textContent = text;
    msg.className = kind === "error" ? "ag-err" : "muted";
  }

  async function openOauthPanel() {
    byId("ag-oauth-panel").classList.remove("hidden");
    byId("ag-oauth-redirect").value = "";
    setOauthMessage("", "info");
    try {
      const started = await apiPost("/oauth/start", {});
      state.oauthPending = started;
      byId("ag-oauth-url").hidden = false;
      byId("ag-oauth-url").href = started.url;
      byId("ag-oauth-url").textContent = "Open the Google consent page";
      window.open(started.url, "_blank", "noopener");
      setOauthMessage(`Consent link is ready. Approve in the opened tab, then paste the full redirect URL below (expires in ${started.expiresInSec}s).`);
    } catch (error) {
      setOauthMessage(error.message, "error");
    }
  }

  async function submitOauth() {
    const redirectUrl = byId("ag-oauth-redirect").value.trim();
    if (!redirectUrl) {
      setOauthMessage("Paste the redirect URL from your browser address bar first.", "error");
      return;
    }
    try {
      const result = await apiPost("/oauth/exchange", { redirectUrl });
      byId("ag-oauth-panel").classList.add("hidden");
      setOauthMessage("", "info");
      await refresh(true);
      console.log(`[antigravity] added ${result.account?.label ?? "account"}`);
    } catch (error) {
      setOauthMessage(error.message, "error");
    }
  }

  function startView() {
    state.active = true;
    refresh(true).catch(() => {});
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = setInterval(updateCountdowns, 30_000);
  }

  function stopView() {
    state.active = false;
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
  }

  // Wire UI events (element presence is guaranteed because this file is defer-loaded after the markup)
  byId("ag-probe-all")?.addEventListener("click", probeAll);
  byId("ag-add-open")?.addEventListener("click", openOauthPanel);
  byId("ag-oauth-start")?.addEventListener("click", openOauthPanel);
  byId("ag-oauth-submit")?.addEventListener("click", submitOauth);
  byId("ag-oauth-cancel")?.addEventListener("click", () => byId("ag-oauth-panel").classList.add("hidden"));

  // Expose hooks for dashboard.js view routing
  window.renderAntigravityView = () => {
    startView();
  };
  window.antigravityHide = () => {
    stopView();
  };
  window.antigravityTick = () => {
    if (state.active) {
      refresh(false).catch(() => {});
      updateCountdowns();
    }
  };

  // Periodic refresh while the Antigravity view is active
  setInterval(() => {
    if (state.active) refresh(false).catch(() => {});
  }, 15_000);
})();
