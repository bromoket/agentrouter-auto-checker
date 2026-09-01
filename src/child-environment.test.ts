import { describe, expect, test } from "bun:test";
import {
  BROWSER_WORKER_ALLOWLIST,
  CHART_WORKER_ALLOWLIST,
  FORBIDDEN_ENV_NAMES,
  FORBIDDEN_ENV_PREFIXES,
  SECRET_PATTERNS,
  buildBrowserWorkerEnv,
  buildChartWorkerEnv,
  isAllowedEnvKey,
  sanitizeChildEnv,
} from "./child-environment";

describe("child-environment", () => {
  describe("isAllowedEnvKey", () => {
    test("allows safe standard variables", () => {
      expect(isAllowedEnvKey("PATH", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("Path", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("path", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("SystemRoot", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("TEMP", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("USERPROFILE", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("HOME", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("DISPLAY", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("WAYLAND_DISPLAY", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("XAUTHORITY", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("XDG_RUNTIME_DIR", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("DBUS_SESSION_BUS_ADDRESS", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("NODE_ENV", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("PLAYWRIGHT_BROWSERS_PATH", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("FONTCONFIG_PATH", BROWSER_WORKER_ALLOWLIST)).toBe(true);
      expect(isAllowedEnvKey("DISPLAY", CHART_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("XAUTHORITY", CHART_WORKER_ALLOWLIST)).toBe(false);
    });

    test("rejects forbidden prefixes regardless of casing", () => {
      expect(isAllowedEnvKey("TELEGRAM_BOT_TOKEN", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("telegram_bot_token", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("OMP_AUTH_BROKER_URL", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("DASHBOARD_API_KEY", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("dashboard_api_key", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("GITHUB_TOKEN", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("GH_TOKEN", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("AGENTROUTER_API_TOKEN", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("COLLECTOR_SECRET", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("OBSERVATORY_TOKEN", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("PROVIDER_KEY", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("OPENAI_API_KEY", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("ANTHROPIC_API_KEY", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("GEMINI_API_KEY", BROWSER_WORKER_ALLOWLIST)).toBe(false);
    });

    test("rejects secret patterns and arbitrary unlisted variables", () => {
      expect(isAllowedEnvKey("CUSTOM_SECRET_KEY", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("MY_API_KEY", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("BEARER_TOKEN", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("SSH_AUTH_KEY", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("USER_PASSWORD", BROWSER_WORKER_ALLOWLIST)).toBe(false);
      expect(isAllowedEnvKey("UNLISTED_CUSTOM_VAR", BROWSER_WORKER_ALLOWLIST)).toBe(false);
    });
  });

  describe("buildBrowserWorkerEnv", () => {
    test("preserves essential Windows platform variables", () => {
      const mockEnv = {
        Path: "C:\\Windows\\system32;C:\\Windows",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: "C:\\Windows",
        SYSTEMDRIVE: "C:",
        windir: "C:\\Windows",
        TEMP: "C:\\Users\\User\\AppData\\Local\\Temp",
        TMP: "C:\\Users\\User\\AppData\\Local\\Temp",
        USERPROFILE: "C:\\Users\\User",
        USERNAME: "testuser",
        LOCALAPPDATA: "C:\\Users\\User\\AppData\\Local",
        APPDATA: "C:\\Users\\User\\AppData\\Roaming",
        PROGRAMDATA: "C:\\ProgramData",
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        ProgramW6432: "C:\\Program Files",
        COMSPEC: "C:\\Windows\\system32\\cmd.exe",
        NUMBER_OF_PROCESSORS: "8",
        OS: "Windows_NT",
        PROCESSOR_ARCHITECTURE: "AMD64",
        PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules",
      };

      const result = buildBrowserWorkerEnv(mockEnv);

      expect(result.Path).toBe("C:\\Windows\\system32;C:\\Windows");
      expect(result.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
      expect(result.SystemRoot).toBe("C:\\Windows");
      expect(result.SYSTEMDRIVE).toBe("C:");
      expect(result.windir).toBe("C:\\Windows");
      expect(result.TEMP).toBe("C:\\Users\\User\\AppData\\Local\\Temp");
      expect(result.TMP).toBe("C:\\Users\\User\\AppData\\Local\\Temp");
      expect(result.USERPROFILE).toBe("C:\\Users\\User");
      expect(result.USERNAME).toBe("testuser");
      expect(result.LOCALAPPDATA).toBe("C:\\Users\\User\\AppData\\Local");
      expect(result.APPDATA).toBe("C:\\Users\\User\\AppData\\Roaming");
      expect(result.PROGRAMDATA).toBe("C:\\ProgramData");
      expect(result.ProgramFiles).toBe("C:\\Program Files");
      expect(result["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
      expect(result.ProgramW6432).toBe("C:\\Program Files");
      expect(result.COMSPEC).toBe("C:\\Windows\\system32\\cmd.exe");
      expect(result.NUMBER_OF_PROCESSORS).toBe("8");
      expect(result.OS).toBe("Windows_NT");
      expect(result.PROCESSOR_ARCHITECTURE).toBe("AMD64");
      expect(result.PSModulePath).toBe("C:\\Program Files\\WindowsPowerShell\\Modules");
    });

    test("preserves essential Linux / Unix and GUI display variables", () => {
      const mockEnv = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/home/testuser",
        USER: "testuser",
        LOGNAME: "testuser",
        TMPDIR: "/tmp",
        DISPLAY: ":0",
        WAYLAND_DISPLAY: "wayland-0",
        XAUTHORITY: "/tmp/.Xauthority-1000",
        XDG_RUNTIME_DIR: "/run/user/1000",
        XDG_CONFIG_HOME: "/home/testuser/.config",
        XDG_DATA_HOME: "/home/testuser/.local/share",
        XDG_CACHE_HOME: "/home/testuser/.cache",
        XDG_CURRENT_DESKTOP: "GNOME",
        XDG_SESSION_TYPE: "wayland",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        TZ: "UTC",
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=4096",
        NODE_BINARY: "/usr/bin/node",
        PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright-browsers",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        CHROME_BIN: "/usr/bin/chromium",
        HTTP_PROXY: "http://proxy.internal:8080",
        NO_PROXY: "127.0.0.1,localhost",
      };

      const result = buildBrowserWorkerEnv(mockEnv);

      expect(result.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
      expect(result.HOME).toBe("/home/testuser");
      expect(result.USER).toBe("testuser");
      expect(result.LOGNAME).toBe("testuser");
      expect(result.TMPDIR).toBe("/tmp");
      expect(result.DISPLAY).toBe(":0");
      expect(result.WAYLAND_DISPLAY).toBe("wayland-0");
      expect(result.XAUTHORITY).toBe("/tmp/.Xauthority-1000");
      expect(result.XDG_RUNTIME_DIR).toBe("/run/user/1000");
      expect(result.XDG_CONFIG_HOME).toBe("/home/testuser/.config");
      expect(result.XDG_DATA_HOME).toBe("/home/testuser/.local/share");
      expect(result.XDG_CACHE_HOME).toBe("/home/testuser/.cache");
      expect(result.XDG_CURRENT_DESKTOP).toBe("GNOME");
      expect(result.XDG_SESSION_TYPE).toBe("wayland");
      expect(result.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
      expect(result.LANG).toBe("en_US.UTF-8");
      expect(result.LC_ALL).toBe("en_US.UTF-8");
      expect(result.TZ).toBe("UTC");
      expect(result.NODE_ENV).toBe("production");
      expect(result.NODE_OPTIONS).toBe("--max-old-space-size=4096");
      expect(result.NODE_BINARY).toBe("/usr/bin/node");
      expect(result.PLAYWRIGHT_BROWSERS_PATH).toBe("/opt/playwright-browsers");
      expect(result.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe("1");
      expect(result.CHROME_BIN).toBe("/usr/bin/chromium");
      expect(result.HTTP_PROXY).toBe("http://proxy.internal:8080");
      expect(result.NO_PROXY).toBe("127.0.0.1,localhost");
    });

    test("filters out all secrets and forbidden variables", () => {
      const mockEnv = {
        PATH: "/usr/bin",
        TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
        TELEGRAM_CHAT_ID: "987654321",
        TELEGRAM_ALLOWED_USERNAME: "alice",
        TELEGRAM_STATE_FILE: "/data/telegram-state.json",
        TELEGRAM_DASHBOARD_URL: "http://127.0.0.1:3100",
        OMP_AUTH_BROKER_URL: "http://127.0.0.1:8765",
        OMP_AUTH_BROKER_TOKEN: "omp-broker-secret-token",
        OMP_BROKER_TOKEN: "secret-broker-tok",
        OMP_QUOTA_STATE_FILE: "/data/omp-quota-state.json",
        DASHBOARD_API_KEY: "k".repeat(32),
        DASHBOARD_ALLOWED_ORIGINS: "http://127.0.0.1:3100",
        DASHBOARD_HOST: "127.0.0.1",
        DASHBOARD_PORT: "3100",
        AGENTROUTER_API_TOKEN: "ar-secret-token-1234567890",
        AGENTROUTER_SECRET: "ar-internal-secret",
        GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz123456",
        GITHUB_SECRET: "gh-secret-value",
        GITHUB_PAT: "ghp_personal_access_token",
        GH_TOKEN: "ghp_short_gh_token",
        COLLECTOR_TOKEN: "collector-secret-token",
        OBSERVATORY_SECRET: "observatory-key",
        OPENAI_API_KEY: "sk-openai-key-12345",
        ANTHROPIC_API_KEY: "sk-ant-api-03-anthropic-key",
        GEMINI_API_KEY: "AIzaSyGeminiApiKeyExample",
        BASE_URL: "https://agentrouter.org",
        DATA_DIR: "/data",
        DB_PATH: "/data/db.sqlite",
        SCREENSHOT_DIR: "/data/screenshots",
        ACCOUNT_STATE_DIR: "/data/states",
        BROWSER_PROFILE_DIR: "/data/profiles",
        CUSTOM_SECRET_TOKEN: "my-custom-token-val",
        AWS_SECRET_ACCESS_KEY: "aws-secret-access-key",
        APPLICATION_PASSWORD: "super-secure-password",
      };

      const result = buildBrowserWorkerEnv(mockEnv);

      expect(result).toEqual({
        PATH: "/usr/bin",
      });
      expect(result.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(result.OMP_AUTH_BROKER_TOKEN).toBeUndefined();
      expect(result.DASHBOARD_API_KEY).toBeUndefined();
      expect(result.AGENTROUTER_API_TOKEN).toBeUndefined();
      expect(result.GITHUB_TOKEN).toBeUndefined();
      expect(result.COLLECTOR_TOKEN).toBeUndefined();
      expect(result.OPENAI_API_KEY).toBeUndefined();
      expect(result.BASE_URL).toBeUndefined();
      expect(result.DATA_DIR).toBeUndefined();
    });

    test("excludes undefined and non-string values", () => {
      const mockEnv: Record<string, unknown> = {
        PATH: "/usr/bin",
        NODE_ENV: undefined,
        LANG: null,
        NUMBER_OF_PROCESSORS: 8 as unknown as string, // non-string number
        DISPLAY: undefined,
        UNLISTED_KEY: undefined,
      };

      const result = buildBrowserWorkerEnv(mockEnv as Record<string, string | undefined>);
      expect(result).toEqual({
        PATH: "/usr/bin",
      });
      expect("NODE_ENV" in result).toBe(false);
      expect("LANG" in result).toBe(false);
      expect("NUMBER_OF_PROCESSORS" in result).toBe(false);
      expect("DISPLAY" in result).toBe(false);
    });

    test("caller cannot mutate retained environment", () => {
      const mockEnv = {
        PATH: "/usr/bin",
        NODE_ENV: "production",
      };

      const result1 = buildBrowserWorkerEnv(mockEnv);
      result1.PATH = "/mutated/bin";
      result1.NODE_ENV = "test";
      (result1 as Record<string, string>).NEW_VAR = "injected";

      const result2 = buildBrowserWorkerEnv(mockEnv);
      expect(result2.PATH).toBe("/usr/bin");
      expect(result2.NODE_ENV).toBe("production");
      expect((result2 as Record<string, string>).NEW_VAR).toBeUndefined();

      // Mutating sourceEnv after call does not alter existing result
      mockEnv.PATH = "/modified/later";
      expect(result2.PATH).toBe("/usr/bin");
    });

    test("extraEnv overrides only allowlisted non-secret variables", () => {
      const sourceEnv = {
        PATH: "/usr/bin",
        NODE_ENV: "development",
      };

      const extraEnv = {
        NODE_ENV: "test",
        TELEGRAM_BOT_TOKEN: "attempted-token-injection",
        UNKNOWN_VAR: "attempted-unknown",
      };

      const result = buildBrowserWorkerEnv(sourceEnv, extraEnv);
      expect(result.PATH).toBe("/usr/bin");
      expect(result.NODE_ENV).toBe("test");
      expect(result.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(result.UNKNOWN_VAR).toBeUndefined();
    });
  });

  describe("buildChartWorkerEnv", () => {
    test("keeps only minimal Node runtime, font, temp, and platform variables for displayless chart rendering", () => {
      const mockEnv = {
        PATH: "/usr/bin",
        HOME: "/home/user",
        TEMP: "/tmp",
        TMPDIR: "/tmp",
        NODE_ENV: "production",
        NODE_OPTIONS: "--trace-warnings",
        FONTCONFIG_PATH: "/etc/fonts",
        FONTCONFIG_FILE: "/etc/fonts/fonts.conf",
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "wayland-0",
        XAUTHORITY: "/tmp/.Xauthority-1000",
        XDG_DATA_HOME: "/home/user/.local/share",
        PLAYWRIGHT_BROWSERS_PATH: "/opt/browsers",
        LANG: "en_US.UTF-8",
        TZ: "UTC",

        // Variables allowed for browser worker but excluded from chart worker
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
        HTTP_PROXY: "http://proxy:8080",
        HTTPS_PROXY: "https://proxy:8080",
        ALL_PROXY: "socks5://proxy:1080",
        NO_PROXY: "localhost",
        PSMODULEPATH: "/ps/modules",
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
        PLAYWRIGHT_NODEJS_PATH: "/usr/bin/node",
        PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH: "/usr/bin/firefox",
        PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH: "/usr/bin/webkit",

        // Secrets
        TELEGRAM_BOT_TOKEN: "bot-token-123",
        OMP_AUTH_BROKER_TOKEN: "broker-token-123",
        DASHBOARD_API_KEY: "k".repeat(32),
      };

      const result = buildChartWorkerEnv(mockEnv);

      // Kept variables
      expect(result.PATH).toBe("/usr/bin");
      expect(result.HOME).toBe("/home/user");
      expect(result.TEMP).toBe("/tmp");
      expect(result.TMPDIR).toBe("/tmp");
      expect(result.NODE_ENV).toBe("production");
      expect(result.NODE_OPTIONS).toBe("--trace-warnings");
      expect(result.FONTCONFIG_PATH).toBe("/etc/fonts");
      expect(result.FONTCONFIG_FILE).toBe("/etc/fonts/fonts.conf");
      expect(result.XDG_DATA_HOME).toBe("/home/user/.local/share");
      expect(result.PLAYWRIGHT_BROWSERS_PATH).toBe("/opt/browsers");
      expect(result.LANG).toBe("en_US.UTF-8");
      expect(result.TZ).toBe("UTC");

      // Display / X11 / Wayland variables are stripped for displayless chart worker
      expect(result.DISPLAY).toBeUndefined();
      expect(result.WAYLAND_DISPLAY).toBeUndefined();
      expect(result.XAUTHORITY).toBeUndefined();

      // Browser-only variables are stripped
      expect(result.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
      expect(result.HTTP_PROXY).toBeUndefined();
      expect(result.HTTPS_PROXY).toBeUndefined();
      expect(result.ALL_PROXY).toBeUndefined();
      expect(result.NO_PROXY).toBeUndefined();
      expect(result.PSMODULEPATH).toBeUndefined();
      expect(result.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBeUndefined();
      expect(result.PLAYWRIGHT_NODEJS_PATH).toBeUndefined();
      expect(result.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH).toBeUndefined();
      expect(result.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH).toBeUndefined();

      // Secrets are stripped
      expect(result.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(result.OMP_AUTH_BROKER_TOKEN).toBeUndefined();
      expect(result.DASHBOARD_API_KEY).toBeUndefined();
    });
  });
});
