import { describe, expect, it } from "vitest";
import {
  cleanLinkedInGroupAboutText,
  normalizeLinkedInGroupUrl,
  parseLinkedInGroupJoinState,
  resolveGroupUrl
} from "../linkedinGroups.js";

describe("resolveGroupUrl", () => {
  it("accepts raw group ids", () => {
    expect(resolveGroupUrl("66325")).toBe("https://www.linkedin.com/groups/66325/");
  });

  it("normalizes /groups paths", () => {
    expect(resolveGroupUrl("/groups/66325/about/")).toBe(
      "https://www.linkedin.com/groups/66325/"
    );
  });

  it("normalizes absolute LinkedIn group URLs", () => {
    expect(
      resolveGroupUrl("https://www.linkedin.com/groups/66325/?foo=bar#fragment")
    ).toBe("https://www.linkedin.com/groups/66325/");
  });

  it("rejects non-group LinkedIn URLs", () => {
    expect(() =>
      resolveGroupUrl("https://www.linkedin.com/in/someone/")
    ).toThrow("Group URL must point to linkedin.com/groups/.");
  });

  it("rejects invalid encoded group urls with a structured precondition error", () => {
    expect(() =>
      resolveGroupUrl("https://www.linkedin.com/groups/%E0%A4%A/")
    ).toThrow("Group URL contains an invalid encoded path segment.");
  });
});

describe("normalizeLinkedInGroupUrl", () => {
  it("strips query strings and hashes", () => {
    expect(
      normalizeLinkedInGroupUrl(
        "https://www.linkedin.com/groups/66325/?foo=bar#fragment"
      )
    ).toBe("https://www.linkedin.com/groups/66325/");
  });
});

describe("cleanLinkedInGroupAboutText", () => {
  it("removes modal chrome and detail labels", () => {
    expect(
      cleanLinkedInGroupAboutText(
        "Dialog content start. About this group Description LinkedIn's biggest marketing community. Details Public Anyone can see posts. Done Dialog content end."
      )
    ).toBe("LinkedIn's biggest marketing community.");
  });

  it("keeps descriptions that mention details in normal prose", () => {
    expect(
      cleanLinkedInGroupAboutText(
        "About this group We share details daily with growth marketers."
      )
    ).toBe("We share details daily with growth marketers.");
  });
});

describe("parseLinkedInGroupJoinState", () => {
  it("detects not joined groups from join actions", () => {
    expect(
      parseLinkedInGroupJoinState({
        headerText: "Public group 2,977,869 members Join The Social Media Marketing Group group Join Share Report this group",
        actions: ["Public group", "Join The Social Media Marketing Group group Join"]
      })
    ).toBe("not_joined");
  });

  it("detects joined groups from membership actions", () => {
    expect(
      parseLinkedInGroupJoinState({
        headerText:
          "Private Listed Share Manage notifications Update your settings Leave this group Report this group",
        actions: ["Manage notifications", "Update your settings"]
      })
    ).toBe("joined");
  });
});
