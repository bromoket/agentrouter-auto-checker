/**
 * Command Code browser-assisted API-key retrieval OAuth flow.
 *
 * Command Code uses a non-standard flow: a local one-shot HTTP server on a
 * CLI-compatible port; the Studio page POSTs the API key back to /callback.
 * API keys do not expire, so access == refresh == key with a far-future expiry
 * and refresh is a no-op. This mirrors the official pi-commandcode-provider flow.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { COMMANDCODE_AUTH_DEFAULT_PORT, COMMANDCODE_AUTH_PORT_RANGE, COMMANDCODE_STUDIO_BASE_URL, COMMANDCODE_TEN_YEARS_MS } from "./constants";

export interface CommandCodeOauthConfig {
  /** Optional loopback port base (default 5959). */
  startPort?: number;
  /** How many consecutive ports to try when occupied (default 10). */
  portRange?: number;
  /** Timeout for the browser callback (default 15s). */
  timeoutMs?: number;
}

export interface CommandCodeAuthCallback {
  apiKey: string;
  state: string;
  userId: string;
  userName: string;
  keyName: string;
}

export interface CommandCodeTokenResult {
  apiKey: string;
  label: string;
  email: string;
  expiresAtMs: number;
}

export interface CommandCodeOauthCallbacks {
  /** Open the auth URL in the user's browser. */
  onAuth(params: { url: string }): void;
  /** Prompt the user to paste the API key (fallback when browser transfer fails). */
  onPrompt(params: { message: string }): Promise<string>;
}

function listenOnAvailablePort(server: Server, startPort: number, range: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let offset = 0;
    const tryListen = () => {
      const useFallback = startPort === 0 || offset >= range;
      const port = useFallback ? 0 : startPort + offset;
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE" && !useFallback) {
          offset += 1;
          tryListen();
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address() as AddressInfo;
        resolve(address.port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    };
    tryListen();
  });
}

function startAuthServer(config: { startPort: number; portRange: number }): Promise<{ server: Server; port: number; waitForCallback: Promise<CommandCodeAuthCallback> }> {
  let resolveCallback!: (value: CommandCodeAuthCallback) => void;
  let rejectCallback!: (error: Error) => void;
  const waitForCallback = new Promise<CommandCodeAuthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const allowedOrigins = ["http://localhost:3000", "https://staging.commandcode.ai", "https://commandcode.ai"];
  const server = createServer((req, res) => {
    const origin = req.headers.origin || "";
    const responseOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    res.setHeader("Access-Control-Allow-Origin", responseOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Content-Type", "application/json");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url !== "/callback") {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: "Not found" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end(JSON.stringify({ success: false, error: "Method not allowed. Use POST." }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (parsed.error) {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
          const description = typeof parsed.error_description === "string" ? parsed.error_description : String(parsed.error);
          rejectCallback(new Error(description || String(parsed.error)));
          server.close();
          return;
        }
        const apiKey = typeof parsed.apiKey === "string" ? parsed.apiKey : "";
        const state = typeof parsed.state === "string" ? parsed.state : "";
        const userId = typeof parsed.userId === "string" ? parsed.userId : "";
        const userName = typeof parsed.userName === "string" ? parsed.userName : "";
        const keyName = typeof parsed.keyName === "string" ? parsed.keyName : "";
        if (!apiKey || !state || !userId || !userName || !keyName) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: "Missing required fields" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        resolveCallback({ apiKey, state, userId, userName, keyName });
        server.close();
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
      }
    });
    req.on("error", () => {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: "Request error" }));
    });
  });

  return listenOnAvailablePort(server, config.startPort, config.portRange).then((port) => ({
    server,
    port,
    waitForCallback,
  }));
}

function sanitizeApiKey(input: string): string {
  const esc = String.fromCharCode(27);
  return Array.from(
    input
      .replaceAll(`${esc}[200~`, "")
      .replaceAll(`${esc}[201~`, "")
      .replaceAll("[200~", "")
      .replaceAll("[201~", ""),
  )
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .trim();
}

/**
 * Run the browser-assisted Command Code login. Returns the API key + identity.
 * Falls back to a manual paste when the browser cannot reach the local callback.
 */
export async function authorizeCommandCodeStart(
  options: { config?: CommandCodeOauthConfig; callbacks: CommandCodeOauthCallbacks },
): Promise<CommandCodeTokenResult> {
  const config = options.config ?? {};
  const callbacks = options.callbacks;
  const timeoutMs = config.timeoutMs ?? 15_000;
  let server: Server | null = null;
  try {
    const authServer = await startAuthServer({
      startPort: config.startPort ?? COMMANDCODE_AUTH_DEFAULT_PORT,
      portRange: config.portRange ?? COMMANDCODE_AUTH_PORT_RANGE,
    });
    server = authServer.server;
    const stateToken = randomBytes(32).toString("base64url");
    const callbackUrl = `http://localhost:${authServer.port}/callback`;
    const authUrl = `${COMMANDCODE_STUDIO_BASE_URL}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(stateToken)}`;
    callbacks.onAuth({ url: authUrl });

    const callback = await Promise.race([
      authServer.waitForCallback,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Command Code browser auth timed out.")), timeoutMs);
      }),
    ]);
    if (callback.state !== stateToken) {
      throw new Error("State token mismatch. Authentication may have been tampered with.");
    }
    return { apiKey: callback.apiKey, label: callback.keyName || callback.userName || "Command Code", email: callback.userName || callback.userId, expiresAtMs: Date.now() + COMMANDCODE_TEN_YEARS_MS };
  } catch (error) {
    server?.close();
    const pasted = sanitizeApiKey(await callbacks.onPrompt({ message: "Automatic Command Code transfer failed. Paste your Command Code API key:" }));
    if (!pasted) throw error instanceof Error ? error : new Error(String(error));
    return { apiKey: pasted, label: "Command Code", email: "", expiresAtMs: Date.now() + COMMANDCODE_TEN_YEARS_MS };
  }
}

export function commandCodeAccessToken(apiKey: string): string {
  return apiKey;
}
