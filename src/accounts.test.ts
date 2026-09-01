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
    const token = "a".repeat(48);

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

  test("normalizes labels to Unicode NFC form", async () => {
    const store = await temporaryStore();
    const latinNfd = "Cafe\u0301";
    const hangulNfd = "\u1100\u1161";

    const first = await store.upsert({
      githubUsername: "octocat",
      githubPassword: "test-password-1",
      label: latinNfd,
    });
    const second = await store.upsert({
      githubUsername: "hubot",
      githubPassword: "test-password-2",
      label: hangulNfd,
    });

    expect(first.label).toBe("Caf\u00e9");
    expect(second.label).toBe("\uac00");

    const [storedFirst, storedSecond] = await store.load();
    expect(storedFirst.label).toBe("Caf\u00e9");
    expect(storedSecond.label).toBe("\uac00");

    const publicAccounts = await store.listPublic();
    expect(publicAccounts[0].label).toBe("Caf\u00e9");
    expect(publicAccounts[1].label).toBe("\uac00");
  });

  test("rejects forbidden C0 control characters in labels without leaking label content", async () => {
    const store = await temporaryStore();
    const c0Cases = [
      { label: "secret-c0\x00-label", name: "NUL" },
      { label: "secret-c0\x07-label", name: "BEL" },
      { label: "secret-c0\x08-label", name: "BS" },
      { label: "secret-c0\t-label", name: "TAB" },
      { label: "secret-c0\x1b-label", name: "ESC" },
      { label: "secret-c0\x7f-label", name: "DEL" },
    ];

    for (const { label } of c0Cases) {
      try {
        await store.upsert({
          githubUsername: "octocat",
          githubPassword: "test-password",
          label,
        });
        expect.unreachable("Expected forbidden C0 label to be rejected");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toBe("Account 1 has an invalid label.");
        expect(message).not.toContain("secret-c0");
      }
    }
  });

  test("rejects CR, LF, and CRLF line breaks in labels without leaking label content", async () => {
    const store = await temporaryStore();
    const lineBreakCases = [
      "secret-lf\n-label",
      "secret-cr\r-label",
      "secret-crlf\r\n-label",
      "secret-trailing-lf\n",
      "\nsecret-leading-lf",
      " \r\n ",
    ];

    for (const label of lineBreakCases) {
      try {
        await store.upsert({
          githubUsername: "octocat",
          githubPassword: "test-password",
          label,
        });
        expect.unreachable(`Expected line break label ${JSON.stringify(label)} to be rejected`);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toBe("Account 1 has an invalid label.");
        expect(message).not.toContain("secret-");
      }
    }
  });

  test("rejects C1 control characters in labels without leaking label content", async () => {
    const store = await temporaryStore();
    const c1Cases = [
      { label: "secret-c1\u0080-label", name: "PAD (0x80)" },
      { label: "secret-c1\u0085-label", name: "NEL (0x85)" },
      { label: "secret-c1\u009B-label", name: "CSI (0x9B)" },
      { label: "secret-c1\u009F-label", name: "APC (0x9F)" },
    ];

    for (const { label } of c1Cases) {
      try {
        await store.upsert({
          githubUsername: "octocat",
          githubPassword: "test-password",
          label,
        });
        expect.unreachable("Expected C1 label to be rejected");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toBe("Account 1 has an invalid label.");
        expect(message).not.toContain("secret-c1");
      }
    }
  });

  test("rejects Unicode line and paragraph separators in labels without leaking label content", async () => {
    const store = await temporaryStore();
    const separatorCases = [
      { label: "secret-sep\u2028-label", name: "Line Separator (U+2028)" },
      { label: "secret-sep\u2029-label", name: "Paragraph Separator (U+2029)" },
    ];

    for (const { label } of separatorCases) {
      try {
        await store.upsert({
          githubUsername: "octocat",
          githubPassword: "test-password",
          label,
        });
        expect.unreachable("Expected separator label to be rejected");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toBe("Account 1 has an invalid label.");
        expect(message).not.toContain("secret-sep");
      }
    }
  });

  test("rejects bidirectional formatting controls, overrides, and isolates in labels without leaking label content", async () => {
    const store = await temporaryStore();
    const bidiCases = [
      { label: "secret-bidi\u061C-label", name: "ALM" },
      { label: "secret-bidi\u200E-label", name: "LRM" },
      { label: "secret-bidi\u200F-label", name: "RLM" },
      { label: "secret-bidi\u202A-label", name: "LRE" },
      { label: "secret-bidi\u202B-label", name: "RLE" },
      { label: "secret-bidi\u202C-label", name: "PDF" },
      { label: "secret-bidi\u202D-label", name: "LRO" },
      { label: "secret-bidi\u202E-label", name: "RLO" },
      { label: "secret-bidi\u2066-label", name: "LRI" },
      { label: "secret-bidi\u2067-label", name: "RLI" },
      { label: "secret-bidi\u2068-label", name: "FSI" },
      { label: "secret-bidi\u2069-label", name: "PDI" },
    ];

    for (const { label } of bidiCases) {
      try {
        await store.upsert({
          githubUsername: "octocat",
          githubPassword: "test-password",
          label,
        });
        expect.unreachable("Expected bidi label to be rejected");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toBe("Account 1 has an invalid label.");
        expect(message).not.toContain("secret-bidi");
      }
    }
  });

  test("rejects ANSI escape sequences in labels without leaking label content", async () => {
    const store = await temporaryStore();
    const ansiCases = [
      "\u001b[31msecret-ansi-red\u001b[0m",
      "\u001b]0;secret-title\x07",
      "\u009B2J",
    ];

    for (const label of ansiCases) {
      try {
        await store.upsert({
          githubUsername: "octocat",
          githubPassword: "test-password",
          label,
        });
        expect.unreachable("Expected ANSI escape label to be rejected");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toBe("Account 1 has an invalid label.");
        expect(message).not.toContain("secret-");
      }
    }
  });

  test("accepts valid Unicode labels across multiple scripts and emoji", async () => {
    const store = await temporaryStore();
    const validLabels = [
      { username: "user-latin", label: "Compte vérifié #1" },
      { username: "user-umlaut", label: "Überprüfungskonto" },
      { username: "user-japanese", label: "アカウント管理者" },
      { username: "user-chinese", label: "自动化账号" },
      { username: "user-arabic", label: "حساب رئيسي" },
      { username: "user-hebrew", label: "חשבון בדיקה" },
      { username: "user-cyrillic", label: "Основной аккаунт" },
      { username: "user-emoji", label: "🚀 Deploy Bot #1 🛡️" },
    ];

    for (const { username, label } of validLabels) {
      const created = await store.upsert({
        githubUsername: username,
        githubPassword: "test-password",
        label,
      });
      expect(created.label).toBe(label.normalize("NFC"));
    }

    const loaded = await store.load();
    expect(loaded).toHaveLength(validLabels.length);
    for (let i = 0; i < validLabels.length; i++) {
      expect(loaded[i].label).toBe(validLabels[i].label.normalize("NFC"));
    }
  });

  test("handles label boundary lengths and fallback rules correctly", async () => {
    const store = await temporaryStore();
    const exact80 = "A".repeat(80);
    const over80 = "B".repeat(81);

    const created80 = await store.upsert({
      githubUsername: "user-exact",
      githubPassword: "test-password",
      label: exact80,
    });
    expect(created80.label).toBe(exact80);

    try {
      await store.upsert({
        githubUsername: "user-over",
        githubPassword: "test-password",
        label: over80,
      });
      expect.unreachable("Expected 81 char label to be rejected");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("longer than 80 characters");
      expect(message).not.toContain(over80);
    }

    // Fallback to username on undefined, empty string, or whitespace-only
    const createdDefault = await store.upsert({
      githubUsername: "user-default",
      githubPassword: "test-password",
    });
    expect(createdDefault.label).toBe("user-default");

    const createdSpaces = await store.upsert({
      githubUsername: "user-spaces",
      githubPassword: "test-password",
      label: "    ",
    });
    expect(createdSpaces.label).toBe("user-spaces");

    // Preserves existing label on update when label is not provided
    const updated = await store.upsert({
      id: created80.id,
      githubUsername: "user-exact",
      githubPassword: "",
      enabled: false,
    });
    expect(updated.label).toBe(exact80);
  });
});
