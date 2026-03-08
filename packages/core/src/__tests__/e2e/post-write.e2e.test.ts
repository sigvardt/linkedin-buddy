import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getRuntime,
  checkCdpAvailable,
  checkAuthenticated,
  cleanupRuntime
} from "./setup.js";

const writeTest = process.env.LINKEDIN_ENABLE_POST_WRITE_E2E === "1" ? it : it.skip;

/**
 * Post Write E2E — two-phase commit create a LinkedIn post.
 *
 * This publishes a real public post and is intentionally opt-in.
 * Set LINKEDIN_ENABLE_POST_WRITE_E2E=1 only after explicit approval.
 *
 * Flow: posts.prepareCreate → twoPhaseCommit.confirmByToken
 */
describe("Post Write E2E (2PC post.create)", () => {
  let cdpOk = false;
  let authOk = false;

  beforeAll(async () => {
    cdpOk = await checkCdpAvailable();
    if (cdpOk) {
      authOk = await checkAuthenticated();
    }
  });

  afterAll(() => {
    cleanupRuntime();
  });

  writeTest("creates a public post via prepare → confirm", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const timestamp = new Date().toISOString();
    const postText = `E2E post from linkedin-owa-agentools [${timestamp}]`;

    const prepared = await runtime.posts.prepareCreate({
      text: postText,
      visibility: "public",
      operatorNote: "Automated E2E post write test"
    });

    expect(prepared.preparedActionId).toBeTruthy();
    expect(prepared.preparedActionId).toMatch(/^pa_/);
    expect(prepared.confirmToken).toBeTruthy();
    expect(prepared.confirmToken).toMatch(/^ct_/);
    expect(prepared.preview).toHaveProperty("summary");
    expect(prepared.preview).toHaveProperty("target");
    expect(prepared.preview).toHaveProperty("outbound");

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: prepared.confirmToken
    });

    expect(result.status).toBe("executed");
    expect(result.preparedActionId).toBe(prepared.preparedActionId);
    expect(result.actionType).toBe("post.create");
    expect(result.result).toHaveProperty("posted", true);
    expect(result.result).toHaveProperty("visibility", "public");
    expect(result.result).toHaveProperty("verification_snippet");
  }, 180_000);

  it("prepare returns valid preview with rate limit info", async () => {
    if (!cdpOk || !authOk) return;
    const runtime = getRuntime();
    const prepared = await runtime.posts.prepareCreate({
      text: `E2E preview-only post [${new Date().toISOString()}]`,
      visibility: "public"
    });

    expect(prepared.preview).toHaveProperty("rate_limit");
    const rateLimit = prepared.preview.rate_limit as Record<string, unknown>;
    expect(rateLimit).toHaveProperty("counter_key", "linkedin.post.create");
    expect(typeof rateLimit.remaining).toBe("number");
    expect(typeof rateLimit.allowed).toBe("boolean");
  }, 60_000);
});
