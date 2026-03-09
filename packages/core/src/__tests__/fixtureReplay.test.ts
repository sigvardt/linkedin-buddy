import { describe, expect, it } from "vitest";
import {
  buildFixtureRouteKey,
  isLinkedInFixtureReplayUrl,
  normalizeFixtureRouteHeaders
} from "../fixtureReplay.js";

describe("fixtureReplay helpers", () => {
  it("normalizes route keys before replay lookup", () => {
    expect(
      buildFixtureRouteKey({
        method: "get",
        url: "https://www.linkedin.com/jobs/search/?location=Copenhagen&keywords=software%20engineer#results"
      })
    ).toBe(
      buildFixtureRouteKey({
        method: "GET",
        url: "https://www.linkedin.com/jobs/search/?keywords=software%20engineer&location=Copenhagen"
      })
    );
  });

  it("normalizes response headers and strips unsafe transfer metadata", () => {
    expect(
      normalizeFixtureRouteHeaders({
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": "123",
        "Content-Encoding": "gzip",
        "Transfer-Encoding": "chunked",
        "X-Trace-Id": "fixture-1"
      })
    ).toEqual({
      "content-type": "application/json; charset=utf-8",
      "x-trace-id": "fixture-1"
    });
  });

  it("matches only linkedin and licdn replay targets", () => {
    expect(isLinkedInFixtureReplayUrl("https://www.linkedin.com/feed/")).toBe(true);
    expect(isLinkedInFixtureReplayUrl("https://media.licdn.com/dms/image/foo")).toBe(true);
    expect(isLinkedInFixtureReplayUrl("https://example.com/feed/")).toBe(false);
    expect(isLinkedInFixtureReplayUrl("data:text/html,fixture")).toBe(false);
  });
});
