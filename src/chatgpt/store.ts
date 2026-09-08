/**
 * ChatGPT/Codex account store (separate sqlite). Access tokens encrypted at rest.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { deriveCommandCodeKey, decryptSecret, encryptSecret } from "../commandcode/crypto";

export interface ChatgptAccountInput {
  id?: string;
  label: string;
  email?: string | null;
  accessToken: string;
  enabled?: boolean;
}

export interface ChatgptAccountPublic {
  id: string;
  label: string;
  email: string | null;
  enabled: boolean;
  hasToken: boolean;
  createdAt: string;
  updatedAt: string;
  snapshot: ChatgptSnapshot | null;
}

export interface ChatgptSnapshot {
  planType: string | null;
  email: string | null;
  credits: number | null;
  resetCredits: number | null;
  windows: Array<{ bucketId: string; windowId: string; usedPercent: number; limitWindowSeconds: number; resetAt: string | null; meter: string | null }> | null;
  lastError: string | null;
  consecutiveFailures: number;
  probedAt: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_LABEL = 128;

function validateId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!ID_PATTERN.test(id)) throw new Error(`Invalid ChatGPT account id: ${id}`);
  return id;
}

export class ChatgptStore {
  private readonly db: Database;
  private readonly ownsDb: boolean;
  private readonly key: Buffer;
  private readonly closeHandlers = new Set<() => void>();

  constructor(dbPathOrDb: string | Database, encryptionSecret: string) {
    this.key = deriveCommandCodeKey(encryptionSecret);
    if (typeof dbPathOrDb === "string") {
      if (dbPathOrDb !== ":memory:") mkdirSync(dirname(dbPathOrDb), { recursive: true });
      this.db = new Database(dbPathOrDb, { create: true, strict: true });
      this.ownsDb = true;
    } else {
      this.db = dbPathOrDb;
      this.ownsDb = false;
    }
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chatgpt_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        email TEXT,
        token_enc TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chatgpt_snapshots (
        account_id TEXT PRIMARY KEY REFERENCES chatgpt_accounts(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `);
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  private rowToRecord(row: Record<string, unknown> | null | undefined): { id: string; label: string; email: string | null; tokenEnc: string; enabled: boolean; createdAt: string; updatedAt: string } | null {
    if (!row) return null;
    return {
      id: String(row.id),
      label: String(row.label),
      email: row.email ? String(row.email) : null,
      tokenEnc: String(row.token_enc),
      enabled: Number(row.enabled) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private snapshotOf(id: string): ChatgptSnapshot | null {
    const row = this.db.query("SELECT snapshot_json FROM chatgpt_snapshots WHERE account_id = ?").get(id) as { snapshot_json?: unknown } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(String(row.snapshot_json)) as ChatgptSnapshot;
    } catch {
      return null;
    }
  }

  listAccounts(): ChatgptAccountPublic[] {
    const rows = this.db.query("SELECT * FROM chatgpt_accounts ORDER BY created_at ASC").all() as Record<string, unknown>[];
    return rows.map((row) => {
      const r = this.rowToRecord(row);
      if (!r) throw new Error("Unexpected empty account row");
      return {
        id: r.id,
        label: r.label,
        email: r.email,
        enabled: r.enabled,
        hasToken: r.tokenEnc.length > 0,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        snapshot: this.snapshotOf(r.id),
      };
    });
  }

  listEnabledAccounts(): ChatgptAccountPublic[] {
    return this.listAccounts().filter((a) => a.enabled);
  }

  getAccessToken(id: string): string | null {
    const row = this.db.query("SELECT token_enc FROM chatgpt_accounts WHERE id = ?").get(validateId(id)) as { token_enc?: unknown } | undefined;
    if (!row) return null;
    try {
      return decryptSecret(String(row.token_enc), this.key);
    } catch {
      return null;
    }
  }

  upsertAccount(input: ChatgptAccountInput): ChatgptAccountPublic {
    const id = validateId(input.id ?? randomUUID());
    const now = new Date().toISOString();
    const label = input.label.trim().slice(0, MAX_LABEL);
    if (!label) throw new Error("ChatGPT account label is required.");
    const email = input.email?.trim() || null;
    const enabled = input.enabled !== false;
    const encrypted = encryptSecret(input.accessToken, this.key);

    const existing = this.db.query("SELECT id FROM chatgpt_accounts WHERE id = ?").get(id) as { id?: unknown } | undefined;
    if (existing) {
      this.db.query("UPDATE chatgpt_accounts SET label = ?, email = ?, token_enc = ?, enabled = ?, updated_at = ? WHERE id = ?").run(label, email, encrypted, enabled ? 1 : 0, now, id);
    } else {
      this.db.query("INSERT INTO chatgpt_accounts (id, label, email, token_enc, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, label, email, encrypted, enabled ? 1 : 0, now, now);
    }
    return {
      id,
      label,
      email,
      enabled,
      hasToken: true,
      createdAt: now,
      updatedAt: now,
      snapshot: this.snapshotOf(id),
    };
  }

  setAccountEnabled(id: string, enabled: boolean): ChatgptAccountPublic | null {
    const normalized = validateId(id);
    const now = new Date().toISOString();
    const result = this.db.query("UPDATE chatgpt_accounts SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, now, normalized);
    if (result.changes === 0) return null;
    return this.listAccounts().find((a) => a.id === normalized) ?? null;
  }

  removeAccount(id: string): boolean {
    const result = this.db.query("DELETE FROM chatgpt_accounts WHERE id = ?").run(validateId(id));
    return result.changes > 0;
  }

  saveSnapshot(accountId: string, snapshot: ChatgptSnapshot): void {
    const json = JSON.stringify(snapshot);
    this.db.query("INSERT INTO chatgpt_snapshots (account_id, snapshot_json, observed_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, observed_at = excluded.observed_at").run(validateId(accountId), json, snapshot.probedAt);
  }

  getSnapshot(accountId: string): ChatgptSnapshot | null {
    return this.snapshotOf(validateId(accountId));
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        // ignore
      }
    }
    this.closeHandlers.clear();
    if (this.ownsDb) this.db.close();
  }
}
