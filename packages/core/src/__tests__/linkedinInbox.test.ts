import { describe, expect, it, vi } from "vitest";
import {
  ADD_RECIPIENTS_ACTION_TYPE,
  SEND_MESSAGE_ACTION_TYPE,
  SEND_NEW_THREAD_ACTION_TYPE,
  LinkedInInboxService,
  createLinkedInActionExecutors,
  type LinkedInInboxRuntime
} from "../linkedinInbox.js";

function resolveProfileUrl(target: string): string {
  if (/^https?:\/\//i.test(target)) {
    return target.endsWith("/") ? target : `${target}/`;
  }

  if (target.startsWith("/in/")) {
    return `https://www.linkedin.com${target.endsWith("/") ? target : `${target}/`}`;
  }

  return `https://www.linkedin.com/in/${target}/`;
}

function vanityNameFromTarget(target: string): string {
  const profileUrl = resolveProfileUrl(target);
  const match = /\/in\/([^/?#]+)/.exec(profileUrl);
  return match?.[1] ?? "unknown";
}

function createMockRuntime(): {
  runtime: LinkedInInboxRuntime;
  mocks: {
    prepare: ReturnType<typeof vi.fn>;
    search: ReturnType<typeof vi.fn>;
    viewProfile: ReturnType<typeof vi.fn>;
  };
} {
  const prepare = vi.fn((input: { preview: Record<string, unknown> }) => ({
    preparedActionId: "pa_test",
    confirmToken: "ct_test",
    expiresAtMs: 123,
    preview: input.preview
  }));
  const search = vi.fn(async () => ({
    query: "Simon Miller",
    category: "people" as const,
    count: 1,
    results: [
      {
        name: "Simon Miller",
        headline: "Product Lead at Replay Labs",
        location: "London, United Kingdom",
        profile_url: "https://www.linkedin.com/in/realsimonmiller/",
        vanity_name: "realsimonmiller",
        connection_degree: "2nd",
        mutual_connections: "5 mutual connections"
      }
    ]
  }));
  const viewProfile = vi.fn(async (input: { target?: string }) => {
    const target = String(input.target ?? "");
    const vanityName = vanityNameFromTarget(target);
    const fullName = vanityName === "realsimonmiller" ? "Simon Miller" : "Alex Example";

    return {
      profile_url: resolveProfileUrl(target),
      vanity_name: vanityName,
      full_name: fullName,
      headline: "Product Lead at Replay Labs",
      location: "London, United Kingdom",
      about: "",
      connection_degree: "2nd",
      experience: [],
      education: []
    };
  });

  const rateLimitState = {
    allowed: true,
    count: 0,
    counterKey: "linkedin.messaging.send_message",
    limit: 20,
    remaining: 20,
    windowSizeMs: 60 * 60 * 1000,
    windowStartMs: 0
  };

  const runtime = {
    runId: "run_test",
    db: {} as unknown as LinkedInInboxRuntime["db"],
    auth: {
      ensureAuthenticated: vi.fn(async () => undefined)
    } as unknown as LinkedInInboxRuntime["auth"],
    cdpUrl: undefined,
    selectorLocale: "en",
    profileManager: {} as unknown as LinkedInInboxRuntime["profileManager"],
    artifacts: {} as unknown as LinkedInInboxRuntime["artifacts"],
    confirmFailureArtifacts:
      {} as unknown as LinkedInInboxRuntime["confirmFailureArtifacts"],
    rateLimiter: {
      peek: vi.fn(() => rateLimitState),
      consume: vi.fn(() => rateLimitState)
    } as unknown as LinkedInInboxRuntime["rateLimiter"],
    logger: {
      log: vi.fn()
    } as unknown as LinkedInInboxRuntime["logger"],
    profile: {
      viewProfile
    } as unknown as LinkedInInboxRuntime["profile"],
    search: {
      search
    } as unknown as LinkedInInboxRuntime["search"],
    twoPhaseCommit: {
      prepare
    } as unknown as LinkedInInboxRuntime["twoPhaseCommit"]
  } satisfies LinkedInInboxRuntime;

  return {
    runtime,
    mocks: {
      prepare,
      search,
      viewProfile
    }
  };
}

describe("LinkedIn inbox action executors", () => {
  it("registers reply, new-thread, and add-recipient executors", () => {
    const executors = createLinkedInActionExecutors();
    expect(executors[SEND_MESSAGE_ACTION_TYPE]).toBeDefined();
    expect(executors[SEND_NEW_THREAD_ACTION_TYPE]).toBeDefined();
    expect(executors[ADD_RECIPIENTS_ACTION_TYPE]).toBeDefined();
  });
});

describe("LinkedInInboxService", () => {
  it("searchRecipients maps people search results to recipient records", async () => {
    const { runtime, mocks } = createMockRuntime();
    const service = new LinkedInInboxService(runtime);

    const result = await service.searchRecipients({
      profileName: "default",
      query: "Simon Miller",
      limit: 5
    });

    expect(mocks.search).toHaveBeenCalledWith({
      profileName: "default",
      query: "Simon Miller",
      category: "people",
      limit: 5
    });
    expect(result).toMatchObject({
      query: "Simon Miller",
      count: 1,
      recipients: [
        {
          full_name: "Simon Miller",
          profile_url: "https://www.linkedin.com/in/realsimonmiller/"
        }
      ]
    });
  });

  it("prepareNewThread resolves recipients and stores a prepared action", async () => {
    const { runtime, mocks } = createMockRuntime();
    const service = new LinkedInInboxService(runtime);

    const result = await service.prepareNewThread({
      profileName: "default",
      recipients: ["realsimonmiller"],
      text: "Hello Simon"
    });

    expect(mocks.viewProfile).toHaveBeenCalledWith({
      profileName: "default",
      target: "realsimonmiller"
    });
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: SEND_NEW_THREAD_ACTION_TYPE,
        payload: {
          text: "Hello Simon"
        },
        target: expect.objectContaining({
          profile_name: "default",
          recipient_count: 1,
          recipients: [
            expect.objectContaining({
              full_name: "Simon Miller",
              profile_url: "https://www.linkedin.com/in/realsimonmiller/"
            })
          ]
        })
      })
    );
    expect(result).toMatchObject({
      preparedActionId: "pa_test",
      confirmToken: "ct_test"
    });
  });

  it("prepareAddRecipients resolves the thread target and recipient payload", async () => {
    const { runtime, mocks } = createMockRuntime();
    const service = new LinkedInInboxService(runtime);
    vi.spyOn(service, "getThread").mockResolvedValue({
      thread_id: "thread-1",
      title: "Simon Miller",
      unread_count: 0,
      snippet: "",
      thread_url: "https://www.linkedin.com/messaging/thread/thread-1/",
      messages: []
    });

    const result = await service.prepareAddRecipients({
      profileName: "default",
      thread: "thread-1",
      recipients: ["alexexample"]
    });

    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: ADD_RECIPIENTS_ACTION_TYPE,
        target: expect.objectContaining({
          profile_name: "default",
          thread_id: "thread-1"
        }),
        payload: {
          recipients: [
            expect.objectContaining({
              full_name: "Alex Example",
              profile_url: "https://www.linkedin.com/in/alexexample/"
            })
          ]
        }
      })
    );
    expect(result).toMatchObject({
      preparedActionId: "pa_test",
      confirmToken: "ct_test"
    });
  });
});
