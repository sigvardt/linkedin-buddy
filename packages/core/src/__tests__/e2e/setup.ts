import { afterAll, beforeAll } from "vitest";
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

export interface E2ESuite<TFixtures = void> {
  availability(): E2EAvailability;
  canRun(): boolean;
  runtime(): CoreRuntime;
  fixtures(): TFixtures;
}

interface E2ESuiteOptions<TFixtures> {
  fixtures?: (runtime: CoreRuntime) => Promise<TFixtures>;
  timeoutMs?: number;
}

const UNINITIALIZED_AVAILABILITY: E2EAvailability = {
  cdpAvailable: false,
  authenticated: false,
  canRun: false,
  reason: "E2E availability has not been initialized."
};

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

export function setupE2ESuite<TFixtures = void>(
  options: E2ESuiteOptions<TFixtures> = {}
): E2ESuite<TFixtures> {
  let availability = UNINITIALIZED_AVAILABILITY;
  let suiteFixtures: TFixtures | undefined;

  beforeAll(async () => {
    availability = await getE2EAvailability();
    if (availability.canRun && options.fixtures) {
      suiteFixtures = await options.fixtures(getRuntime());
    }
  }, options.timeoutMs);

  afterAll(() => {
    cleanupRuntime();
    availability = UNINITIALIZED_AVAILABILITY;
    suiteFixtures = undefined;
  });

  return {
    availability: () => availability,
    canRun: () => availability.canRun,
    runtime: () => getRuntime(),
    fixtures: () => {
      if (!options.fixtures) {
        throw new Error("This E2E suite does not define fixtures.");
      }
      if (suiteFixtures === undefined) {
        throw new Error("E2E fixtures are not available for this suite.");
      }

      return suiteFixtures;
    }
  };
}

export function cleanupRuntime(): void {
  if (sharedRuntime) {
    sharedRuntime.close();
    sharedRuntime = undefined;
  }
  sharedAvailability = undefined;
}
