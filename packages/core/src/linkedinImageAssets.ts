import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import type { ArtifactHelpers } from "./artifacts.js";
import { LinkedInBuddyError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import type { LinkedInProfileService } from "./linkedinProfile.js";

const DEFAULT_OPENAI_IMAGES_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-1.5";
export const DEFAULT_LINKEDIN_PERSONA_POST_IMAGE_COUNT = 6;
export const MAX_LINKEDIN_PERSONA_POST_IMAGE_COUNT = 10;
const DEFAULT_PROFILE_UPLOAD_DELAY_MS = 4_500;
const PROFILE_PHOTO_OUTPUT_WIDTH = 800;
const PROFILE_PHOTO_OUTPUT_HEIGHT = 800;
const PROFILE_BANNER_OUTPUT_WIDTH = 1_584;
const PROFILE_BANNER_OUTPUT_HEIGHT = 396;

type LinkedInImageAssetKind = "profile_photo" | "banner" | "post_image";
type OpenAiImageSize = "1024x1024" | "1536x1024" | "1024x1536";

interface OpenAiImageGenerationResponse {
  created?: number;
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
    url?: string;
  }>;
  usage?: Record<string, unknown>;
}

interface PlannedLinkedInImageAsset {
  kind: LinkedInImageAssetKind;
  conceptKey: string;
  title: string;
  fileName: string;
  prompt: string;
  sourceSize: OpenAiImageSize;
  outputWidth: number;
  outputHeight: number;
}

interface OpenAiImageGenerationConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}

export interface LinkedInImagePersona {
  slug: string;
  full_name: string;
  headline: string;
  location: string;
  summary: string;
  current_role?: string;
  current_company?: string;
  focus_areas: string[];
  project_titles: string[];
}

export interface GenerateLinkedInPersonaImageSetInput {
  persona: LinkedInImagePersona;
  postImageCount?: number;
  model?: string;
  uploadProfileMedia?: boolean;
  profileName?: string;
  operatorNote?: string;
  uploadDelayMs?: number;
}

export interface GeneratedLinkedInImageAsset {
  kind: LinkedInImageAssetKind;
  title: string;
  concept_key: string;
  file_name: string;
  relative_path: string;
  absolute_path: string;
  mime_type: "image/png";
  width: number;
  height: number;
  size_bytes: number;
  sha256: string;
  prompt: string;
  revised_prompt: string | null;
}

export interface LinkedInPersonaMediaUploadResult {
  prepared_action_id: string;
  action_type: string;
  status: string;
  file_name: string;
  result: Record<string, unknown>;
  artifacts: string[];
}

export interface GeneratedLinkedInPersonaImageSet {
  generated_at: string;
  model: string;
  bundle_relative_dir: string;
  bundle_absolute_dir: string;
  manifest_path: string;
  persona: LinkedInImagePersona;
  profile_photo: GeneratedLinkedInImageAsset;
  banner: GeneratedLinkedInImageAsset;
  post_images: GeneratedLinkedInImageAsset[];
  upload_results?: {
    profile_photo: LinkedInPersonaMediaUploadResult;
    banner: LinkedInPersonaMediaUploadResult;
  };
  openai_usage?: Record<string, unknown>;
}

interface ConfirmPreparedActionResult {
  preparedActionId: string;
  actionType: string;
  status: string;
  result: Record<string, unknown>;
  artifacts: string[];
}

export interface LinkedInImageAssetsRuntime {
  logger: Pick<JsonEventLogger, "log">;
  artifacts: ArtifactHelpers;
  profile: Pick<LinkedInProfileService, "prepareUploadPhoto" | "prepareUploadBanner">;
  confirmPreparedAction: (
    confirmToken: string
  ) => Promise<ConfirmPreparedActionResult>;
}

const POST_IMAGE_BLUEPRINTS = [
  {
    key: "copenhagen-workspace",
    title: "Copenhagen AI Workspace",
    size: "1536x1024",
    width: 1536,
    height: 1024,
    createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) =>
      [
        "Create a realistic LinkedIn post image of a polished Copenhagen tech workspace.",
        `${personaDescriptor}.`,
        "Scene: standing desk, laptop, secondary monitor with abstract code blocks and charts, notebook, coffee, clean Scandinavian office styling, soft daylight, muted slate and teal palette.",
        "The image should feel like an authentic workplace photo for a post about AI product building and developer tools.",
        "No logos, no watermarks, no unreadable interface text, no deformed hands, no duplicate objects."
      ].join(" ")
  },
  {
    key: "meetup-stage",
    title: "AI Meetup Stage Portrait",
    size: "1024x1536",
    width: 1024,
    height: 1536,
    createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) =>
      [
        "Create a portrait-oriented LinkedIn post image from a small AI or developer-tools meetup in Copenhagen.",
        `${personaDescriptor}.`,
        "A confident speaker is on stage in business-casual clothing, warm event lighting, attentive audience silhouettes, modern Nordic venue, tasteful depth of field.",
        "Keep it realistic and professional, like a candid event photo for engineering culture content.",
        "No logos, no banner text, no distorted faces, no extra fingers, no watermarks."
      ].join(" ")
  },
  {
    key: "llm-evaluation-map",
    title: "LLM Evaluation Diagram",
    size: "1024x1024",
    width: 1024,
    height: 1024,
    createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) =>
      [
        "Create a clean square diagram-style illustration for a LinkedIn post about evaluating LLM systems.",
        `${personaDescriptor}.`,
        "Show abstract blocks, retrieval paths, test cases, observability signals, and feedback loops in a modern vector-like style with teal, graphite, sand, and off-white colors.",
        "Make it readable as a diagram without relying on body text or logos.",
        "No fake UI chrome, no gibberish text, no watermarks."
      ].join(" ")
  },
  {
    key: "whiteboard-session",
    title: "Developer Tools Whiteboard Session",
    size: "1536x1024",
    width: 1536,
    height: 1024,
    createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) =>
      [
        "Create a realistic LinkedIn post image of an engineering team whiteboard session.",
        `${personaDescriptor}.`,
        "Show two or three professionals in a bright Scandinavian meeting room with a whiteboard covered in simple architecture sketches, sticky notes, and arrows, plus laptops on the table.",
        "Tone: thoughtful, collaborative, grounded, suitable for a post about developer experience and engineering culture.",
        "No company logos, no readable brand names, no malformed hands or faces, no watermarks."
      ].join(" ")
  },
  {
    key: "observability-grid",
    title: "AI Observability Grid",
    size: "1024x1024",
    width: 1024,
    height: 1024,
    createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) =>
      [
        "Create a square infographic-style illustration for a LinkedIn post about AI observability.",
        `${personaDescriptor}.`,
        "Use a refined Scandinavian tech aesthetic with modular panels, traces, alerts, token flows, evaluation snapshots, and calm negative space.",
        "Keep it visual-first with iconography and shapes instead of paragraphs of text.",
        "No gibberish labels, no logos, no watermarks."
      ].join(" ")
  },
  {
    key: "pair-programming",
    title: "Pair Programming Session",
    size: "1536x1024",
    width: 1536,
    height: 1024,
    createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) =>
      [
        "Create a realistic LinkedIn post image of a calm pair-programming session in a Copenhagen office.",
        `${personaDescriptor}.`,
        "Two engineers collaborate at a desk with large monitors, soft daylight, subtle plants, notebooks, and a clean modern office environment.",
        "The vibe should fit a post about engineering culture, code review, and thoughtful product development.",
        "No visible brand logos, no uncanny hands, no unreadable text, no watermarks."
      ].join(" ")
  },
  {
    key: "conference-corridor",
    title: "Conference Hallway Conversation",
    size: "1024x1536",
    width: 1024,
    height: 1536,
    createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) =>
      [
        "Create a portrait-oriented LinkedIn post image of an authentic conference hallway conversation for AI engineers.",
        `${personaDescriptor}.`,
        "Modern European venue, business-casual professionals, soft natural lighting, subtle badges without readable text, candid energy, premium editorial photography feel.",
        "Suitable for a post about meetups, conferences, or lessons learned from the community.",
        "No logos, no gibberish text, no distorted anatomy, no watermarks."
      ].join(" ")
  },
  {
    key: "platform-blueprint",
    title: "Platform Architecture Blueprint",
    size: "1024x1024",
    width: 1024,
    height: 1024,
    createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) =>
      [
        "Create a square architectural blueprint illustration for a LinkedIn post about AI platform design.",
        `${personaDescriptor}.`,
        "Show modular services, data flows, guardrails, evaluation checkpoints, and deployment layers in a crisp diagram aesthetic with calm Nordic colors.",
        "Use shapes and light annotations only if they remain simple and clean; avoid dense text.",
        "No watermarks, no fake logos, no gibberish."
      ].join(" ")
  },
  {
    key: "coffee-chat",
    title: "Engineering Coffee Chat",
    size: "1536x1024",
    width: 1536,
    height: 1024,
    createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) =>
      [
        "Create a realistic LinkedIn post image of two engineers having a thoughtful coffee chat in a bright Copenhagen office lounge.",
        `${personaDescriptor}.`,
        "Natural daylight, minimalist furniture, laptop on the side, notebooks, relaxed but professional body language, editorial business photography feel.",
        "Suitable for a post about mentoring, team health, or engineering leadership.",
        "No logos, no awkward anatomy, no watermarks."
      ].join(" ")
  },
  {
    key: "city-office",
    title: "Copenhagen Office Window Scene",
    size: "1536x1024",
    width: 1536,
    height: 1024,
    createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) =>
      [
        "Create a realistic LinkedIn post image of a modern AI engineer office setup with large windows overlooking Copenhagen rooftops.",
        `${personaDescriptor}.`,
        "Standing desk, laptop, external monitor with abstract charts, notebook, soft morning light, polished Scandinavian design.",
        "The image should feel practical and aspirational for a post about developer tools or focused engineering work.",
        "No logos, no gibberish text, no watermarks."
      ].join(" ")
  }
] as const satisfies ReadonlyArray<{
  key: string;
  title: string;
  size: OpenAiImageSize;
  width: number;
  height: number;
  createPrompt: (persona: LinkedInImagePersona, personaDescriptor: string) => string;
}>;

function normalizeRecord(
  value: unknown,
  message: string
): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new LinkedInBuddyError("ACTION_PRECONDITION_FAILED", message);
}

function readRequiredText(
  record: Record<string, unknown>,
  key: string,
  message: string
): string {
  const value = record[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  throw new LinkedInBuddyError("ACTION_PRECONDITION_FAILED", message, {
    field: key
  });
}

function readOptionalText(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function readOptionalTextArray(
  record: Record<string, unknown>,
  key: string
): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function slugifyPathComponent(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized.length > 0 ? normalized : "asset";
}

function buildPersonaDescriptor(persona: LinkedInImagePersona): string {
  const descriptors = [
    persona.headline,
    persona.location,
    ...persona.focus_areas.slice(0, 4)
  ];

  if (persona.current_role && persona.current_company) {
    descriptors.unshift(
      `${persona.current_role} at ${persona.current_company}`
    );
  } else if (persona.current_role) {
    descriptors.unshift(persona.current_role);
  }

  return descriptors.join(", ");
}

function buildProfilePhotoPrompt(persona: LinkedInImagePersona): string {
  const personaDescriptor = buildPersonaDescriptor(persona);
  return [
    "Create a highly realistic professional LinkedIn headshot.",
    `${persona.full_name} is a Copenhagen-based tech professional: ${personaDescriptor}.`,
    "Business casual or smart casual styling, approachable confidence, natural expression, shoulders-up framing, eye-level camera, soft daylight, subtle studio or modern office background, realistic skin texture, sharp focus on the face.",
    "The result should feel authentic and trustworthy for a real AI/ML engineer profile photo on LinkedIn.",
    "No extra people, no text, no logos, no watermarks, no glamour retouching, no distorted anatomy."
  ].join(" ");
}

function buildBannerPrompt(persona: LinkedInImagePersona): string {
  const personaDescriptor = buildPersonaDescriptor(persona);
  return [
    "Create a wide professional LinkedIn banner image for an AI and developer-tools professional.",
    `${persona.full_name} is described as: ${personaDescriptor}.`,
    "Use a refined Scandinavian visual language with clean geometry, subtle gradients, abstract system diagrams, observability motifs, code-inspired patterns, and calm slate, teal, and warm neutral colors.",
    "Keep the left third visually quiet because the LinkedIn profile photo overlays there; concentrate detail in the center-right without becoming busy.",
    "No text, no logos, no watermarks, no people, no clutter."
  ].join(" ");
}

function parseOpenAiImageSize(size: OpenAiImageSize): {
  width: number;
  height: number;
} {
  switch (size) {
    case "1024x1024":
      return { width: 1024, height: 1024 };
    case "1536x1024":
      return { width: 1536, height: 1024 };
    case "1024x1536":
      return { width: 1024, height: 1536 };
  }
}

function validatePostImageCount(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LINKEDIN_PERSONA_POST_IMAGE_COUNT;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      "postImageCount must be a whole number greater than 0."
    );
  }

  if (value > MAX_LINKEDIN_PERSONA_POST_IMAGE_COUNT) {
    throw new LinkedInBuddyError(
      "ACTION_PRECONDITION_FAILED",
      `postImageCount must be ${MAX_LINKEDIN_PERSONA_POST_IMAGE_COUNT} or fewer.`,
      {
        max_post_image_count: MAX_LINKEDIN_PERSONA_POST_IMAGE_COUNT
      }
    );
  }

  return value;
}

function buildImagePlan(
  persona: LinkedInImagePersona,
  postImageCount: number
): PlannedLinkedInImageAsset[] {
  const filePrefix = slugifyPathComponent(persona.slug || persona.full_name);
  const personaDescriptor = buildPersonaDescriptor(persona);
  const plan: PlannedLinkedInImageAsset[] = [
    {
      kind: "profile_photo",
      conceptKey: "profile-photo",
      title: "Profile Photo",
      fileName: `${filePrefix}-profile-photo.png`,
      prompt: buildProfilePhotoPrompt(persona),
      sourceSize: "1024x1024",
      outputWidth: PROFILE_PHOTO_OUTPUT_WIDTH,
      outputHeight: PROFILE_PHOTO_OUTPUT_HEIGHT
    },
    {
      kind: "banner",
      conceptKey: "profile-banner",
      title: "Profile Banner",
      fileName: `${filePrefix}-banner-ai-systems.png`,
      prompt: buildBannerPrompt(persona),
      sourceSize: "1536x1024",
      outputWidth: PROFILE_BANNER_OUTPUT_WIDTH,
      outputHeight: PROFILE_BANNER_OUTPUT_HEIGHT
    }
  ];

  for (let index = 0; index < postImageCount; index += 1) {
    const blueprint = POST_IMAGE_BLUEPRINTS[index]!;
    plan.push({
      kind: "post_image",
      conceptKey: blueprint.key,
      title: blueprint.title,
      fileName: `${filePrefix}-post-${String(index + 1).padStart(2, "0")}-${blueprint.key}.png`,
      prompt: blueprint.createPrompt(persona, personaDescriptor),
      sourceSize: blueprint.size,
      outputWidth: blueprint.width,
      outputHeight: blueprint.height
    });
  }

  return plan;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sampleDelay(baseDelayMs: number): number {
  if (baseDelayMs <= 0) {
    return 0;
  }

  const jitter = Math.max(250, Math.round(baseDelayMs * 0.25));
  const minimum = Math.max(0, baseDelayMs - jitter);
  const maximum = baseDelayMs + jitter;
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function bilinearSample(
  data: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number
): [number, number, number, number] {
  const clampedX = Math.min(Math.max(x, 0), width - 1);
  const clampedY = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.floor(clampedX);
  const y0 = Math.floor(clampedY);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const xWeight = clampedX - x0;
  const yWeight = clampedY - y0;

  const topLeftIndex = (y0 * width + x0) * 4;
  const topRightIndex = (y0 * width + x1) * 4;
  const bottomLeftIndex = (y1 * width + x0) * 4;
  const bottomRightIndex = (y1 * width + x1) * 4;

  const sampleChannel = (offset: number): number => {
    const top =
      data[topLeftIndex + offset]! * (1 - xWeight) +
      data[topRightIndex + offset]! * xWeight;
    const bottom =
      data[bottomLeftIndex + offset]! * (1 - xWeight) +
      data[bottomRightIndex + offset]! * xWeight;
    return Math.round(top * (1 - yWeight) + bottom * yWeight);
  };

  return [
    sampleChannel(0),
    sampleChannel(1),
    sampleChannel(2),
    sampleChannel(3)
  ];
}

function resizePngCover(
  sourcePng: PNG,
  outputWidth: number,
  outputHeight: number
): PNG {
  const destination = new PNG({
    width: outputWidth,
    height: outputHeight
  });
  const sourceAspect = sourcePng.width / sourcePng.height;
  const outputAspect = outputWidth / outputHeight;

  let cropWidth = sourcePng.width;
  let cropHeight = sourcePng.height;
  let offsetX = 0;
  let offsetY = 0;

  if (sourceAspect > outputAspect) {
    cropWidth = sourcePng.height * outputAspect;
    offsetX = (sourcePng.width - cropWidth) / 2;
  } else if (sourceAspect < outputAspect) {
    cropHeight = sourcePng.width / outputAspect;
    offsetY = (sourcePng.height - cropHeight) / 2;
  }

  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      const sourceX = offsetX + ((x + 0.5) / outputWidth) * cropWidth - 0.5;
      const sourceY = offsetY + ((y + 0.5) / outputHeight) * cropHeight - 0.5;
      const [red, green, blue, alpha] = bilinearSample(
        sourcePng.data,
        sourcePng.width,
        sourcePng.height,
        sourceX,
        sourceY
      );
      const destinationIndex = (y * outputWidth + x) * 4;
      destination.data[destinationIndex] = red;
      destination.data[destinationIndex + 1] = green;
      destination.data[destinationIndex + 2] = blue;
      destination.data[destinationIndex + 3] = alpha;
    }
  }

  return destination;
}

function renderOutputPng(
  inputBuffer: Buffer,
  outputWidth: number,
  outputHeight: number
): Buffer {
  const source = PNG.sync.read(inputBuffer);
  const resized = resizePngCover(source, outputWidth, outputHeight);
  return PNG.sync.write(resized);
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildArtifactMetadata(
  plannedAsset: PlannedLinkedInImageAsset,
  revisedPrompt: string | null,
  sha256: string,
  sizeBytes: number
): Record<string, unknown> {
  return {
    concept_key: plannedAsset.conceptKey,
    kind: plannedAsset.kind,
    prompt: plannedAsset.prompt,
    revised_prompt: revisedPrompt,
    sha256,
    size_bytes: sizeBytes,
    width: plannedAsset.outputWidth,
    height: plannedAsset.outputHeight
  };
}

function writeBinaryArtifact(
  artifacts: ArtifactHelpers,
  relativePath: string,
  contents: Buffer,
  metadata: Record<string, unknown>
): string {
  const absolutePath = artifacts.resolve(relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  artifacts.registerArtifact(relativePath, "image/png", metadata);
  return absolutePath;
}

function parseJsonResponseBody(
  value: unknown
): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

async function readOpenAiImageBuffer(
  response: OpenAiImageGenerationResponse
): Promise<{ buffer: Buffer; revisedPrompt: string | null }> {
  const firstImage = response.data?.[0];
  if (!firstImage) {
    throw new LinkedInBuddyError(
      "NETWORK_ERROR",
      "OpenAI image generation returned no images."
    );
  }

  if (typeof firstImage.b64_json === "string" && firstImage.b64_json.length > 0) {
    return {
      buffer: Buffer.from(firstImage.b64_json, "base64"),
      revisedPrompt:
        typeof firstImage.revised_prompt === "string"
          ? firstImage.revised_prompt
          : null
    };
  }

  if (typeof firstImage.url === "string" && firstImage.url.length > 0) {
    const downloadResponse = await fetch(firstImage.url, {
      signal: AbortSignal.timeout(120_000)
    });
    if (!downloadResponse.ok) {
      throw new LinkedInBuddyError(
        "NETWORK_ERROR",
        "OpenAI image download URL could not be fetched.",
        {
          status: downloadResponse.status
        }
      );
    }

    return {
      buffer: Buffer.from(await downloadResponse.arrayBuffer()),
      revisedPrompt:
        typeof firstImage.revised_prompt === "string"
          ? firstImage.revised_prompt
          : null
    };
  }

  throw new LinkedInBuddyError(
    "NETWORK_ERROR",
    "OpenAI image generation returned an unsupported payload."
  );
}

export function buildLinkedInImagePersonaFromProfileSeed(
  input: unknown
): LinkedInImagePersona {
  const root = normalizeRecord(
    input,
    "Image persona seed must be a JSON object."
  );
  const intro = normalizeRecord(
    root.intro,
    'Image persona seed must include an "intro" object.'
  );
  const firstName = readRequiredText(
    intro,
    "firstName",
    'Image persona seed intro must include "firstName".'
  );
  const lastName = readRequiredText(
    intro,
    "lastName",
    'Image persona seed intro must include "lastName".'
  );
  const headline = readRequiredText(
    intro,
    "headline",
    'Image persona seed intro must include "headline".'
  );
  const location = readRequiredText(
    intro,
    "location",
    'Image persona seed intro must include "location".'
  );
  const summary = readRequiredText(
    root,
    "about",
    'Image persona seed must include an "about" summary.'
  );
  const experience = Array.isArray(root.experience) ? root.experience : [];
  const firstExperience =
    experience.length > 0
      ? normalizeRecord(
          experience[0],
          "Image persona seed experience entries must be objects."
        )
      : undefined;
  const skills = readOptionalTextArray(root, "skills");
  const projects = Array.isArray(root.projects)
    ? root.projects
        .map((entry) =>
          normalizeRecord(
            entry,
            "Image persona seed project entries must be objects."
          )
        )
        .map((entry) => readOptionalText(entry, "title"))
        .filter((value): value is string => typeof value === "string")
    : [];
  const focusAreas = [
    ...skills.slice(0, 5),
    ...projects.slice(0, 3)
  ].filter((value, index, values) => values.indexOf(value) === index);
  const currentRole = firstExperience
    ? readOptionalText(firstExperience, "title")
    : undefined;
  const currentCompany = firstExperience
    ? readOptionalText(firstExperience, "company")
    : undefined;

  return {
    slug: slugifyPathComponent(`${firstName}-${lastName}`),
    full_name: `${firstName} ${lastName}`.trim(),
    headline,
    location,
    summary,
    ...(currentRole ? { current_role: currentRole } : {}),
    ...(currentCompany ? { current_company: currentCompany } : {}),
    focus_areas: focusAreas,
    project_titles: projects.slice(0, 5)
  };
}

export class LinkedInImageAssetsService {
  constructor(
    private readonly runtime: LinkedInImageAssetsRuntime,
    private readonly config: OpenAiImageGenerationConfig = {}
  ) {}

  async generatePersonaImageSet(
    input: GenerateLinkedInPersonaImageSetInput
  ): Promise<GeneratedLinkedInPersonaImageSet> {
    const apiKey = this.config.apiKey?.trim();
    if (!apiKey) {
      throw new LinkedInBuddyError(
        "ACTION_PRECONDITION_FAILED",
        "OpenAI image generation requires OPENAI_API_KEY to be configured."
      );
    }

    const postImageCount = validatePostImageCount(input.postImageCount);
    const model =
      input.model?.trim() ||
      this.config.defaultModel?.trim() ||
      DEFAULT_OPENAI_IMAGE_MODEL;
    const baseUrl =
      this.config.baseUrl?.trim() || DEFAULT_OPENAI_IMAGES_BASE_URL;
    const persona = input.persona;
    const generatedAt = new Date().toISOString();
    const timestampSlug = generatedAt.replace(/[:.]/g, "-");
    const bundleRelativeDir = `linkedin-ai-assets/${persona.slug}/${timestampSlug}`;
    const bundleAbsoluteDir = this.runtime.artifacts.resolve(bundleRelativeDir);
    mkdirSync(bundleAbsoluteDir, { recursive: true });

    this.runtime.logger.log("info", "image_assets.generate.start", {
      persona_slug: persona.slug,
      model,
      post_image_count: postImageCount,
      upload_profile_media: Boolean(input.uploadProfileMedia)
    });

    const plan = buildImagePlan(persona, postImageCount);
    const renderedAssets: GeneratedLinkedInImageAsset[] = [];
    let openAiUsage: Record<string, unknown> | undefined;

    for (const plannedAsset of plan) {
      this.runtime.logger.log("info", "image_assets.generate.asset.start", {
        concept_key: plannedAsset.conceptKey,
        kind: plannedAsset.kind,
        size: plannedAsset.sourceSize
      });

      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/images/generations`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          prompt: plannedAsset.prompt,
          size: plannedAsset.sourceSize,
          quality: "high",
          output_format: "png",
          n: 1
        }),
        signal: AbortSignal.timeout(180_000)
      }).catch((error: unknown) => {
        throw new LinkedInBuddyError(
          "NETWORK_ERROR",
          "OpenAI image generation request failed.",
          {
            cause: error instanceof Error ? error.message : String(error),
            concept_key: plannedAsset.conceptKey
          }
        );
      });

      if (!response.ok) {
        const requestId = response.headers.get("x-request-id");
        let responseBody: unknown;
        try {
          responseBody = await response.json();
        } catch {
          responseBody = await response.text();
        }

        const errorPayload = parseJsonResponseBody(responseBody);
        if (response.status === 401) {
          throw new LinkedInBuddyError(
            "ACTION_PRECONDITION_FAILED",
            "OpenAI image generation was rejected. Check OPENAI_API_KEY.",
            {
              status: response.status,
              request_id: requestId,
              response: errorPayload ?? String(responseBody)
            }
          );
        }

        if (response.status === 429) {
          throw new LinkedInBuddyError(
            "RATE_LIMITED",
            "OpenAI image generation is rate limited right now.",
            {
              status: response.status,
              request_id: requestId,
              response: errorPayload ?? String(responseBody)
            }
          );
        }

        throw new LinkedInBuddyError(
          "NETWORK_ERROR",
          "OpenAI image generation failed.",
          {
            status: response.status,
            request_id: requestId,
            response: errorPayload ?? String(responseBody),
            concept_key: plannedAsset.conceptKey
          }
        );
      }

      const responseJson = (await response.json()) as OpenAiImageGenerationResponse;
      if (responseJson.usage && !openAiUsage) {
        openAiUsage = responseJson.usage;
      }

      const { buffer: rawBuffer, revisedPrompt } = await readOpenAiImageBuffer(
        responseJson
      );
      const { width: sourceWidth, height: sourceHeight } = parseOpenAiImageSize(
        plannedAsset.sourceSize
      );
      const renderedBuffer =
        sourceWidth === plannedAsset.outputWidth &&
        sourceHeight === plannedAsset.outputHeight
          ? rawBuffer
          : renderOutputPng(
              rawBuffer,
              plannedAsset.outputWidth,
              plannedAsset.outputHeight
            );
      const relativePath = `${bundleRelativeDir}/${plannedAsset.fileName}`;
      const sha256 = hashBuffer(renderedBuffer);
      const absolutePath = writeBinaryArtifact(
        this.runtime.artifacts,
        relativePath,
        renderedBuffer,
        buildArtifactMetadata(
          plannedAsset,
          revisedPrompt,
          sha256,
          renderedBuffer.byteLength
        )
      );

      renderedAssets.push({
        kind: plannedAsset.kind,
        title: plannedAsset.title,
        concept_key: plannedAsset.conceptKey,
        file_name: plannedAsset.fileName,
        relative_path: relativePath,
        absolute_path: absolutePath,
        mime_type: "image/png",
        width: plannedAsset.outputWidth,
        height: plannedAsset.outputHeight,
        size_bytes: renderedBuffer.byteLength,
        sha256,
        prompt: plannedAsset.prompt,
        revised_prompt: revisedPrompt
      });

      this.runtime.logger.log("info", "image_assets.generate.asset.done", {
        concept_key: plannedAsset.conceptKey,
        kind: plannedAsset.kind,
        relative_path: relativePath
      });
    }

    const profilePhoto = renderedAssets.find(
      (asset) => asset.kind === "profile_photo"
    );
    const banner = renderedAssets.find((asset) => asset.kind === "banner");
    const postImages = renderedAssets.filter(
      (asset) => asset.kind === "post_image"
    );

    if (!profilePhoto || !banner) {
      throw new LinkedInBuddyError(
        "UNKNOWN",
        "Image generation plan did not produce the required profile media."
      );
    }

    let manifest: GeneratedLinkedInPersonaImageSet = {
      generated_at: generatedAt,
      model,
      bundle_relative_dir: bundleRelativeDir,
      bundle_absolute_dir: bundleAbsoluteDir,
      manifest_path: this.runtime.artifacts.resolve(`${bundleRelativeDir}/manifest.json`),
      persona,
      profile_photo: profilePhoto,
      banner,
      post_images: postImages,
      ...(openAiUsage ? { openai_usage: openAiUsage } : {})
    };

    this.runtime.artifacts.writeJson(`${bundleRelativeDir}/manifest.json`, manifest, {
      kind: "linkedin_ai_image_manifest",
      persona_slug: persona.slug,
      model,
      post_image_count: postImages.length
    });

    if (input.uploadProfileMedia) {
      const profileName = input.profileName?.trim() || "default";
      const uploadDelayMs =
        typeof input.uploadDelayMs === "number"
          ? Math.max(0, Math.round(input.uploadDelayMs))
          : DEFAULT_PROFILE_UPLOAD_DELAY_MS;
      const operatorNote =
        input.operatorNote?.trim() || `issue-211 persona images for ${persona.full_name}`;

      this.runtime.logger.log("info", "image_assets.upload_profile_media.start", {
        persona_slug: persona.slug,
        profile_name: profileName
      });

      const preparedPhoto = await this.runtime.profile.prepareUploadPhoto({
        profileName,
        filePath: profilePhoto.absolute_path,
        operatorNote
      });
      const confirmedPhoto = await this.runtime.confirmPreparedAction(
        preparedPhoto.confirmToken
      );

      const photoUploadResult: LinkedInPersonaMediaUploadResult = {
        prepared_action_id: confirmedPhoto.preparedActionId,
        action_type: confirmedPhoto.actionType,
        status: confirmedPhoto.status,
        file_name: profilePhoto.file_name,
        result: confirmedPhoto.result,
        artifacts: confirmedPhoto.artifacts
      };

      const actualDelayMs = sampleDelay(uploadDelayMs);
      if (actualDelayMs > 0) {
        await sleep(actualDelayMs);
      }

      const preparedBanner = await this.runtime.profile.prepareUploadBanner({
        profileName,
        filePath: banner.absolute_path,
        operatorNote
      });
      const confirmedBanner = await this.runtime.confirmPreparedAction(
        preparedBanner.confirmToken
      );

      const bannerUploadResult: LinkedInPersonaMediaUploadResult = {
        prepared_action_id: confirmedBanner.preparedActionId,
        action_type: confirmedBanner.actionType,
        status: confirmedBanner.status,
        file_name: banner.file_name,
        result: confirmedBanner.result,
        artifacts: confirmedBanner.artifacts
      };

      manifest = {
        ...manifest,
        upload_results: {
          profile_photo: photoUploadResult,
          banner: bannerUploadResult
        }
      };

      this.runtime.artifacts.writeJson(`${bundleRelativeDir}/manifest.json`, manifest, {
        kind: "linkedin_ai_image_manifest",
        persona_slug: persona.slug,
        model,
        uploaded_profile_media: true,
        post_image_count: postImages.length
      });

      this.runtime.logger.log("info", "image_assets.upload_profile_media.done", {
        persona_slug: persona.slug,
        profile_name: profileName
      });
    }

    this.runtime.logger.log("info", "image_assets.generate.done", {
      persona_slug: persona.slug,
      bundle_relative_dir: bundleRelativeDir,
      post_image_count: postImages.length
    });

    return manifest;
  }
}
