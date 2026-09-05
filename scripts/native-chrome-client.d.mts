import type { Browser, BrowserContext, BrowserType } from "playwright";

export interface NativeChromeHostConfig {
  executablePath: string;
  userDataDir: string;
  port: number;
  startupTimeoutMs: number;
}

export interface NativeChromeHostHandle {
  endpointURL: string;
  product: string;
  pid: number;
  stop(): Promise<void>;
}

export interface NativeChromeConnection {
  browser: Browser;
  context: BrowserContext;
  host: NativeChromeHostHandle;
  close(): Promise<void>;
}

export function startNativeChromeHost(config: NativeChromeHostConfig): Promise<NativeChromeHostHandle>;
export function connectNativeChrome(
  chromium: BrowserType<Browser>,
  config: NativeChromeHostConfig,
): Promise<NativeChromeConnection>;
