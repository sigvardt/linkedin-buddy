import { describe, expect, it } from "vitest";
import {
  cleanLinkedInEventDescription,
  normalizeLinkedInEventUrl,
  parseLinkedInEventRsvpState,
  resolveEventUrl
} from "../linkedinEvents.js";

describe("resolveEventUrl", () => {
  it("accepts raw event ids", () => {
    expect(resolveEventUrl("7424814333760700416")).toBe(
      "https://www.linkedin.com/events/7424814333760700416/"
    );
  });

  it("normalizes /events paths", () => {
    expect(resolveEventUrl("/events/7424814333760700416/comments/")).toBe(
      "https://www.linkedin.com/events/7424814333760700416/"
    );
  });

  it("normalizes absolute LinkedIn event URLs", () => {
    expect(
      resolveEventUrl(
        "https://www.linkedin.com/events/7424814333760700416/?foo=bar#fragment"
      )
    ).toBe("https://www.linkedin.com/events/7424814333760700416/");
  });

  it("rejects non-event LinkedIn URLs", () => {
    expect(() =>
      resolveEventUrl("https://www.linkedin.com/jobs/view/123/")
    ).toThrow("Event URL must point to linkedin.com/events/.");
  });

  it("rejects invalid encoded event urls with a structured precondition error", () => {
    expect(() =>
      resolveEventUrl("https://www.linkedin.com/events/%E0%A4%A/")
    ).toThrow("Event URL contains an invalid encoded path segment.");
  });
});

describe("normalizeLinkedInEventUrl", () => {
  it("strips query strings and hashes", () => {
    expect(
      normalizeLinkedInEventUrl(
        "https://www.linkedin.com/events/7424814333760700416/?foo=bar#fragment"
      )
    ).toBe("https://www.linkedin.com/events/7424814333760700416/");
  });
});

describe("cleanLinkedInEventDescription", () => {
  it("removes the truncated see-more suffix", () => {
    expect(
      cleanLinkedInEventDescription(
        "A practical, no-hype executive breakfast briefing. …more"
      )
    ).toBe("A practical, no-hype executive breakfast briefing.");
  });
});

describe("parseLinkedInEventRsvpState", () => {
  it("detects unresolved RSVP flows from attend buttons", () => {
    expect(parseLinkedInEventRsvpState(["Attend", "Share"])).toBe(
      "not_responded"
    );
  });

  it("detects attending events from top-card actions", () => {
    expect(parseLinkedInEventRsvpState(["Attending", "Invite"])).toBe(
      "attending"
    );
  });

  it("does not misclassify not attending as attending", () => {
    expect(parseLinkedInEventRsvpState(["Not attending"])).toBe("declined");
  });
});
