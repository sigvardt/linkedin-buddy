import { type BrowserContext, type Page } from "playwright-core";
import type { LinkedInAuthService } from "./auth/session.js";
import { LinkedInAssistantError, asLinkedInAssistantError } from "./errors.js";
import type { JsonEventLogger } from "./logging.js";
import type { ProfileManager } from "./profileManager.js";

export interface LinkedInExperience {
  title: string;
  company: string;
  duration: string;
  location: string;
  description: string;
}

export interface LinkedInEducation {
  school: string;
  degree: string;
  field_of_study: string;
  dates: string;
}

export interface LinkedInProfile {
  profile_url: string;
  vanity_name: string | null;
  full_name: string;
  headline: string;
  location: string;
  about: string;
  connection_degree: string;
  experience: LinkedInExperience[];
  education: LinkedInEducation[];
}

export interface ViewProfileInput {
  profileName?: string;
  target?: string;
}

export interface LinkedInProfileRuntime {
  auth: LinkedInAuthService;
  profileManager: ProfileManager;
  logger: JsonEventLogger;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function resolveProfileUrl(target: string | undefined): string {
  const trimmedTarget = normalizeText(target);
  if (!trimmedTarget || trimmedTarget.toLowerCase() === "me") {
    return "https://www.linkedin.com/in/me/";
  }

  if (isAbsoluteUrl(trimmedTarget)) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmedTarget);
    } catch (error) {
      throw asLinkedInAssistantError(
        error,
        "ACTION_PRECONDITION_FAILED",
        "Profile URL must be a valid URL."
      );
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const isLinkedInDomain =
      hostname === "linkedin.com" || hostname.endsWith(".linkedin.com");
    if (!isLinkedInDomain || !parsedUrl.pathname.startsWith("/in/")) {
      throw new LinkedInAssistantError(
        "ACTION_PRECONDITION_FAILED",
        "Profile URL must point to linkedin.com/in/.",
        { target: trimmedTarget }
      );
    }

    return trimmedTarget;
  }

  if (trimmedTarget.startsWith("/in/")) {
    return `https://www.linkedin.com${trimmedTarget}`;
  }

  return `https://www.linkedin.com/in/${encodeURIComponent(trimmedTarget)}/`;
}

async function getOrCreatePage(context: BrowserContext): Promise<Page> {
  const existing = context.pages()[0];
  if (existing) {
    return existing;
  }
  return context.newPage();
}

/* eslint-disable no-undef -- DOM types (ParentNode, Element) are valid inside page.evaluate() */
async function extractProfileData(page: Page): Promise<LinkedInProfile> {
  const extracted = await page.evaluate(() => {
    const normalize = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const emptyProfile = {
      profile_url: globalThis.window.location.href,
      vanity_name: null,
      full_name: "",
      headline: "",
      location: "",
      about: "",
      connection_degree: "",
      experience: [],
      education: []
    };

    const pickText = (
      selectors: string[],
      root: ParentNode = globalThis.document
    ): string => {
      for (const selector of selectors) {
        const text = normalize(root.querySelector(selector)?.textContent);
        if (text) {
          return text;
        }
      }
      return "";
    };

    const pickList = (
      selectors: string[],
      root: ParentNode = globalThis.document
    ): string[] => {
      for (const selector of selectors) {
        const values = Array.from(root.querySelectorAll(selector))
          .map((node) => normalize(node.textContent))
          .filter((value) => value.length > 0);
        if (values.length > 0) {
          return values;
        }
      }
      return [];
    };

    const findSectionRoot = (id: string, label: string): Element | null => {
      const byId = globalThis.document.querySelector(`#${id}`);
      if (byId) {
        return byId.closest("section") ?? byId;
      }

      const sections = Array.from(
        globalThis.document.querySelectorAll("section, div.pv-profile-card")
      );
      for (const section of sections) {
        const heading = normalize(
          section.querySelector("h2, h3, .pvs-header__title")?.textContent
        );
        if (heading.toLowerCase().includes(label.toLowerCase())) {
          return section;
        }
      }

      return null;
    };

    const collectSectionItems = (sectionRoot: Element | null): Element[] => {
      if (!sectionRoot) {
        return [];
      }

      const itemSelectors = [
        ".pvs-list__paged-list-item",
        ".pvs-list__item--line-separated",
        "li.artdeco-list__item",
        "li[class*='pvs-list__item']"
      ];
      for (const selector of itemSelectors) {
        const items = Array.from(sectionRoot.querySelectorAll(selector));
        if (items.length > 0) {
          return items;
        }
      }

      return Array.from(sectionRoot.querySelectorAll("li"));
    };

    const textLooksLikeDuration = (value: string): boolean =>
      /\b(present|\d+\s*(?:yr|yrs|year|years|mo|mos|month|months))\b/i.test(
        value
      );

    try {
      const vanityMatch = /\/in\/([^/]+)/.exec(
        globalThis.window.location.pathname
      );
      const vanityNameRaw = vanityMatch?.[1];
      let vanityName: string | null = null;
      if (vanityNameRaw) {
        try {
          vanityName = decodeURIComponent(vanityNameRaw);
        } catch {
          vanityName = vanityNameRaw;
        }
      }

      const nameSelectors = [
        "h1.text-heading-xlarge",
        "h1[class*='text-heading']",
        "h1"
      ];
      const fullName = pickText(nameSelectors);
      const nameElement =
        globalThis.document.querySelector("h1.text-heading-xlarge") ??
        globalThis.document.querySelector("h1[class*='text-heading']") ??
        globalThis.document.querySelector("h1");
      const headerContainer =
        nameElement?.closest(".pv-text-details__left-panel") ??
        nameElement?.parentElement?.parentElement ??
        nameElement?.closest("section") ??
        globalThis.document;

      let headline = pickText(
        [
          ".text-body-medium[data-anonymize='headline']",
          ".text-body-medium"
        ],
        headerContainer
      );
      if (!headline) {
        headline = pickText([
          ".text-body-medium[data-anonymize='headline']",
          ".text-body-medium"
        ]);
      }

      let location = pickText(
        [
          "span.text-body-small[data-anonymize='location']",
          ".text-body-small.inline"
        ],
        headerContainer
      );
      if (!location) {
        location = pickText([
          "span.text-body-small[data-anonymize='location']",
          ".text-body-small.inline"
        ]);
      }

      let about = pickText([
        "#about .inline-show-more-text span[aria-hidden='true']",
        "#about .inline-show-more-text",
        "#about ~ .display-flex .inline-show-more-text span[aria-hidden='true']",
        "#about ~ .display-flex .inline-show-more-text"
      ]);

      if (!about) {
        const sections = Array.from(
          globalThis.document.querySelectorAll("section, div")
        );
        for (const section of sections) {
          const heading = normalize(
            section.querySelector("h2, h3, .pvs-header__title")?.textContent
          );
          if (!heading || !heading.toLowerCase().includes("about")) {
            continue;
          }

          about = pickText(
            [
              ".inline-show-more-text span[aria-hidden='true']",
              ".inline-show-more-text",
              ".pv-shared-text-with-see-more",
              "p"
            ],
            section
          );
          if (about) {
            break;
          }
        }
      }

      let connectionDegree = pickText([
        ".dist-value",
        ".distance-badge",
        "[class*='distance']"
      ]);

      if (!connectionDegree) {
        const bodyText = normalize(globalThis.document.body?.textContent);
        const degreeMatch = /\b(1st|2nd|3rd\+?)\b/i.exec(bodyText);
        connectionDegree = degreeMatch ? normalize(degreeMatch[1]) : "";
      }

      const experienceSection = findSectionRoot("experience", "experience");
      const experience = collectSectionItems(experienceSection)
        .map((item) => {
          const lines = pickList(
            [
              ".t-bold span[aria-hidden='true']",
              ".t-normal span[aria-hidden='true']",
              ".pvs-entity__caption-wrapper span[aria-hidden='true']",
              ".pvs-entity__description-wrapper span[aria-hidden='true']",
              ".inline-show-more-text span[aria-hidden='true']"
            ],
            item
          );

          const title =
            pickText(
              [
                ".t-bold span[aria-hidden='true']",
                ".t-bold",
                "[data-field='title']"
              ],
              item
            ) ?? "";
          const company =
            pickText(
              [
                ".t-normal span[aria-hidden='true']",
                ".pv-entity__secondary-title",
                "[data-field='company']"
              ],
              item
            ) ?? "";
          let duration = pickText(
            [
              ".pvs-entity__caption-wrapper[aria-hidden='true']",
              ".pv-entity__date-range span:nth-child(2)",
              "[data-field='date-range']"
            ],
            item
          );
          if (!duration) {
            duration =
              lines.find((line) => textLooksLikeDuration(line) && line !== company) ??
              "";
          }

          let itemLocation = pickText(
            [
              ".pvs-entity__caption-wrapper + .pvs-entity__caption-wrapper span[aria-hidden='true']",
              ".pv-entity__location span:nth-child(2)",
              "[data-field='location']"
            ],
            item
          );
          if (!itemLocation) {
            itemLocation =
              lines.find(
                (line) =>
                  line !== title &&
                  line !== company &&
                  line !== duration &&
                  !textLooksLikeDuration(line)
              ) ?? "";
          }

          const description = pickText(
            [
              ".pvs-entity__description-wrapper span[aria-hidden='true']",
              ".inline-show-more-text span[aria-hidden='true']",
              ".inline-show-more-text"
            ],
            item
          );

          return {
            title,
            company,
            duration,
            location: itemLocation,
            description
          };
        })
        .filter(
          (item) =>
            item.title ||
            item.company ||
            item.duration ||
            item.location ||
            item.description
        );

      const educationSection = findSectionRoot("education", "education");
      const education = collectSectionItems(educationSection)
        .map((item) => {
          const lines = pickList(
            [
              ".t-bold span[aria-hidden='true']",
              ".t-normal span[aria-hidden='true']",
              ".pvs-entity__caption-wrapper span[aria-hidden='true']"
            ],
            item
          );

          const school =
            pickText(
              [
                ".t-bold span[aria-hidden='true']",
                ".pv-entity__school-name",
                "[data-field='school']"
              ],
              item
            ) ?? "";
          const degree =
            pickText(
              [
                ".t-normal span[aria-hidden='true']",
                ".pv-entity__degree-name span:nth-child(2)",
                "[data-field='degree']"
              ],
              item
            ) ?? "";
          const fieldOfStudy =
            pickText(
              [".pv-entity__fos span:nth-child(2)", "[data-field='field_of_study']"],
              item
            ) ?? "";
          let dates = pickText(
            [
              ".pvs-entity__caption-wrapper[aria-hidden='true']",
              ".pv-entity__dates span:nth-child(2)",
              "[data-field='dates']"
            ],
            item
          );
          if (!dates) {
            dates = lines.find(textLooksLikeDuration) ?? "";
          }

          return {
            school,
            degree,
            field_of_study: fieldOfStudy,
            dates
          };
        })
        .filter((item) => item.school || item.degree || item.field_of_study || item.dates);

      return {
        profile_url: globalThis.window.location.href,
        vanity_name: vanityName,
        full_name: fullName,
        headline,
        location,
        about,
        connection_degree: connectionDegree,
        experience,
        education
      };
    } catch {
      return emptyProfile;
    }
  });

  return {
    profile_url: normalizeText(extracted.profile_url),
    vanity_name: extracted.vanity_name
      ? normalizeText(extracted.vanity_name)
      : null,
    full_name: normalizeText(extracted.full_name),
    headline: normalizeText(extracted.headline),
    location: normalizeText(extracted.location),
    about: normalizeText(extracted.about),
    connection_degree: normalizeText(extracted.connection_degree),
    experience: extracted.experience.map((item) => ({
      title: normalizeText(item.title),
      company: normalizeText(item.company),
      duration: normalizeText(item.duration),
      location: normalizeText(item.location),
      description: normalizeText(item.description)
    })),
    education: extracted.education.map((item) => ({
      school: normalizeText(item.school),
      degree: normalizeText(item.degree),
      field_of_study: normalizeText(item.field_of_study),
      dates: normalizeText(item.dates)
    }))
  };
}
/* eslint-enable no-undef */

export class LinkedInProfileService {
  constructor(private readonly runtime: LinkedInProfileRuntime) {}

  async viewProfile(input: ViewProfileInput): Promise<LinkedInProfile> {
    const profileName = input.profileName ?? "default";
    const profileUrl = resolveProfileUrl(input.target);

    await this.runtime.auth.ensureAuthenticated({ profileName });

    try {
      return await this.runtime.profileManager.runWithPersistentContext(
        profileName,
        { headless: true },
        async (context) => {
          const page = await getOrCreatePage(context);
          await page.goto(profileUrl, { waitUntil: "domcontentloaded" });
          await page.waitForLoadState("networkidle");
          await page
            .locator("h1")
            .first()
            .waitFor({ state: "visible", timeout: 10_000 })
            .catch(() => undefined);
          return extractProfileData(page);
        }
      );
    } catch (error) {
      if (error instanceof LinkedInAssistantError) {
        throw error;
      }
      throw asLinkedInAssistantError(
        error,
        "UNKNOWN",
        "Failed to view LinkedIn profile."
      );
    }
  }
}
