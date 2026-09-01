import { describe, expect, test } from "bun:test";
import {
  PINNED_TAILSCALE_CLI_VERSION,
  PINNED_TAILSCALE_WHOIS_SCHEMA,
  TAILSCALE_WHOIS_MAX_STDOUT_BYTES,
  TAILSCALE_WHOIS_TIMEOUT_MS,
  TailscaleIdentityAdapter,
  TailscaleIdentityError,
  TailscaleIdentityErrorCategory,
  type TailscaleWhoisExecutionRequest,
  type TailscaleWhoisExecutionResult,
  type TailscaleWhoisExecutor,
} from "./tailscale-identity";

const EXECUTABLE = "/opt/afo/pinned/tailscale";
const PEER = "100.64.0.42:8457";
const NODE_ID = "n-redacted-stable-node-id";
const ALLOWED_TAG = "tag:afo-collector";
const NAME_CANARY = "NAME-CANARY.invalid.";
const EMAIL_CANARY = "EMAIL-CANARY@example.invalid";
const IP_CANARY = "100.99.88.77/32";
const PROFILE_CANARY = "https://example.invalid/PROFILE-CANARY";
const STDOUT_CANARY = "STDOUT-CANARY-NEVER-RETURN";
const ERROR_CANARY = "ERROR-CANARY-NEVER-RETURN";

function whoisFixture(
  nodeOverrides: Record<string, unknown> = {},
  topLevelOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    Node: {
      ID: 987654,
      StableID: NODE_ID,
      Name: NAME_CANARY,
      User: 1234,
      Key: "nodekey:REDACTED",
      KeyExpiry: "2030-01-01T00:00:00Z",
      Machine: "machinekey:REDACTED",
      DiscoKey: "discokey:REDACTED",
      Addresses: [IP_CANARY],
      AllowedIPs: [IP_CANARY],
      Hostinfo: {},
      Created: "2025-01-01T00:00:00Z",
      Tags: [ALLOWED_TAG],
      ...nodeOverrides,
    },
    UserProfile: {
      ID: 1234,
      LoginName: EMAIL_CANARY,
      DisplayName: "DISPLAY-NAME-CANARY",
      ProfilePicURL: PROFILE_CANARY,
      Groups: [],
    },
    CapMap: {},
    ...topLevelOverrides,
  };
}

function jsonResult(value = whoisFixture()): TailscaleWhoisExecutionResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(value),
  };
}

function executorReturning(
  result: TailscaleWhoisExecutionResult
): TailscaleWhoisExecutor {
  return async () => result;
}

function createAdapter(executor: TailscaleWhoisExecutor): TailscaleIdentityAdapter {
  return new TailscaleIdentityAdapter({
    executablePath: EXECUTABLE,
    cliVersion: PINNED_TAILSCALE_CLI_VERSION,
    allowedTags: [ALLOWED_TAG],
    executor,
  });
}

async function captureError(
  promise: Promise<unknown>,
  category: TailscaleIdentityErrorCategory
): Promise<TailscaleIdentityError> {
  try {
    await promise;
    throw new Error("expected categorical identity failure");
  } catch (error) {
    expect(error).toBeInstanceOf(TailscaleIdentityError);
    const identityError = error as TailscaleIdentityError;
    expect(identityError.category).toBe(category);
    expect(identityError.message).toBe(`tailscale_identity:${category}`);
    expect(identityError.stack).toBeUndefined();
    return identityError;
  }
}

describe("TailscaleIdentityAdapter", () => {
  test("pins the CLI and closed whois schema contract", () => {
    expect(PINNED_TAILSCALE_CLI_VERSION).toBe(
      "1.102.2-t6cac91817-g6ff0ddc72"
    );
    expect(PINNED_TAILSCALE_WHOIS_SCHEMA).toBe(
      "tailscale-1.102.2.whois-json.v1"
    );
  });

  test("returns only the stable Node ID after validating allowed tags", async () => {
    const identity = await createAdapter(executorReturning(jsonResult())).lookup(PEER);

    expect(identity).toEqual({ nodeId: NODE_ID });
    expect(Object.keys(identity)).toEqual(["nodeId"]);
    expect(Object.isFrozen(identity)).toBe(true);
    const serialized = JSON.stringify(identity);
    for (const canary of [
      NAME_CANARY,
      EMAIL_CANARY,
      IP_CANARY,
      PROFILE_CANARY,
      "987654",
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  test("passes exact argv, empty environment, deadline, and stdout cap", async () => {
    let request: TailscaleWhoisExecutionRequest | undefined;
    const executor: TailscaleWhoisExecutor = async (received) => {
      request = received;
      return jsonResult();
    };

    await createAdapter(executor).lookup(PEER);

    expect(request).toBeDefined();
    expect(request!.argv).toEqual([
      EXECUTABLE,
      "whois",
      "--json",
      PEER,
    ]);
    expect(request!.env).toEqual({});
    expect(Object.keys(request!.env)).toEqual([]);
    expect(request!.timeoutMs).toBe(TAILSCALE_WHOIS_TIMEOUT_MS);
    expect(request!.timeoutMs).toBe(1_000);
    expect(request!.maxStdoutBytes).toBe(TAILSCALE_WHOIS_MAX_STDOUT_BYTES);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request!.argv)).toBe(true);
    expect(Object.isFrozen(request!.env)).toBe(true);
    expect(request!.signal).toBeInstanceOf(AbortSignal);
  });

  test("accepts raw IPv6 and bracketed IPv6 with a port without rewriting argv", async () => {
    const peers = ["fd7a:115c:a1e0::42", "[fd7a:115c:a1e0::42]:8457"];
    const seen: string[] = [];
    const adapter = createAdapter(async (request) => {
      seen.push(request.argv[3] ?? "");
      return jsonResult();
    });

    for (const peer of peers) await adapter.lookup(peer);
    expect(seen).toEqual(peers);
  });

  test("rejects hostnames and malformed peers categorically without executing", async () => {
    let executions = 0;
    const adapter = createAdapter(async () => {
      executions++;
      return jsonResult();
    });

    for (const peer of [
      "collector.example.invalid:8457",
      "100.64.0.42:0",
      "100.64.0.42:65536",
      "100.64.0.42 --json",
    ]) {
      await captureError(
        adapter.lookup(peer),
        TailscaleIdentityErrorCategory.INVALID_PEER
      );
    }
    expect(executions).toBe(0);
  });

  test("rejects missing, unallowlisted, duplicate, and malformed tags", async () => {
    const cases = [
      whoisFixture({ Tags: undefined }),
      whoisFixture({ Tags: ["tag:other-role"] }),
      whoisFixture({ Tags: [ALLOWED_TAG, "tag:other-role"] }),
      whoisFixture({ Tags: ["not-a-tailnet-tag"] }),
      whoisFixture({ Tags: [] }),
      whoisFixture({ Tags: [ALLOWED_TAG, ALLOWED_TAG] }),
    ];

    for (const fixture of cases) {
      await captureError(
        createAdapter(executorReturning(jsonResult(fixture))).lookup(PEER),
        TailscaleIdentityErrorCategory.TAG_REJECTED
      );
    }
  });

  test("requires the complete registered tag set", async () => {
    const executor = executorReturning(
      jsonResult(whoisFixture({ Tags: [ALLOWED_TAG] }))
    );
    const adapter = new TailscaleIdentityAdapter({
      executablePath: EXECUTABLE,
      cliVersion: PINNED_TAILSCALE_CLI_VERSION,
      allowedTags: [ALLOWED_TAG, "tag:production"],
      executor,
    });

    await captureError(
      adapter.lookup(PEER),
      TailscaleIdentityErrorCategory.TAG_REJECTED
    );

    const exactAdapter = new TailscaleIdentityAdapter({
      executablePath: EXECUTABLE,
      cliVersion: PINNED_TAILSCALE_CLI_VERSION,
      allowedTags: [ALLOWED_TAG, "tag:production"],
      executor: executorReturning(
        jsonResult(whoisFixture({ Tags: [ALLOWED_TAG, "tag:production"] }))
      ),
    });
    await expect(exactAdapter.lookup(PEER)).resolves.toEqual({ nodeId: NODE_ID });
  });

  test("rejects invalid allowlist configuration before any execution", () => {
    const executor = executorReturning(jsonResult());
    for (const allowedTags of [
      [],
      ["not-a-tag"],
      [ALLOWED_TAG, ALLOWED_TAG],
    ]) {
      expect(
        () =>
          new TailscaleIdentityAdapter({
            executablePath: EXECUTABLE,
            cliVersion: PINNED_TAILSCALE_CLI_VERSION,
            allowedTags,
            executor,
          })
      ).toThrow(TailscaleIdentityError);
    }
  });

  test("rejects malformed JSON, invalid UTF-8, and malformed field types", async () => {
    const invalidUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
    const cases: TailscaleWhoisExecutionResult[] = [
      { exitCode: 0, stdout: `{${STDOUT_CANARY}` },
      { exitCode: 0, stdout: invalidUtf8 },
      jsonResult(whoisFixture({ StableID: 42 })),
      jsonResult(whoisFixture({ Tags: ALLOWED_TAG })),
      jsonResult(whoisFixture({ StableID: "node id with spaces" })),
    ];

    for (const result of cases) {
      const error = await captureError(
        createAdapter(executorReturning(result)).lookup(PEER),
        result === cases[0] || result === cases[1]
          ? TailscaleIdentityErrorCategory.INVALID_OUTPUT
          : TailscaleIdentityErrorCategory.SCHEMA_MISMATCH
      );
      expect(String(error)).not.toContain(STDOUT_CANARY);
      expect(JSON.stringify(error)).not.toContain(STDOUT_CANARY);
    }
  });

  test("fails closed on stale, future, and recursively extra schema", async () => {
    const stale = whoisFixture();
    delete (stale.Node as Record<string, unknown>).StableID;

    const futureTopLevel = whoisFixture({}, { SchemaVersion: 2 });
    const extraNodeField = whoisFixture({ FutureIdentity: "future" });
    const extraProfileField = whoisFixture();
    (extraProfileField.UserProfile as Record<string, unknown>).FutureProfile = "future";

    for (const fixture of [
      stale,
      futureTopLevel,
      extraNodeField,
      extraProfileField,
    ]) {
      await captureError(
        createAdapter(executorReturning(jsonResult(fixture))).lookup(PEER),
        TailscaleIdentityErrorCategory.SCHEMA_MISMATCH
      );
    }
  });

  test("categorizes timeout, nonzero exit, executor failure, and oversized output", async () => {
    await captureError(
      createAdapter(
        executorReturning({ exitCode: 0, stdout: "", timedOut: true })
      ).lookup(PEER),
      TailscaleIdentityErrorCategory.TIMEOUT
    );

    await captureError(
      createAdapter(
        executorReturning({ exitCode: 23, stdout: STDOUT_CANARY })
      ).lookup(PEER),
      TailscaleIdentityErrorCategory.NONZERO_EXIT
    );

    await captureError(
      createAdapter(async () => {
        throw new Error(ERROR_CANARY);
      }).lookup(PEER),
      TailscaleIdentityErrorCategory.EXECUTION_FAILED
    );

    await captureError(
      createAdapter(
        executorReturning({
          exitCode: 0,
          stdout: "x".repeat(TAILSCALE_WHOIS_MAX_STDOUT_BYTES + 1),
        })
      ).lookup(PEER),
      TailscaleIdentityErrorCategory.OUTPUT_TOO_LARGE
    );

    await captureError(
      createAdapter(
        executorReturning({
          exitCode: 0,
          stdout: "",
          stdoutOverflow: true,
        })
      ).lookup(PEER),
      TailscaleIdentityErrorCategory.OUTPUT_TOO_LARGE
    );
  });

  test("never reflects stdout, stderr-like extras, executor errors, or spoof fields", async () => {
    const results: Array<{
      promise: Promise<unknown>;
      category: TailscaleIdentityErrorCategory;
    }> = [
      {
        promise: createAdapter(
          executorReturning({
            exitCode: 9,
            stdout: STDOUT_CANARY,
            stderr: ERROR_CANARY,
          } as TailscaleWhoisExecutionResult & { stderr: string })
        ).lookup(PEER),
        category: TailscaleIdentityErrorCategory.NONZERO_EXIT,
      },
      {
        promise: createAdapter(
          executorReturning(
            jsonResult(
              whoisFixture({
                Tags: ["tag:denied"],
                Name: NAME_CANARY,
                Addresses: [IP_CANARY],
              })
            )
          )
        ).lookup(PEER),
        category: TailscaleIdentityErrorCategory.TAG_REJECTED,
      },
      {
        promise: createAdapter(async () => {
          throw new Error(`${ERROR_CANARY}:${EMAIL_CANARY}:${IP_CANARY}`);
        }).lookup(PEER),
        category: TailscaleIdentityErrorCategory.EXECUTION_FAILED,
      },
    ];

    for (const { promise, category } of results) {
      const error = await captureError(promise, category);
      const exposed = `${String(error)} ${JSON.stringify(error)} ${String(error.stack)}`;
      for (const canary of [
        STDOUT_CANARY,
        ERROR_CANARY,
        NAME_CANARY,
        EMAIL_CANARY,
        IP_CANARY,
        PROFILE_CANARY,
      ]) {
        expect(exposed).not.toContain(canary);
      }
    }
  });
});
