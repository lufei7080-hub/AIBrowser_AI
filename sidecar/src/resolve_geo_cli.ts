/**
 * 启动前 GeoIP 预解析 CLI（JSON stdout，供 Rust 在拉起浏览器前调用）。
 * 用法: node dist/resolve_geo_cli.js --config-file=<path>
 */
import { readFile } from "node:fs/promises";

import { resolveGeoViaCloakBrowser, type GeoResolveInput } from "./geo_resolver.js";

function emit(ok: boolean, message: string, data: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({
      ok,
      message,
      data,
      ts: new Date().toISOString(),
    })}\n`,
  );
}

async function parseConfig(argv: string[]): Promise<GeoResolveInput> {
  const configPath = argv.find((arg) => arg.startsWith("--config-file="));
  if (!configPath) {
    throw new Error("missing --config-file=");
  }
  const raw = await readFile(configPath.slice("--config-file=".length), "utf8");
  const normalized = raw.replace(/^\uFEFF/, "").trim();
  const parsed = JSON.parse(normalized) as GeoResolveInput;
  return parsed;
}

async function main(): Promise<void> {
  try {
    const config = await parseConfig(process.argv.slice(2));
    const geo = await resolveGeoViaCloakBrowser(config);
    emit(true, "geo_resolved", { ...geo });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit(false, "geo_resolve_failed", { error: message });
    process.exitCode = 1;
  }
}

void main();
