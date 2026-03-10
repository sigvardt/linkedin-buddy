import { describe, expect, it } from "vitest";
import type {
  JsonLogEntry,
  LinkedInBuddyErrorPayload,
  SelectorAuditReport
} from "@linkedin-buddy/core";
import {
  formatSelectorAuditError,
  formatSelectorAuditReport,
  resolveSelectorAuditOutputMode,
  SelectorAuditProgressReporter
} from "../src/selectorAuditOutput.js";

function createLogEntry(entry: {
  event: string;
  payload: Record<string, unknown>;
}): JsonLogEntry {
  return {
    ts: "2026-03-08T12:00:00.000Z",
    run_id: "run_test",
    level: "info",
    event: entry.event,
    payload: entry.payload
  };
}

function createSelectorAuditReportFixture(): SelectorAuditReport {
  return {
    run_id: "run_test",
    profile_name: "default",
    checked_at: "2026-03-08T12:00:00.000Z",
    outcome: "fail",
    summary:
      "Checked 3 selector groups across 2 pages. 2 passed. 1 failed. 1 used fallback selectors.",
    total_count: 3,
    pass_count: 2,
    fail_count: 1,
    fallback_count: 1,
    artifact_dir: "/tmp/run_test/selector-audit",
    report_path: "/tmp/run_test/selector-audit/report.json",
    page_summaries: [
      {
        page: "feed",
        total_count: 2,
        pass_count: 1,
        fail_count: 1,
        fallback_count: 1
      },
      {
        page: "inbox",
        total_count: 1,
        pass_count: 1,
        fail_count: 0,
        fallback_count: 0
      }
    ],
    page_warnings: [
      {
        page: "feed",
        warnings: [
          "The feed page did not reach network idle within 5000ms. Selector checks continued with the current DOM state."
        ]
      }
    ],
    failed_selectors: [
      {
        page: "feed",
        page_url: "https://www.linkedin.com/feed/",
        selector_key: "post_composer_trigger",
        description: "Feed post composer trigger",
        error:
          "No selector strategy matched for post_composer_trigger on feed. Review the failure artifacts, update the selector registry if LinkedIn's UI changed, and rerun the selector audit.",
        warnings: [
          "The feed page did not reach network idle within 5000ms. Selector checks continued with the current DOM state."
        ],
        failure_artifacts: {
          screenshot_path: "/tmp/run_test/selector-audit/feed/post_composer_trigger.png",
          dom_snapshot_path: "/tmp/run_test/selector-audit/feed/post_composer_trigger.html",
          accessibility_snapshot_path:
            "/tmp/run_test/selector-audit/feed/post_composer_trigger.a11y.json",
          capture_warnings: [
            "Could not capture the DOM snapshot for post_composer_trigger on feed: Snapshot unavailable."
          ]
        },
        recommended_action:
          "Open the captured failure artifacts for post_composer_trigger on feed, update that selector group in the registry, and rerun the selector audit."
      }
    ],
    fallback_selectors: [
      {
        page: "feed",
        page_url: "https://www.linkedin.com/feed/",
        selector_key: "feed_sort_menu",
        description: "Feed sort menu",
        fallback_strategy: "secondary",
        fallback_used: "css-feed-sort-menu",
        recommended_action:
          "Primary selectors did not match for feed_sort_menu on feed. Review the primary selector and keep css-feed-sort-menu (secondary) only if it reflects the stable LinkedIn UI."
      }
    ],
    recommended_actions: [
      "Open /tmp/run_test/selector-audit/report.json and the captured artifacts for failed selector groups before changing the registry.",
      "Update the selector registry entries for the failed selector groups, then rerun linkedin audit selectors --profile default.",
      "Review selector groups that only matched via fallback and refresh their primary selectors before they fail completely.",
      "Some pages were not fully stable during the audit. Refresh the LinkedIn session or attached browser and rerun before treating warnings as definitive UI drift."
    ],
    results: [
      {
        page: "feed",
        page_url: "https://www.linkedin.com/feed/",
        selector_key: "post_composer_trigger",
        description: "Feed post composer trigger",
        status: "fail",
        matched_strategy: null,
        matched_selector_key: null,
        fallback_used: null,
        fallback_strategy: null,
        strategies: {
          primary: {
            strategy: "primary",
            status: "fail",
            selector_key: "role-button-start-post",
            selector_hint: "getByRole(button, /start a post/i)",
            error: "Selector not visible"
          },
          secondary: {
            strategy: "secondary",
            status: "fail",
            selector_key: "css-start-post",
            selector_hint: ".share-box-feed-entry__trigger",
            error: "Selector not visible"
          },
          tertiary: {
            strategy: "tertiary",
            status: "fail",
            selector_key: "text-start-post",
            selector_hint: "text=Start a post",
            error: "Selector not visible"
          }
        },
        failure_artifacts: {
          screenshot_path: "/tmp/run_test/selector-audit/feed/post_composer_trigger.png",
          dom_snapshot_path: "/tmp/run_test/selector-audit/feed/post_composer_trigger.html",
          accessibility_snapshot_path:
            "/tmp/run_test/selector-audit/feed/post_composer_trigger.a11y.json",
          capture_warnings: [
            "Could not capture the DOM snapshot for post_composer_trigger on feed: Snapshot unavailable."
          ]
        },
        warnings: [
          "The feed page did not reach network idle within 5000ms. Selector checks continued with the current DOM state."
        ],
        error:
          "No selector strategy matched for post_composer_trigger on feed. Review the failure artifacts, update the selector registry if LinkedIn's UI changed, and rerun the selector audit."
      },
      {
        page: "feed",
        page_url: "https://www.linkedin.com/feed/",
        selector_key: "feed_sort_menu",
        description: "Feed sort menu",
        status: "pass",
        matched_strategy: "secondary",
        matched_selector_key: "css-feed-sort-menu",
        fallback_used: "css-feed-sort-menu",
        fallback_strategy: "secondary",
        strategies: {
          primary: {
            strategy: "primary",
            status: "fail",
            selector_key: "role-feed-sort-menu",
            selector_hint: "getByRole(button, /sort/i)",
            error: "Selector not visible"
          },
          secondary: {
            strategy: "secondary",
            status: "pass",
            selector_key: "css-feed-sort-menu",
            selector_hint: ".feed-sort-menu"
          },
          tertiary: {
            strategy: "tertiary",
            status: "fail",
            selector_key: "text-feed-sort-menu",
            selector_hint: "text=Sort",
            error: "Selector not visible"
          }
        },
        failure_artifacts: {}
      },
      {
        page: "inbox",
        page_url: "https://www.linkedin.com/messaging/",
        selector_key: "thread_list",
        description: "Inbox thread list",
        status: "pass",
        matched_strategy: "primary",
        matched_selector_key: "role-thread-list",
        fallback_used: null,
        fallback_strategy: null,
        strategies: {
          primary: {
            strategy: "primary",
            status: "pass",
            selector_key: "role-thread-list",
            selector_hint: "getByRole(list, /conversation/i)"
          },
          secondary: {
            strategy: "secondary",
            status: "fail",
            selector_key: "css-thread-list",
            selector_hint: ".msg-conversations-container__conversations-list",
            error: "Selector not visible"
          },
          tertiary: {
            strategy: "tertiary",
            status: "fail",
            selector_key: "text-thread-list",
            selector_hint: "text=Conversations",
            error: "Selector not visible"
          }
        },
        failure_artifacts: {}
      }
    ]
  };
}

describe("selector audit output helpers", () => {
  it("defaults to human output in interactive terminals unless JSON is forced", () => {
    expect(resolveSelectorAuditOutputMode({ json: false }, true)).toBe("human");
    expect(resolveSelectorAuditOutputMode({ json: false }, false)).toBe("json");
    expect(resolveSelectorAuditOutputMode({ json: true }, true)).toBe("json");
  });

  it("renders a scannable human-readable report", () => {
    const output = formatSelectorAuditReport(createSelectorAuditReportFixture());

    expect(output).toContain("Selector Audit: FAIL");
    expect(output).toContain(
      "Summary: Checked 3 selector groups across 2 pages. 2 passed. 1 failed. 1 used fallback selectors."
    );
    expect(output).toContain("Pages");
    expect(output).toContain("Failures");
    expect(output).toContain("Fallbacks");
    expect(output).toContain("Warnings");
    expect(output).toContain("Next Steps");
    expect(output).toContain("Artifacts: /tmp/run_test/selector-audit");
    expect(output).toContain("screenshot=/tmp/run_test/selector-audit/feed/post_composer_trigger.png");
  });

  it("adds selector-by-selector detail in verbose mode", () => {
    const output = formatSelectorAuditReport(createSelectorAuditReportFixture(), {
      verbose: true
    });

    expect(output).toContain("Selector Details");
    expect(output).toContain("FAIL feed/post_composer_trigger — Feed post composer trigger");
    expect(output).toContain("Strategies: primary=FAIL, secondary=FAIL, tertiary=FAIL");
    expect(output).toContain("WARN feed/feed_sort_menu — Feed sort menu");
    expect(output).toContain("Matched via secondary: css-feed-sort-menu");
  });

  it("formats friendly human-facing errors", () => {
    const payload: LinkedInBuddyErrorPayload = {
      code: "NETWORK_ERROR",
      message: "Could not load the feed page because the browser or network connection failed.",
      details: {
        page: "feed",
        page_url: "https://www.linkedin.com/feed/"
      }
    };

    const output = formatSelectorAuditError(payload);

    expect(output).toContain("Selector audit failed [NETWORK_ERROR]");
    expect(output).toContain("page=feed");
    expect(output).toContain("Tip: rerun with --json");
  });

  it("emits clear per-page progress lines", () => {
    const lines: string[] = [];
    const reporter = new SelectorAuditProgressReporter({
      writeLine: (line) => {
        lines.push(line);
      }
    });

    reporter.handleLog(
      createLogEntry({
        event: "selector.audit.start",
        payload: {
          profileName: "default",
          pageCount: 2
        }
      })
    );
    reporter.handleLog(
      createLogEntry({
        event: "selector.audit.page.start",
        payload: {
          page: "feed",
          selectorCount: 2
        }
      })
    );
    reporter.handleLog(
      createLogEntry({
        event: "selector.audit.page.done",
        payload: {
          page: "feed",
          passCount: 1,
          failCount: 1,
          fallbackCount: 1
        }
      })
    );
    reporter.handleLog(
      createLogEntry({
        event: "selector.audit.done",
        payload: {
          reportPath: "/tmp/run_test/selector-audit/report.json"
        }
      })
    );

    expect(lines).toEqual([
      "Starting selector audit for profile default (2 pages).",
      "Checking page 1/2: feed (2 selector groups)...",
      "Finished page 1/2: feed — 1 passed, 1 failed, 1 fallback.",
      "Selector audit finished. Report: /tmp/run_test/selector-audit/report.json"
    ]);
  });
});
