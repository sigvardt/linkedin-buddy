import { describe, expect, it } from "vitest";
import {
  expectPreparedAction,
  expectPreparedOutboundText,
  expectRateLimitPreview,
  getFeedPost
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const FIXTURE_POST_TEXT =
  "Building safe automation with fixture replay gives us deterministic LinkedIn coverage without touching production accounts.";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectFeedPostDataQuality(post: {
  post_id: string;
  author_name: string;
  author_headline: string;
  author_profile_url: string;
  posted_at: string;
  text: string;
  reactions_count: string;
  comments_count: string;
  post_url: string;
}): void {
  expect(post.author_name.trim().length).toBeGreaterThan(0);
  expect(post.author_headline.trim().length).toBeGreaterThan(0);
  expect(post.author_profile_url).toContain("/in/");
  expect(post.text.trim().length).toBeGreaterThan(0);
  expect(post.reactions_count.trim().length).toBeGreaterThan(0);
  expect(typeof post.comments_count).toBe("string");
  expect(post.comments_count).toMatch(/\d/);
  expect(post.post_url).toContain("linkedin.com");
  expect(post.post_url.startsWith("https://")).toBe(true);
  expect(post.post_id.trim().length).toBeGreaterThan(0);
  expect(post.posted_at.trim().length).toBeGreaterThan(0);
}

describe("Feed E2E", () => {
  const e2e = setupE2ESuite();

  it("view feed returns posts array with complete populated fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const posts = await runtime.feed.viewFeed({ limit: 5 });

    expect(Array.isArray(posts)).toBe(true);
    expect(posts.length).toBeGreaterThan(0);

    for (const post of posts) {
      expectFeedPostDataQuality(post);
      expect(post.reactions_count).toMatch(/\d/);
    }

    const [first] = posts;
    if (first) {
      expect(first.comments_count).toMatch(/\d/);
    }
  }, 60_000);

  it("view feed with limit respects parameter", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const posts = await runtime.feed.viewFeed({ limit: 3 });

    expect(posts.length).toBeLessThanOrEqual(3);

    for (const post of posts) {
      expect(post.post_url.startsWith("https://")).toBe(true);
      expect(post.post_url).toContain("linkedin.com");
    }
  }, 60_000);

  it("view feed mine=true returns recent activity feed data", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const posts = await runtime.feed.viewFeed({ mine: true, limit: 3 });

    expect(Array.isArray(posts)).toBe(true);
    expect(posts.length).toBeLessThanOrEqual(3);
    for (const post of posts) {
      expectFeedPostDataQuality(post);
    }
  }, 60_000);

  it("view post returns complete data without text duplication", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const post = await getFeedPost(runtime);
    const viewedPost = await runtime.feed.viewPost({
      postUrl: post.post_url
    });

    expectFeedPostDataQuality(viewedPost);
    expect(viewedPost.author_headline).not.toBe(viewedPost.author_name);
    expect(viewedPost.text).toBe(FIXTURE_POST_TEXT);

    const duplicatedTextMatches = viewedPost.text.match(
      new RegExp(escapeRegExp(FIXTURE_POST_TEXT), "g")
    );
    expect(duplicatedTextMatches?.length ?? 0).toBe(1);
  }, 60_000);

  it("prepare like returns valid preview with fixture post", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const post = await getFeedPost(runtime);
    const prepared = runtime.feed.prepareLikePost({
      postUrl: post.post_url,
      reaction: "like"
    });

    expectPreparedAction(prepared);
    expectRateLimitPreview(prepared.preview, "linkedin.feed.like_post");
  }, 60_000);

  it("prepare comment returns valid preview with fixture post", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const post = await getFeedPost(runtime);
    const text = "E2E prepare-only comment preview";
    const prepared = runtime.feed.prepareCommentOnPost({
      postUrl: post.post_url,
      text
    });

    expectPreparedAction(prepared);
    expectPreparedOutboundText(prepared, text);
    expectRateLimitPreview(prepared.preview, "linkedin.feed.comment_on_post");
  }, 60_000);
});
