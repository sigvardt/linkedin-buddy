import { errors as playwrightErrors, type Page } from "playwright-core";

export async function waitForNetworkIdleBestEffort(
  page: Page,
  timeoutMs: number = 5_000
): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch (error) {
    if (error instanceof playwrightErrors.TimeoutError) {
      return;
    }
    throw error;
  }
}
