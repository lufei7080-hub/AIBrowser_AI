/**
 * 数据规划 / 沙盘字段造数 CLI — 无浏览器，仅需 AI 配置
 * 用法：node dist/data_planner_cli.js --config-file=<json>
 *
 * mode=plan_batch（默认）| mock_fields
 */
import { readFile, unlink } from "node:fs/promises";

import { planBatchReplayData, type PlanBatchDataRequest } from "./data_planner.js";
import {
  mockSandboxEnvFields,
  type MockSandboxEnvFieldsRequest,
  type SandboxMockFieldInput,
} from "./field_mock.js";
import type { SidecarAiSettings } from "./engine.js";
import { installIpcGuards, JsonLogger } from "./json-logger.js";
import { parseGeoContext, parsePersonaData } from "./persona_engine.js";

installIpcGuards();

const logger = new JsonLogger();

interface PlannerCliConfig {
  mode?: "plan_batch" | "mock_fields";
  selectors?: string[];
  envIds?: string[];
  userPrompt?: string;
  fileData?: string;
  envId?: string;
  fields?: SandboxMockFieldInput[];
  onlyKeys?: string[];
  geo?: unknown;
  persona?: unknown;
  aiSettings: SidecarAiSettings;
}

async function parseConfig(argv: string[]): Promise<{ config: PlannerCliConfig; configPath: string }> {
  const configPath = argv.find((arg) => arg.startsWith("--config-file="));
  if (!configPath) {
    throw new Error("missing --config-file=");
  }
  const path = configPath.slice("--config-file=".length);
  const raw = await readFile(path, "utf8");
  const normalized = raw.replace(/^\uFEFF/, "").trim();
  const parsed = JSON.parse(normalized) as PlannerCliConfig;
  return { config: parsed, configPath: path };
}

async function runPlanBatch(config: PlannerCliConfig): Promise<void> {
  const { aiSettings, ...rest } = config;
  if (!aiSettings?.apiKey?.trim()) {
    throw new Error("missing aiSettings.apiKey");
  }

  const request: PlanBatchDataRequest = {
    selectors: rest.selectors ?? [],
    envIds: rest.envIds ?? [],
    userPrompt: rest.userPrompt ?? "",
    fileData: rest.fileData,
  };

  logger.status("data_planner_starting", {
    envCount: request.envIds.length,
    selectorCount: request.selectors.length,
    fileChars: request.fileData?.length ?? 0,
  });

  const result = await planBatchReplayData(request, aiSettings);
  logger.result("data_planner_complete", {
    envCount: result.planMatrix.length,
    summary: result.summary.slice(0, 200),
  });
  process.stdout.write(
    `${JSON.stringify({ type: "data_planner_result", summary: result.summary, planMatrix: result.planMatrix })}\n`,
  );
}

async function runMockFields(config: PlannerCliConfig): Promise<void> {
  const { aiSettings } = config;
  if (!aiSettings?.apiKey?.trim()) {
    throw new Error("missing aiSettings.apiKey");
  }

  const request: MockSandboxEnvFieldsRequest = {
    envId: String(config.envId ?? "").trim(),
    fields: Array.isArray(config.fields) ? config.fields : [],
    onlyKeys: config.onlyKeys,
    geo: parseGeoContext(config.geo),
    persona: parsePersonaData(config.persona),
  };

  logger.status("field_mock_starting", {
    envId: request.envId,
    fieldCount: request.fields.length,
    onlyKeys: request.onlyKeys?.length ?? 0,
    hasGeo: Boolean(request.geo),
    hasPersona: Boolean(request.persona),
  });

  const result = await mockSandboxEnvFields(request, aiSettings);
  logger.result("field_mock_complete", {
    envId: result.envId,
    keys: Object.keys(result.valueOverrides).length,
    summary: result.summary.slice(0, 200),
  });
  process.stdout.write(
    `${JSON.stringify({
      type: "field_mock_result",
      envId: result.envId,
      valueOverrides: result.valueOverrides,
      summary: result.summary,
    })}\n`,
  );
}

async function main(): Promise<void> {
  let configPath = "";
  try {
    const parsed = await parseConfig(process.argv.slice(2));
    configPath = parsed.configPath;
    const mode = parsed.config.mode === "mock_fields" ? "mock_fields" : "plan_batch";
    if (mode === "mock_fields") {
      await runMockFields(parsed.config);
    } else {
      await runPlanBatch(parsed.config);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("data_planner_failed", { error: message });
    process.stdout.write(
      `${JSON.stringify({ type: "error", code: "DATA_PLANNER_FAILED", message })}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (configPath) {
      await unlink(configPath).catch(() => undefined);
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logger.error("unhandled_data_planner_error", { error: message });
  process.stdout.write(
    `${JSON.stringify({ type: "error", code: "DATA_PLANNER_FAILED", message })}\n`,
  );
  process.exit(1);
});
