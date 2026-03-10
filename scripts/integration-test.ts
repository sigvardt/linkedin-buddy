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
const OTHER_PROFILE_VANITY =
  process.env.LINKEDIN_INTEGRATION_TARGET_VANITY ?? "realsimonmiller";
const OTHER_PROFILE_DISPLAY =
  process.env.LINKEDIN_INTEGRATION_TARGET_DISPLAY ?? "Simon Miller";
const EXPECTED_OWN_NAME_SUBSTRING =
  process.env.LINKEDIN_INTEGRATION_EXPECTED_OWN_NAME_SUBSTRING?.trim().toLowerCase() ?? "";
const OWN_PROFILE_VANITY =
  process.env.LINKEDIN_INTEGRATION_OWN_PROFILE_VANITY?.trim() ?? "";

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
      await humanDelay(3000, 5000);

      const url = page.url();
      const isLoginPage =
        url.includes("/login") || url.includes("/checkpoint");

      if (isLoginPage) {
        throw new Error(`Not authenticated — redirected to ${url}`);
      }

      // Check for nav element (LinkedIn uses <nav> or <header> for top bar)
      const navVisible = await page
        .locator("nav")
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false);
      const headerVisible = await page
        .locator("header")
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false);

      // Verify we have profile-related content (own profile link)
      const hasProfileLink = await page.evaluate(() => {
        return document.querySelectorAll('a[href*="/in/"]').length > 0;
      });

      if (!navVisible && !headerVisible) {
        throw new Error(
          `No navigation visible (URL: ${url}) — session may be expired`
        );
      }

      return `Authenticated. URL: ${url}, nav: ${navVisible}, header: ${headerVisible}, profile links: ${hasProfileLink}`;
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
      await humanDelay(3000, 5000);

      // Wait for h1 (name) to appear
      const h1 = await page
        .locator("h1")
        .first()
        .textContent({ timeout: 15_000 })
        .catch(() => null);
      const name = h1?.replace(/\s+/g, " ").trim() ?? "(not found)";

      // Extract headline (look for text near the name)
      const headlineText = await page.evaluate(() => {
        // LinkedIn profile headline is usually near h1
        const h1 = document.querySelector("h1");
        if (!h1) return "(not found)";
        const parent = h1.closest("section") ?? h1.parentElement?.parentElement?.parentElement;
        if (!parent) return "(not found)";
        
        // Look for text elements after name
        const textEls = parent.querySelectorAll("div, span");
        for (const el of textEls) {
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          if (text.length > 10 && text.length < 200 && text !== name && !text.includes(name ?? "")) {
            // Skip elements that are just wrappers
            if (el.children.length > 2) continue;
            return text;
          }
        }
        return "(not found)";
      });

      if (!name || name === "(not found)") {
        throw new Error("Could not extract own profile name");
      }

      const matchesExpectedName =
        EXPECTED_OWN_NAME_SUBSTRING.length === 0
          ? "skipped"
          : String(name.toLowerCase().includes(EXPECTED_OWN_NAME_SUBSTRING));

      return `Name: ${name} | Headline: ${headlineText} | Expected-name match: ${matchesExpectedName}`;
    } finally {
      await page.close();
    }
  });

  await humanDelay(2000, 4000);

  // ── Test 3: View Other Profile ─────────────────────────
  await runTest(`View Profile: ${OTHER_PROFILE_DISPLAY}`, async () => {
    const page = await context.newPage();
    try {
      await page.goto(
        `https://www.linkedin.com/in/${OTHER_PROFILE_VANITY}/`,
        { waitUntil: "domcontentloaded" }
      );
      await humanDelay(3000, 5000);

      // Check we didn't get 404
      const url = page.url();
      if (url.includes("/404")) {
        throw new Error(`Profile not found (404) for ${OTHER_PROFILE_VANITY}`);
      }

      const h1 = await page
        .locator("h1")
        .first()
        .textContent({ timeout: 15_000 })
        .catch(() => null);
      const name = h1?.replace(/\s+/g, " ").trim() ?? "(not found)";

      if (!name || name === "(not found)") {
        throw new Error(`Could not extract profile name for ${OTHER_PROFILE_VANITY}`);
      }

      return `Name: ${name} | URL: ${url}`;
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
      await humanDelay(3000, 5000);

      // Wait for profile links to appear in the connections list
      await page
        .locator("a[href*='/in/']")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => undefined);

      // Extract connection data using profile links as anchors
      const connectionData = await page.evaluate((ownProfileVanity) => {
        // Find all profile links with text content (connection names)
        const links = Array.from(document.querySelectorAll("a[href*='/in/']"));
        const seen = new Set<string>();
        const connections: Array<{ name: string; vanity: string; url: string }> = [];

        for (const link of links) {
          const href = (link as HTMLAnchorElement).href.split("?")[0] ?? "";
          const text = (link.textContent ?? "").replace(/\s+/g, " ").trim();
          
          // Skip own profile links and empty text links
          if (!text || text.length < 3 || seen.has(href)) continue;
          // Skip links that look like they're part of nav/sidebar
          if (href.includes("/in/me")) continue;
          if (ownProfileVanity && href.includes(`/in/${ownProfileVanity}`)) continue;
          
          const vanityMatch = /\/in\/([^/]+)/.exec(href);
          if (!vanityMatch?.[1]) continue;

          seen.add(href);
          connections.push({
            name: text.slice(0, 60),
            vanity: vanityMatch[1],
            url: href,
          });
        }

        return connections;
      }, OWN_PROFILE_VANITY);

      if (connectionData.length === 0) {
        throw new Error("No connection profile links found on connections page");
      }

      // Check page title/heading for total count
      const totalText = await page.evaluate(() => {
        const body = document.body.textContent ?? "";
        const match = /([\d,]+)\s+connections?/i.exec(body);
        return match ? match[0] : "(count not found)";
      });

      const first5 = connectionData.slice(0, 5).map(c => c.name).join(", ");
      return `${totalText}. Found ${connectionData.length} on page. First 5: ${first5}`;
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
      await humanDelay(3000, 6000);

      // Wait for any sign of feed content
      // LinkedIn's new DOM uses role="listitem" for feed posts, or comment buttons, or profile links
      let feedLoaded = false;

      // Try: wait for comment/repost buttons (indicates posts are present)
      try {
        await page
          .locator("button")
          .filter({ hasText: /comment/i })
          .first()
          .waitFor({ state: "visible", timeout: 8_000 });
        feedLoaded = true;
      } catch {
        // Try: wait for feed update links
        try {
          await page
            .locator("a[href*='/feed/update/']")
            .first()
            .waitFor({ state: "visible", timeout: 5_000 });
          feedLoaded = true;
        } catch {
          // Try: just check for any profile links in the main content
          const linkCount = await page.evaluate(
            () => document.querySelectorAll("a[href*='/in/']").length
          );
          feedLoaded = linkCount > 3; // More than sidebar links
        }
      }

      if (!feedLoaded) {
        throw new Error("No feed content detected on LinkedIn feed page");
      }

      // Extract feed data using profile links and content
      const feedData = await page.evaluate((ownProfileVanity) => {
        // Find unique authors from /in/ links (excluding own profile)
        const links = Array.from(document.querySelectorAll("a[href*='/in/']"));
        const seen = new Set<string>();
        const authors: string[] = [];

        for (const link of links) {
          const href = (link as HTMLAnchorElement).href.split("?")[0] ?? "";
          const text = (link.textContent ?? "").replace(/\s+/g, " ").trim();
          if (!text || text.length < 3 || seen.has(href)) continue;
          if (href.includes("/in/me")) continue;
          if (ownProfileVanity && href.includes(`/in/${ownProfileVanity}`)) continue;

          seen.add(href);
          authors.push(text.slice(0, 50));
        }

        // Count feed update links (each post may have one)
        const feedUpdateLinks = document.querySelectorAll("a[href*='/feed/update/']").length;
        
        // Count comment buttons (each post has one)
        const commentBtns = Array.from(document.querySelectorAll("button")).filter(
          btn => /comment/i.test(btn.textContent ?? "")
        ).length;

        return {
          authorCount: authors.length,
          firstAuthors: authors.slice(0, 3),
          feedUpdateLinks,
          commentBtns,
        };
      }, OWN_PROFILE_VANITY);

      return `Feed loaded. ${feedData.commentBtns} posts with comment buttons, ${feedData.feedUpdateLinks} update links, ${feedData.authorCount} unique authors. First: ${feedData.firstAuthors.join(", ") || "(none)"}`;
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
  md += `**Authenticated as:** current browser session profile\n`;
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
  md += `1. **Auth Status Check** — Navigate to feed, verify authenticated session (nav/header visible, no login redirect)\n`;
  md += `2. **View Own Profile** — Navigate to /in/me/, extract name and headline, and optionally compare against LINKEDIN_INTEGRATION_EXPECTED_OWN_NAME_SUBSTRING\n`;
  md += `3. **View Profile: ${OTHER_PROFILE_DISPLAY}** — Navigate to /in/${OTHER_PROFILE_VANITY}/, extract name\n`;
  md += `4. **Connection List** — Navigate to connections page, count connections, extract first names\n`;
  md += `5. **Feed View** — Navigate to feed, detect posts via comment buttons/update links, extract authors\n`;

  md += `\n## Notes\n\n`;
  md += `- All tests are **READ-ONLY** (no likes, comments, invites, messages)\n`;
  md += `- Human-like delays (2-6s) between tests to avoid bot detection\n`;
  md += `- Each test opens a new page and closes it after to avoid cross-test state leakage\n`;
  md += `- CDP connection mode: browser.close() only disconnects CDP, does not close the browser\n`;
  md += `- LinkedIn has migrated to CSS modules with obfuscated class names — tests use semantic/ARIA selectors\n`;

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
