import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { AccountStore } from "./accounts";

const temporaryDirectories: string[] = [];

async function temporaryStore(): Promise<AccountStore> {
  const directory = await mkdtemp(join(tmpdir(), "agentrouter-accounts-test-"));
  temporaryDirectories.push(directory);
  return new AccountStore(join(directory, "accounts.json"));
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = resolve(temporaryDirectories.pop()!);
    const tempRoot = `${resolve(tmpdir())}${sep}`;
    if (directory.startsWith(tempRoot)) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("AccountStore", () => {
  test("a missing file produces an empty account list", async () => {
    const store = await temporaryStore();
    expect(await store.load()).toEqual([]);
    expect(await store.listPublic()).toEqual([]);
  });

  test("saves arbitrary accounts without exposing passwords", async () => {
    const store = await temporaryStore();
    const first = await store.upsert({
      githubUsername: "octocat",
      githubPassword: "test-password-1",
      label: "Main",
      enabled: true,
    });
    const second = await store.upsert({
      githubUsername: "hubot",
      githubPassword: "test-password-2",
      enabled: true,
    });

    expect(first.id).toBe("octocat");
    expect(second.id).toBe("hubot");
    const publicAccounts = await store.listPublic();
    expect(publicAccounts).toHaveLength(2);
    expect(publicAccounts[0]).not.toHaveProperty("githubPassword");
    expect(publicAccounts[0].hasPassword).toBe(true);
    expect(publicAccounts.map((account) => account.runOrder)).toEqual([0, 1]);
  });

  test("keeps an existing password when an edit sends an empty password", async () => {
    const store = await temporaryStore();
    const created = await store.upsert({
      githubUsername: "octocat",
      githubPassword: "test-password",
      enabled: true,
    });
    await store.upsert({
      id: created.id,
      githubUsername: "octocat",
      githubPassword: "",
      label: "Updated",
      enabled: false,
      runOrder: 7,
    });

    const [stored] = await store.load();
    expect(stored.githubPassword).toBe("test-password");
    expect(stored.label).toBe("Updated");
    expect(stored.enabled).toBe(false);
    expect(stored.runOrder).toBe(7);
  });

  test("stores a captured API token without exposing its value publicly", async () => {
    const store = await temporaryStore();
    const account = await store.upsert({
      githubUsername: "octocat",
      githubPassword: "test-password",
    });
    const token = `sk-${"a".repeat(32)}`;

    expect(await store.setApiToken(account.id, token)).toBe(true);
    expect(await store.getApiToken(account.id)).toBe(token);
    const [publicAccount] = await store.listPublic();
    expect(publicAccount.hasApiToken).toBe(true);
    expect(publicAccount).not.toHaveProperty("agentRouterApiToken");
  });

  test("rejects duplicate usernames and invalid GitHub usernames", async () => {
    const store = await temporaryStore();
    await store.upsert({
      githubUsername: "octocat",
      githubPassword: "test-password",
    });
    await expect(
      store.upsert({ githubUsername: "OctoCat", githubPassword: "different" }),
    ).rejects.toThrow("already configured");
    await expect(
      store.upsert({ githubUsername: "invalid--name", githubPassword: "different" }),
    ).rejects.toThrow("invalid GitHub username");
  });

  test("removes an account without affecting other accounts", async () => {
    const store = await temporaryStore();
    const first = await store.upsert({ githubUsername: "octocat", githubPassword: "one" });
    await store.upsert({ githubUsername: "hubot", githubPassword: "two" });

    expect(await store.remove(first.id)).toBe(true);
    expect(await store.remove(first.id)).toBe(false);
    expect((await store.load()).map((account) => account.githubUsername)).toEqual(["hubot"]);
  });
});
