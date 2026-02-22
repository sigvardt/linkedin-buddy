#!/usr/bin/env -S npx tsx
/**
 * Integration test runner for LinkedIn CLI against a live CDP browser.
 *
 * READ-ONLY operations only. No likes, comments, invites, messages.
 *
 * Usage:
 *   npx tsx scripts/integration-test.ts
 *
 * Requires: Chrome at CDP port 18800 with LinkedIn authenticated.
 * Writes results to /tmp/linkedin-integration-results.md
 */

import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const CDP_URL = "http://127.0.0.1:18800";
const RESULTS_PATH = "/tmp/linkedin-integration-results.md";
const OWN_PROFILE = "me";
const OTHER_PROFILE = "simonmillercph"; // Simon Miller

interface TestResult {
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  duration: number;
  details: string;
  error?: string;
}

const results: TestResult[] = [];

async function runTest(
  name: string,
  fn: () => Promise<string>
): Promise<void> {
  const start = Date.now();
  try {
    const details = await fn();
    results.push({
      name,
      status: "PASS",
      duration: Date.now() - start,
      details,
    });
    console.log(`  ✅ ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    results.push({
      name,
      status: "FAIL",
      duration: Date.now() - start,
      details: "",
      error: errMsg,
    });
    console.log(`  ❌ ${name} (${Date.now() - start}ms): ${errMsg}`);
  }
}

function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log("LinkedIn Integration Tests (READ-ONLY)");
  console.log(`CDP: ${CDP_URL}`);
  console.log("---");

  // Verify CDP connection
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    console.log(
      `Connected to CDP — ${browser.contexts().length} context(s)\n`
    );
  } catch (e) {
    console.error(`Failed to connect to CDP at ${CDP_URL}:`, e);
    process.exit(1);
  }

  const context = browser.contexts()[0];
  if (!context) {
    console.error("No browser context found on CDP connection");
    await browser.close();
    process.exit(1);
  }

  // ── Test 1: Auth Status ───────────────────────────────
  await runTest("Auth Status Check", async () => {
    const page = await context.newPage();
    try {
      await page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded",
      });
      await humanDelay(1500, 3000);

      const url = page.url();
      const isLoginPage =
        url.includes("/login") || url.includes("/checkpoint");
      const navVisible = await page
        .locator("nav.global-nav")
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false);

      if (isLoginPage) {
        throw new Error(`Not authenticated — redirected to ${url}`);
      }

      if (!navVisible) {
        throw new Error(
          `Global nav not visible (URL: ${url}) — session may be expired`
        );
      }

      return `Authenticated. URL: ${url}, nav visible: ${navVisible}`;
    } finally {
      await page.close();
    }
  });

  await humanDelay(2000, 4000);

  // ── Test 2: View Own Profile ──────────────────────────
  await runTest("View Own Profile", async () => {
    const page = await context.newPage();
    try {
      await page.goto("https://www.linkedin.com/in/me/", {
        waitUntil: "domcontentloaded",
      });
      await humanDelay(2000, 4000);
      await page.waitForLoadState("networkidle").catch(() => undefined);

      const h1 = await page
        .locator("h1")
        .first()
        .textContent({ timeout: 10_000 })
        .catch(() => null);
      const name = h1?.replace(/\s+/g, " ").trim() ?? "(not found)";

      const headline = await page
        .locator(".text-body-medium")
        .first()
        .textContent({ timeout: 5_000 })
        .catch(() => null);
      const headlineText = headline?.replace(/\s+/g, " ").trim() ?? "(not found)";

      const location = await page
        .locator("span.text-body-small[data-anonymize='location']")
        .first()
        .textContent({ timeout: 5_000 })
        .catch(() => null);
      const locationText = location?.replace(/\s+/g, " ").trim() ?? "(not found)";

      if (!name || name === "(not found)") {
        throw new Error("Could not extract own profile name");
      }

      return `Name: ${name} | Headline: ${headlineText} | Location: ${locationText}`;
    } finally {
      await page.close();
    }
  });

  await humanDelay(2000, 4000);

  // ── Test 3: View Other Profile (Simon Miller) ─────────
  await runTest("View Profile: Simon Miller", async () => {
    const page = await context.newPage();
    try {
      await page.goto(
        `https://www.linkedin.com/in/${OTHER_PROFILE}/`,
        { waitUntil: "domcontentloaded" }
      );
      await humanDelay(2000, 4000);
      await page.waitForLoadState("networkidle").catch(() => undefined);

      const h1 = await page
        .locator("h1")
        .first()
        .textContent({ timeout: 10_000 })
        .catch(() => null);
      const name = h1?.replace(/\s+/g, " ").trim() ?? "(not found)";

      const headline = await page
        .locator(".text-body-medium")
        .first()
        .textContent({ timeout: 5_000 })
        .catch(() => null);
      const headlineText = headline?.replace(/\s+/g, " ").trim() ?? "(not found)";

      if (!name || name === "(not found)") {
        throw new Error("Could not extract Simon Miller's profile name");
      }

      return `Name: ${name} | Headline: ${headlineText}`;
    } finally {
      await page.close();
    }
  });

  await humanDelay(2000, 4000);

  // ── Test 4: Connection List ───────────────────────────
  await runTest("Connection List", async () => {
    const page = await context.newPage();
    try {
      await page.goto(
        "https://www.linkedin.com/mynetwork/invite-connect/connections/",
        { waitUntil: "domcontentloaded" }
      );
      await humanDelay(2000, 4000);
      await page.waitForLoadState("networkidle").catch(() => undefined);

      // Wait for connection cards to appear
      await page
        .locator(
          "li.mn-connection-card, li.reusable-search-simple-insight, div.mn-connection-card"
        )
        .first()
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => undefined);

      const count = await page.evaluate(() => {
        return document.querySelectorAll(
          "li.mn-connection-card, li.reusable-search-simple-insight, div.mn-connection-card, li[class*='mn-connection-card']"
        ).length;
      });

      if (count === 0) {
        throw new Error("No connection cards found on connections page");
      }

      // Extract first few names
      const names = await page.evaluate(() => {
        const cards = Array.from(
          document.querySelectorAll(
            "li.mn-connection-card, li.reusable-search-simple-insight, div.mn-connection-card"
          )
        ).slice(0, 5);
        return cards.map((card) => {
          const nameEl =
            card.querySelector(".mn-connection-card__name") ??
            card.querySelector(
              ".entity-result__title-text a span[aria-hidden='true']"
            ) ??
            card.querySelector(
              "span.mn-connection-card__name"
            ) ??
            card.querySelector("a[href*='/in/'] span[aria-hidden='true']");
          return (nameEl?.textContent ?? "").replace(/\s+/g, " ").trim();
        }).filter(Boolean);
      });

      return `Found ${count} connections. First 5: ${names.join(", ") || "(could not extract names)"}`;
    } finally {
      await page.close();
    }
  });

  await humanDelay(2000, 4000);

  // ── Test 5: Feed ──────────────────────────────────────
  await runTest("Feed View", async () => {
    const page = await context.newPage();
    try {
      await page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded",
      });
      await humanDelay(2000, 5000);
      await page.waitForLoadState("networkidle").catch(() => undefined);

      // Wait for feed posts
      const feedSelectors = [
        "[data-urn]",
        ".feed-shared-update-v2",
        ".occludable-update",
      ];
      let feedFound = false;
      for (const sel of feedSelectors) {
        try {
          await page
            .locator(sel)
            .first()
            .waitFor({ state: "visible", timeout: 5_000 });
          feedFound = true;
          break;
        } catch {
          // next
        }
      }

      if (!feedFound) {
        throw new Error("No feed posts found on LinkedIn feed page");
      }

      // Count posts and extract first author
      const postData = await page.evaluate(() => {
        const cards = Array.from(
          document.querySelectorAll(
            "[data-urn], div.feed-shared-update-v2, div.occludable-update"
          )
        );
        const unique = new Set<Element>();
        for (const c of cards) {
          const root =
            c.closest(
              "div[data-urn], div.feed-shared-update-v2, div.occludable-update"
            ) ?? c;
          unique.add(root);
        }
        const count = unique.size;

        const firstCard = Array.from(unique)[0];
        let firstAuthor = "";
        if (firstCard) {
          const actorRoot =
            firstCard.querySelector(
              ".update-components-actor, .feed-shared-actor"
            ) ?? firstCard;
          const nameEl = actorRoot.querySelector(
            ".update-components-actor__name, .feed-shared-actor__name"
          );
          firstAuthor = (nameEl?.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim();
        }

        return { count, firstAuthor };
      });

      return `Found ${postData.count} feed posts. First author: ${postData.firstAuthor || "(could not extract)"}`;
    } finally {
      await page.close();
    }
  });

  // ── Done ──────────────────────────────────────────────
  await browser.close(); // Just disconnects CDP

  // Write results
  const timestamp = new Date().toISOString();
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;

  let md = `# LinkedIn Integration Test Results\n\n`;
  md += `**Date:** ${timestamp}\n`;
  md += `**CDP:** ${CDP_URL}\n`;
  md += `**Summary:** ${passed} passed, ${failed} failed, ${skipped} skipped out of ${results.length} tests\n\n`;

  md += `## Results\n\n`;
  md += `| # | Test | Status | Duration | Details |\n`;
  md += `|---|------|--------|----------|---------|\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const statusEmoji = r.status === "PASS" ? "✅" : r.status === "FAIL" ? "❌" : "⏭️";
    const details = r.status === "FAIL" ? `**Error:** ${r.error}` : r.details;
    md += `| ${i + 1} | ${r.name} | ${statusEmoji} ${r.status} | ${r.duration}ms | ${details} |\n`;
  }

  md += `\n## Test Descriptions\n\n`;
  md += `1. **Auth Status Check** — Navigate to feed, verify authenticated session (global nav visible, no login redirect)\n`;
  md += `2. **View Own Profile** — Navigate to /in/me/, extract name, headline, location\n`;
  md += `3. **View Profile: Simon Miller** — Navigate to /in/${OTHER_PROFILE}/, extract name and headline\n`;
  md += `4. **Connection List** — Navigate to connections page, count connection cards, extract first 5 names\n`;
  md += `5. **Feed View** — Navigate to feed, verify posts load, extract first author name\n`;

  md += `\n## Notes\n\n`;
  md += `- All tests are READ-ONLY (no likes, comments, invites, messages)\n`;
  md += `- Human-like delays (1.5-5s) between tests to avoid bot detection\n`;
  md += `- Each test opens a new page and closes it after to avoid cross-test state\n`;
  md += `- CDP connection mode: browser.close() only disconnects CDP, does not close the browser\n`;

  writeFileSync(RESULTS_PATH, md);
  console.log(`\n---`);
  console.log(`Results: ${passed}/${results.length} passed`);
  console.log(`Written to ${RESULTS_PATH}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Integration test runner failed:", error);
  process.exit(1);
});
