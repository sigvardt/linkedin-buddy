import { describe, expect, it } from "vitest";
import {
  callMcpTool,
  expectPreparedAction,
  expectRateLimitPreview,
  getDefaultProfileName,
  getLastJsonObject,
  isOptInEnabled,
  MCP_TOOL_NAMES,
  runCliCommand
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const writeTest = isOptInEnabled("LINKEDIN_ENABLE_PUBLISHING_WRITE_E2E")
  ? it
  : it.skip;

/**
 * Publishing E2E — articles and newsletters acid test.
 *
 * Write confirms require LINKEDIN_ENABLE_PUBLISHING_WRITE_E2E=1 and
 * explicit approval from the project owner.
 *
 * @see https://github.com/sigvardt/linkedin-buddy/issues/445
 */
describe.sequential("Publishing E2E — Articles & Newsletters", () => {
  const e2e = setupE2ESuite({ timeoutMs: 180_000 });
  const profileName = getDefaultProfileName();

  it("lists newsletters via TypeScript API", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const result = await runtime.newsletters.list({ profileName });

    expect(typeof result.count).toBe("number");
    expect(Array.isArray(result.newsletters)).toBe(true);
    for (const newsletter of result.newsletters) {
      expect(typeof newsletter.title).toBe("string");
      expect(newsletter.title.length).toBeGreaterThan(0);
    }
  }, 120_000);

  it("lists newsletters via CLI", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "newsletter",
      "list",
      "--profile",
      profileName
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    const payload = getLastJsonObject(result.stdout);
    expect(typeof payload.count).toBe("number");
    expect(payload).toHaveProperty("newsletters");
    expect(Array.isArray(payload.newsletters)).toBe(true);
  }, 120_000);

  it("lists newsletters via MCP", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(MCP_TOOL_NAMES.newsletterList, {
      profileName
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      count: expect.any(Number),
      newsletters: expect.any(Array)
    });
  }, 120_000);

  it("prepares article creation with meaningful preview via TypeScript API", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const prepared = await runtime.articles.prepareCreate({
      title: "The Future of AI in Professional Development",
      body:
        "As artificial intelligence continues to reshape the professional landscape, " +
        "it is becoming increasingly clear that continuous learning and adaptation " +
        "are essential. This article explores how AI tools are transforming career " +
        "development, from personalized learning paths to intelligent networking " +
        "recommendations.\n\n" +
        "Whether you are a seasoned engineer or just starting out, understanding " +
        "these shifts is critical for staying relevant in a rapidly evolving market.",
      profileName
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.article.create");

    expect(prepared.preview).toHaveProperty("outbound");
    const outbound = prepared.preview.outbound as Record<string, unknown>;
    expect(outbound.title).toBe(
      "The Future of AI in Professional Development"
    );
    expect(typeof outbound.body).toBe("string");

    expect(prepared.preview).toHaveProperty("validation");
    const validation = prepared.preview.validation as Record<string, unknown>;
    expect(typeof validation.title_length).toBe("number");
    expect(typeof validation.body_length).toBe("number");
    expect(typeof validation.body_paragraph_count).toBe("number");

    expect(prepared.preview).toHaveProperty("artifacts");
    expect(Array.isArray(prepared.preview.artifacts)).toBe(true);
  }, 120_000);

  it("prepares article creation via CLI", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "article",
      "prepare-create",
      "--profile",
      profileName,
      "--title",
      "Building Resilient Engineering Teams",
      "--body",
      "In today's rapidly evolving tech landscape, engineering teams face " +
        "unprecedented challenges. This article discusses strategies for " +
        "building teams that can adapt and thrive under uncertainty."
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    const payload = getLastJsonObject(result.stdout);
    expect(payload).toMatchObject({
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  }, 120_000);

  it("prepares article creation via MCP", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(MCP_TOOL_NAMES.articlePrepareCreate, {
      profileName,
      title: "Navigating Career Transitions in Tech",
      body:
        "Career transitions are becoming increasingly common in the technology " +
        "sector. Whether moving from individual contributor to management, or " +
        "pivoting between specialties, understanding the landscape is key to a " +
        "successful transition."
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
    const preview = result.payload.preview as Record<string, unknown>;
    expect(preview).toHaveProperty("summary");
    expect(preview).toHaveProperty("outbound");
  }, 120_000);

  it("prepares newsletter creation with meaningful preview via TypeScript API", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    const prepared = await runtime.newsletters.prepareCreate({
      title: "Tech Pulse Weekly",
      description:
        "A weekly digest of the most impactful technology trends, engineering " +
        "insights, and career development tips for professionals.",
      cadence: "weekly",
      profileName
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.newsletter.create");

    const outbound = prepared.preview.outbound as Record<string, unknown>;
    expect(outbound.title).toBe("Tech Pulse Weekly");
    expect(typeof outbound.description).toBe("string");
    expect(outbound.cadence).toBe("weekly");

    const validation = prepared.preview.validation as Record<string, unknown>;
    expect(typeof validation.title_length).toBe("number");
    expect(typeof validation.description_length).toBe("number");
    expect(validation.cadence_label).toBe("Weekly");
  }, 120_000);

  it("prepares newsletter creation via CLI", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "newsletter",
      "prepare-create",
      "--profile",
      profileName,
      "--title",
      "Engineering Insights Monthly",
      "--description",
      "Monthly deep-dives into engineering practices, architecture decisions, " +
        "and technical leadership.",
      "--cadence",
      "monthly"
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    const payload = getLastJsonObject(result.stdout);
    expect(payload).toMatchObject({
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  }, 120_000);

  it("prepares newsletter creation via MCP", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(MCP_TOOL_NAMES.newsletterPrepareCreate, {
      profileName,
      title: "AI Builders Digest",
      description:
        "Biweekly insights for developers building with AI, covering tools, " +
        "patterns, and best practices.",
      cadence: "biweekly"
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  }, 120_000);

  it("prepares newsletter issue publication via MCP", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const newsletters = await runtime.newsletters.list({ profileName });

    if (newsletters.count === 0) {
      const result = await callMcpTool(
        MCP_TOOL_NAMES.newsletterPreparePublishIssue,
        {
          profileName,
          newsletter: "Nonexistent Newsletter",
          title: "Test Issue",
          body: "Test body content for issue publication."
        }
      );
      expect(typeof result.isError).toBe("boolean");
      return;
    }

    const targetNewsletter = newsletters.newsletters[0]!.title;
    const result = await callMcpTool(
      MCP_TOOL_NAMES.newsletterPreparePublishIssue,
      {
        profileName,
        newsletter: targetNewsletter,
        title: "Weekly Engineering Digest",
        body:
          "This week in engineering: developments in distributed systems, " +
          "improvements to CI/CD pipelines, and insights from technical " +
          "leadership across the industry."
      }
    );

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  }, 120_000);

  it("prepares article publish via MCP with a synthetic draft URL", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    // Uses a syntactically valid but nonexistent draft URL so the tool
    // exercises its full navigation path and returns a structured response.
    const result = await callMcpTool(MCP_TOOL_NAMES.articlePreparePublish, {
      profileName,
      draftUrl: "https://www.linkedin.com/pulse/edit/0000000000000/"
    });

    expect(typeof result.isError).toBe("boolean");
    if (result.isError) {
      expect(result.payload).toHaveProperty("message");
    } else {
      expect(result.payload).toMatchObject({
        profile_name: profileName,
        preparedActionId: expect.stringMatching(/^pa_/),
        confirmToken: expect.stringMatching(/^ct_/)
      });
    }
  }, 120_000);

  it("CLI returns error for article with whitespace-only title", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "article",
      "prepare-create",
      "--profile",
      profileName,
      "--title",
      "   ",
      "--body",
      "Valid article body content."
    ]);

    expect(result.exitCode).toBe(1);
    const payload = getLastJsonObject(result.stderr);
    expect(payload).toHaveProperty("message");
    expect(String(payload.message)).toMatch(/title/i);
  }, 30_000);

  it("CLI returns error for article with whitespace-only body", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "article",
      "prepare-create",
      "--profile",
      profileName,
      "--title",
      "Valid Article Title",
      "--body",
      "   "
    ]);

    expect(result.exitCode).toBe(1);
    const payload = getLastJsonObject(result.stderr);
    expect(payload).toHaveProperty("message");
    expect(String(payload.message)).toMatch(/body/i);
  }, 30_000);

  it("MCP returns error for article publish with non-LinkedIn URL", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(MCP_TOOL_NAMES.articlePreparePublish, {
      profileName,
      draftUrl: "https://example.com/article/123"
    });

    expect(result.isError).toBe(true);
    expect(String(result.payload.message)).toMatch(/linkedin\.com/i);
  }, 30_000);

  it("MCP returns error for newsletter with invalid cadence", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(MCP_TOOL_NAMES.newsletterPrepareCreate, {
      profileName,
      title: "Valid Newsletter Title",
      description: "Valid newsletter description.",
      cadence: "quarterly"
    });

    expect(result.isError).toBe(true);
    expect(String(result.payload.message)).toMatch(/cadence/i);
  }, 30_000);

  it("MCP returns error for newsletter issue with empty newsletter name", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await callMcpTool(
      MCP_TOOL_NAMES.newsletterPreparePublishIssue,
      {
        profileName,
        newsletter: "   ",
        title: "Valid Issue Title",
        body: "Valid issue body content."
      }
    );

    expect(result.isError).toBe(true);
    expect(String(result.payload.message)).toMatch(/newsletter/i);
  }, 30_000);

  it("CLI returns error for newsletter with whitespace-only title", async (context) => {
    skipIfE2EUnavailable(e2e, context);

    const result = await runCliCommand([
      "newsletter",
      "prepare-create",
      "--profile",
      profileName,
      "--title",
      "   ",
      "--description",
      "Valid description.",
      "--cadence",
      "weekly"
    ]);

    expect(result.exitCode).toBe(1);
    const payload = getLastJsonObject(result.stderr);
    expect(payload).toHaveProperty("message");
    expect(String(payload.message)).toMatch(/title/i);
  }, 30_000);

  writeTest("creates article draft via prepare → confirm", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const timestamp = new Date().toISOString();

    const title = `AI Trends in Software Engineering [${timestamp}]`;
    const body =
      "The integration of artificial intelligence into software engineering " +
      "workflows represents one of the most significant shifts in how we " +
      "build technology. From code generation to automated testing, AI tools " +
      "are augmenting developer capabilities in ways that were unimaginable " +
      "just a few years ago.\n\n" +
      "This article examines current trends and what they mean for the future " +
      "of our industry, including practical advice for teams looking to adopt " +
      "AI-powered development workflows.";

    const prepared = await runtime.articles.prepareCreate({
      title,
      body,
      profileName,
      operatorNote: "Automated acid test #445"
    });

    expectPreparedAction(prepared);

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    expect(result.preparedActionId).toBe(prepared.preparedActionId);
    expect(result.actionType).toBe("article.create");
    expect(result.result).toHaveProperty("draft_created", true);
    expect(result.result).toHaveProperty("draft_url");
    expect(result.result).toHaveProperty("title");
    expect(result.result).toHaveProperty("verification_snippet");
  }, 180_000);

  writeTest("creates newsletter via prepare → confirm", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const timestamp = new Date().toISOString().slice(0, 10);

    const prepared = await runtime.newsletters.prepareCreate({
      title: `Tech Insights [${timestamp}]`,
      description:
        "Weekly insights on technology trends, engineering best practices, " +
        "and career development for software professionals.",
      cadence: "weekly",
      profileName,
      operatorNote: "Automated acid test #445"
    });

    expectPreparedAction(prepared);

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    expect(result.preparedActionId).toBe(prepared.preparedActionId);
    expect(result.actionType).toBe("newsletter.create");
    expect(result.result).toHaveProperty("newsletter_created", true);
    expect(result.result).toHaveProperty("newsletter_title");
    expect(result.result).toHaveProperty("cadence");
    expect(result.result).toHaveProperty("editor_url");
  }, 180_000);

  writeTest("publishes newsletter issue via prepare → confirm", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const timestamp = new Date().toISOString();

    const newsletters = await runtime.newsletters.list({ profileName });
    if (newsletters.count === 0) {
      context.skip(
        "No newsletters available for issue publication test."
      );
      return;
    }

    const targetNewsletter = newsletters.newsletters[0]!.title;
    const issueTitle = `AI Engineering Update [${timestamp}]`;
    const issueBody =
      "This week in AI engineering: new developments in code generation, " +
      "improvements to testing frameworks, and insights from industry " +
      "leaders on adopting large language models in production.\n\n" +
      "Key highlights include advances in reasoning models and their " +
      "application to complex debugging scenarios.";

    const prepared = await runtime.newsletters.preparePublishIssue({
      newsletter: targetNewsletter,
      title: issueTitle,
      body: issueBody,
      profileName,
      operatorNote: "Automated acid test #445"
    });

    expectPreparedAction(prepared);

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    expect(result.preparedActionId).toBe(prepared.preparedActionId);
    expect(result.actionType).toBe("newsletter.publish_issue");
    expect(result.result).toHaveProperty("published", true);
    expect(result.result).toHaveProperty("newsletter_title");
    expect(result.result).toHaveProperty("issue_url");
    expect(result.result).toHaveProperty("verification_snippet");
  }, 180_000);
});
