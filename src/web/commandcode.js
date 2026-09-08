/**
 * Command Code monitoring page. Mirrors the Antigravity view: add an account by
 * pasting an API key, probe, and view subscription/quota windows live.
 */
(function () {
  "use strict";

  const API = "/api/commandcode";
  const byId = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const state = { active: false, lastFetch: 0, fetching: false, overview: null };

  function countdown(iso) {
    if (!iso) return "no reset window";
    const delta = new Date(iso).getTime() - Date.now();
    if (delta <= 0) return "resetting now";
    const h = Math.floor(delta / 3600_000);
    const m = Math.floor((delta % 3600_000) / 60_000);
    const s = Math.floor((delta % 60_000) / 1000);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    return `${h}h ${m}m ${s}s`;
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
      if (state.active) render();
    } catch (error) {
      byId("cc-body").innerHTML = `<div class="panel glass"><p class="muted">Command Code API unavailable: ${esc(error.message)}</p></div>`;
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
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
  }

  async function addAccount() {
    const apiKey = byId("cc-key").value.trim();
    const label = byId("cc-label").value.trim();
    if (!apiKey) { window.alert("Paste your Command Code API key first."); return; }
    try {
      await apiPost("/oauth/exchange", { apiKey, label });
      byId("cc-key").value = "";
      byId("cc-label").value = "";
      byId("cc-oauth-panel").classList.add("hidden");
      await refresh(true);
    } catch (error) {
      window.alert(`Add account failed: ${error.message}`);
    }
  }

  function windowBar(window, label) {
    const pct = window.cap > 0 ? Math.round((window.used / window.cap) * 100) : 0;
    const remaining = Math.max(0, window.cap - window.used);
    return (
      `<div class="cc-window">
        <div class="cc-window-head"><span>${esc(label)}</span><span class="muted">${esc(String(window.used))} / ${esc(String(window.cap))}</span></div>
        <div class="cc-bar"><span class="cc-bar-fill cc-bar-fill-${pctShade(pct)}" style="width:${Math.min(100, pct)}%"></span></div>
        <div class="cc-window-foot"><span class="muted">${remaining} remaining</span><span class="muted">resets ${esc(countdown(window.resetAt))}</span></div>
      </div>`);
  }

  function pctShade(pct) {
    if (pct >= 90) return "danger";
    if (pct >= 70) return "warn";
    return "ok";
  }

  function render() {
    const o = state.overview;
    if (!o) return;
    byId("cc-status").innerHTML =
      `<span class="chip">${o.enabled ? "enabled" : "disabled"}</span>` +
      `<span class="chip">${o.status?.enabledAccountCount ?? 0}/${o.status?.accountCount ?? 0} accounts</span>`;

    if (o.accounts.length === 0) {
      byId("cc-body").innerHTML = `<div class="panel glass"><p class="muted">No Command Code accounts. Add your first account (paste your API key).</p></div>`;
      return;
    }
    byId("cc-body").innerHTML = o.accounts.map((a) => {
      const snap = a.snapshot;
      const windows = (snap?.windows ?? []).map((w) => windowBar(w, w.window === "weekly" ? "Weekly" : "5-hour")).join("");
      return (
        `<div class="panel glass cc-account" data-account="${esc(a.id)}">
          <div class="cc-account-head">
            <div><h3>${esc(a.label)}</h3><span class="muted">${esc(a.id)}${a.enabled ? "" : " · disabled"}</span></div>
            <div class="cc-account-actions">
              <button class="btn" data-act="probe" data-id="${esc(a.id)}">Probe</button>
              <button class="btn" data-act="toggle" data-id="${esc(a.id)}" data-enabled="${a.enabled}">${a.enabled ? "Disable" : "Enable"}</button>
              <button class="btn danger" data-act="delete" data-id="${esc(a.id)}">Delete</button>
            </div>
          </div>
          ${snap?.lastError ? `<p class="cc-error">${esc(snap.lastError)}</p>` : ""}
          <div class="cc-grid">
            <div class="cc-stat"><span class="muted">Remaining credits</span><strong>${esc(String(snap?.remainingCredits ?? "—"))}</strong></div>
            <div class="cc-stat"><span class="muted">Plan</span><strong>${esc(String(snap?.planId ?? "—"))}</strong></div>
            <div class="cc-stat"><span class="muted">Monthly</span><strong>${esc(String(snap?.monthlyCredits ?? "—"))}</strong></div>
            <div class="cc-stat"><span class="muted">Purchased</span><strong>${esc(String(snap?.purchasedCredits ?? "—"))}</strong></div>
          </div>
          ${windows || `<p class="muted">No window data yet.</p>`}
        </div>`);
    }).join("");
  }

  byId("cc-body")?.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const { act, id } = target.dataset;
    try {
      if (act === "probe") { await apiPost("/probe", { accountId: id }); }
      else if (act === "toggle") { await fetch(`${API}/accounts/${id}`, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: target.dataset.enabled !== "true" }) }); }
      else if (act === "delete") { if (confirm("Remove this Command Code account?")) { await fetch(`${API}/accounts/${id}`, { method: "DELETE", credentials: "same-origin" }); } }
      await refresh(true);
    } catch (error) {
      window.alert(`${act} failed: ${error.message}`);
    }
  });

  byId("cc-add-open")?.addEventListener("click", () => byId("cc-oauth-panel").classList.remove("hidden"));
  byId("cc-oauth-cancel")?.addEventListener("click", () => byId("cc-oauth-panel").classList.add("hidden"));
  byId("cc-oauth-submit")?.addEventListener("click", addAccount);
  byId("cc-probe-all")?.addEventListener("click", async () => { try { await apiPost("/probe", {}); await refresh(true); } catch (error) { window.alert(`Probe failed: ${error.message}`); } });

  window.renderCommandCodeView = () => { state.active = true; refresh(true); };
  window.commandcodeHide = () => { state.active = false; };
  setInterval(() => { if (state.active) refresh(); }, 30_000);
})();
