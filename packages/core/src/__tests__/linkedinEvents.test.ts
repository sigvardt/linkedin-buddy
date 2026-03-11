import { describe, expect, it, vi } from "vitest";
import {
  EVENT_RSVP_ACTION_TYPE,
  LinkedInEventsService,
  buildEventSearchUrl,
  buildEventViewUrl,
  createEventActionExecutors
} from "../linkedinEvents.js";
import { createAllowedRateLimiterStub } from "./rateLimiterTestUtils.js";

describe("LinkedInEvents helpers", () => {
  it("builds event search URLs", () => {
    expect(buildEventSearchUrl("leadership")).toBe(
      "https://www.linkedin.com/search/results/events/?keywords=leadership"
    );
  });

  it("builds event view URLs", () => {
    expect(buildEventViewUrl("7433954919704973312")).toBe(
      "https://www.linkedin.com/events/7433954919704973312/"
    );
  });
});

describe("createEventActionExecutors", () => {
  it("registers the RSVP executor", () => {
    const executors = createEventActionExecutors();

    expect(Object.keys(executors)).toEqual([EVENT_RSVP_ACTION_TYPE]);
    expect(executors[EVENT_RSVP_ACTION_TYPE]).toBeDefined();
  });
});

describe("LinkedInEventsService prepare flows", () => {
  it("prepares attend RSVP actions with explicit payloads", () => {
    const prepare = vi.fn((input: {
      payload: Record<string, unknown>;
      preview: Record<string, unknown>;
    }) => ({
      preparedActionId: "pa_event",
      confirmToken: "ct_event",
      expiresAtMs: 123,
      preview: input.preview
    }));
    const rateLimiter = createAllowedRateLimiterStub();
    const service = new LinkedInEventsService({
      rateLimiter,
      twoPhaseCommit: { prepare }
    } as unknown as ConstructorParameters<typeof LinkedInEventsService>[0]);

    const prepared = service.prepareRsvp({
      event: "https://www.linkedin.com/events/7433954919704973312/"
    });

    expect(prepared.preview).toMatchObject({
      summary: "RSVP attend for LinkedIn event 7433954919704973312",
      target: {
        event_id: "7433954919704973312",
        event_url: "https://www.linkedin.com/events/7433954919704973312/",
        profile_name: "default"
      },
      payload: {
        response: "attend"
      },
      rate_limit: {
        counter_key: "linkedin.events.rsvp"
      }
    });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: EVENT_RSVP_ACTION_TYPE,
        payload: {
          response: "attend"
        }
      })
    );
  });
});
