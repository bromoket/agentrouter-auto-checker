import { readFile } from "node:fs/promises";

interface HarEntry {
  startedDateTime?: string;
  request?: { method?: string; url?: string; headers?: Array<{ name?: string }> };
  response?: {
    status?: number;
    headers?: Array<{ name?: string; value?: string }>;
    content?: { mimeType?: string; text?: string; encoding?: string };
  };
  time?: number;
}

function jsonShape(text: string | undefined, encoding: string | undefined): string {
  if (!text) return "empty";
  try {
    const decoded = encoding === "base64" ? Buffer.from(text, "base64").toString("utf8") : text;
    const value: unknown = JSON.parse(decoded);
    if (Array.isArray(value)) return `array(${value.length})`;
    if (!value || typeof value !== "object") return typeof value;
    const record = value as Record<string, unknown>;
    const top = Object.keys(record).slice(0, 20).join(",") || "object";
    const data = record.data;
    if (Array.isArray(data)) {
      const first = data[0];
      return `${top}; data=array(${data.length})${first && typeof first === "object" ? ` first=${Object.keys(first).slice(0, 30).join(",")}` : ""}`;
    }
    return data && typeof data === "object"
      ? `${top}; data=${Object.keys(data).slice(0, 40).join(",")}`
      : top;
  } catch {
    return "non-json";
  }
}

const harPath = process.argv[2];
if (!harPath) throw new Error("Usage: bun run scripts/analyze-har.ts <capture.har>");
const parsed = JSON.parse((await readFile(harPath, "utf8")).replace(/^\uFEFF/, "")) as {
  log?: { entries?: HarEntry[] };
};
const entries = parsed.log?.entries ?? [];
const interesting = entries.filter((entry) => {
  try {
    const url = new URL(entry.request?.url ?? "");
    return url.hostname === "agentrouter.org" && (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/dashboard/") ||
      url.pathname.startsWith("/console") ||
      url.pathname.includes("logout")
    );
  } catch {
    return false;
  }
});

for (const entry of interesting) {
  const url = new URL(entry.request?.url ?? "https://agentrouter.org/");
  const contentType = entry.response?.headers
    ?.find((header) => header.name?.toLowerCase() === "content-type")?.value
    ?.split(";", 1)[0] ?? entry.response?.content?.mimeType ?? "";
  const headerNames = (entry.request?.headers ?? [])
    .map((header) => header.name?.toLowerCase())
    .filter((name): name is string => Boolean(name))
    .filter((name) => ["authorization", "cookie", "new-api-user", "x-api-key"].includes(name));
  console.log(JSON.stringify({
    at: entry.startedDateTime,
    method: entry.request?.method,
    path: url.pathname,
    queryKeys: [...url.searchParams.keys()],
    status: entry.response?.status,
    contentType,
    authHeaders: [...new Set(headerNames)],
    responseShape: jsonShape(entry.response?.content?.text, entry.response?.content?.encoding),
    timeMs: Math.round(entry.time ?? 0),
  }));
}
