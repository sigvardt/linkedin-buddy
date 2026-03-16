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

export async function navigateToLinkedIn(
  page: Page,
  url: string,
  options?: { retries?: number; retryDelayMs?: number },
): Promise<void> {
  const retryablePattern = /(net::|ERR_|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up)/i;
  let retriesRemaining = options?.retries ?? 1;
  const retryDelayMs = options?.retryDelayMs ?? 1_000;

  while (true) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitForNetworkIdleBestEffort(page);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRetryable = retryablePattern.test(message);

      if (!isRetryable || retriesRemaining <= 0) {
        throw error;
      }

      retriesRemaining -= 1;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
