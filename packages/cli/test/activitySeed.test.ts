import { describe, expect, it } from "vitest";
import {
  parseActivitySeedGeneratedImageManifest,
  parseActivitySeedSpec
} from "../src/activitySeed.js";

describe("activity seed spec parser", () => {
  it("parses issue-212 style sections and defaults", () => {
    const spec = parseActivitySeedSpec({
      assets: {
        generatedImageManifestPath: "reports/profile-images.json"
      },
      connections: {
        acceptPending: {
          limit: 5
        },
        invites: [
          {
            targetProfile: "https://www.linkedin.com/in/example-person/",
            note: "Thought your recent post on developer tools was excellent."
          }
        ]
      },
      posts: [
        {
          text: "A text-only update about AI evaluation loops."
        },
        {
          text: "A media post about shipping practical developer tools.",
          generatedImageIndex: 1,
          visibility: "connections"
        }
      ],
      feed: {
        discoveryLimit: 12,
        likes: [
          {
            postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:123/"
          }
        ],
        comments: [
          {
            postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:456/",
            text: "Really like the emphasis on closing the feedback loop here."
          }
        ]
      },
      jobs: {
        searches: [
          {
            query: "AI engineer",
            location: "Copenhagen, Denmark",
            limit: 5,
            viewTop: 2
          }
        ]
      },
      messaging: {
        newThreads: [
          {
            recipients: ["Simon Miller"],
            text: "Hi Simon, hope you are doing well."
          }
        ],
        replies: [
          {
            thread: "thread-123",
            text: "Thanks for the note."
          }
        ]
      },
      notifications: {
        limit: 15
      }
    });

    expect(spec.assets?.generatedImageManifestPath).toBe("reports/profile-images.json");
    expect(spec.connections.acceptPending?.limit).toBe(5);
    expect(spec.connections.invites).toHaveLength(1);
    expect(spec.posts[0]).toMatchObject({
      text: "A text-only update about AI evaluation loops."
    });
    expect(spec.posts[1]).toMatchObject({
      generatedImageIndex: 1,
      visibility: "connections"
    });
    expect(spec.feed.discoveryLimit).toBe(12);
    expect(spec.jobs.searches[0]).toMatchObject({
      query: "AI engineer",
      viewTop: 2
    });
    expect(spec.messaging.newThreads[0]?.recipients).toEqual(["Simon Miller"]);
    expect(spec.notifications?.limit).toBe(15);
  });

  it("rejects posts that mix direct media paths and generated image indexes", () => {
    expect(() =>
      parseActivitySeedSpec({
        posts: [
          {
            text: "Conflicting post media config",
            mediaPath: "./local.png",
            generatedImageIndex: 0
          }
        ]
      })
    ).toThrow("posts[0] cannot include both mediaPath and generatedImageIndex");
  });
});

describe("activity seed generated image manifest parser", () => {
  it("extracts generated post image metadata from an issue-211 report", () => {
    const manifest = parseActivitySeedGeneratedImageManifest({
      generated_at: "2026-03-10T10:00:00.000Z",
      post_images: [
        {
          absolute_path: "/tmp/post-01.png",
          file_name: "post-01.png",
          concept_key: "copenhagen-workspace",
          title: "Workspace"
        }
      ]
    });

    expect(manifest.postImages).toEqual([
      {
        absolutePath: "/tmp/post-01.png",
        fileName: "post-01.png",
        conceptKey: "copenhagen-workspace",
        title: "Workspace"
      }
    ]);
  });
});
