/**
 * One-off import: Antigravity accounts from the OpenCode plugin config
 * (gemini_stack PoC) into the encrypted observatory Antigravity store.
 *
 * Reads ~/.config/opencode/antigravity-accounts.json (schema v4), validates each entry,
 * and upserts accounts with deterministic ids derived from the email so re-running the
 * import refreshes tokens/fingerprints instead of duplicating rows.
 *
 * Usage (on the machine that holds the source file, e.g. the workstation or Xeon after
 * the file is transferred):
 *   ANTIGRAVITY_ENC_KEY=... \
 *   ANTIGRAVITY_DB_PATH=... \
 *   OPENCODE_ACCOUNTS_FILE=... \
 *   bun run scripts/import-antigravity-accounts.ts
 *
 * Never prints token values. The source file is never written into this repo.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AntigravityStore } from "../src/antigravity/store";

interface OpencodeAccountEntry {
  email?: unknown;
  refreshToken?: unknown;
  enabled?: unknown;
  addedAt?: unknown;
  fingerprint?: unknown;
  projectId?: unknown;
}

interface OpencodeAccountsFile {
  version?: unknown;
  accounts?: unknown;
}

async function parseJsonFile(filePath: string): Promise<unknown> {
  if (!existsSync(filePath)) {
    throw new Error(`OpenCode accounts file not found: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`OpenCode accounts file is not valid JSON: ${filePath}`);
  }
}

function stableAccountId(email: string): string {
  const digest = createHash("sha256").update(email.trim().toLowerCase(), "utf8").digest("hex");
  return `ag-${digest.slice(0, 24)}`;
}

function normalizeFingerprint(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const allowed = ["deviceId", "sessionToken", "userAgent", "apiClient", "clientMetadata", "createdAt"];
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  if (Object.keys(out).length === 0) return null;
  return JSON.stringify(out);
}

async function main(): Promise<void> {
  const encryptionKey = process.env.ANTIGRAVITY_ENC_KEY?.trim();
  if (!encryptionKey) {
    throw new Error("ANTIGRAVITY_ENC_KEY is required (32+ bytes).");
  }
  const dbPath =
    process.env.ANTIGRAVITY_DB_PATH?.trim() ||
    join(process.env.DATA_DIR?.trim() || "data", "antigravity.sqlite");
  const defaultFile = join(homedir(), ".config", "opencode", "antigravity-accounts.json");
  const filePath = process.env.OPENCODE_ACCOUNTS_FILE?.trim() || defaultFile;

  const parsed = await parseJsonFile(filePath);
  const file = (parsed ?? {}) as OpencodeAccountsFile;
  if (file.version !== 4) {
    throw new Error(`Unsupported opencode accounts schema version: ${String(file.version)} (expected 4)`);
  }
  if (!Array.isArray(file.accounts)) {
    throw new Error("OpenCode accounts file has no accounts array.");
  }

  const store = new AntigravityStore(dbPath, encryptionKey);
  let imported = 0;
  let skipped = 0;
  const problems: string[] = [];

  for (const rawAccount of file.accounts as unknown[]) {
    const entry = (rawAccount ?? {}) as OpencodeAccountEntry;
    const email = typeof entry.email === "string" ? entry.email.trim() : "";
    const refreshToken = typeof entry.refreshToken === "string" ? entry.refreshToken.trim() : "";
    if (!email) {
      skipped += 1;
      problems.push("account missing email");
      continue;
    }
    if (!refreshToken) {
      skipped += 1;
      problems.push(`${email}: missing refresh token`);
      continue;
    }
    const enabled = entry.enabled !== false;
    const fingerprintJson = normalizeFingerprint(entry.fingerprint);
    const projectId = typeof entry.projectId === "string" && entry.projectId.trim()
      ? entry.projectId.trim()
      : null;
    const id = stableAccountId(email);
    store.upsertAccount({
      id,
      label: email,
      email,
      refreshToken,
      fingerprintJson,
      projectId,
      enabled,
    });
    imported += 1;
  }

  console.log(
    `Antigravity import complete: ${imported} accounts imported/refreshed, ${skipped} skipped` +
      (problems.length > 0 ? `\nProblems: ${problems.join("; ")}` : ""),
  );
  store.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
