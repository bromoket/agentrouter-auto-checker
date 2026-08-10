import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

describe("loadConfig dashboard network controls", () => {
  test("defaults to loopback-only origins", () => {
    delete process.env.DASHBOARD_HOST;
    delete process.env.DASHBOARD_PORT;
    delete process.env.DASHBOARD_ALLOWED_ORIGINS;

    const config = loadConfig();
    expect(config.dashboardHost).toBe("127.0.0.1");
    expect(config.dashboardAllowedOrigins).toEqual([
      "http://127.0.0.1:3100",
      "http://localhost:3100",
    ]);
  });

  test("accepts an exact Tailnet bind and explicit MagicDNS origin", () => {
    process.env.DASHBOARD_HOST = "100.127.29.78";
    process.env.DASHBOARD_PORT = "8456";
    process.env.DASHBOARD_ALLOWED_ORIGINS =
      "http://100.127.29.78:8456, http://bkserver:8456/";

    const config = loadConfig();
    expect(config.dashboardHost).toBe("100.127.29.78");
    expect(config.dashboardAllowedOrigins).toEqual([
      "http://100.127.29.78:8456",
      "http://bkserver:8456",
    ]);
  });

  test("rejects wildcard binds and cross-port origins", () => {
    process.env.DASHBOARD_HOST = "0.0.0.0";
    expect(() => loadConfig()).toThrow("exact loopback or private interface");

    process.env.DASHBOARD_HOST = "8.8.8.8";
    expect(() => loadConfig()).toThrow("exact loopback or private interface");

    process.env.DASHBOARD_HOST = "100.127.29.78";
    process.env.DASHBOARD_PORT = "8456";
    process.env.DASHBOARD_ALLOWED_ORIGINS = "http://bkserver:9999";
    expect(() => loadConfig()).toThrow("using DASHBOARD_PORT");
  });
});

describe("loadConfig Telegram controls", () => {
  test("keeps Telegram disabled when no recipient is configured", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_ALLOWED_USERNAME;

    const config = loadConfig();
    expect(config.telegram.botToken).toBeNull();
    expect(config.telegram.chatId).toBeNull();
    expect(config.telegram.allowedUsername).toBeNull();
  });

  test("requires a token, numeric chat id, and username together", () => {
    process.env.TELEGRAM_BOT_TOKEN = `12345678:${"A".repeat(40)}`;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_ALLOWED_USERNAME;
    expect(() => loadConfig()).toThrow("must be configured together");
  });

  test("normalizes and validates a private Telegram recipient", () => {
    process.env.TELEGRAM_BOT_TOKEN = `12345678:${"A".repeat(40)}`;
    process.env.TELEGRAM_CHAT_ID = "123456789";
    process.env.TELEGRAM_ALLOWED_USERNAME = "@BromoketOne";
    process.env.TELEGRAM_LOW_BALANCE_USD = "40";
    process.env.TELEGRAM_LARGE_DROP_USD = "15";
    process.env.TELEGRAM_REPEATED_FAILURE_COUNT = "4";
    process.env.TELEGRAM_DASHBOARD_URL = "http://100.127.29.78:8456/";

    const config = loadConfig();
    expect(config.telegram.allowedUsername).toBe("bromoketone");
    expect(config.telegram.lowBalanceUsd).toBe(40);
    expect(config.telegram.largeDropUsd).toBe(15);
    expect(config.telegram.repeatedFailureCount).toBe(4);
    expect(config.telegram.dashboardUrl).toBe("http://100.127.29.78:8456");
  });
});
