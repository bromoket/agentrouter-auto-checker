/**
 * Antigravity account + snapshot store (separate sqlite file from the observatory DB).
 *
 * Refresh tokens are stored AES-256-GCM encrypted at rest via ./crypto. Raw tokens never
 * cross the store boundary unencrypted except transiently inside an upsert call.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { decryptToken, deriveEncryptionKey, encryptToken } from "./crypto";
import type {
  AntigravityAccountPublic,
  AntigravityAccountRecord,
  AntigravityAccountSnapshot,
} from "./types";

export interface AntigravityAccountInput {
  id?: string;
  label: string;
  email?: string | null;
  refreshToken: string;
  fingerprintJson?: string | null;
  projectId?: string | null;
  enabled?: boolean;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_LABEL = 128;

function validateId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Invalid Antigravity account id: ${id}`);
  }
  return id;
}

export class AntigravityStore {
  private readonly db: Database;
  private readonly ownsDb: boolean;
  private readonly key: Buffer;
  private readonly closeHandlers = new Set<() => void>();

  constructor(dbPathOrDb: string | Database, encryptionSecret: string) {
    this.key = deriveEncryptionKey(encryptionSecret);
    if (typeof dbPathOrDb === "string") {
      if (dbPathOrDb !== ":memory:") {
        mkdirSync(dirname(dbPathOrDb), { recursive: true });
      }
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
      CREATE TABLE IF NOT EXISTS antigravity_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        email TEXT,
        refresh_token_enc TEXT NOT NULL,
        fingerprint_json TEXT,
        project_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS antigravity_snapshots (
        account_id TEXT PRIMARY KEY REFERENCES antigravity_accounts(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
    `);
    this.db.exec("PRAGMA journal_mode = WAL;");
  }

  private rowToRecord(row: Record<string, unknown> | null | undefined): AntigravityAccountRecord | null {
    if (!row) return null;
    return {
      id: String(row.id),
      label: String(row.label),
      email: row.email ? String(row.email) : null,
      refreshTokenEnc: String(row.refresh_token_enc),
      fingerprintJson: row.fingerprint_json ? String(row.fingerprint_json) : null,
      projectId: row.project_id ? String(row.project_id) : null,
      enabled: Number(row.enabled) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private snapshotOf(record: AntigravityAccountRecord): AntigravityAccountSnapshot | null {
    const row = this.db
      .query("SELECT snapshot_json FROM antigravity_snapshots WHERE account_id = ?")
      .get(record.id) as { snapshot_json?: unknown } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(String(row.snapshot_json)) as AntigravityAccountSnapshot;
    } catch {
      return null;
    }
  }

  listAccounts(): AntigravityAccountPublic[] {
    const rows = this.db
      .query("SELECT * FROM antigravity_accounts ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map((row) => {
      const record = this.rowToRecord(row);
      if (!record) throw new Error("Unexpected empty account row");
      const snapshot = this.snapshotOf(record);
      return {
        id: record.id,
        label: record.label,
        email: record.email,
        projectId: record.projectId,
        enabled: record.enabled,
        hasToken: record.refreshTokenEnc.length > 0,
        hasFingerprint: record.fingerprintJson !== null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        snapshot,
      };
    });
  }

  listEnabledAccounts(): AntigravityAccountPublic[] {
    return this.listAccounts().filter((account) => account.enabled);
  }

  getAccount(id: string): AntigravityAccountRecord | null {
    const row = this.db
      .query("SELECT * FROM antigravity_accounts WHERE id = ?")
      .get(validateId(id)) as Record<string, unknown> | undefined;
    return this.rowToRecord(row);
  }

  /** Returns decrypted refresh token for a stored account id. */
  getRefreshToken(id: string): string | null {
    const record = this.getAccount(id);
    if (!record) return null;
    try {
      return decryptToken(record.refreshTokenEnc, this.key);
    } catch {
      return null;
    }
  }

  upsertAccount(input: AntigravityAccountInput): AntigravityAccountPublic {
    const id = validateId(input.id ?? randomUUID());
    const now = new Date().toISOString();
    const label = input.label.trim().slice(0, MAX_LABEL);
    if (!label) {
      throw new Error("Antigravity account label is required.");
    }
    const email = input.email?.trim() || null;
    const fingerprintJson = input.fingerprintJson?.trim() || null;
    const projectId = input.projectId?.trim() || null;
    const enabled = input.enabled !== false;
    const encrypted = encryptToken(input.refreshToken, this.key);

    const existing = this.db
      .query("SELECT id FROM antigravity_accounts WHERE id = ?")
      .get(id) as { id?: unknown } | undefined;

    if (existing) {
      this.db
        .query(
          `UPDATE antigravity_accounts
             SET label = ?, email = ?, refresh_token_enc = ?, fingerprint_json = ?, project_id = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(label, email, encrypted, fingerprintJson, projectId, enabled ? 1 : 0, now, id);
    } else {
      this.db
        .query(
          `INSERT INTO antigravity_accounts
             (id, label, email, refresh_token_enc, fingerprint_json, project_id, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, label, email, encrypted, fingerprintJson, projectId, enabled ? 1 : 0, now, now);
    }
    const record = this.getAccount(id);
    if (!record) throw new Error("Antigravity account upsert failed.");
    return {
      id: record.id,
      label: record.label,
      email: record.email,
      projectId: record.projectId,
      enabled: record.enabled,
      hasToken: true,
      hasFingerprint: record.fingerprintJson !== null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      snapshot: this.snapshotOf(record),
    };
  }

  /** Rotate a stored refresh token (Google may issue a new one on refresh). */
  updateAccountRefreshToken(id: string, refreshToken: string): void {
    const encrypted = encryptToken(refreshToken, this.key);
    const now = new Date().toISOString();
    this.db
      .query("UPDATE antigravity_accounts SET refresh_token_enc = ?, updated_at = ? WHERE id = ?")
      .run(encrypted, now, validateId(id));
  }

  setAccountEnabled(id: string, enabled: boolean): AntigravityAccountPublic | null {
    const normalized = validateId(id);
    const now = new Date().toISOString();
    const result = this.db
      .query("UPDATE antigravity_accounts SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, now, normalized);
    if (result.changes === 0) return null;
    const record = this.getAccount(normalized);
    if (!record) return null;
    const publicAccount: AntigravityAccountPublic = {
      id: record.id,
      label: record.label,
      email: record.email,
      projectId: record.projectId,
      enabled: record.enabled,
      hasToken: true,
      hasFingerprint: record.fingerprintJson !== null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      snapshot: this.snapshotOf(record),
    };
    return publicAccount;
  }

  setAccountProject(id: string, projectId: string | null): void {
    const now = new Date().toISOString();
    this.db
      .query("UPDATE antigravity_accounts SET project_id = ?, updated_at = ? WHERE id = ?")
      .run(projectId?.trim() || null, now, validateId(id));
  }

  removeAccount(id: string): boolean {
    const result = this.db
      .query("DELETE FROM antigravity_accounts WHERE id = ?")
      .run(validateId(id));
    return result.changes > 0;
  }

  saveSnapshot(accountId: string, snapshot: AntigravityAccountSnapshot): void {
    const json = JSON.stringify(snapshot);
    this.db
      .query(
        `INSERT INTO antigravity_snapshots (account_id, snapshot_json, observed_at)
         VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, observed_at = excluded.observed_at`,
      )
      .run(validateId(accountId), json, snapshot.probedAt);
  }

  getSnapshot(accountId: string): AntigravityAccountSnapshot | null {
    const record = this.getAccount(accountId);
    if (!record) return null;
    return this.snapshotOf(record);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  close(): void {
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        // ignore per-handler failures
      }
    }
    this.closeHandlers.clear();
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
