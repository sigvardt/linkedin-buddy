import { type Page } from "playwright-core";
import type { LinkedInAuthService } from "./auth/session.js";
import { LinkedInBuddyError, asLinkedInBuddyError } from "./errors.js";
import type { LinkedInFeedService } from "./linkedinFeed.js";
import type { JsonEventLogger } from "./logging.js";
import { waitForNetworkIdleBestEffort } from "./pageLoad.js";
import type { ProfileManager } from "./profileManager.js";
import { normalizeText, getOrCreatePage, isAbsoluteUrl } from "./shared.js";

export const LINKEDIN_ANALYTICS_SURFACES = [
  "profile_views",
  "search_appearances",
  "content_metrics",
  "post_metrics",
] as const;

export type LinkedInAnalyticsSurface =
  (typeof LINKEDIN_ANALYTICS_SURFACES)[number];

export type LinkedInAnalyticsMetricUnit = "count" | "percent" | "unknown";
export type LinkedInAnalyticsMetricTrend = "up" | "down" | "flat" | "unknown";

export interface LinkedInAnalyticsMetric {
  metric_key: string;
  label: string;
  value: number | null;
  value_text: string;
  delta_value: number | null;
  delta_text: string | null;
  unit: LinkedInAnalyticsMetricUnit;
  trend: LinkedInAnalyticsMetricTrend;
  observed_at: string;
}

export interface LinkedInAnalyticsCard {
  card_key: string;
  title: string;
  description: string;
  href: string | null;
  metrics: LinkedInAnalyticsMetric[];
}

export interface LinkedInAnalyticsSummary {
  surface: Exclude<LinkedInAnalyticsSurface, "post_metrics">;
  source_url: string;
  observed_at: string;
  metrics: LinkedInAnalyticsMetric[];
  cards: LinkedInAnalyticsCard[];
}

export interface LinkedInPostMetricsSummary {
  surface: "post_metrics";
  source_url: string;
  observed_at: string;
  metrics: LinkedInAnalyticsMetric[];
  cards: LinkedInAnalyticsCard[];
  post: {
    post_id: string;
    post_url: string;
    author_name: string;
    author_headline: string;
    posted_at: string;
    text: string;
  };
}

export interface ReadAnalyticsInput {
  profileName?: string;
}

export interface ReadContentMetricsInput extends ReadAnalyticsInput {
  limit?: number;
}

export interface ReadPostMetricsInput extends ReadAnalyticsInput {
  postUrl: string;
}

export interface LinkedInAnalyticsRuntime {
  auth: LinkedInAuthService;
  cdpUrl?: string | undefined;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
  feed: Pick<LinkedInFeedService, "viewPost">;
}

interface AnalyticsMetricDraft {
  label: string;
  valueText: string;
  deltaText: string | null;
}

interface AnalyticsCardSnapshot {
  title: string;
  description: string;
  href: string | null;
  lines: string[];
}

const LINKEDIN_SELF_PROFILE_URL = "https://www.linkedin.com/in/me/";
const PROFILE_VIEW_KEYWORDS = [
  "profile view",
  "who viewed",
  "viewed your profile",
] as const;
const SEARCH_APPEARANCES_KEYWORDS = ["search appearance"] as const;
const CONTENT_METRICS_KEYWORDS = [
  "impression",
  "content",
  "engagement",
  "creator analytics",
] as const;
const CONTENT_METRICS_NEGATIVE_KEYWORDS = [
  ...PROFILE_VIEW_KEYWORDS,
  ...SEARCH_APPEARANCES_KEYWORDS,
] as const;
const IGNORED_ANALYTICS_LINES = new Set([
  "private to you",
  "only visible to you",
]);

export function readAnalyticsLimit(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.floor(value), 50));
}

export function toAbsoluteLinkedInUrl(
  value: string | null | undefined,
): string | null {
  const href = normalizeText(value);
  if (!href) {
    return null;
  }

  if (isAbsoluteUrl(href)) {
    return href;
  }

  return href.startsWith("/")
    ? `https://www.linkedin.com${href}`
    : `https://www.linkedin.com/${href}`;
}

export function toLinkedInAnalyticsMetricKey(label: string): string {
  const normalized = normalizeText(label).toLowerCase();
  if (!normalized) {
    return "metric";
  }

  return normalized
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

export function parseLinkedInAnalyticsNumber(value: string): number | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const tokenMatch = /[+-]?\d[\d.,\s]*(?:[KMBT])?\s*%?/i.exec(normalized);
  const token = normalizeText(tokenMatch?.[0]);
  if (!token) {
    return null;
  }

  const isPercent = token.includes("%");
  const suffixMatch = /([KMBT])\s*%?$/i.exec(token);
  const suffix = suffixMatch?.[1]?.toUpperCase() ?? "";
  const magnitude =
    suffix === "K"
      ? 1_000
      : suffix === "M"
        ? 1_000_000
        : suffix === "B"
          ? 1_000_000_000
          : suffix === "T"
            ? 1_000_000_000_000
            : 1;

  let numeric = token.replace(/[KMBT%]/gi, "").replace(/\s+/g, "");
  if (!numeric) {
    return null;
  }

  const lastComma = numeric.lastIndexOf(",");
  const lastDot = numeric.lastIndexOf(".");

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      numeric = numeric.replace(/\./g, "").replace(",", ".");
    } else {
      numeric = numeric.replace(/,/g, "");
    }
  } else if (lastComma >= 0) {
    const decimalDigits = numeric.length - lastComma - 1;
    numeric =
      decimalDigits > 0 && decimalDigits <= 2
        ? numeric.replace(",", ".")
        : numeric.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const decimalDigits = numeric.length - lastDot - 1;
    numeric =
      decimalDigits === 3 && !suffix && !isPercent
        ? numeric.replace(/\./g, "")
        : numeric;
  }

  const parsed = Number(numeric);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return parsed * magnitude;
}

export function inferAnalyticsMetricUnit(
  label: string,
  valueText: string,
): LinkedInAnalyticsMetricUnit {
  if (valueText.includes("%") || /\brate\b|\bpercent\b/i.test(label)) {
    return "percent";
  }

  return parseLinkedInAnalyticsNumber(valueText) === null ? "unknown" : "count";
}

export function inferAnalyticsMetricTrend(
  value: string | null | undefined,
): LinkedInAnalyticsMetricTrend {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return "unknown";
  }

  if (
    normalized.startsWith("+") ||
    /\b(up|increase|increased|higher|grew|growth)\b/.test(normalized)
  ) {
    return "up";
  }

  if (
    normalized.startsWith("-") ||
    /\b(down|decrease|decreased|lower|declined|drop)\b/.test(normalized)
  ) {
    return "down";
  }

  if (/\b(flat|same|unchanged|steady)\b/.test(normalized)) {
    return "flat";
  }

  return "unknown";
}

function extractMetricValueToken(value: string): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const match = /[+-]?\d[\d.,\s]*(?:[KMBT])?\s*%?/i.exec(normalized);
  return normalizeText(match?.[0]);
}

function isDeltaLikeLine(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith("+") || normalized.startsWith("-")) {
    return true;
  }

  return /\b(up|down|increase|decrease|past|last|vs\.?)\b/i.test(normalized);
}

function createMetricDraft(
  line: string,
  fallbackLabel: string,
): AnalyticsMetricDraft | null {
  const normalized = normalizeText(line);
  const valueText = extractMetricValueToken(normalized);
  if (!valueText) {
    return null;
  }

  const label =
    normalizeText(normalized.replace(valueText, "")) || fallbackLabel;
  return {
    label,
    valueText,
    deltaText: null,
  };
}

function buildAnalyticsMetric(
  draft: AnalyticsMetricDraft,
  observedAt: string,
): LinkedInAnalyticsMetric {
  const label = normalizeText(draft.label) || "Metric";
  const metricKey = toLinkedInAnalyticsMetricKey(label);
  const unit = inferAnalyticsMetricUnit(label, draft.valueText);

  return {
    metric_key: metricKey,
    label,
    value: parseLinkedInAnalyticsNumber(draft.valueText),
    value_text: normalizeText(draft.valueText),
    delta_value:
      draft.deltaText === null
        ? null
        : parseLinkedInAnalyticsNumber(draft.deltaText),
    delta_text: draft.deltaText,
    unit,
    trend: inferAnalyticsMetricTrend(draft.deltaText),
    observed_at: observedAt,
  };
}

function buildCardMetricsFromLines(
  title: string,
  lines: string[],
  observedAt: string,
): LinkedInAnalyticsMetric[] {
  const cleanedLines = lines
    .map((line) => normalizeText(line))
    .filter((line) => line.length > 0)
    .filter((line) => line.toLowerCase() !== normalizeText(title).toLowerCase())
    .filter((line) => !IGNORED_ANALYTICS_LINES.has(line.toLowerCase()));

  const drafts: AnalyticsMetricDraft[] = [];

  for (const line of cleanedLines) {
    if (isDeltaLikeLine(line) && drafts.length > 0) {
      const previous = drafts[drafts.length - 1];
      if (previous && previous.deltaText === null) {
        previous.deltaText = line;
        continue;
      }
    }

    const draft = createMetricDraft(line, title);
    if (draft) {
      drafts.push(draft);
    }
  }

  return drafts.map((draft) => buildAnalyticsMetric(draft, observedAt));
}

function cardTextHaystack(card: LinkedInAnalyticsCard): string {
  return [
    card.card_key,
    card.title,
    card.description,
    card.href ?? "",
    ...card.metrics.map((metric) => metric.label),
  ]
    .join(" ")
    .toLowerCase();
}

export function matchesAnalyticsCard(
  card: LinkedInAnalyticsCard,
  keywords: readonly string[],
  negativeKeywords: readonly string[] = [],
): boolean {
  const haystack = cardTextHaystack(card);
  if (
    negativeKeywords.some((keyword) => haystack.includes(keyword.toLowerCase()))
  ) {
    return false;
  }

  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

async function waitForAnalyticsSurface(page: Page): Promise<void> {
  await page
    .locator("main")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
  await waitForNetworkIdleBestEffort(page);
}

/* eslint-disable no-undef -- DOM types are valid inside page.evaluate() */
async function extractProfileAnalyticsCardSnapshots(
  page: Page,
): Promise<AnalyticsCardSnapshot[]> {
  return page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();

    const splitLines = (value: string): string[] =>
      value
        .split(/\n+/)
        .map((line) => normalize(line))
        .filter((line) => line.length > 0);

    const toAbsoluteHref = (
      value: string | null | undefined,
    ): string | null => {
      const href = normalize(value);
      if (!href) {
        return null;
      }

      try {
        return new URL(href, globalThis.window.location.origin).toString();
      } catch {
        return href;
      }
    };

    const readInnerText = (element: Element): string => {
      return element instanceof HTMLElement
        ? normalize(element.innerText)
        : normalize(element.textContent);
    };

    const readTitle = (element: Element, lines: string[]): string => {
      const heading = normalize(
        element.querySelector("h1, h2, h3, h4, strong, dt")?.textContent,
      );
      if (heading) {
        return heading;
      }

      return lines[0] ?? "";
    };

    const relevantPattern =
      /(profile views?|who viewed|viewed your profile|search appearances?|impressions?|content|engagement|analytics)/i;
    const relevantHrefPattern = /(analytics|profile-view|search-appear)/i;
    const candidates = Array.from(
      document.querySelectorAll("a[href], button, article, li"),
    ).filter((element) => {
      const text = readInnerText(element);
      if (!text || text.length > 400) {
        return false;
      }

      const href = normalize(
        element instanceof HTMLAnchorElement
          ? element.href
          : element.getAttribute("href"),
      );

      return relevantPattern.test(text) || relevantHrefPattern.test(href);
    });

    const deduped = new Map<string, AnalyticsCardSnapshot>();
    for (const candidate of candidates) {
      const text = readInnerText(candidate);
      const lines = splitLines(text);
      if (lines.length === 0) {
        continue;
      }

      const title = readTitle(candidate, lines);
      const href = toAbsoluteHref(
        candidate instanceof HTMLAnchorElement
          ? candidate.href
          : candidate.getAttribute("href"),
      );
      const description = lines
        .filter((line) => line !== title)
        .filter((line) => !/\d/.test(line))
        .join(" ");

      const snapshot: AnalyticsCardSnapshot = {
        title,
        description,
        href,
        lines,
      };
      const dedupeKey = `${title.toLowerCase()}|${href ?? ""}`;
      const existing = deduped.get(dedupeKey);
      if (
        !existing ||
        existing.lines.join(" ").length < lines.join(" ").length
      ) {
        deduped.set(dedupeKey, snapshot);
      }
    }

    return Array.from(deduped.values());
  });
}
/* eslint-enable no-undef -- DOM types are valid inside page.evaluate() */

function toAnalyticsCards(
  snapshots: AnalyticsCardSnapshot[],
  observedAt: string,
): LinkedInAnalyticsCard[] {
  return snapshots
    .map((snapshot) => {
      const title = normalizeText(snapshot.title);
      const description = normalizeText(snapshot.description);
      const metrics = buildCardMetricsFromLines(
        title,
        snapshot.lines,
        observedAt,
      );
      return {
        card_key: toLinkedInAnalyticsMetricKey(title),
        title,
        description,
        href: toAbsoluteLinkedInUrl(snapshot.href),
        metrics,
      } satisfies LinkedInAnalyticsCard;
    })
    .filter((card) => card.title.length > 0)
    .filter((card) => card.metrics.length > 0);
}

async function loadProfileAnalyticsCards(
  runtime: LinkedInAnalyticsRuntime,
  profileName: string,
): Promise<{
  sourceUrl: string;
  observedAt: string;
  cards: LinkedInAnalyticsCard[];
}> {
  await runtime.auth.ensureAuthenticated({
    profileName,
    cdpUrl: runtime.cdpUrl,
  });

  return runtime.profileManager.runWithContext(
    {
      cdpUrl: runtime.cdpUrl,
      profileName,
      headless: true,
    },
    async (context) => {
      const page = await getOrCreatePage(context);
      await page.goto(LINKEDIN_SELF_PROFILE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await waitForAnalyticsSurface(page);
      const observedAt = new Date().toISOString();
      const cards = toAnalyticsCards(
        await extractProfileAnalyticsCardSnapshots(page),
        observedAt,
      );
      return {
        sourceUrl: page.url(),
        observedAt,
        cards,
      };
    },
  );
}

export function ensureMatchingCards(
  surface: LinkedInAnalyticsSurface,
  cards: LinkedInAnalyticsCard[],
  availableCards: LinkedInAnalyticsCard[],
): LinkedInAnalyticsCard[] {
  if (cards.length > 0) {
    return cards;
  }

  throw new LinkedInBuddyError(
    "UI_CHANGED_SELECTOR_FAILED",
    `Could not locate LinkedIn analytics cards for ${surface}.`,
    {
      surface,
      available_card_titles: availableCards.map((card) => card.title),
    },
  );
}

function buildSummary(
  surface: Exclude<LinkedInAnalyticsSurface, "post_metrics">,
  sourceUrl: string,
  observedAt: string,
  cards: LinkedInAnalyticsCard[],
): LinkedInAnalyticsSummary {
  return {
    surface,
    source_url: sourceUrl,
    observed_at: observedAt,
    metrics: cards.flatMap((card) => card.metrics),
    cards,
  };
}

export class LinkedInAnalyticsService {
  constructor(private readonly runtime: LinkedInAnalyticsRuntime) {}

  private resolveProfileName(profileName: string | undefined): string {
    const normalizedProfileName = normalizeText(profileName);
    return normalizedProfileName || "default";
  }

  private async fetchProfileSurface(input: {
    surface: Exclude<LinkedInAnalyticsSurface, "post_metrics">;
    profileName: string | undefined;
    selectCards: (cards: LinkedInAnalyticsCard[]) => LinkedInAnalyticsCard[];
    errorMessage: string;
  }): Promise<LinkedInAnalyticsSummary> {
    const profileName = this.resolveProfileName(input.profileName);

    try {
      const { sourceUrl, observedAt, cards } = await loadProfileAnalyticsCards(
        this.runtime,
        profileName,
      );
      const matchedCards = ensureMatchingCards(
        input.surface,
        input.selectCards(cards),
        cards,
      );

      return buildSummary(input.surface, sourceUrl, observedAt, matchedCards);
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }

      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        `${input.errorMessage} (profileName: ${profileName}).`,
      );
    }
  }

  async getProfileViews(
    input: ReadAnalyticsInput = {},
  ): Promise<LinkedInAnalyticsSummary> {
    return this.fetchProfileSurface({
      surface: "profile_views",
      profileName: input.profileName,
      selectCards: (cards) =>
        cards.filter((card) =>
          matchesAnalyticsCard(card, PROFILE_VIEW_KEYWORDS),
        ),
      errorMessage: "Failed to read LinkedIn profile view analytics.",
    });
  }

  async getSearchAppearances(
    input: ReadAnalyticsInput = {},
  ): Promise<LinkedInAnalyticsSummary> {
    return this.fetchProfileSurface({
      surface: "search_appearances",
      profileName: input.profileName,
      selectCards: (cards) =>
        cards.filter((card) =>
          matchesAnalyticsCard(card, SEARCH_APPEARANCES_KEYWORDS),
        ),
      errorMessage: "Failed to read LinkedIn search appearance analytics.",
    });
  }

  async getContentMetrics(
    input: ReadContentMetricsInput = {},
  ): Promise<LinkedInAnalyticsSummary> {
    const limit = readAnalyticsLimit(input.limit, 4);

    return this.fetchProfileSurface({
      surface: "content_metrics",
      profileName: input.profileName,
      selectCards: (cards) => {
        const directMatches = cards.filter((card) =>
          matchesAnalyticsCard(
            card,
            CONTENT_METRICS_KEYWORDS,
            CONTENT_METRICS_NEGATIVE_KEYWORDS,
          ),
        );
        const fallbackMatches = cards.filter(
          (card) =>
            !matchesAnalyticsCard(card, PROFILE_VIEW_KEYWORDS) &&
            !matchesAnalyticsCard(card, SEARCH_APPEARANCES_KEYWORDS),
        );
        const matchedCards =
          directMatches.length > 0
            ? directMatches.slice(0, limit)
            : fallbackMatches.slice(0, limit);

        return matchedCards;
      },
      errorMessage: "Failed to read LinkedIn content analytics.",
    });
  }

  async getPostMetrics(
    input: ReadPostMetricsInput,
  ): Promise<LinkedInPostMetricsSummary> {
    const profileName = this.resolveProfileName(input.profileName);

    try {
      const post = await this.runtime.feed.viewPost({
        profileName,
        postUrl: input.postUrl,
      });
      const observedAt = new Date().toISOString();
      const metrics = [
        {
          label: "Reactions",
          valueText: post.reactions_count,
        },
        {
          label: "Comments",
          valueText: post.comments_count,
        },
        {
          label: "Reposts",
          valueText: post.reposts_count,
        },
      ]
        .map((entry) => ({
          metric_key: toLinkedInAnalyticsMetricKey(entry.label),
          label: entry.label,
          value: parseLinkedInAnalyticsNumber(entry.valueText),
          value_text: normalizeText(entry.valueText),
          delta_value: null,
          delta_text: null,
          unit: inferAnalyticsMetricUnit(entry.label, entry.valueText),
          trend: "unknown" as const,
          observed_at: observedAt,
        }))
        .filter(
          (metric) => metric.value_text.length > 0 || metric.value !== null,
        );

      const engagementTotal = metrics.reduce((total, metric) => {
        return metric.value === null ? total : total + metric.value;
      }, 0);

      const cards: LinkedInAnalyticsCard[] = [
        {
          card_key: "post_engagement",
          title: "Post engagement",
          description:
            "Read from the live LinkedIn post surface and normalized for downstream automation.",
          href: post.post_url,
          metrics: [
            ...metrics,
            {
              metric_key: "engagement_total",
              label: "Engagement total",
              value: engagementTotal,
              value_text: String(engagementTotal),
              delta_value: null,
              delta_text: null,
              unit: "count",
              trend: "unknown",
              observed_at: observedAt,
            },
          ],
        },
      ];

      return {
        surface: "post_metrics",
        source_url: post.post_url,
        observed_at: observedAt,
        metrics: cards.flatMap((card) => card.metrics),
        cards,
        post: {
          post_id: normalizeText(post.post_id),
          post_url: normalizeText(post.post_url),
          author_name: normalizeText(post.author_name),
          author_headline: normalizeText(post.author_headline),
          posted_at: normalizeText(post.posted_at),
          text: normalizeText(post.text),
        },
      };
    } catch (error) {
      if (error instanceof LinkedInBuddyError) {
        throw error;
      }

      throw asLinkedInBuddyError(
        error,
        "UNKNOWN",
        `Failed to read LinkedIn post metrics. (profileName: ${profileName}).`,
      );
    }
  }
}
