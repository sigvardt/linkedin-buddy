import { describe, expect, it, vi } from "vitest";
import { errors as playwrightErrors } from "playwright-core";
import { navigateToLinkedIn, waitForNetworkIdleBestEffort } from "../pageLoad.js";

function createMockPage(url = "about:blank") {
  return {
    goto: vi.fn().mockResolvedValue(null),
    url: vi.fn().mockReturnValue(url),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("playwright-core").Page;
}

describe("pageLoad", () => {
  describe("navigateToLinkedIn", () => {
    it("navigates successfully on first attempt", async () => {
      const page = createMockPage();

      await navigateToLinkedIn(page, "https://www.linkedin.com/feed/");

      expect(page.goto).toHaveBeenCalledOnce();
      expect(page.goto).toHaveBeenCalledWith("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded",
      });
      expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", {
        timeout: 5_000,
      });
    });

    it("succeeds on retry after network error", async () => {
      const page = createMockPage();
      vi.mocked(page.goto)
        .mockRejectedValueOnce(new Error("net::ERR_NAME_NOT_RESOLVED"))
        .mockResolvedValueOnce(null);

      await navigateToLinkedIn(page, "https://www.linkedin.com/feed/", {
        retryDelayMs: 0,
      });

      expect(page.goto).toHaveBeenCalledTimes(2);
      expect(page.waitForLoadState).toHaveBeenCalledTimes(1);
    });

    it("retries on ECONN errors", async () => {
      const page = createMockPage();
      vi.mocked(page.goto)
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce(null);

      await navigateToLinkedIn(page, "https://www.linkedin.com/feed/", {
        retryDelayMs: 0,
      });

      expect(page.goto).toHaveBeenCalledTimes(2);
      expect(page.waitForLoadState).toHaveBeenCalledTimes(1);
    });

    it("throws after exhausting retries", async () => {
      const page = createMockPage();
      const error = new Error("net::ERR_CONNECTION_RESET");
      vi.mocked(page.goto).mockRejectedValue(error);

      await expect(
        navigateToLinkedIn(page, "https://www.linkedin.com/feed/", {
          retries: 1,
          retryDelayMs: 0,
        }),
      ).rejects.toBe(error);

      expect(page.goto).toHaveBeenCalledTimes(2);
      expect(page.waitForLoadState).not.toHaveBeenCalled();
    });

    it("does not retry non-network errors", async () => {
      const page = createMockPage();
      const error = new Error("some other error");
      vi.mocked(page.goto).mockRejectedValue(error);

      await expect(
        navigateToLinkedIn(page, "https://www.linkedin.com/feed/", {
          retries: 5,
          retryDelayMs: 0,
        }),
      ).rejects.toBe(error);

      expect(page.goto).toHaveBeenCalledOnce();
      expect(page.waitForLoadState).not.toHaveBeenCalled();
    });

    it("respects custom retry options", async () => {
      const page = createMockPage();
      const error = new Error("ENOTFOUND");
      vi.mocked(page.goto).mockRejectedValue(error);

      await expect(
        navigateToLinkedIn(page, "https://www.linkedin.com/feed/", {
          retries: 2,
          retryDelayMs: 0,
        }),
      ).rejects.toBe(error);

      expect(page.goto).toHaveBeenCalledTimes(3);
      expect(page.waitForLoadState).not.toHaveBeenCalled();
    });
  });

  describe("waitForNetworkIdleBestEffort", () => {
    it("returns true on networkidle", async () => {
      const page = createMockPage();

      await expect(waitForNetworkIdleBestEffort(page)).resolves.toBe(true);

      expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", {
        timeout: 5_000,
      });
    });

    it("returns false on timeout", async () => {
      const page = createMockPage();
      vi.mocked(page.waitForLoadState).mockRejectedValue(
        new playwrightErrors.TimeoutError("timed out"),
      );

      await expect(waitForNetworkIdleBestEffort(page)).resolves.toBe(false);
    });

    it("throws on other errors", async () => {
      const page = createMockPage();
      const error = new Error("boom");
      vi.mocked(page.waitForLoadState).mockRejectedValue(error);

      await expect(waitForNetworkIdleBestEffort(page)).rejects.toBe(error);
    });
  });
});
