import { describe, expect, it } from "vitest";
import { getMessageThread } from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

/**
 * Inbox Read E2E — validates thread listing, thread detail, recipient search,
 * and unread filtering against the live (or fixture-backed) inbox surface.
 *
 * All tests are read-only and safe to run without opt-in flags.
 */
describe("Inbox E2E", () => {
  const e2e = setupE2ESuite();

  it("list threads returns array with complete fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const threads = await runtime.inbox.listThreads({ limit: 20 });

    expect(Array.isArray(threads)).toBe(true);
    expect(threads.length).toBeGreaterThan(0);

    const [first] = threads;
    if (first) {
      expect(first.thread_id).toEqual(expect.any(String));
      expect(first.thread_id.length).toBeGreaterThan(0);
      expect(typeof first.title).toBe("string");
      expect(typeof first.unread_count).toBe("number");
      expect(first.unread_count).toBeGreaterThanOrEqual(0);
      expect(typeof first.snippet).toBe("string");
      expect(typeof first.thread_url).toBe("string");
      expect(first.thread_url).toMatch(/linkedin\.com/);
    }
  });

  it("list with limit respects parameter", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const threads = await runtime.inbox.listThreads({ limit: 5 });

    expect(threads.length).toBeLessThanOrEqual(5);
  });

  it("get thread returns messages with sender, text, timestamp", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const simonThread = await getMessageThread(runtime);

    const detail = await runtime.inbox.getThread({
      thread: simonThread.thread_id,
      limit: 10
    });

    expect(detail.thread_id).toBe(simonThread.thread_id);
    expect(typeof detail.title).toBe("string");
    expect(typeof detail.unread_count).toBe("number");
    expect(typeof detail.snippet).toBe("string");
    expect(typeof detail.thread_url).toBe("string");
    expect(detail.thread_url).toMatch(/linkedin\.com/);
    expect(Array.isArray(detail.messages)).toBe(true);
    expect(detail.messages.length).toBeGreaterThan(0);

    const [firstMessage] = detail.messages;
    if (firstMessage) {
      expect(typeof firstMessage.author).toBe("string");
      expect(firstMessage.author.length).toBeGreaterThan(0);
      expect(typeof firstMessage.text).toBe("string");
      expect(
        firstMessage.sent_at === null || typeof firstMessage.sent_at === "string"
      ).toBe(true);
    }
  }, 60_000);

  it("search recipients returns results with profile URLs", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const result = await runtime.inbox.searchRecipients({
      query: "Simon Miller",
      limit: 5
    });

    expect(typeof result.query).toBe("string");
    expect(typeof result.count).toBe("number");
    expect(Array.isArray(result.recipients)).toBe(true);

    if (result.recipients.length > 0) {
      const [first] = result.recipients;
      if (first) {
        expect(typeof first.full_name).toBe("string");
        expect(first.full_name.length).toBeGreaterThan(0);
        expect(typeof first.headline).toBe("string");
        expect(typeof first.profile_url).toBe("string");
        expect(first.profile_url).toMatch(/linkedin\.com/);
        expect(typeof first.connection_degree).toBe("string");
      }
    }
  }, 60_000);
});
