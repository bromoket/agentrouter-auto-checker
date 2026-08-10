import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const output = process.argv[2];
if (!output || !output.toLowerCase().endsWith(".png")) {
  throw new Error("Usage: node scripts/telegram-chart.mjs <output.png>");
}

const input = JSON.parse(await new Response(process.stdin).text());
const label = typeof input?.label === "string" ? input.label.slice(0, 64) : "AgentRouter account";
const history = Array.isArray(input?.history)
  ? input.history.slice(-60).map((item) => ({
      at: new Date(item.at).toISOString(),
      balance: Number(item.balance),
      consumed: Number(item.consumed),
    })).filter((item) => Number.isFinite(item.balance) && Number.isFinite(item.consumed))
  : [];
if (history.length < 2) throw new Error("At least two history points are required.");

const escapeXml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const width = 1_200;
const height = 630;
const plot = { left: 90, top: 170, right: 1_120, bottom: 520 };
const values = history.flatMap((item) => [item.balance, item.consumed]);
const minimum = Math.min(...values);
const maximum = Math.max(...values);
const padding = Math.max(5, (maximum - minimum) * 0.12);
const minY = Math.max(0, minimum - padding);
const maxY = maximum + padding;
const x = (index) => plot.left + (index / (history.length - 1)) * (plot.right - plot.left);
const y = (value) => plot.bottom - ((value - minY) / Math.max(1, maxY - minY)) * (plot.bottom - plot.top);
const pathFor = (key) => history
  .map((item, index) => `${index === 0 ? "M" : "L"} ${x(index).toFixed(1)} ${y(item[key]).toFixed(1)}`)
  .join(" ");
const grid = Array.from({ length: 5 }, (_, index) => {
  const ratio = index / 4;
  const gridY = plot.top + ratio * (plot.bottom - plot.top);
  const value = maxY - ratio * (maxY - minY);
  return `<line x1="${plot.left}" y1="${gridY}" x2="${plot.right}" y2="${gridY}" class="grid"/><text x="${plot.left - 18}" y="${gridY + 6}" class="axis" text-anchor="end">$${value.toFixed(0)}</text>`;
}).join("");
const firstDate = new Date(history[0].at).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
const lastDate = new Date(history.at(-1).at).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
const latest = history.at(-1);
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#07030f"/><stop offset="0.55" stop-color="#16072c"/><stop offset="1" stop-color="#090311"/></linearGradient>
    <linearGradient id="balance" x1="0" x2="1"><stop stop-color="#8b5cf6"/><stop offset="1" stop-color="#d946ef"/></linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="1200" height="630" rx="38" fill="url(#bg)"/>
  <circle cx="1080" cy="70" r="180" fill="#7c3aed" opacity=".12"/>
  <text x="72" y="72" class="eyebrow">AGENTROUTER MONITOR</text>
  <text x="72" y="120" class="title">${escapeXml(label)}</text>
  <text x="1128" y="76" class="balanceValue" text-anchor="end">$${latest.balance.toFixed(2)}</text>
  <text x="1128" y="112" class="muted" text-anchor="end">current balance</text>
  ${grid}
  <path d="${pathFor("consumed")}" fill="none" stroke="#f472b6" stroke-width="5" opacity=".82" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${pathFor("balance")}" fill="none" stroke="url(#balance)" stroke-width="8" filter="url(#glow)" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="${x(history.length - 1)}" cy="${y(latest.balance)}" r="9" fill="#f5d0fe" stroke="#a855f7" stroke-width="5"/>
  <text x="${plot.left}" y="565" class="axis">${firstDate}</text>
  <text x="${plot.right}" y="565" class="axis" text-anchor="end">${lastDate}</text>
  <circle cx="86" cy="600" r="6" fill="#a855f7"/><text x="102" y="607" class="legend">Balance</text>
  <circle cx="220" cy="600" r="6" fill="#f472b6"/><text x="236" y="607" class="legend">Consumed</text>
  <style>
    text { font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; fill: #f8f5ff; }
    .eyebrow { font-size: 17px; font-weight: 800; letter-spacing: 4px; fill: #c4b5fd; }
    .title { font-size: 38px; font-weight: 800; }
    .balanceValue { font-size: 38px; font-weight: 850; fill: #f5d0fe; }
    .muted, .axis, .legend { fill: #a99dbc; }
    .muted { font-size: 17px; }
    .axis { font-size: 15px; }
    .legend { font-size: 17px; font-weight: 650; }
    .grid { stroke: #8b7ca5; stroke-opacity: .20; stroke-width: 1; }
  </style>
</svg>`;

const browser = await chromium.launch({ headless: true, channel: "chromium" });
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:#07030f}</style>${svg}`, { waitUntil: "load" });
  await page.screenshot({ path: output, type: "png" });
} finally {
  await browser.close();
}
