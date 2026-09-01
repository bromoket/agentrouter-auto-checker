import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface GitHubAccount {
  id: string;
  label: string;
  githubUsername: string;
  githubPassword: string;
  agentRouterApiToken?: string;
  enabled: boolean;
  runOrder: number;
}

export interface PublicAccount {
  id: string;
  label: string;
  githubUsername: string;
  enabled: boolean;
  hasPassword: boolean;
  hasApiToken: boolean;
  runOrder: number;
}

export interface AccountInput {
  id?: unknown;
  label?: unknown;
  githubUsername?: unknown;
  githubPassword?: unknown;
  enabled?: unknown;
  runOrder?: unknown;
}

interface AccountFile {
  version: 1;
  accounts: GitHubAccount[];
}

const USERNAME_PATTERN = /^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FORBIDDEN_LABEL_PATTERN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]|\p{Bidi_Control}/u;
const MAX_ACCOUNTS = 100;

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validateStoredAccount(value: unknown, index: number): GitHubAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Account ${index + 1} is not an object.`);
  }

  const candidate = value as Record<string, unknown>;
  const id = asTrimmedString(candidate.id).toLowerCase();
  const githubUsername = asTrimmedString(candidate.githubUsername);
  const githubPassword = typeof candidate.githubPassword === "string" ? candidate.githubPassword : "";
  const agentRouterApiToken = typeof candidate.agentRouterApiToken === "string"
    ? candidate.agentRouterApiToken.trim()
    : undefined;
  let label: string;
  if (typeof candidate.label === "string") {
    if (FORBIDDEN_LABEL_PATTERN.test(candidate.label)) {
      throw new Error(`Account ${index + 1} has an invalid label.`);
    }
    const trimmed = candidate.label.trim().normalize("NFC");
    label = trimmed || githubUsername;
  } else if (candidate.label === undefined || candidate.label === null) {
    label = githubUsername;
  } else {
    throw new Error(`Account ${index + 1} has an invalid label.`);
  }
  const requestedOrder = Number(candidate.runOrder);
  const runOrder = Number.isSafeInteger(requestedOrder) && requestedOrder >= 0
    ? Math.min(requestedOrder, 10_000)
    : index;

  if (!ID_PATTERN.test(id)) {
    throw new Error(`Account ${index + 1} has an invalid id.`);
  }
  if (!USERNAME_PATTERN.test(githubUsername)) {
    throw new Error(`Account ${index + 1} has an invalid GitHub username.`);
  }
  if (!githubPassword || githubPassword.length > 512) {
    throw new Error(`Account ${index + 1} must have a password of at most 512 characters.`);
  }
  if (agentRouterApiToken && (!/^[A-Za-z0-9_-]{20,256}$/.test(agentRouterApiToken))) {
    throw new Error(`Account ${index + 1} has an invalid AgentRouter API token.`);
  }
  if (label.length > 80) {
    throw new Error(`Account ${index + 1} has a label longer than 80 characters.`);
  }

  return {
    id,
    label,
    githubUsername,
    githubPassword,
    agentRouterApiToken,
    enabled: candidate.enabled !== false,
    runOrder,
  };
}

function normalizeFile(value: unknown): AccountFile {
  const rawAccounts = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).accounts)
      ? ((value as Record<string, unknown>).accounts as unknown[])
      : null;

  if (!rawAccounts) {
    throw new Error("Account file must contain an accounts array.");
  }
  if (rawAccounts.length > MAX_ACCOUNTS) {
    throw new Error(`Account file cannot contain more than ${MAX_ACCOUNTS} accounts.`);
  }

  const accounts = rawAccounts.map(validateStoredAccount);
  const ids = new Set<string>();
  const usernames = new Set<string>();
  for (const account of accounts) {
    const usernameKey = account.githubUsername.toLowerCase();
    if (ids.has(account.id)) {
      throw new Error(`Duplicate account id: ${account.id}`);
    }
    if (usernames.has(usernameKey)) {
      throw new Error(`Duplicate GitHub username: ${account.githubUsername}`);
    }
    ids.add(account.id);
    usernames.add(usernameKey);
  }

  return { version: 1, accounts };
}

function publicAccount(account: GitHubAccount): PublicAccount {
  return {
    id: account.id,
    label: account.label,
    githubUsername: account.githubUsername,
    enabled: account.enabled,
    hasPassword: account.githubPassword.length > 0,
    hasApiToken: Boolean(account.agentRouterApiToken),
    runOrder: account.runOrder,
  };
}

function createId(username: string, existing: GitHubAccount[]): string {
  const base = username
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "account";

  if (!existing.some((account) => account.id === base)) {
    return base;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

async function restrictCredentialFile(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(filePath, 0o600);
    return;
  }

  const username = process.env.USERNAME?.trim();
  if (!username) {
    throw new Error("Cannot restrict the account file because USERNAME is unavailable.");
  }
  const processHandle = Bun.spawn({
    cmd: [
      "icacls",
      filePath,
      "/inheritance:r",
      "/grant:r",
      `${username}:(F)`,
      "*S-1-5-18:(F)",
      "*S-1-5-32-544:(F)",
    ],
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrPromise = new Response(processHandle.stderr).text();
  const exitCode = await processHandle.exited;
  const stderr = await stderrPromise;
  if (exitCode !== 0) {
    throw new Error(`Failed to restrict the account file ACL: ${stderr.trim()}`);
  }
}

export class AccountStore {
  constructor(readonly path: string) {}

  async load(): Promise<GitHubAccount[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Account file is not valid JSON: ${this.path}`);
    }
    return normalizeFile(parsed).accounts;
  }

  async listPublic(): Promise<PublicAccount[]> {
    return (await this.load()).map(publicAccount);
  }

  async setApiToken(id: string, token: string): Promise<boolean> {
    if (!ID_PATTERN.test(id) || !/^[A-Za-z0-9_-]{20,256}$/.test(token)) return false;
    const accounts = await this.load();
    const index = accounts.findIndex((account) => account.id === id);
    if (index < 0) return false;
    accounts[index] = { ...accounts[index], agentRouterApiToken: token };
    await this.write(accounts);
    return true;
  }

  async getApiToken(id: string): Promise<string | null> {
    if (!ID_PATTERN.test(id)) return null;
    return (await this.load()).find((account) => account.id === id)?.agentRouterApiToken ?? null;
  }

  async upsert(input: AccountInput): Promise<PublicAccount> {
    const accounts = await this.load();
    const requestedId = asTrimmedString(input.id).toLowerCase();
    const existingIndex = requestedId
      ? accounts.findIndex((account) => account.id === requestedId)
      : -1;
    const existing = existingIndex >= 0 ? accounts[existingIndex] : undefined;

    const githubUsername = asTrimmedString(input.githubUsername) || existing?.githubUsername || "";
    const suppliedPassword = typeof input.githubPassword === "string" ? input.githubPassword : "";
    const githubPassword = suppliedPassword || existing?.githubPassword || "";
    const rawLabel = input.label !== undefined
      ? (typeof input.label === "string" && input.label.trim().length === 0 && !FORBIDDEN_LABEL_PATTERN.test(input.label)
          ? (existing?.label || githubUsername)
          : input.label)
      : (existing?.label || githubUsername);
    const id = existing?.id || (requestedId && ID_PATTERN.test(requestedId)
      ? requestedId
      : createId(githubUsername, accounts));

    const account = validateStoredAccount(
      {
        id,
        label: rawLabel,
        githubUsername,
        githubPassword,
        agentRouterApiToken: existing?.agentRouterApiToken,
        enabled: typeof input.enabled === "boolean" ? input.enabled : existing?.enabled ?? true,
        runOrder: input.runOrder ?? existing?.runOrder ?? accounts.length,
      },
      existingIndex >= 0 ? existingIndex : accounts.length,
    );

    const duplicate = accounts.find(
      (candidate, index) =>
        index !== existingIndex &&
        candidate.githubUsername.toLowerCase() === account.githubUsername.toLowerCase(),
    );
    if (duplicate) {
      throw new Error(`GitHub username ${account.githubUsername} is already configured.`);
    }

    if (existingIndex >= 0) {
      accounts[existingIndex] = account;
    } else {
      if (accounts.length >= MAX_ACCOUNTS) {
        throw new Error(`No more than ${MAX_ACCOUNTS} accounts can be configured.`);
      }
      accounts.push(account);
    }

    await this.write(accounts);
    return publicAccount(account);
  }

  async remove(id: string): Promise<boolean> {
    if (!ID_PATTERN.test(id)) {
      return false;
    }
    const accounts = await this.load();
    const remaining = accounts.filter((account) => account.id !== id);
    if (remaining.length === accounts.length) {
      return false;
    }
    await this.write(remaining);
    return true;
  }

  private async write(accounts: GitHubAccount[]): Promise<void> {
    const normalized = normalizeFile({ accounts });
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const contents = `${JSON.stringify(normalized, null, 2)}\n`;
    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await restrictCredentialFile(temporaryPath);
      await rename(temporaryPath, this.path);
      await restrictCredentialFile(this.path);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
