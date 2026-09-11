import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const distRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../node_modules/cloakbrowser/dist",
);

function moduleHref(name: string): string {
  return pathToFileURL(path.join(distRoot, name)).href;
}

export interface ProReleaseInfo {
  version: string;
  requestedChannel: "stable" | "preview";
  resolvedChannel: "stable" | "preview";
  fallback: boolean;
}

export interface SessionSeats {
  active: number | null;
  limit: number | null;
  state: "ok" | "unreachable" | "denied" | "unknown";
  reason: string | null;
}

export interface CloakExtras {
  checkForProUpdate: (licenseKey: string, releaseChannel?: string) => Promise<string | null>;
  getProLatestRelease: (releaseChannel?: string) => Promise<ProReleaseInfo | null>;
  getSessionSeats: (licenseKey: string) => Promise<SessionSeats>;
  licenseErrorFrom: (err: unknown) => Error | null;
  WRAPPER_VERSION: string;
}

let cached: CloakExtras | null = null;

export async function loadCloakExtras(): Promise<CloakExtras> {
  if (cached) {
    return cached;
  }

  const [download, license, config] = await Promise.all([
    import(moduleHref("download.js")),
    import(moduleHref("license.js")),
    import(moduleHref("config.js")),
  ]);

  cached = {
    checkForProUpdate: download.checkForProUpdate as CloakExtras["checkForProUpdate"],
    getProLatestRelease: license.getProLatestRelease as CloakExtras["getProLatestRelease"],
    getSessionSeats: license.getSessionSeats as CloakExtras["getSessionSeats"],
    licenseErrorFrom: license.licenseErrorFrom as CloakExtras["licenseErrorFrom"],
    WRAPPER_VERSION: config.WRAPPER_VERSION as string,
  };
  return cached;
}
