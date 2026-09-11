import { readFile } from "node:fs/promises";

import { launchProfileBrowser, type ProfileLaunchConfig } from "./browser_launcher.js";
import {
  attachInteractiveElementWatcher,
  pushInteractiveExtractForContext,
} from "./interactive_elements.js";
import { attachContextUrlWatchers } from "./page_url_watcher.js";
import { installIpcGuards, JsonLogger } from "./json-logger.js";
import { installParentProcessWatchdog } from "./parent_process_watchdog.js";

installIpcGuards();
installParentProcessWatchdog();

const logger = new JsonLogger();

async function parseLaunchConfig(argv: string[]): Promise<ProfileLaunchConfig> {
  const inline = argv.find((arg) => arg.startsWith("--config="));
  if (inline) {
    return JSON.parse(inline.slice("--config=".length)) as ProfileLaunchConfig;
  }

  const configPath = argv.find((arg) => arg.startsWith("--config-file="));
  if (configPath) {
    const raw = await readFile(configPath.slice("--config-file=".length), "utf8");
    const normalized = raw.replace(/^\uFEFF/, "").trim();
    return JSON.parse(normalized) as ProfileLaunchConfig;
  }

  throw new Error("missing --config= or --config-file=");
}

function waitForBrowserDisconnect(
  browser: { isConnected(): boolean; once(event: "disconnected", listener: () => void): void } | null,
): Promise<string> {
  return new Promise((resolve) => {
    if (!browser || !browser.isConnected()) {
      resolve("browser_disconnected");
      return;
    }
    browser.once("disconnected", () => resolve("browser_disconnected"));
  });
}

async function main(): Promise<void> {
  let context: Awaited<ReturnType<typeof launchProfileBrowser>> | null = null;
  let shuttingDown = false;
  let profileId = "unknown";
  let cdpPort = 0;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.status("browser_shutting_down", { reason, profileId });
    if (context) {
      try {
        await Promise.race([
          context.close(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 8000);
          }),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("browser_close_error", { error: message, profileId });
      }
      context = null;
    }
    if (cdpPort > 0) {
      logger.browserStatus(profileId, "stopped", cdpPort);
    }
    logger.result("browser_stopped", { reason, exitCode, profileId });
    process.exit(exitCode);
  };

  const waitForCommands = (): Promise<string> =>
    new Promise((resolve) => {
      if (process.stdin.isTTY) {
        process.stdin.setEncoding("utf8");
        process.stdin.resume();
      } else {
        process.stdin.setEncoding("utf8");
        process.stdin.resume();
      }

      let buffer = "";
      process.stdin.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          try {
            const parsed = JSON.parse(trimmed) as { command?: string };
            if (parsed.command === "extract_now" || parsed.command === "interactive_extract_now") {
              if (context) {
                void pushInteractiveExtractForContext(context, logger, profileId).catch((err) => {
                  logger.warn("extract_now_failed", {
                    profileId,
                    error: err instanceof Error ? err.message : String(err),
                  });
                });
              } else {
                logger.warn("extract_now_no_context", { profileId });
              }
              continue;
            }
            if (parsed.command === "shutdown") {
              resolve("stdin_shutdown");
              return;
            }
          } catch {
            // fall through to substring shutdown check
          }

          if (trimmed.includes("shutdown")) {
            resolve("stdin_shutdown");
            return;
          }
        }
      });

      process.once("SIGINT", () => resolve("sigint"));
      process.once("SIGTERM", () => resolve("sigterm"));
    });

  try {
    const config = await parseLaunchConfig(process.argv.slice(2));
    profileId = config.profileId;
    cdpPort = config.cdpPort;

    logger.status("launch_starting", {
      profileId: config.profileId,
      cdpPort: config.cdpPort,
      userDataDir: config.userDataDir,
      useGeoip: config.useGeoip,
      humanize: config.humanize,
      stealthPreset: config.stealthPreset,
    });

    context = await launchProfileBrowser(config, logger);

    await attachContextUrlWatchers(context, logger, config.profileId);
    // 始终挂载 watcher：测试窗依赖内存推送；UI「元素提取」开关仍门禁智能填表
    await attachInteractiveElementWatcher(
      context,
      true,
      config.userDataDir,
      logger,
      config.profileId,
    );
    void pushInteractiveExtractForContext(context, logger, config.profileId).catch(() => undefined);

    const browser = context.browser();
    if (browser) {
      browser.on("disconnected", () => {
        logger.browserStatus(profileId, "stopped", cdpPort);
        void shutdown("browser_disconnected");
      });
    }

    const reason = await Promise.race([
      waitForCommands(),
      waitForBrowserDisconnect(browser),
    ]);
    await shutdown(reason);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("LAUNCH_FAILED")) {
      logger.launchError("LAUNCH_FAILED", message, profileId);
    }
    logger.error("launch_failed", { profileId, error: message });
    await shutdown("launch_failed", 1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.launchError("LAUNCH_FAILED", message, "unknown");
  logger.error("unhandled_launch_error", { error: message });
  process.exit(1);
});
