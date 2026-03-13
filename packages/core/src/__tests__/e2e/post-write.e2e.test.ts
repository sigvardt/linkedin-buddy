import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CREATE_MEDIA_POST_ACTION_TYPE,
  CREATE_POLL_POST_ACTION_TYPE,
  CREATE_POST_ACTION_TYPE,
  DELETE_POST_ACTION_TYPE,
  EDIT_POST_ACTION_TYPE,
  LINKEDIN_POST_MAX_LENGTH,
  LINKEDIN_POST_POLL_DURATION_DAYS,
  LINKEDIN_POST_POLL_MAX_OPTIONS,
  LINKEDIN_POST_POLL_MIN_OPTIONS,
  normalizeLinkedInPostVisibility,
  validateLinkedInPostText,
} from "../../linkedinPosts.js";
import { LinkedInBuddyError } from "../../errors.js";
import {
  expectPreparedAction,
  expectPreparedOutboundText,
  expectRateLimitPreview,
  isOptInEnabled,
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const DEFAULT_FIXTURE_POST_URL =
  "https://www.linkedin.com/feed/update/urn:li:activity:fixture-post-1/";

const writeTest =
  isOptInEnabled("LINKEDIN_ENABLE_POST_WRITE_E2E") ? it : it.skip;


describe("Post Write E2E (2PC post.create)", () => {
  const e2e = setupE2ESuite();

  writeTest(
    "creates a public post via prepare → confirm",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();
      const timestamp = new Date().toISOString();
      const postText = `E2E post from linkedin-buddy [${timestamp}]`;

      const prepared = await runtime.posts.prepareCreate({
        text: postText,
        visibility: "public",
        operatorNote: "Automated E2E post write test",
      });

      expectPreparedAction(prepared);
      expectPreparedOutboundText(prepared, postText);

      const result = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken,
      });

      expect(result.status).toBe("executed");
      expect(result.preparedActionId).toBe(prepared.preparedActionId);
      expect(result.actionType).toBe("post.create");
      expect(result.result).toHaveProperty("posted", true);
      expect(result.result).toHaveProperty("visibility", "public");
      expect(result.result).toHaveProperty("verification_snippet");
    },
    180_000,
  );

  // -----------------------------------------------------------------------
  // 1. Text post — prepare-only
  // -----------------------------------------------------------------------

  it(
    "prepareCreate returns valid preview with rate limit info",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();
      const prepared = await runtime.posts.prepareCreate({
        text: `E2E preview-only post [${new Date().toISOString()}]`,
        visibility: "public",
      });

      expectPreparedAction(prepared);
      expectRateLimitPreview(prepared.preview, "linkedin.post.create");
    },
    60_000,
  );

  it(
    "prepareCreate preview contains outbound text",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();
      const postText = `Acid test text post [${Date.now()}]`;

      const prepared = await runtime.posts.prepareCreate({
        text: postText,
        visibility: "public",
      });

      expectPreparedAction(prepared);
      expectPreparedOutboundText(prepared, postText);
    },
    60_000,
  );

  it(
    "prepareCreate preview includes validation metadata",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const prepared = await runtime.posts.prepareCreate({
        text: "Short validation test post",
        visibility: "public",
      });

      expectPreparedAction(prepared);
      const validation = prepared.preview.validation as Record<string, unknown>;
      expect(typeof validation.character_count).toBe("number");
      expect(typeof validation.line_count).toBe("number");
      expect(typeof validation.paragraph_count).toBe("number");
      expect(typeof validation.max_length).toBe("number");
      expect(validation.linkedin_max_length).toBe(LINKEDIN_POST_MAX_LENGTH);
    },
    60_000,
  );

  it(
    "prepareCreate preview summary reflects visibility",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const publicPrepared = await runtime.posts.prepareCreate({
        text: "Public visibility test",
        visibility: "public",
      });

      expect(String(publicPrepared.preview.summary).toLowerCase()).toContain(
        "public",
      );
    },
    60_000,
  );

  it(
    "prepareCreate preview includes target with profile and visibility",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const prepared = await runtime.posts.prepareCreate({
        text: "Target metadata test",
        visibility: "public",
      });

      expectPreparedAction(prepared);
      const target = prepared.preview.target as Record<string, unknown>;
      expect(target).toHaveProperty("profile_name");
      expect(target).toHaveProperty("visibility", "public");
      expect(target).toHaveProperty("visibility_label", "Public");
      expect(target).toHaveProperty("compose_url");
    },
    60_000,
  );

  // -----------------------------------------------------------------------
  // 2. Media post — prepare-only
  // -----------------------------------------------------------------------

  describe("prepareCreateMedia", () => {
    let tempDir: string;

    beforeAll(() => {
      tempDir = mkdtempSync(path.join(os.tmpdir(), "post-media-e2e-"));
    });

    afterAll(() => {
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it(
      "prepareCreateMedia returns valid preview with media metadata",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        const pngPath = path.join(tempDir, "test-image.png");
        const minimalPng = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
            "Nl7BcQAAAABJRU5ErkJggg==",
          "base64",
        );
        writeFileSync(pngPath, minimalPng);

        const prepared = await runtime.posts.prepareCreateMedia({
          text: `Media post test [${Date.now()}]`,
          mediaPaths: [pngPath],
          visibility: "public",
        });

        expectPreparedAction(prepared);
        expectRateLimitPreview(prepared.preview, "linkedin.post.create");

        const outbound = prepared.preview.outbound as Record<string, unknown>;
        expect(Array.isArray(outbound.media)).toBe(true);
        const media = outbound.media as Array<Record<string, unknown>>;
        expect(media.length).toBe(1);
        expect(media[0]).toHaveProperty("file_name", "test-image.png");
        expect(media[0]).toHaveProperty("kind", "image");
        expect(typeof media[0]!.size_bytes).toBe("number");
      },
      60_000,
    );

    it(
      "prepareCreateMedia preview includes media count in validation",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        const pngPath = path.join(tempDir, "test-image-2.png");
        const minimalPng = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
            "Nl7BcQAAAABJRU5ErkJggg==",
          "base64",
        );
        writeFileSync(pngPath, minimalPng);

        const prepared = await runtime.posts.prepareCreateMedia({
          text: `Media validation test [${Date.now()}]`,
          mediaPaths: [pngPath],
          visibility: "public",
        });

        const validation = prepared.preview.validation as Record<
          string,
          unknown
        >;
        expect(validation.media_count).toBe(1);
        expect(validation.media_kind).toBe("image");
      },
      60_000,
    );
  });

  // -----------------------------------------------------------------------
  // 3. Poll post — prepare-only
  // -----------------------------------------------------------------------

  it(
    "prepareCreatePoll returns valid preview with poll metadata",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const prepared = await runtime.posts.prepareCreatePoll({
        question: "What is your favourite framework?",
        options: ["React", "Vue", "Svelte"],
        durationDays: 7,
        visibility: "public",
      });

      expectPreparedAction(prepared);
      expectRateLimitPreview(prepared.preview, "linkedin.post.create");

      const outbound = prepared.preview.outbound as Record<string, unknown>;
      expect(outbound.question).toBe("What is your favourite framework?");
      expect(outbound.options).toEqual(["React", "Vue", "Svelte"]);
      expect(outbound.duration_days).toBe(7);
    },
    60_000,
  );

  it(
    "prepareCreatePoll with optional body text includes text in outbound",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const bodyText = "Let me know your thoughts:";
      const prepared = await runtime.posts.prepareCreatePoll({
        text: bodyText,
        question: "Best database?",
        options: ["PostgreSQL", "MySQL"],
        durationDays: 3,
        visibility: "public",
      });

      expectPreparedAction(prepared);
      const outbound = prepared.preview.outbound as Record<string, unknown>;
      expect(outbound.text).toBe(bodyText);
    },
    60_000,
  );

  it(
    "prepareCreatePoll preview includes poll validation metadata",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const prepared = await runtime.posts.prepareCreatePoll({
        question: "Poll validation test?",
        options: ["Yes", "No"],
        durationDays: 14,
        visibility: "public",
      });

      const validation = prepared.preview.validation as Record<
        string,
        unknown
      >;
      expect(validation.poll_option_count).toBe(2);
      expect(validation.poll_duration_days).toBe(14);
    },
    60_000,
  );

  // -----------------------------------------------------------------------
  // 4. Edit post — prepare-only
  // -----------------------------------------------------------------------

  it(
    "prepareEdit returns valid preview with post URL in target",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const prepared = await runtime.posts.prepareEdit({
        postUrl: DEFAULT_FIXTURE_POST_URL,
        text: "Updated post content for acid test",
      });

      expectPreparedAction(prepared);
      expectRateLimitPreview(prepared.preview, "linkedin.post.edit");

      const target = prepared.preview.target as Record<string, unknown>;
      expect(target.post_url).toBe(DEFAULT_FIXTURE_POST_URL);
    },
    60_000,
  );

  it(
    "prepareEdit preview contains outbound text",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const editText = "Edited content for verification";
      const prepared = await runtime.posts.prepareEdit({
        postUrl: DEFAULT_FIXTURE_POST_URL,
        text: editText,
      });

      expectPreparedAction(prepared);
      expectPreparedOutboundText(prepared, editText);
    },
    60_000,
  );

  it(
    "prepareEdit preview summary includes post URL",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const prepared = await runtime.posts.prepareEdit({
        postUrl: DEFAULT_FIXTURE_POST_URL,
        text: "Summary URL check",
      });

      expect(String(prepared.preview.summary)).toContain(
        DEFAULT_FIXTURE_POST_URL,
      );
    },
    60_000,
  );

  // -----------------------------------------------------------------------
  // 5. Delete post — prepare-only
  // -----------------------------------------------------------------------

  it(
    "prepareDelete returns valid preview with destructive flag",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const prepared = await runtime.posts.prepareDelete({
        postUrl: DEFAULT_FIXTURE_POST_URL,
      });

      expectPreparedAction(prepared);
      expectRateLimitPreview(prepared.preview, "linkedin.post.delete");

      const outbound = prepared.preview.outbound as Record<string, unknown>;
      expect(outbound.destructive).toBe(true);
    },
    60_000,
  );

  it(
    "prepareDelete preview target includes post URL",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const prepared = await runtime.posts.prepareDelete({
        postUrl: DEFAULT_FIXTURE_POST_URL,
      });

      const target = prepared.preview.target as Record<string, unknown>;
      expect(target.post_url).toBe(DEFAULT_FIXTURE_POST_URL);
    },
    60_000,
  );

  it(
    "prepareDelete preview summary includes post URL",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const prepared = await runtime.posts.prepareDelete({
        postUrl: DEFAULT_FIXTURE_POST_URL,
      });

      expect(String(prepared.preview.summary)).toContain(
        DEFAULT_FIXTURE_POST_URL,
      );
    },
    60_000,
  );

  // -----------------------------------------------------------------------
  // 6. Cross-cutting — distinct action types, IDs and tokens
  // -----------------------------------------------------------------------

  it(
    "each post prepare action produces distinct IDs and tokens",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();

      const createResult = await runtime.posts.prepareCreate({
        text: "Distinct ID test - create",
        visibility: "public",
      });

      const editResult = await runtime.posts.prepareEdit({
        postUrl: DEFAULT_FIXTURE_POST_URL,
        text: "Distinct ID test - edit",
      });

      const deleteResult = await runtime.posts.prepareDelete({
        postUrl: DEFAULT_FIXTURE_POST_URL,
      });

      const ids = [createResult, editResult, deleteResult].map(
        (p) => p.preparedActionId,
      );
      expect(new Set(ids).size).toBe(3);

      const tokens = [createResult, editResult, deleteResult].map(
        (p) => p.confirmToken,
      );
      expect(new Set(tokens).size).toBe(3);

      for (const prepared of [createResult, editResult, deleteResult]) {
        expect(prepared.preparedActionId).toMatch(/^pa_/);
        expect(prepared.confirmToken).toMatch(/^ct_/);
      }
    },
    90_000,
  );

  // -----------------------------------------------------------------------
  // 7. Input validation — pure functions (no browser required)
  // -----------------------------------------------------------------------

  describe("validateLinkedInPostText", () => {
    it("throws ACTION_PRECONDITION_FAILED for empty text", (context) => {
      skipIfE2EUnavailable(e2e, context);

      expect(() => validateLinkedInPostText("")).toThrow(LinkedInBuddyError);
      try {
        validateLinkedInPostText("");
      } catch (error) {
        expect(error).toBeInstanceOf(LinkedInBuddyError);
        expect((error as LinkedInBuddyError).code).toBe(
          "ACTION_PRECONDITION_FAILED",
        );
      }
    });

    it("throws ACTION_PRECONDITION_FAILED for whitespace-only text", (context) => {
      skipIfE2EUnavailable(e2e, context);

      expect(() => validateLinkedInPostText("   \n  \t  ")).toThrow(
        LinkedInBuddyError,
      );
    });

    it("throws ACTION_PRECONDITION_FAILED for text exceeding max length", (context) => {
      skipIfE2EUnavailable(e2e, context);

      const longText = "a".repeat(LINKEDIN_POST_MAX_LENGTH + 1);
      expect(() => validateLinkedInPostText(longText)).toThrow(
        LinkedInBuddyError,
      );

      try {
        validateLinkedInPostText(longText);
      } catch (error) {
        expect(error).toBeInstanceOf(LinkedInBuddyError);
        expect((error as LinkedInBuddyError).code).toBe(
          "ACTION_PRECONDITION_FAILED",
        );
      }
    });

    it("returns validated text metadata for valid input", (context) => {
      skipIfE2EUnavailable(e2e, context);

      const result = validateLinkedInPostText("Hello world #test @mention https://example.com");
      expect(result.normalizedText).toBe(
        "Hello world #test @mention https://example.com",
      );
      expect(result.characterCount).toBeGreaterThan(0);
      expect(result.lineCount).toBe(1);
      expect(result.paragraphCount).toBeGreaterThanOrEqual(1);
      expect(result.containsUrl).toBe(true);
      expect(result.containsMention).toBe(true);
      expect(result.containsHashtag).toBe(true);
    });

    it("text at exactly max length passes validation", (context) => {
      skipIfE2EUnavailable(e2e, context);

      const exactText = "a".repeat(LINKEDIN_POST_MAX_LENGTH);
      const result = validateLinkedInPostText(exactText);
      expect(result.characterCount).toBe(LINKEDIN_POST_MAX_LENGTH);
    });
  });

  describe("normalizeLinkedInPostVisibility", () => {
    it("normalizes 'public' to 'public'", (context) => {
      skipIfE2EUnavailable(e2e, context);
      expect(normalizeLinkedInPostVisibility("public")).toBe("public");
    });

    it("normalizes 'connections' to 'connections'", (context) => {
      skipIfE2EUnavailable(e2e, context);
      expect(normalizeLinkedInPostVisibility("connections")).toBe(
        "connections",
      );
    });

    it("returns fallback for undefined input", (context) => {
      skipIfE2EUnavailable(e2e, context);
      expect(normalizeLinkedInPostVisibility(undefined)).toBe("public");
    });

    it("throws ACTION_PRECONDITION_FAILED for invalid visibility", (context) => {
      skipIfE2EUnavailable(e2e, context);

      expect(() =>
        normalizeLinkedInPostVisibility("nonsense_visibility"),
      ).toThrow(LinkedInBuddyError);

      try {
        normalizeLinkedInPostVisibility("nonsense_visibility");
      } catch (error) {
        expect(error).toBeInstanceOf(LinkedInBuddyError);
        expect((error as LinkedInBuddyError).code).toBe(
          "ACTION_PRECONDITION_FAILED",
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // 8. Distinct action types — verify each operation uses its own type
  // -----------------------------------------------------------------------

  it("action type constants are distinct", (context) => {
    skipIfE2EUnavailable(e2e, context);

    const types = [
      CREATE_POST_ACTION_TYPE,
      CREATE_MEDIA_POST_ACTION_TYPE,
      CREATE_POLL_POST_ACTION_TYPE,
      EDIT_POST_ACTION_TYPE,
      DELETE_POST_ACTION_TYPE,
    ];
    expect(new Set(types).size).toBe(5);

    expect(CREATE_POST_ACTION_TYPE).toBe("post.create");
    expect(CREATE_MEDIA_POST_ACTION_TYPE).toBe("post.create_media");
    expect(CREATE_POLL_POST_ACTION_TYPE).toBe("post.create_poll");
    expect(EDIT_POST_ACTION_TYPE).toBe("post.edit");
    expect(DELETE_POST_ACTION_TYPE).toBe("post.delete");
  });

  // -----------------------------------------------------------------------
  // 9. Poll validation edge cases
  // -----------------------------------------------------------------------

  describe("poll input validation", () => {
    it(
      "prepareCreatePoll throws for fewer than min options",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        await expect(
          runtime.posts.prepareCreatePoll({
            question: "Too few options?",
            options: ["Only one"],
            durationDays: 7,
            visibility: "public",
          }),
        ).rejects.toThrow(LinkedInBuddyError);
      },
      60_000,
    );

    it(
      "prepareCreatePoll throws for more than max options",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        await expect(
          runtime.posts.prepareCreatePoll({
            question: "Too many options?",
            options: ["A", "B", "C", "D", "E"],
            durationDays: 7,
            visibility: "public",
          }),
        ).rejects.toThrow(LinkedInBuddyError);
      },
      60_000,
    );

    it(
      "prepareCreatePoll throws for duplicate options",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        await expect(
          runtime.posts.prepareCreatePoll({
            question: "Duplicate check?",
            options: ["Same", "Same"],
            durationDays: 7,
            visibility: "public",
          }),
        ).rejects.toThrow(LinkedInBuddyError);
      },
      60_000,
    );

    it(
      "prepareCreatePoll throws for invalid duration",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        await expect(
          runtime.posts.prepareCreatePoll({
            question: "Invalid duration?",
            options: ["Yes", "No"],
            durationDays: 5 as 7,
            visibility: "public",
          }),
        ).rejects.toThrow(LinkedInBuddyError);
      },
      60_000,
    );

    it(
      "prepareCreatePoll throws for empty question",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        await expect(
          runtime.posts.prepareCreatePoll({
            question: "",
            options: ["Yes", "No"],
            durationDays: 7,
            visibility: "public",
          }),
        ).rejects.toThrow(LinkedInBuddyError);
      },
      60_000,
    );

    it("poll duration constants are correct", (context) => {
      skipIfE2EUnavailable(e2e, context);

      expect(LINKEDIN_POST_POLL_DURATION_DAYS).toEqual([1, 3, 7, 14]);
      expect(LINKEDIN_POST_POLL_MIN_OPTIONS).toBe(2);
      expect(LINKEDIN_POST_POLL_MAX_OPTIONS).toBe(4);
    });
  });

  // -----------------------------------------------------------------------
  // 10. Post URL validation edge cases (edit/delete)
  // -----------------------------------------------------------------------

  describe("post URL validation", () => {
    it(
      "prepareEdit throws for empty post URL",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        await expect(
          runtime.posts.prepareEdit({
            postUrl: "",
            text: "Will fail",
          }),
        ).rejects.toThrow(LinkedInBuddyError);
      },
      60_000,
    );

    it(
      "prepareDelete throws for empty post URL",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        await expect(
          runtime.posts.prepareDelete({
            postUrl: "",
          }),
        ).rejects.toThrow(LinkedInBuddyError);
      },
      60_000,
    );

    it(
      "prepareEdit throws for whitespace-only post URL",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        await expect(
          runtime.posts.prepareEdit({
            postUrl: "   ",
            text: "Will fail",
          }),
        ).rejects.toThrow(LinkedInBuddyError);
      },
      60_000,
    );
  });

  // -----------------------------------------------------------------------
  // 11. Media validation edge cases
  // -----------------------------------------------------------------------

  describe("media input validation", () => {
    it(
      "prepareCreateMedia throws for empty mediaPaths",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        await expect(
          runtime.posts.prepareCreateMedia({
            text: "No media attached",
            mediaPaths: [],
            visibility: "public",
          }),
        ).rejects.toThrow(LinkedInBuddyError);
      },
      60_000,
    );

    it(
      "prepareCreateMedia throws for non-existent file path",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        await expect(
          runtime.posts.prepareCreateMedia({
            text: "File does not exist",
            mediaPaths: ["/tmp/definitely-does-not-exist-abc123.png"],
            visibility: "public",
          }),
        ).rejects.toThrow(LinkedInBuddyError);
      },
      60_000,
    );

    it(
      "prepareCreateMedia throws for unsupported file extension",
      async (context) => {
        skipIfE2EUnavailable(e2e, context);
        const runtime = e2e.runtime();

        const tempDir = mkdtempSync(
          path.join(os.tmpdir(), "post-media-ext-e2e-"),
        );
        try {
          const txtPath = path.join(tempDir, "not-media.txt");
          writeFileSync(txtPath, "This is not a media file.");

          await expect(
            runtime.posts.prepareCreateMedia({
              text: "Wrong file type",
              mediaPaths: [txtPath],
              visibility: "public",
            }),
          ).rejects.toThrow(LinkedInBuddyError);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      },
      60_000,
    );
  });

  // -----------------------------------------------------------------------
  // 12. Rate limit rejection (from #478)
  // -----------------------------------------------------------------------

  it("prepare rejects with RATE_LIMITED when post limit is exceeded", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    try {
      await runtime.posts.prepareCreate({
        text: `E2E preview-only post [${new Date().toISOString()}]`,
        visibility: "public",
      });
      expect.fail("Expected prepareCreate to throw RATE_LIMITED when limit is exceeded");
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      const buddyError = error as LinkedInBuddyError;
      expect(buddyError.code).toBe("RATE_LIMITED");
      expect(buddyError.details).toHaveProperty("rate_limit");

      const rateLimit = buddyError.details.rate_limit as Record<string, unknown>;
      expect(rateLimit).toHaveProperty("counter_key", "linkedin.post.create");
      expect(rateLimit.allowed).toBe(false);
      expect(rateLimit.remaining).toBe(0);
    }
  }, 60_000);
});
