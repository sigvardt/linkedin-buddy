import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const activitySeedCliMocks = vi.hoisted(() => ({
  close: vi.fn(),
  confirmByToken: vi.fn(),
  createCoreRuntime: vi.fn(),
  getThread: vi.fn(),
  jobsSearchJobs: vi.fn(),
  jobsViewJob: vi.fn(),
  listConnections: vi.fn(),
  listNotifications: vi.fn(),
  listPendingInvitations: vi.fn(),
  listThreads: vi.fn(),
  loggerLog: vi.fn(),
  prepareAcceptInvitation: vi.fn(),
  prepareCommentOnPost: vi.fn(),
  prepareCreate: vi.fn(),
  prepareCreateMedia: vi.fn(),
  prepareLikePost: vi.fn(),
  prepareNewThread: vi.fn(),
  prepareReply: vi.fn(),
  prepareSendInvitation: vi.fn(),
  viewFeed: vi.fn(),
  viewPost: vi.fn()
}));

vi.mock("@linkedin-buddy/core", async () => {
  const actual = await import("../../core/src/index.js");
  return {
    ...actual,
    createCoreRuntime: activitySeedCliMocks.createCoreRuntime
  };
});

import { runCli } from "../src/bin/linkedin.js";

describe("CLI activity seed workflow", () => {
  let tempDir = "";
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[] = [];
  let stderrChunks: string[] = [];

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "linkedin-cli-activity-seed-"));
    process.env.LINKEDIN_BUDDY_HOME = path.join(tempDir, "buddy-home");
    process.exitCode = undefined;
    stdoutChunks = [];
    stderrChunks = [];
    vi.clearAllMocks();

    activitySeedCliMocks.createCoreRuntime.mockImplementation(() => ({
      runId: "run-activity-seed-cli",
      evasion: {
        level: "moderate",
        diagnosticsEnabled: false
      },
      logger: {
        log: activitySeedCliMocks.loggerLog
      },
      connections: {
        listPendingInvitations: activitySeedCliMocks.listPendingInvitations,
        listConnections: activitySeedCliMocks.listConnections,
        prepareAcceptInvitation: activitySeedCliMocks.prepareAcceptInvitation,
        prepareSendInvitation: activitySeedCliMocks.prepareSendInvitation
      },
      posts: {
        prepareCreate: activitySeedCliMocks.prepareCreate,
        prepareCreateMedia: activitySeedCliMocks.prepareCreateMedia
      },
      feed: {
        viewFeed: activitySeedCliMocks.viewFeed,
        viewPost: activitySeedCliMocks.viewPost,
        prepareLikePost: activitySeedCliMocks.prepareLikePost,
        prepareCommentOnPost: activitySeedCliMocks.prepareCommentOnPost
      },
      jobs: {
        searchJobs: activitySeedCliMocks.jobsSearchJobs,
        viewJob: activitySeedCliMocks.jobsViewJob
      },
      inbox: {
        listThreads: activitySeedCliMocks.listThreads,
        getThread: activitySeedCliMocks.getThread,
        prepareNewThread: activitySeedCliMocks.prepareNewThread,
        prepareReply: activitySeedCliMocks.prepareReply
      },
      notifications: {
        listNotifications: activitySeedCliMocks.listNotifications
      },
      twoPhaseCommit: {
        confirmByToken: activitySeedCliMocks.confirmByToken
      },
      close: activitySeedCliMocks.close
    }));

    activitySeedCliMocks.listPendingInvitations.mockImplementation(
      async (input: { filter?: string }) => {
        if (input.filter === "received") {
          return [
            {
              vanity_name: "pending-person",
              full_name: "Pending Person",
              headline: "Staff Engineer",
              profile_url: "https://www.linkedin.com/in/pending-person/",
              sent_or_received: "received"
            }
          ];
        }

        return [];
      }
    );

    activitySeedCliMocks.listConnections
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          vanity_name: "new-person",
          full_name: "New Person",
          headline: "Applied AI Engineer",
          profile_url: "https://www.linkedin.com/in/new-person/",
          connected_since: "Today"
        }
      ]);

    activitySeedCliMocks.prepareAcceptInvitation.mockReturnValue({
      preparedActionId: "pa-accept",
      confirmToken: "ct-accept",
      expiresAtMs: 1,
      preview: { summary: "Accept invitation" }
    });
    activitySeedCliMocks.prepareSendInvitation.mockReturnValue({
      preparedActionId: "pa-invite",
      confirmToken: "ct-invite",
      expiresAtMs: 1,
      preview: { summary: "Invite connection" }
    });
    activitySeedCliMocks.prepareCreate.mockResolvedValue({
      preparedActionId: "pa-post-1",
      confirmToken: "ct-post-1",
      expiresAtMs: 1,
      preview: { summary: "Create post" }
    });
    activitySeedCliMocks.prepareCreateMedia.mockResolvedValue({
      preparedActionId: "pa-post-2",
      confirmToken: "ct-post-2",
      expiresAtMs: 1,
      preview: { summary: "Create media post" }
    });
    activitySeedCliMocks.prepareLikePost.mockReturnValue({
      preparedActionId: "pa-like",
      confirmToken: "ct-like",
      expiresAtMs: 1,
      preview: { summary: "Like post" }
    });
    activitySeedCliMocks.prepareCommentOnPost.mockReturnValue({
      preparedActionId: "pa-comment",
      confirmToken: "ct-comment",
      expiresAtMs: 1,
      preview: { summary: "Comment on post" }
    });
    activitySeedCliMocks.prepareNewThread.mockResolvedValue({
      preparedActionId: "pa-thread",
      confirmToken: "ct-thread",
      expiresAtMs: 1,
      preview: { summary: "New thread" }
    });
    activitySeedCliMocks.prepareReply.mockResolvedValue({
      preparedActionId: "pa-reply",
      confirmToken: "ct-reply",
      expiresAtMs: 1,
      preview: { summary: "Reply" }
    });

    activitySeedCliMocks.confirmByToken
      .mockResolvedValueOnce({
        preparedActionId: "pa-accept",
        status: "executed",
        actionType: "connections.accept_invitation",
        result: {
          status: "invitation_accepted",
          target_profile: "https://www.linkedin.com/in/pending-person/"
        },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa-invite",
        status: "executed",
        actionType: "connections.send_invitation",
        result: {
          status: "invitation_sent",
          target_profile: "https://www.linkedin.com/in/new-person/"
        },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa-post-1",
        status: "executed",
        actionType: "post.create",
        result: {
          posted: true,
          published_post_url: "https://www.linkedin.com/feed/update/urn:li:activity:post-1/"
        },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa-post-2",
        status: "executed",
        actionType: "post.create_media",
        result: {
          posted: true,
          published_post_url: "https://www.linkedin.com/feed/update/urn:li:activity:post-2/"
        },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa-like",
        status: "executed",
        actionType: "feed.like_post",
        result: {
          reacted: true,
          post_url: "https://www.linkedin.com/feed/update/urn:li:activity:feed-1/"
        },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa-comment",
        status: "executed",
        actionType: "feed.comment_on_post",
        result: {
          commented: true,
          post_url: "https://www.linkedin.com/feed/update/urn:li:activity:feed-2/"
        },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa-thread",
        status: "executed",
        actionType: "inbox.send_new_thread",
        result: {
          sent: true,
          thread_url: "https://www.linkedin.com/messaging/thread/thread-1/"
        },
        artifacts: []
      })
      .mockResolvedValueOnce({
        preparedActionId: "pa-reply",
        status: "executed",
        actionType: "send_message",
        result: {
          sent: true,
          thread_url: "https://www.linkedin.com/messaging/thread/thread-2/"
        },
        artifacts: []
      });

    activitySeedCliMocks.viewPost
      .mockResolvedValueOnce({
        post_id: "post-1",
        author_name: "Emil Sorensen",
        author_headline: "AI/ML Engineer",
        author_profile_url: "https://www.linkedin.com/in/emil-sorensen/",
        posted_at: "Now",
        text: "Text-only post",
        reactions_count: "0",
        comments_count: "0",
        reposts_count: "0",
        post_url: "https://www.linkedin.com/feed/update/urn:li:activity:post-1/"
      })
      .mockResolvedValueOnce({
        post_id: "post-2",
        author_name: "Emil Sorensen",
        author_headline: "AI/ML Engineer",
        author_profile_url: "https://www.linkedin.com/in/emil-sorensen/",
        posted_at: "Now",
        text: "Media post",
        reactions_count: "0",
        comments_count: "0",
        reposts_count: "0",
        post_url: "https://www.linkedin.com/feed/update/urn:li:activity:post-2/"
      });

    activitySeedCliMocks.viewFeed.mockResolvedValue([
      {
        post_id: "feed-1",
        author_name: "Someone Else",
        author_headline: "AI Engineer",
        author_profile_url: "https://www.linkedin.com/in/someone-else/",
        posted_at: "1h",
        text: "A post about evaluation loops.",
        reactions_count: "12",
        comments_count: "3",
        reposts_count: "1",
        post_url: "https://www.linkedin.com/feed/update/urn:li:activity:feed-1/"
      }
    ]);

    activitySeedCliMocks.jobsSearchJobs.mockResolvedValue({
      query: "AI engineer",
      location: "Copenhagen, Denmark",
      count: 1,
      results: [
        {
          job_id: "job-1",
          title: "AI Engineer",
          company: "Signikant",
          location: "Copenhagen, Denmark",
          posted_at: "1d",
          job_url: "https://www.linkedin.com/jobs/view/job-1/",
          salary_range: "",
          employment_type: "Full-time"
        }
      ]
    });
    activitySeedCliMocks.jobsViewJob.mockResolvedValue({
      job_id: "job-1",
      title: "AI Engineer",
      company: "Signikant",
      company_url: "https://www.linkedin.com/company/signikant/",
      location: "Copenhagen, Denmark",
      posted_at: "1d",
      description: "Build AI systems.",
      salary_range: "",
      employment_type: "Full-time",
      job_url: "https://www.linkedin.com/jobs/view/job-1/",
      applicant_count: "5 applicants",
      seniority_level: "Mid-Senior",
      is_remote: false
    });

    activitySeedCliMocks.listThreads.mockResolvedValue([
      {
        thread_id: "thread-1",
        title: "Simon Miller",
        unread_count: 0,
        snippet: "Latest message",
        thread_url: "https://www.linkedin.com/messaging/thread/thread-1/"
      }
    ]);
    activitySeedCliMocks.getThread.mockResolvedValue({
      thread_id: "thread-1",
      title: "Simon Miller",
      unread_count: 0,
      snippet: "Latest message",
      thread_url: "https://www.linkedin.com/messaging/thread/thread-1/",
      messages: [
        {
          author: "Emil Sorensen",
          sent_at: "Now",
          text: "Hi Simon"
        }
      ]
    });

    activitySeedCliMocks.listNotifications.mockResolvedValue([
      {
        id: "notification-1",
        type: "connection",
        message: "Someone viewed your profile",
        timestamp: "1h",
        link: "https://www.linkedin.com/notifications/",
        is_read: false
      }
    ]);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
      stdoutChunks.push(String(value ?? ""));
    });
    stderrWriteSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((...args: Parameters<typeof process.stderr.write>) => {
        stderrChunks.push(String(args[0]));
        return true;
      });
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    stderrWriteSpy.mockRestore();
    process.exitCode = undefined;
    delete process.env.LINKEDIN_BUDDY_HOME;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs an issue-212 style seed spec and reuses generated media assets", async () => {
    const specPath = path.join(tempDir, "activity-spec.json");
    const imageReportPath = path.join(tempDir, "profile-images.json");
    await writeFile(
      imageReportPath,
      JSON.stringify(
        {
          post_images: [
            {
              absolute_path: path.join(tempDir, "generated-post-01.png"),
              file_name: "generated-post-01.png",
              concept_key: "copenhagen-workspace",
              title: "Workspace"
            }
          ]
        },
        null,
        2
      )
    );
    await writeFile(
      specPath,
      JSON.stringify(
        {
          assets: {
            generatedImageManifestPath: path.basename(imageReportPath)
          },
          connections: {
            acceptPending: {
              limit: 1
            },
            invites: [
              {
                targetProfile: "https://www.linkedin.com/in/new-person/",
                note: "Thought your recent AI platform post was excellent."
              }
            ]
          },
          posts: [
            {
              text: "A text-only update about practical AI evaluation loops."
            },
            {
              text: "A media update about grounded developer tooling.",
              generatedImageIndex: 0
            }
          ],
          feed: {
            discoveryLimit: 8,
            likes: [
              {
                postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:feed-1/",
                reaction: "insightful"
              }
            ],
            comments: [
              {
                postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:feed-2/",
                text: "Really like the focus on instrumentation here."
              }
            ]
          },
          jobs: {
            searches: [
              {
                query: "AI engineer",
                location: "Copenhagen, Denmark",
                limit: 5,
                viewTop: 1
              }
            ]
          },
          messaging: {
            newThreads: [
              {
                recipients: ["Simon Miller"],
                text: "Hi Simon, hope your week is going well."
              }
            ],
            replies: [
              {
                thread: "https://www.linkedin.com/messaging/thread/thread-2/",
                text: "Thanks for the note."
              }
            ]
          },
          notifications: {
            limit: 5
          }
        },
        null,
        2
      )
    );

    await runCli([
      "node",
      "linkedin",
      "seed",
      "activity",
      "--profile",
      "smoke",
      "--spec",
      specPath,
      "--delay-ms",
      "0",
      "--yes"
    ]);

    const output = JSON.parse(stdoutChunks.join("\n")) as {
      generated_image_manifest_path: string;
      plan: {
        totalWriteActions: number;
      };
      posts: Array<{
        action_type: string;
        media_path?: string;
      }>;
      verification: {
        inbox_threads: Array<{ thread_id: string }>;
      };
    };

    expect(output.generated_image_manifest_path).toBe(path.resolve(imageReportPath));
    expect(output.plan.totalWriteActions).toBe(8);
    expect(output.posts.map((post) => post.action_type)).toEqual([
      "post.create",
      "post.create_media"
    ]);
    expect(output.posts[1]?.media_path).toBe(path.join(tempDir, "generated-post-01.png"));
    expect(output.verification.inbox_threads[0]?.thread_id).toBe("thread-1");
    expect(activitySeedCliMocks.prepareCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "smoke",
        visibility: "connections"
      })
    );
    expect(activitySeedCliMocks.prepareCreateMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        profileName: "smoke",
        mediaPaths: [path.join(tempDir, "generated-post-01.png")],
        visibility: "connections"
      })
    );
    expect(stderrChunks.join("")).toContain("No running keepalive daemon was detected");
  });
});
