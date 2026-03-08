import { createCoreRuntime, type CoreRuntime } from "../../runtime.js";

const CDP_URL = process.env.LINKEDIN_CDP_URL ?? "http://localhost:18800";

let sharedRuntime: CoreRuntime | undefined;
let sharedAvailability: E2EAvailability | undefined;

export interface E2EAvailability {
  cdpAvailable: boolean;
  authenticated: boolean;
  canRun: boolean;
  reason: string;
}

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

export async function getE2EAvailability(): Promise<E2EAvailability> {
  if (sharedAvailability) {
    return sharedAvailability;
  }

  const cdpAvailable = await checkCdpAvailable();
  if (!cdpAvailable) {
    sharedAvailability = {
      cdpAvailable,
      authenticated: false,
      canRun: false,
      reason: `No CDP endpoint is reachable at ${CDP_URL}.`
    };
    return sharedAvailability;
  }

  const authenticated = await checkAuthenticated();
  sharedAvailability = {
    cdpAvailable,
    authenticated,
    canRun: cdpAvailable && authenticated,
    reason: authenticated
      ? `Authenticated LinkedIn session detected via ${CDP_URL}.`
      : `LinkedIn session is not authenticated via ${CDP_URL}.`
  };

  return sharedAvailability;
}

export function cleanupRuntime(): void {
  if (sharedRuntime) {
    sharedRuntime.close();
    sharedRuntime = undefined;
  }
  sharedAvailability = undefined;
}
