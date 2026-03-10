import { LinkedInAssistantError } from "@linkedin-assistant/core";

export interface ActivitySeedGeneratedPostImage {
  absolutePath: string;
  conceptKey: string;
  fileName: string;
  title: string;
}

export interface ActivitySeedGeneratedImageManifest {
  postImages: ActivitySeedGeneratedPostImage[];
}

export interface ActivitySeedAssetsSpec {
  generatedImageManifestPath?: string;
}

export interface ActivitySeedAcceptPendingSpec {
  limit: number;
}

export interface ActivitySeedInviteSpec {
  note?: string;
  operatorNote?: string;
  targetProfile: string;
}

export interface ActivitySeedConnectionsSpec {
  acceptPending?: ActivitySeedAcceptPendingSpec;
  invites: ActivitySeedInviteSpec[];
}

export interface ActivitySeedPostSpec {
  generatedImageIndex?: number;
  mediaPath?: string;
  operatorNote?: string;
  text: string;
  visibility?: string;
}

export interface ActivitySeedFeedLikeSpec {
  operatorNote?: string;
  postUrl: string;
  reaction?: string;
}

export interface ActivitySeedFeedCommentSpec {
  operatorNote?: string;
  postUrl: string;
  text: string;
}

export interface ActivitySeedFeedSpec {
  comments: ActivitySeedFeedCommentSpec[];
  discoveryLimit?: number;
  likes: ActivitySeedFeedLikeSpec[];
}

export interface ActivitySeedJobSearchSpec {
  limit?: number;
  location?: string;
  query: string;
  viewTop?: number;
}

export interface ActivitySeedJobsSpec {
  searches: ActivitySeedJobSearchSpec[];
}

export interface ActivitySeedNewThreadSpec {
  operatorNote?: string;
  recipients: string[];
  text: string;
}

export interface ActivitySeedReplySpec {
  operatorNote?: string;
  text: string;
  thread: string;
}

export interface ActivitySeedMessagingSpec {
  newThreads: ActivitySeedNewThreadSpec[];
  replies: ActivitySeedReplySpec[];
}

export interface ActivitySeedNotificationsSpec {
  limit?: number;
}

export interface ActivitySeedSpec {
  assets?: ActivitySeedAssetsSpec;
  connections: ActivitySeedConnectionsSpec;
  feed: ActivitySeedFeedSpec;
  jobs: ActivitySeedJobsSpec;
  messaging: ActivitySeedMessagingSpec;
  notifications?: ActivitySeedNotificationsSpec;
  posts: ActivitySeedPostSpec[];
}

export function parseActivitySeedSpec(input: unknown): ActivitySeedSpec {
  if (!isRecord(input)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Activity seed spec must be a JSON object."
    );
  }

  return {
    ...(input.assets !== undefined ? { assets: normalizeAssetsSpec(input.assets) } : {}),
    connections: normalizeConnectionsSpec(input.connections),
    posts: normalizePostsSpec(input.posts),
    feed: normalizeFeedSpec(input.feed),
    jobs: normalizeJobsSpec(input.jobs),
    messaging: normalizeMessagingSpec(input.messaging),
    ...(input.notifications !== undefined
      ? { notifications: normalizeNotificationsSpec(input.notifications) }
      : {})
  };
}

export function parseActivitySeedGeneratedImageManifest(
  input: unknown
): ActivitySeedGeneratedImageManifest {
  if (!isRecord(input)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "Generated image manifest must be a JSON object."
    );
  }

  const rawPostImages = input.post_images;
  if (!Array.isArray(rawPostImages)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      'Generated image manifest must include a "post_images" array.'
    );
  }

  return {
    postImages: rawPostImages.map((entry, index) =>
      normalizeGeneratedPostImage(entry, `post_images[${index}]`)
    )
  };
}

function normalizeAssetsSpec(value: unknown): ActivitySeedAssetsSpec {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "activity seed assets must be a JSON object."
    );
  }

  const generatedImageManifestPath = readOptionalString(value.generatedImageManifestPath);

  return {
    ...(generatedImageManifestPath ? { generatedImageManifestPath } : {})
  };
}

function normalizeConnectionsSpec(value: unknown): ActivitySeedConnectionsSpec {
  const record = normalizeOptionalRecord(value);

  return {
    ...(record.acceptPending !== undefined
      ? { acceptPending: normalizeAcceptPendingSpec(record.acceptPending) }
      : {}),
    invites: Array.isArray(record.invites)
      ? record.invites.map((entry, index) =>
          normalizeInviteSpec(entry, `connections.invites[${index}]`)
        )
      : []
  };
}

function normalizeAcceptPendingSpec(value: unknown): ActivitySeedAcceptPendingSpec {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "connections.acceptPending must be a JSON object."
    );
  }

  return {
    limit: readPositiveInt(value.limit, "connections.acceptPending.limit")
  };
}

function normalizeInviteSpec(value: unknown, label: string): ActivitySeedInviteSpec {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const targetProfile = readRequiredString(value.targetProfile, `${label}.targetProfile`);
  const note = readOptionalString(value.note);
  const operatorNote = readOptionalString(value.operatorNote);

  return {
    targetProfile,
    ...(note ? { note } : {}),
    ...(operatorNote ? { operatorNote } : {})
  };
}

function normalizePostsSpec(value: unknown): ActivitySeedPostSpec[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      "posts must be a JSON array."
    );
  }

  return value.map((entry, index) => normalizePostSpec(entry, `posts[${index}]`));
}

function normalizePostSpec(value: unknown, label: string): ActivitySeedPostSpec {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const text = readRequiredString(value.text, `${label}.text`);
  const mediaPath = readOptionalString(value.mediaPath);
  const operatorNote = readOptionalString(value.operatorNote);
  const visibility = readOptionalString(value.visibility);
  const generatedImageIndex = readOptionalNonNegativeInt(
    value.generatedImageIndex,
    `${label}.generatedImageIndex`
  );

  if (mediaPath && generatedImageIndex !== undefined) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} cannot include both mediaPath and generatedImageIndex.`
    );
  }

  return {
    text,
    ...(mediaPath ? { mediaPath } : {}),
    ...(operatorNote ? { operatorNote } : {}),
    ...(visibility ? { visibility } : {}),
    ...(generatedImageIndex !== undefined ? { generatedImageIndex } : {})
  };
}

function normalizeFeedSpec(value: unknown): ActivitySeedFeedSpec {
  const record = normalizeOptionalRecord(value);
  const discoveryLimit = readOptionalPositiveInt(
    record.discoveryLimit,
    "feed.discoveryLimit"
  );

  return {
    ...(discoveryLimit !== undefined ? { discoveryLimit } : {}),
    likes: Array.isArray(record.likes)
      ? record.likes.map((entry, index) =>
          normalizeFeedLikeSpec(entry, `feed.likes[${index}]`)
        )
      : [],
    comments: Array.isArray(record.comments)
      ? record.comments.map((entry, index) =>
          normalizeFeedCommentSpec(entry, `feed.comments[${index}]`)
        )
      : []
  };
}

function normalizeFeedLikeSpec(
  value: unknown,
  label: string
): ActivitySeedFeedLikeSpec {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const postUrl = readRequiredString(value.postUrl, `${label}.postUrl`);
  const reaction = readOptionalString(value.reaction);
  const operatorNote = readOptionalString(value.operatorNote);

  return {
    postUrl,
    ...(reaction ? { reaction } : {}),
    ...(operatorNote ? { operatorNote } : {})
  };
}

function normalizeFeedCommentSpec(
  value: unknown,
  label: string
): ActivitySeedFeedCommentSpec {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const postUrl = readRequiredString(value.postUrl, `${label}.postUrl`);
  const text = readRequiredString(value.text, `${label}.text`);
  const operatorNote = readOptionalString(value.operatorNote);

  return {
    postUrl,
    text,
    ...(operatorNote ? { operatorNote } : {})
  };
}

function normalizeJobsSpec(value: unknown): ActivitySeedJobsSpec {
  const record = normalizeOptionalRecord(value);

  return {
    searches: Array.isArray(record.searches)
      ? record.searches.map((entry, index) =>
          normalizeJobSearchSpec(entry, `jobs.searches[${index}]`)
        )
      : []
  };
}

function normalizeJobSearchSpec(
  value: unknown,
  label: string
): ActivitySeedJobSearchSpec {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const query = readRequiredString(value.query, `${label}.query`);
  const location = readOptionalString(value.location);
  const limit = readOptionalPositiveInt(value.limit, `${label}.limit`);
  const viewTop = readOptionalPositiveInt(value.viewTop, `${label}.viewTop`);

  return {
    query,
    ...(location ? { location } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(viewTop !== undefined ? { viewTop } : {})
  };
}

function normalizeMessagingSpec(value: unknown): ActivitySeedMessagingSpec {
  const record = normalizeOptionalRecord(value);

  return {
    newThreads: Array.isArray(record.newThreads)
      ? record.newThreads.map((entry, index) =>
          normalizeNewThreadSpec(entry, `messaging.newThreads[${index}]`)
        )
      : [],
    replies: Array.isArray(record.replies)
      ? record.replies.map((entry, index) =>
          normalizeReplySpec(entry, `messaging.replies[${index}]`)
        )
      : []
  };
}

function normalizeNewThreadSpec(
  value: unknown,
  label: string
): ActivitySeedNewThreadSpec {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const recipients = readStringArray(value.recipients, `${label}.recipients`);
  const text = readRequiredString(value.text, `${label}.text`);
  const operatorNote = readOptionalString(value.operatorNote);

  if (recipients.length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label}.recipients must include at least one recipient.`
    );
  }

  return {
    recipients,
    text,
    ...(operatorNote ? { operatorNote } : {})
  };
}

function normalizeReplySpec(value: unknown, label: string): ActivitySeedReplySpec {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  const thread = readRequiredString(value.thread, `${label}.thread`);
  const text = readRequiredString(value.text, `${label}.text`);
  const operatorNote = readOptionalString(value.operatorNote);

  return {
    thread,
    text,
    ...(operatorNote ? { operatorNote } : {})
  };
}

function normalizeNotificationsSpec(value: unknown): ActivitySeedNotificationsSpec {
  const record = normalizeOptionalRecord(value);
  const limit = readOptionalPositiveInt(record.limit, "notifications.limit");
  return {
    ...(limit !== undefined ? { limit } : {})
  };
}

function normalizeGeneratedPostImage(
  value: unknown,
  label: string
): ActivitySeedGeneratedPostImage {
  if (!isRecord(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a JSON object.`
    );
  }

  return {
    absolutePath: readRequiredString(value.absolute_path, `${label}.absolute_path`),
    conceptKey: readRequiredString(value.concept_key, `${label}.concept_key`),
    fileName: readRequiredString(value.file_name, `${label}.file_name`),
    title: readRequiredString(value.title, `${label}.title`)
  };
}

function normalizeOptionalRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  if (isRecord(value)) {
    return value;
  }

  throw new LinkedInAssistantError(
    "ACTION_PRECONDITION_FAILED",
    "Expected a JSON object."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(value: unknown): string | undefined {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : undefined;
}

function readRequiredString(value: unknown, label: string): string {
  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a non-empty string.`
    );
  }

  return normalized;
}

function readPositiveInt(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a whole number greater than 0.`
    );
  }

  return value;
}

function readOptionalPositiveInt(value: unknown, label: string): number | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  return readPositiveInt(value, label);
}

function readOptionalNonNegativeInt(value: unknown, label: string): number | undefined {
  if (typeof value === "undefined") {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be a whole number greater than or equal to 0.`
    );
  }

  return value;
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new LinkedInAssistantError(
      "ACTION_PRECONDITION_FAILED",
      `${label} must be an array of strings.`
    );
  }

  return value.map((entry, index) =>
    readRequiredString(entry, `${label}[${index}]`)
  );
}
