import { describe, expect, it } from "vitest";
import {
  buildReleaseNotes,
  formatCalver,
  groupCommitsBySection,
  selectReleaseVersion
} from "../../../scripts/release-utils.mjs";

describe("release-utils", () => {
  describe("formatCalver", () => {
    it("formats UTC calendar versions without zero-padding", () => {
      expect(formatCalver(new Date("2026-03-10T06:00:00Z"))).toBe("2026.3.10");
    });
  });

  describe("selectReleaseVersion", () => {
    it("uses the bare date for scheduled releases", () => {
      expect(
        selectReleaseVersion({
          date: new Date("2026-03-10T06:00:00Z"),
          existingVersions: ["2026.3.9", "2026.3.10", "2026.3.10-1"],
          mode: "scheduled"
        })
      ).toBe("2026.3.10");
    });

    it("keeps the bare date for manual releases when that day has no release yet", () => {
      expect(
        selectReleaseVersion({
          date: new Date("2026-03-10T06:00:00Z"),
          existingVersions: ["2026.3.9", "2026.3.9-1"],
          mode: "manual"
        })
      ).toBe("2026.3.10");
    });

    it("increments the same-day manual hotfix suffix", () => {
      expect(
        selectReleaseVersion({
          date: new Date("2026-03-10T06:00:00Z"),
          existingVersions: [
            "2026.3.10",
            "2026.3.10-1",
            "2026.3.10-2",
            "2026.3.9"
          ],
          mode: "manual"
        })
      ).toBe("2026.3.10-3");
    });
  });

  describe("groupCommitsBySection", () => {
    it("groups feat and fix commits while leaving other commits in the fallback bucket", () => {
      const sections = groupCommitsBySection([
        {
          sha: "1111111111111111111111111111111111111111",
          subject: "feat: automate releases"
        },
        {
          sha: "2222222222222222222222222222222222222222",
          subject: "fix #250: handle same-day hotfix suffixes"
        },
        {
          sha: "3333333333333333333333333333333333333333",
          subject: "docs: explain npm release token setup"
        }
      ]);

      expect(sections.features).toHaveLength(1);
      expect(sections.fixes).toHaveLength(1);
      expect(sections.other).toHaveLength(1);
    });
  });

  describe("buildReleaseNotes", () => {
    it("renders grouped changelog sections with compare links", () => {
      const notes = buildReleaseNotes({
        version: "2026.3.10",
        previousTag: "v2026.3.9",
        compareUrl:
          "https://github.com/sigvardt/linkedin-buddy/compare/v2026.3.9...abcdef0",
        repository: "sigvardt/linkedin-buddy",
        commits: [
          {
            sha: "abcdef0123456789abcdef0123456789abcdef01",
            subject: "feat: automate the npm release workflow"
          },
          {
            sha: "1234567890abcdef1234567890abcdef12345678",
            subject: "fix: skip daily releases when nothing changed"
          },
          {
            sha: "fedcba9876543210fedcba9876543210fedcba98",
            subject: "chore: refresh package metadata for npm"
          }
        ]
      });

      expect(notes).toContain("# v2026.3.10");
      expect(notes).toContain("## Features");
      expect(notes).toContain("## Fixes");
      expect(notes).toContain("## Other");
      expect(notes).toContain("Compare: https://github.com/sigvardt/linkedin-buddy/compare/v2026.3.9...abcdef0");
      expect(notes).toContain("[abcdef0](https://github.com/sigvardt/linkedin-buddy/commit/abcdef0123456789abcdef0123456789abcdef01)");
    });
  });
});
