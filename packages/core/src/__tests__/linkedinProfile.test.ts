import { describe, expect, it } from "vitest";
import { resolveProfileUrl } from "../linkedinProfile.js";

describe("resolveProfileUrl", () => {
  it("defaults to /in/me/ for undefined input", () => {
    expect(resolveProfileUrl(undefined)).toBe("https://www.linkedin.com/in/me/");
  });

  it("defaults to /in/me/ for empty string", () => {
    expect(resolveProfileUrl("")).toBe("https://www.linkedin.com/in/me/");
  });

  it("defaults to /in/me/ for 'me'", () => {
    expect(resolveProfileUrl("me")).toBe("https://www.linkedin.com/in/me/");
  });

  it("passes through a full linkedin URL", () => {
    expect(resolveProfileUrl("https://www.linkedin.com/in/johndoe/")).toBe(
      "https://www.linkedin.com/in/johndoe/"
    );
  });

  it("prepends origin for /in/ path", () => {
    expect(resolveProfileUrl("/in/johndoe")).toBe(
      "https://www.linkedin.com/in/johndoe"
    );
  });

  it("treats plain string as vanity name", () => {
    expect(resolveProfileUrl("johndoe")).toBe(
      "https://www.linkedin.com/in/johndoe/"
    );
  });

  it("encodes special characters in vanity name", () => {
    expect(resolveProfileUrl("john doe")).toBe(
      "https://www.linkedin.com/in/john%20doe/"
    );
  });
});
