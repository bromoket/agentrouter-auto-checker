import { isIP } from "node:net";

/**
 * Supported CLI/schema pair. Registration must verify the pinned local binary
 * before constructing the adapter; lookup never probes another executable.
 */
export const PINNED_TAILSCALE_CLI_VERSION =
  "1.102.2-t6cac91817-g6ff0ddc72";
export const PINNED_TAILSCALE_WHOIS_SCHEMA =
  "tailscale-1.102.2.whois-json.v1";
export const TAILSCALE_WHOIS_TIMEOUT_MS = 1_000;
export const TAILSCALE_WHOIS_MAX_STDOUT_BYTES = 32 * 1024;

export const TailscaleIdentityErrorCategory = Object.freeze({
  INVALID_CONFIGURATION: "invalid_configuration",
  INVALID_PEER: "invalid_peer",
  TIMEOUT: "timeout",
  EXECUTION_FAILED: "execution_failed",
  NONZERO_EXIT: "nonzero_exit",
  OUTPUT_TOO_LARGE: "output_too_large",
  INVALID_OUTPUT: "invalid_output",
  SCHEMA_MISMATCH: "schema_mismatch",
  TAG_REJECTED: "tag_rejected",
} as const);

export type TailscaleIdentityErrorCategory =
  (typeof TailscaleIdentityErrorCategory)[keyof typeof TailscaleIdentityErrorCategory];

/** A deliberately context-free error safe to use as a categorical audit outcome. */
export class TailscaleIdentityError extends Error {
  readonly category: TailscaleIdentityErrorCategory;

  constructor(category: TailscaleIdentityErrorCategory) {
    super(`tailscale_identity:${category}`);
    this.name = "TailscaleIdentityError";
    this.category = category;
    // A stack contains local source paths and is not part of the safe error contract.
    Object.defineProperty(this, "stack", {
      value: undefined,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  }
}

export interface TailscaleWhoisExecutionRequest {
  /** Complete argv; executors must pass it directly to a process API, never a shell. */
  readonly argv: readonly string[];
  /** Complete child environment. The adapter always supplies an empty environment. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly signal: AbortSignal;
}

export interface TailscaleWhoisExecutionResult {
  readonly exitCode: number;
  readonly stdout: string | Uint8Array;
  /** Set when the executor killed the child at the supplied deadline. */
  readonly timedOut?: boolean;
  /** Set when the executor stopped reading after maxStdoutBytes. */
  readonly stdoutOverflow?: boolean;
}

export type TailscaleWhoisExecutor = (
  request: TailscaleWhoisExecutionRequest
) => Promise<TailscaleWhoisExecutionResult>;

export interface TailscaleIdentityAdapterOptions {
  /** Registration-pinned absolute path to the Tailscale CLI binary. */
  readonly executablePath: string;
  /** Registration-verified version of executablePath. */
  readonly cliVersion: typeof PINNED_TAILSCALE_CLI_VERSION;
  /** Exact tag set permitted for collector source nodes. Must be non-empty. */
  readonly allowedTags: readonly string[];
  /** Injected process boundary; there is intentionally no implicit real executor. */
  readonly executor: TailscaleWhoisExecutor;
}

export interface TailscaleNodeIdentity {
  /** Stable Tailscale Node ID. No mutable or profile fields cross this boundary. */
  readonly nodeId: string;
}

type JsonObject = Record<string, unknown>;
type FieldValidator = (value: unknown) => boolean;

const EMPTY_ENV: Readonly<Record<string, string>> = Object.freeze({});
const TAG_PATTERN = /^tag:[A-Za-z][A-Za-z0-9-]{0,62}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const isString: FieldValidator = (value) => typeof value === "string";
const isNumber: FieldValidator = (value) =>
  typeof value === "number" && Number.isFinite(value);
const isBoolean: FieldValidator = (value) => typeof value === "boolean";
const isObject: FieldValidator = (value) => isPlainObject(value);
const isStringArray: FieldValidator = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const isObjectArray: FieldValidator = (value) =>
  Array.isArray(value) && value.every((item) => isPlainObject(item));

/*
 * Closed field map for the pinned Node JSON shape. Fields carrying names,
 * addresses, keys, routes, capabilities, or host details are type-checked only
 * so schema drift fails closed; none are copied to the returned identity.
 */
const NODE_FIELDS: Readonly<Record<string, FieldValidator>> = Object.freeze({
  ID: isNumber,
  StableID: isString,
  Name: isString,
  User: isNumber,
  Sharer: isNumber,
  Key: isString,
  KeyExpiry: isString,
  KeySignature: isString,
  Machine: isString,
  DiscoKey: isString,
  Addresses: isStringArray,
  AllowedIPs: isStringArray,
  Endpoints: isStringArray,
  DERP: isString,
  HomeDERP: isNumber,
  Hostinfo: isObject,
  Created: isString,
  Cap: isNumber,
  Tags: isStringArray,
  PrimaryRoutes: isStringArray,
  LastSeen: isString,
  Online: isBoolean,
  MachineAuthorized: isBoolean,
  Capabilities: isStringArray,
  CapMap: isObject,
  UnsignedPeerAPIOnly: isBoolean,
  ComputedName: isString,
  ComputedNameWithHost: isString,
  DataPlaneAuditLogID: isString,
  Expired: isBoolean,
  SelfNodeV4MasqAddrForThisPeer: isString,
  SelfNodeV6MasqAddrForThisPeer: isString,
  IsWireGuardOnly: isBoolean,
  IsJailed: isBoolean,
  ExitNodeDNSResolvers: isObjectArray,
});

const REQUIRED_NODE_FIELDS = Object.freeze([
  "ID",
  "StableID",
  "Name",
  "User",
  "Key",
  "KeyExpiry",
  "Machine",
  "DiscoKey",
  "Addresses",
  "AllowedIPs",
  "Hostinfo",
  "Created",
] as const);

const USER_PROFILE_FIELDS: Readonly<Record<string, FieldValidator>> = Object.freeze({
  ID: isNumber,
  LoginName: isString,
  DisplayName: isString,
  ProfilePicURL: isString,
  Groups: isStringArray,
});

const REQUIRED_USER_PROFILE_FIELDS = Object.freeze([
  "ID",
  "LoginName",
  "DisplayName",
] as const);

function fail(category: TailscaleIdentityErrorCategory): never {
  throw new TailscaleIdentityError(category);
}

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKnownFields(
  value: JsonObject,
  validators: Readonly<Record<string, FieldValidator>>,
  required: readonly string[]
): boolean {
  for (const key of Object.keys(value)) {
    const validator = validators[key];
    if (!validator || !validator(value[key])) return false;
  }
  return required.every((key) => Object.hasOwn(value, key));
}

function isAbsoluteExecutablePath(value: string): boolean {
  if (value.length === 0 || value.includes("\0") || /[\r\n]/.test(value)) return false;
  // UNC/network executables are never valid identity roots.
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function isValidPeer(value: string): boolean {
  if (value.length === 0 || value.length > 128 || /[\0\r\n\s]/.test(value)) return false;
  if (isIP(value) !== 0) return true;

  const ipv4WithPort = /^(.*):(\d{1,5})$/.exec(value);
  if (ipv4WithPort && isIP(ipv4WithPort[1] ?? "") === 4) {
    const port = Number(ipv4WithPort[2]);
    return port >= 1 && port <= 65_535;
  }

  const ipv6WithPort = /^\[([^\]]+)]:(\d{1,5})$/.exec(value);
  if (ipv6WithPort && isIP(ipv6WithPort[1] ?? "") === 6) {
    const port = Number(ipv6WithPort[2]);
    return port >= 1 && port <= 65_535;
  }

  return false;
}

function byteLength(stdout: string | Uint8Array): number {
  return typeof stdout === "string"
    ? new TextEncoder().encode(stdout).byteLength
    : stdout.byteLength;
}

function decodeStdout(stdout: string | Uint8Array): string {
  if (typeof stdout === "string") return stdout;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return fail(TailscaleIdentityErrorCategory.INVALID_OUTPUT);
  }
}

function parsePinnedWhoisOutput(stdout: string | Uint8Array): {
  nodeId: string;
  tags: readonly string[];
} {
  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeStdout(stdout));
  } catch (error) {
    if (error instanceof TailscaleIdentityError) throw error;
    return fail(TailscaleIdentityErrorCategory.INVALID_OUTPUT);
  }

  if (!isPlainObject(decoded)) {
    return fail(TailscaleIdentityErrorCategory.SCHEMA_MISMATCH);
  }
  const topLevelKeys = Object.keys(decoded);
  if (
    topLevelKeys.length !== 3 ||
    !topLevelKeys.every((key) => key === "Node" || key === "UserProfile" || key === "CapMap") ||
    !Object.hasOwn(decoded, "Node") ||
    !Object.hasOwn(decoded, "UserProfile") ||
    !Object.hasOwn(decoded, "CapMap")
  ) {
    return fail(TailscaleIdentityErrorCategory.SCHEMA_MISMATCH);
  }

  const node = decoded.Node;
  const userProfile = decoded.UserProfile;
  const capMap = decoded.CapMap;
  if (
    !isPlainObject(node) ||
    !hasExactKnownFields(node, NODE_FIELDS, REQUIRED_NODE_FIELDS) ||
    !isPlainObject(userProfile) ||
    !hasExactKnownFields(
      userProfile,
      USER_PROFILE_FIELDS,
      REQUIRED_USER_PROFILE_FIELDS
    ) ||
    !isPlainObject(capMap)
  ) {
    return fail(TailscaleIdentityErrorCategory.SCHEMA_MISMATCH);
  }

  const nodeId = node.StableID;
  if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
    return fail(TailscaleIdentityErrorCategory.SCHEMA_MISMATCH);
  }

  const tags = node.Tags;
  if (tags === undefined) return { nodeId, tags: Object.freeze([]) };
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
    return fail(TailscaleIdentityErrorCategory.SCHEMA_MISMATCH);
  }
  return { nodeId, tags: Object.freeze([...tags]) };
}

function validateAllowedTags(tags: readonly string[]): ReadonlySet<string> {
  if (tags.length === 0) fail(TailscaleIdentityErrorCategory.INVALID_CONFIGURATION);
  const unique = new Set<string>();
  for (const tag of tags) {
    if (!TAG_PATTERN.test(tag) || unique.has(tag)) {
      fail(TailscaleIdentityErrorCategory.INVALID_CONFIGURATION);
    }
    unique.add(tag);
  }
  return unique;
}

function validateObservedTags(
  observedTags: readonly string[],
  allowedTags: ReadonlySet<string>
): void {
  const observed = new Set(observedTags);
  if (
    observedTags.length === 0 ||
    observed.size !== observedTags.length ||
    observedTags.some((tag) => !TAG_PATTERN.test(tag) || !allowedTags.has(tag)) ||
    [...allowedTags].some((requiredTag) => !observed.has(requiredTag))
  ) {
    fail(TailscaleIdentityErrorCategory.TAG_REJECTED);
  }
}

export class TailscaleIdentityAdapter {
  readonly #executablePath: string;
  readonly #allowedTags: ReadonlySet<string>;
  readonly #executor: TailscaleWhoisExecutor;

  constructor(options: TailscaleIdentityAdapterOptions) {
    if (
      !options ||
      options.cliVersion !== PINNED_TAILSCALE_CLI_VERSION ||
      !isAbsoluteExecutablePath(options.executablePath) ||
      typeof options.executor !== "function" ||
      !Array.isArray(options.allowedTags)
    ) {
      fail(TailscaleIdentityErrorCategory.INVALID_CONFIGURATION);
    }
    this.#executablePath = options.executablePath;
    this.#allowedTags = validateAllowedTags(options.allowedTags);
    this.#executor = options.executor;
  }

  async lookup(peer: string): Promise<TailscaleNodeIdentity> {
    if (!isValidPeer(peer)) fail(TailscaleIdentityErrorCategory.INVALID_PEER);

    const abortController = new AbortController();
    const argv = Object.freeze([
      this.#executablePath,
      "whois",
      "--json",
      peer,
    ] as const);
    const request = Object.freeze({
      argv,
      env: EMPTY_ENV,
      timeoutMs: TAILSCALE_WHOIS_TIMEOUT_MS,
      maxStdoutBytes: TAILSCALE_WHOIS_MAX_STDOUT_BYTES,
      signal: abortController.signal,
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new TailscaleIdentityError(TailscaleIdentityErrorCategory.TIMEOUT));
      }, TAILSCALE_WHOIS_TIMEOUT_MS);
    });

    let result: TailscaleWhoisExecutionResult;
    try {
      result = await Promise.race([this.#executor(request), timeoutPromise]);
    } catch (error) {
      if (error instanceof TailscaleIdentityError) throw error;
      return fail(TailscaleIdentityErrorCategory.EXECUTION_FAILED);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    if (!result || typeof result !== "object") {
      return fail(TailscaleIdentityErrorCategory.EXECUTION_FAILED);
    }
    if (result.timedOut) fail(TailscaleIdentityErrorCategory.TIMEOUT);
    if (
      result.stdoutOverflow ||
      !(typeof result.stdout === "string" || result.stdout instanceof Uint8Array) ||
      byteLength(result.stdout) > TAILSCALE_WHOIS_MAX_STDOUT_BYTES
    ) {
      fail(TailscaleIdentityErrorCategory.OUTPUT_TOO_LARGE);
    }
    if (!Number.isInteger(result.exitCode) || result.exitCode !== 0) {
      fail(TailscaleIdentityErrorCategory.NONZERO_EXIT);
    }

    const parsed = parsePinnedWhoisOutput(result.stdout);
    validateObservedTags(parsed.tags, this.#allowedTags);
    return Object.freeze({ nodeId: parsed.nodeId });
  }
}
