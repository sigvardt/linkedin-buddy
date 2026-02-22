#!/usr/bin/env node
import {
  LinkedInAssistantError,
  createCoreRuntime,
  toLinkedInAssistantErrorPayload
} from "@linkedin-assistant/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest
} from "@modelcontextprotocol/sdk/types.js";
import {
  LINKEDIN_ACTIONS_CONFIRM_TOOL,
  LINKEDIN_CONNECTIONS_ACCEPT_TOOL,
  LINKEDIN_CONNECTIONS_INVITE_TOOL,
  LINKEDIN_CONNECTIONS_LIST_TOOL,
  LINKEDIN_CONNECTIONS_PENDING_TOOL,
  LINKEDIN_CONNECTIONS_WITHDRAW_TOOL,
  LINKEDIN_FEED_COMMENT_TOOL,
  LINKEDIN_FEED_LIKE_TOOL,
  LINKEDIN_FEED_LIST_TOOL,
  LINKEDIN_FEED_VIEW_POST_TOOL,
  LINKEDIN_INBOX_GET_THREAD_TOOL,
  LINKEDIN_INBOX_LIST_THREADS_TOOL,
  LINKEDIN_INBOX_PREPARE_REPLY_TOOL,
  LINKEDIN_PROFILE_VIEW_TOOL,
  LINKEDIN_SESSION_OPEN_LOGIN_TOOL,
  LINKEDIN_SESSION_STATUS_TOOL
} from "../index.js";

type ToolArgs = Record<string, unknown>;
type ToolResult = { content: Array<{ type: "text"; text: string }> };

function readString(args: ToolArgs, key: string, fallback: string): string {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : fallback;
}

function readRequiredString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    `${key} is required.`
  );
}

function readPositiveNumber(
  args: ToolArgs,
  key: string,
  fallback: number
): number {
  const value = args[key];
  if (typeof value !== "number") {
    return fallback;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${key} must be a positive number.`
    );
  }

  return value;
}

function readBoolean(args: ToolArgs, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function toToolResult(payload: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function toErrorResult(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(toLinkedInAssistantErrorPayload(error), null, 2)
      }
    ]
  };
}

function readTargetProfileName(target: Record<string, unknown>): string | undefined {
  const value = target.profile_name;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

async function handleSessionStatus(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");

    runtime.logger.log("info", "mcp.session.status.start", {
      profileName
    });

    const status = await runtime.auth.status({
      profileName
    });

    runtime.logger.log("info", "mcp.session.status.done", {
      profileName,
      authenticated: status.authenticated
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      status
    });
  } finally {
    runtime.close();
  }
}

async function handleSessionOpenLogin(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const timeoutMs = readPositiveNumber(args, "timeoutMs", 5 * 60_000);

    runtime.logger.log("info", "mcp.session.open_login.start", {
      profileName,
      timeoutMs
    });

    const status = await runtime.auth.openLogin({
      profileName,
      timeoutMs
    });

    runtime.logger.log("info", "mcp.session.open_login.done", {
      profileName,
      authenticated: status.authenticated,
      timedOut: status.timedOut
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      status
    });
  } finally {
    runtime.close();
  }
}

async function handleListThreads(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const limit = readPositiveNumber(args, "limit", 20);
    const unreadOnly = readBoolean(args, "unreadOnly", false);

    runtime.logger.log("info", "mcp.inbox.list_threads.start", {
      profileName,
      limit,
      unreadOnly
    });

    const threads = await runtime.inbox.listThreads({
      profileName,
      limit,
      unreadOnly
    });

    runtime.logger.log("info", "mcp.inbox.list_threads.done", {
      profileName,
      count: threads.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: threads.length,
      threads
    });
  } finally {
    runtime.close();
  }
}

async function handleGetThread(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const thread = readRequiredString(args, "thread");
    const limit = readPositiveNumber(args, "limit", 20);

    runtime.logger.log("info", "mcp.inbox.get_thread.start", {
      profileName,
      thread,
      limit
    });

    const detail = await runtime.inbox.getThread({
      profileName,
      thread,
      limit
    });

    runtime.logger.log("info", "mcp.inbox.get_thread.done", {
      profileName,
      threadId: detail.thread_id
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      thread: detail
    });
  } finally {
    runtime.close();
  }
}

async function handlePrepareReply(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const thread = readRequiredString(args, "thread");
    const text = readRequiredString(args, "text");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.inbox.prepare_reply.start", {
      profileName,
      thread
    });

    const prepared = await runtime.inbox.prepareReply({
      profileName,
      thread,
      text,
      ...(operatorNote
        ? {
            operatorNote
          }
        : {})
    });

    runtime.logger.log("info", "mcp.inbox.prepare_reply.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleProfileView(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const target = readString(args, "target", "me");

    runtime.logger.log("info", "mcp.profile.view.start", {
      profileName,
      target
    });

    const profile = await runtime.profile.viewProfile({
      profileName,
      target
    });

    runtime.logger.log("info", "mcp.profile.view.done", {
      profileName,
      fullName: profile.full_name
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      profile
    });
  } finally {
    runtime.close();
  }
}

async function handleConnectionsList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const limit = readPositiveNumber(args, "limit", 40);

    runtime.logger.log("info", "mcp.connections.list.start", {
      profileName,
      limit
    });

    const connections = await runtime.connections.listConnections({
      profileName,
      limit
    });

    runtime.logger.log("info", "mcp.connections.list.done", {
      profileName,
      count: connections.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: connections.length,
      connections
    });
  } finally {
    runtime.close();
  }
}

async function handleConnectionsPending(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const filterRaw = readString(args, "filter", "all");
    const filter = (["sent", "received", "all"].includes(filterRaw)
      ? filterRaw
      : "all") as "sent" | "received" | "all";

    runtime.logger.log("info", "mcp.connections.pending.start", {
      profileName,
      filter
    });

    const invitations = await runtime.connections.listPendingInvitations({
      profileName,
      filter
    });

    runtime.logger.log("info", "mcp.connections.pending.done", {
      profileName,
      count: invitations.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      filter,
      count: invitations.length,
      invitations
    });
  } finally {
    runtime.close();
  }
}

async function handleConnectionsInvite(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const note = readString(args, "note", "");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.connections.invite.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.connections.prepareSendInvitation({
      profileName,
      targetProfile,
      ...(note ? { note } : {}),
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.connections.invite.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleConnectionsAccept(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.connections.accept.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.connections.prepareAcceptInvitation({
      profileName,
      targetProfile,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.connections.accept.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleConnectionsWithdraw(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const targetProfile = readRequiredString(args, "targetProfile");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.connections.withdraw.start", {
      profileName,
      targetProfile
    });

    const prepared = runtime.connections.prepareWithdrawInvitation({
      profileName,
      targetProfile,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.connections.withdraw.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleFeedList(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const limit = readPositiveNumber(args, "limit", 10);

    runtime.logger.log("info", "mcp.feed.list.start", {
      profileName,
      limit
    });

    const posts = await runtime.feed.viewFeed({
      profileName,
      limit
    });

    runtime.logger.log("info", "mcp.feed.list.done", {
      profileName,
      count: posts.length
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      count: posts.length,
      posts
    });
  } finally {
    runtime.close();
  }
}

async function handleFeedViewPost(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");

    runtime.logger.log("info", "mcp.feed.view_post.start", {
      profileName,
      postUrl
    });

    const post = await runtime.feed.viewPost({
      profileName,
      postUrl
    });

    runtime.logger.log("info", "mcp.feed.view_post.done", {
      profileName,
      postId: post.post_id
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      post
    });
  } finally {
    runtime.close();
  }
}

async function handleFeedLike(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.feed.like.start", {
      profileName,
      postUrl
    });

    const prepared = runtime.feed.prepareLikePost({
      profileName,
      postUrl,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.feed.like.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleFeedComment(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const postUrl = readRequiredString(args, "postUrl");
    const text = readRequiredString(args, "text");
    const operatorNote = readString(args, "operatorNote", "");

    runtime.logger.log("info", "mcp.feed.comment.start", {
      profileName,
      postUrl
    });

    const prepared = runtime.feed.prepareCommentOnPost({
      profileName,
      postUrl,
      text,
      ...(operatorNote ? { operatorNote } : {})
    });

    runtime.logger.log("info", "mcp.feed.comment.done", {
      profileName,
      preparedActionId: prepared.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      ...prepared
    });
  } finally {
    runtime.close();
  }
}

async function handleConfirm(args: ToolArgs): Promise<ToolResult> {
  const runtime = createCoreRuntime();

  try {
    const profileName = readString(args, "profileName", "default");
    const token = readRequiredString(args, "token");

    runtime.logger.log("info", "mcp.actions.confirm.start", {
      profileName
    });

    const preview = runtime.twoPhaseCommit.getPreparedActionPreviewByToken({
      confirmToken: token
    });

    const preparedProfileName = readTargetProfileName(preview.target);
    if (preparedProfileName && preparedProfileName !== profileName) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        `Prepared action belongs to profile "${preparedProfileName}", but "${profileName}" was provided.`,
        {
          expected_profile_name: preparedProfileName,
          provided_profile_name: profileName
        }
      );
    }

    const result = await runtime.twoPhaseCommit.confirmByToken({
      confirmToken: token
    });

    runtime.logger.log("info", "mcp.actions.confirm.done", {
      profileName,
      preparedActionId: result.preparedActionId
    });

    return toToolResult({
      run_id: runtime.runId,
      profile_name: profileName,
      preview,
      result
    });
  } finally {
    runtime.close();
  }
}

const server = new Server(
  {
    name: "linkedin-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: LINKEDIN_SESSION_STATUS_TOOL,
        description: "Check LinkedIn session authentication status for a profile.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            }
          }
        }
      },
      {
        name: LINKEDIN_SESSION_OPEN_LOGIN_TOOL,
        description: "Open LinkedIn login and wait for authentication in a profile.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            timeoutMs: {
              type: "number",
              description: "Maximum time to wait for authentication, in milliseconds."
            }
          }
        }
      },
      {
        name: LINKEDIN_INBOX_LIST_THREADS_TOOL,
        description: "List LinkedIn inbox threads for a profile.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            limit: {
              type: "number",
              description: "Maximum number of threads to return."
            },
            unreadOnly: {
              type: "boolean",
              description: "If true, only unread threads are returned."
            }
          }
        }
      },
      {
        name: LINKEDIN_INBOX_GET_THREAD_TOOL,
        description: "Get one LinkedIn thread with recent messages.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["thread"],
          properties: {
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            thread: {
              type: "string",
              description: "Thread id or LinkedIn thread URL."
            },
            limit: {
              type: "number",
              description: "Maximum number of messages to include."
            }
          }
        }
      },
      {
        name: LINKEDIN_INBOX_PREPARE_REPLY_TOOL,
        description: "Prepare a two-phase send_message action for a thread.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["thread", "text"],
          properties: {
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            thread: {
              type: "string",
              description: "Thread id or LinkedIn thread URL."
            },
            text: {
              type: "string",
              description: "Message text to prepare for sending."
            },
            operatorNote: {
              type: "string",
              description: "Optional note attached to the prepared action."
            }
          }
        }
      },
      {
        name: LINKEDIN_PROFILE_VIEW_TOOL,
        description:
          "View a LinkedIn profile. Returns structured profile data including name, headline, location, about, experience, and education.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            profileName: {
              type: "string",
              description: "Persistent Playwright profile name. Defaults to default."
            },
            target: {
              type: "string",
              description:
                "Vanity name (e.g. 'johndoe'), profile URL, or 'me' for own profile. Defaults to 'me'."
            }
          }
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_LIST_TOOL,
        description:
          "List your LinkedIn connections. Returns connection names, headlines, profile URLs, and when connected.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            limit: {
              type: "number",
              description: "Maximum number of connections to return. Defaults to 40."
            }
          }
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_PENDING_TOOL,
        description:
          "List pending LinkedIn connection invitations (sent, received, or both).",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            filter: {
              type: "string",
              enum: ["sent", "received", "all"],
              description:
                "Filter invitations by direction. Defaults to all."
            }
          }
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_INVITE_TOOL,
        description:
          "Prepare a connection invitation to a LinkedIn user (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["targetProfile"],
          properties: {
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            targetProfile: {
              type: "string",
              description:
                "Vanity name (e.g. 'johndoe') or full profile URL."
            },
            note: {
              type: "string",
              description: "Optional invitation note (max 300 chars)."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          }
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_ACCEPT_TOOL,
        description:
          "Prepare to accept a pending connection invitation (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["targetProfile"],
          properties: {
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            targetProfile: {
              type: "string",
              description:
                "Vanity name or profile URL of the person who sent the invitation."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          }
        }
      },
      {
        name: LINKEDIN_CONNECTIONS_WITHDRAW_TOOL,
        description:
          "Prepare to withdraw a sent connection invitation (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["targetProfile"],
          properties: {
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            targetProfile: {
              type: "string",
              description:
                "Vanity name or profile URL of the person to withdraw the invitation from."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          }
        }
      },
      {
        name: LINKEDIN_FEED_LIST_TOOL,
        description:
          "List posts from your LinkedIn feed with author, text, and engagement counts.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            limit: {
              type: "number",
              description: "Maximum number of feed posts to return. Defaults to 10."
            }
          }
        }
      },
      {
        name: LINKEDIN_FEED_VIEW_POST_TOOL,
        description: "View one LinkedIn feed post by URL, URN, or activity id.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["postUrl"],
          properties: {
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            postUrl: {
              type: "string",
              description: "LinkedIn post URL, URN, or activity/share identifier."
            }
          }
        }
      },
      {
        name: LINKEDIN_FEED_LIKE_TOOL,
        description:
          "Prepare to like a LinkedIn post (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["postUrl"],
          properties: {
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            postUrl: {
              type: "string",
              description: "LinkedIn post URL, URN, or activity/share identifier."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          }
        }
      },
      {
        name: LINKEDIN_FEED_COMMENT_TOOL,
        description:
          "Prepare to comment on a LinkedIn post (two-phase: returns confirm token). Use linkedin.actions.confirm to execute.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["postUrl", "text"],
          properties: {
            profileName: {
              type: "string",
              description:
                "Persistent Playwright profile name. Defaults to default."
            },
            postUrl: {
              type: "string",
              description: "LinkedIn post URL, URN, or activity/share identifier."
            },
            text: {
              type: "string",
              description: "Comment text to prepare."
            },
            operatorNote: {
              type: "string",
              description: "Internal note for audit."
            }
          }
        }
      },
      {
        name: LINKEDIN_ACTIONS_CONFIRM_TOOL,
        description: "Confirm and execute a prepared action by confirm token.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: {
            profileName: {
              type: "string",
              description: "Persistent profile expected for this action."
            },
            token: {
              type: "string",
              description: "Confirmation token in ct_... format."
            }
          }
        }
      }
    ]
  };
});

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as ToolArgs;

    try {
      if (name === LINKEDIN_SESSION_STATUS_TOOL) {
        return await handleSessionStatus(args);
      }

      if (name === LINKEDIN_SESSION_OPEN_LOGIN_TOOL) {
        return await handleSessionOpenLogin(args);
      }

      if (name === LINKEDIN_INBOX_LIST_THREADS_TOOL) {
        return await handleListThreads(args);
      }

      if (name === LINKEDIN_INBOX_GET_THREAD_TOOL) {
        return await handleGetThread(args);
      }

      if (name === LINKEDIN_INBOX_PREPARE_REPLY_TOOL) {
        return await handlePrepareReply(args);
      }

      if (name === LINKEDIN_PROFILE_VIEW_TOOL) {
        return await handleProfileView(args);
      }

      if (name === LINKEDIN_CONNECTIONS_LIST_TOOL) {
        return await handleConnectionsList(args);
      }

      if (name === LINKEDIN_CONNECTIONS_PENDING_TOOL) {
        return await handleConnectionsPending(args);
      }

      if (name === LINKEDIN_CONNECTIONS_INVITE_TOOL) {
        return await handleConnectionsInvite(args);
      }

      if (name === LINKEDIN_CONNECTIONS_ACCEPT_TOOL) {
        return await handleConnectionsAccept(args);
      }

      if (name === LINKEDIN_CONNECTIONS_WITHDRAW_TOOL) {
        return await handleConnectionsWithdraw(args);
      }

      if (name === LINKEDIN_FEED_LIST_TOOL) {
        return await handleFeedList(args);
      }

      if (name === LINKEDIN_FEED_VIEW_POST_TOOL) {
        return await handleFeedViewPost(args);
      }

      if (name === LINKEDIN_FEED_LIKE_TOOL) {
        return await handleFeedLike(args);
      }

      if (name === LINKEDIN_FEED_COMMENT_TOOL) {
        return await handleFeedComment(args);
      }

      if (name === LINKEDIN_ACTIONS_CONFIRM_TOOL) {
        return await handleConfirm(args);
      }

      return toErrorResult(`Unknown tool: ${name}`);
    } catch (error) {
      return toErrorResult(error);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  console.error(JSON.stringify(toLinkedInAssistantErrorPayload(error), null, 2));
  process.exit(1);
});
