import { errors as playwrightErrors, type Page } from "playwright-core";

export async function waitForNetworkIdleBestEffort(
  page: Page,
  timeoutMs: number = 5_000
): Promise<boolean> {
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
    return true;
  } catch (error) {
    if (error instanceof playwrightErrors.TimeoutError) {
      return false;
    }
    throw error;
  }
}
