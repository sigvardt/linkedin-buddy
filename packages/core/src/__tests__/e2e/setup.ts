import { createCoreRuntime, type CoreRuntime } from "../../runtime.js";

const CDP_URL = process.env.LINKEDIN_CDP_URL ?? "http://localhost:18800";

let sharedRuntime: CoreRuntime | undefined;

export function getRuntime(): CoreRuntime {
  if (!sharedRuntime) {
    sharedRuntime = createCoreRuntime({ cdpUrl: CDP_URL });
  }
  return sharedRuntime;
}

export function getCdpUrl(): string {
  return CDP_URL;
}

export async function checkCdpAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${CDP_URL}/json/version`);
    return resp.ok;
  } catch {
    return false;
  }
}

export async function checkAuthenticated(): Promise<boolean> {
  try {
    const runtime = getRuntime();
    const status = await runtime.auth.status();
    return status.authenticated;
  } catch {
    return false;
  }
}

export function cleanupRuntime(): void {
  if (sharedRuntime) {
    sharedRuntime.close();
    sharedRuntime = undefined;
  }
}
