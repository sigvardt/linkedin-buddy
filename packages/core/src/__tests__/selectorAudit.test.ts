import { stat } from "node:fs/promises";
import { errors as playwrightErrors, type Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  LINKEDIN_SELECTOR_AUDIT_PAGES,
  LINKEDIN_SELECTOR_AUDIT_STRATEGIES,
  LinkedInSelectorAuditService,
  createLinkedInSelectorAuditRegistry,
  type LinkedInSelectorAuditRuntime,
  type SelectorAuditCandidate
} from "../selectorAudit.js";
import {
  cleanupSelectorAuditTestHarnesses,
  createSelectorAuditCandidate,
  createSelectorAuditPageDefinition,
  createSelectorAuditSelectorDefinition,
  createSelectorAuditTestHarness
} from "./selectorAuditTestUtils.js";

afterEach(async () => {
  await cleanupSelectorAuditTestHarnesses();
});

function summarizeRegistryShape(
  registry: ReturnType<typeof createLinkedInSelectorAuditRegistry>
): Array<{
  page: string;
  selectors: Array<{
    key: string;
    candidates: Array<{ key: string; strategy: string }>;
  }>;
}> {
  return registry.map((pageDefinition) => ({
    page: pageDefinition.page,
    selectors: pageDefinition.selectors.map((selectorDefinition) => ({
      key: selectorDefinition.key,
      candidates: selectorDefinition.candidates.map((candidate) => ({
        key: candidate.key,
        strategy: candidate.strategy
      }))
    }))
  }));
}

function createRoleMatchingPage(
  accessibleNamesByRole: Readonly<Record<string, readonly string[]>>
): Page {
  return {
    getByRole: (role: string, options?: { name?: unknown }) =>
      ({
        waitFor: async () => {
          const nameMatcher = options?.name;
          if (!(nameMatcher instanceof RegExp)) {
            throw new Error(
              "Expected selector audit role candidates to compile regex name matchers."
            );
          }

          const accessibleNames = accessibleNamesByRole[role] ?? [];
          if (!accessibleNames.some((accessibleName) => nameMatcher.test(accessibleName))) {
            throw new Error(
              `No ${role} accessible name matched /${nameMatcher.source}/i.`
            );
          }
        }
      })
  } as unknown as Page;
}

describe("createLinkedInSelectorAuditRegistry", () => {
  it("covers the audit-scope pages with normalized strategies", () => {
    const registry = createLinkedInSelectorAuditRegistry();

    expect(registry.map((pageDefinition) => pageDefinition.page)).toEqual([
      ...LINKEDIN_SELECTOR_AUDIT_PAGES
    ]);

    for (const pageDefinition of registry) {
      expect(pageDefinition.selectors.length).toBeGreaterThan(0);

      for (const selectorDefinition of pageDefinition.selectors) {
        expect(selectorDefinition.description.length).toBeGreaterThan(0);
        expect(selectorDefinition.candidates.map((candidate) => candidate.strategy)).toEqual([
          ...LINKEDIN_SELECTOR_AUDIT_STRATEGIES
        ]);

        for (const candidate of selectorDefinition.candidates) {
          expect(candidate.key.length).toBeGreaterThan(0);
          expect(candidate.selectorHint.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("builds locale-aware selector hints with english fallback", () => {
    const registry = createLinkedInSelectorAuditRegistry("da");
    const feedDefinition = registry.find((pageDefinition) => pageDefinition.page === "feed");
    const primaryCandidate = feedDefinition?.selectors[0]?.candidates[0];

    expect(primaryCandidate?.selectorHint).toContain("Start et opslag");
    expect(primaryCandidate?.selectorHint).toContain("Start a post");
  });

  it("preserves selector keys and candidate ordering across locales", () => {
    const englishRegistry = createLinkedInSelectorAuditRegistry("en");
    const danishRegistry = createLinkedInSelectorAuditRegistry("da");

    expect(summarizeRegistryShape(danishRegistry)).toEqual(
      summarizeRegistryShape(englishRegistry)
    );
  });

  it("resolves localized and english fallback accessible names in the same candidate", async () => {
    const registry = createLinkedInSelectorAuditRegistry("da");
    const feedDefinition = registry.find((pageDefinition) => pageDefinition.page === "feed");
    const primaryCandidate = feedDefinition?.selectors
      .find((selectorDefinition) => selectorDefinition.key === "post_composer_trigger")
      ?.candidates.find((candidate) => candidate.strategy === "primary");

    expect(primaryCandidate).toBeDefined();

    const localizedPage = createRoleMatchingPage({
      button: ["Start et opslag"]
    });
    const englishFallbackPage = createRoleMatchingPage({
      button: ["Start a post"]
    });
    const unsupportedLocalePage = createRoleMatchingPage({
      button: ["Partager une publication"]
    });

    await expect(primaryCandidate!.locatorFactory(localizedPage).waitFor()).resolves.toBeUndefined();
    await expect(
      primaryCandidate!.locatorFactory(englishFallbackPage).waitFor()
    ).resolves.toBeUndefined();
    await expect(
      primaryCandidate!.locatorFactory(unsupportedLocalePage).waitFor()
    ).rejects.toThrow("No button accessible name matched");
  });
});

describe("LinkedInSelectorAuditService", () => {
  it("marks fallback usage when secondary selector is the first passing strategy", async () => {
    const { service } = await createSelectorAuditTestHarness({
      visibleSelectors: ["secondary", "tertiary"]
    });

    const report = await service.auditSelectors({ profileName: "default" });

    expect(report.total_count).toBe(1);
    expect(report.pass_count).toBe(1);
    expect(report.fail_count).toBe(0);
    expect(report.fallback_count).toBe(1);
    expect(report.outcome).toBe("pass_with_fallbacks");
    expect(report.summary).toBe(
      "Checked 1 selector group across 1 page. 1 passed. 0 failed. 1 used fallback selectors."
    );
    expect(report.page_summaries).toEqual([
      {
        page: "feed",
        total_count: 1,
        pass_count: 1,
        fail_count: 0,
        fallback_count: 1
      }
    ]);
    expect(report.results[0]).toMatchObject({
      page: "feed",
      selector_key: "selector_group",
      status: "pass",
      matched_strategy: "secondary",
      matched_selector_key: "secondary-key",
      fallback_used: "secondary-key",
      fallback_strategy: "secondary"
    });
    expect(report.results[0]?.strategies.primary.status).toBe("fail");
    expect(report.results[0]?.strategies.secondary.status).toBe("pass");
    expect(report.failed_selectors).toEqual([]);
    expect(report.page_warnings).toEqual([]);
    expect(report.fallback_selectors).toMatchObject([
      {
        page: "feed",
        selector_key: "selector_group",
        description: "Selector group",
        fallback_strategy: "secondary",
        fallback_used: "secondary-key"
      }
    ]);
    expect(report.fallback_selectors[0]?.recommended_action).toContain(
      "Primary selectors did not match"
    );
    expect(report.recommended_actions).toEqual([
      "Review selector groups that only matched via fallback and refresh their primary selectors before they fail completely."
    ]);
    await expect(stat(report.report_path)).resolves.toBeTruthy();
  });

  it("captures failure artifacts when no selector strategy matches", async () => {
    const { service } = await createSelectorAuditTestHarness();

    const report = await service.auditSelectors({ profileName: "default" });
    const [result] = report.results;

    expect(report.total_count).toBe(1);
    expect(report.pass_count).toBe(0);
    expect(report.fail_count).toBe(1);
    expect(report.fallback_count).toBe(0);
    expect(report.outcome).toBe("fail");
    expect(result).toMatchObject({
      page: "feed",
      selector_key: "selector_group",
      status: "fail",
      matched_strategy: null,
      matched_selector_key: null,
      fallback_used: null,
      fallback_strategy: null
    });
    expect(result?.failure_artifacts.screenshot_path).toBeTruthy();
    expect(result?.failure_artifacts.dom_snapshot_path).toBeTruthy();
    expect(result?.failure_artifacts.accessibility_snapshot_path).toBeTruthy();
    await expect(stat(result!.failure_artifacts.screenshot_path!)).resolves.toBeTruthy();
    await expect(stat(result!.failure_artifacts.dom_snapshot_path!)).resolves.toBeTruthy();
    await expect(
      stat(result!.failure_artifacts.accessibility_snapshot_path!)
    ).resolves.toBeTruthy();
    expect(report.page_warnings).toEqual([
      {
        page: "feed",
        warnings: [
          "Could not confirm that the feed page was ready within 10ms. Last check: Selector check failed for primary selector primary-key (primary): Selector not visible: primary. Verify the page is fully loaded, or update the selector registry before rerunning the selector audit.. Selector checks continued with the current DOM state; if failures persist, reload the page or update the ready selectors and rerun the selector audit."
        ]
      }
    ]);
    expect(report.fallback_selectors).toEqual([]);
    expect(report.failed_selectors).toMatchObject([
      {
        page: "feed",
        selector_key: "selector_group",
        description: "Selector group",
        error:
          "No selector strategy matched for selector_group on feed. Review the failure artifacts, update the selector registry if LinkedIn's UI changed, and rerun the selector audit.",
        failure_artifacts: {
          screenshot_path: result?.failure_artifacts.screenshot_path,
          dom_snapshot_path: result?.failure_artifacts.dom_snapshot_path,
          accessibility_snapshot_path: result?.failure_artifacts.accessibility_snapshot_path
        }
      }
    ]);
    expect(report.failed_selectors[0]?.recommended_action).toContain(
      "update that selector group in the registry"
    );
    expect(report.recommended_actions).toContain(
      `Open ${report.report_path} and the captured artifacts for failed selector groups before changing the registry.`
    );
    expect(report.recommended_actions).toContain(
      "Some pages were not fully stable during the audit. Refresh the LinkedIn session or attached browser and rerun before treating warnings as definitive UI drift."
    );
    await expect(stat(report.report_path)).resolves.toBeTruthy();
  });

  it("aggregates page summaries across passes, failures, and fallback usage", async () => {
    const registry = [
      createSelectorAuditPageDefinition({
        page: "feed",
        selectors: [
          createSelectorAuditSelectorDefinition({
            key: "feed_primary",
            description: "Feed primary selector",
            candidates: [
              createSelectorAuditCandidate({
                strategy: "primary",
                key: "feed-primary-key",
                selectorHint: "feed-primary",
                selector: "feed-primary"
              }),
              createSelectorAuditCandidate({
                strategy: "secondary",
                key: "feed-primary-secondary",
                selectorHint: "feed-primary-secondary",
                selector: "feed-primary-secondary"
              }),
              createSelectorAuditCandidate({
                strategy: "tertiary",
                key: "feed-primary-tertiary",
                selectorHint: "feed-primary-tertiary",
                selector: "feed-primary-tertiary"
              })
            ]
          }),
          createSelectorAuditSelectorDefinition({
            key: "feed_missing",
            description: "Feed missing selector",
            candidates: [
              createSelectorAuditCandidate({
                strategy: "primary",
                key: "feed-missing-primary",
                selectorHint: "feed-missing-primary",
                selector: "feed-missing-primary"
              }),
              createSelectorAuditCandidate({
                strategy: "secondary",
                key: "feed-missing-secondary",
                selectorHint: "feed-missing-secondary",
                selector: "feed-missing-secondary"
              }),
              createSelectorAuditCandidate({
                strategy: "tertiary",
                key: "feed-missing-tertiary",
                selectorHint: "feed-missing-tertiary",
                selector: "feed-missing-tertiary"
              })
            ]
          })
        ]
      }),
      createSelectorAuditPageDefinition({
        page: "inbox",
        selectors: [
          createSelectorAuditSelectorDefinition({
            key: "inbox_fallback",
            description: "Inbox fallback selector",
            candidates: [
              createSelectorAuditCandidate({
                strategy: "primary",
                key: "inbox-primary-key",
                selectorHint: "inbox-primary",
                selector: "inbox-primary"
              }),
              createSelectorAuditCandidate({
                strategy: "secondary",
                key: "inbox-secondary-key",
                selectorHint: "inbox-secondary",
                selector: "inbox-secondary"
              }),
              createSelectorAuditCandidate({
                strategy: "tertiary",
                key: "inbox-tertiary-key",
                selectorHint: "inbox-tertiary",
                selector: "inbox-tertiary"
              })
            ]
          })
        ]
      })
    ];

    const { runtime, service } = await createSelectorAuditTestHarness({
      cdpUrl: "http://127.0.0.1:18800",
      registry,
      visibleSelectors: ["feed-primary", "inbox-secondary"]
    });

    const report = await service.auditSelectors({ profileName: "work" });

    expect(report.total_count).toBe(3);
    expect(report.pass_count).toBe(2);
    expect(report.fail_count).toBe(1);
    expect(report.fallback_count).toBe(1);
    expect(report.page_summaries).toEqual([
      {
        page: "feed",
        total_count: 2,
        pass_count: 1,
        fail_count: 1,
        fallback_count: 0
      },
      {
        page: "inbox",
        total_count: 1,
        pass_count: 1,
        fail_count: 0,
        fallback_count: 1
      }
    ]);
    expect(runtime.auth.ensureAuthenticated).toHaveBeenCalledWith({
      profileName: "work"
    });
    expect(runtime.profileManager.runWithContext).toHaveBeenCalledWith(
      {
        cdpUrl: "http://127.0.0.1:18800",
        profileName: "work",
        headless: true
      },
      expect.any(Function)
    );
  });

  it("defaults to the default profile and opens a page when the context is empty", async () => {
    const { context, runtime, service } = await createSelectorAuditTestHarness({
      existingPages: [],
      visibleSelectors: ["primary"]
    });

    const report = await service.auditSelectors();

    expect(report.profile_name).toBe("default");
    expect(runtime.auth.ensureAuthenticated).toHaveBeenCalledWith({
      profileName: "default"
    });
    expect(context.pages).toHaveBeenCalledTimes(1);
    expect(context.newPage).toHaveBeenCalledTimes(1);
  });

  it("continues auditing when network idle times out", async () => {
    const { page, service } = await createSelectorAuditTestHarness({
      visibleSelectors: ["primary"],
      waitForLoadStateError: new playwrightErrors.TimeoutError(
        "Timed out waiting for network idle"
      )
    });

    const report = await service.auditSelectors({ profileName: "default" });

    expect(report.pass_count).toBe(1);
    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 5_000
    });
    expect(report.results[0]?.warnings).toEqual([
      "The feed page did not reach network idle within 5000ms. Selector checks continued with the current DOM state."
    ]);
    expect(report.page_warnings).toEqual([
      {
        page: "feed",
        warnings: [
          "The feed page did not reach network idle within 5000ms. Selector checks continued with the current DOM state."
        ]
      }
    ]);
    expect(report.recommended_actions).toContain(
      "Some pages were not fully stable during the audit. Refresh the LinkedIn session or attached browser and rerun before treating warnings as definitive UI drift."
    );
  });

  it("marks selector groups failed when page stabilization throws", async () => {
    const { service } = await createSelectorAuditTestHarness({
      waitForLoadStateError: new Error("Renderer crashed")
    });

    const report = await service.auditSelectors({ profileName: "default" });

    expect(report.pass_count).toBe(0);
    expect(report.fail_count).toBe(1);
    expect(report.results[0]).toMatchObject({
      page: "feed",
      selector_key: "selector_group",
      status: "fail",
      error:
        "Could not load the feed page: Renderer crashed. Refresh the LinkedIn session or attached browser and rerun the selector audit."
    });
  });

  it("marks selector groups failed when navigation fails", async () => {
    const { service } = await createSelectorAuditTestHarness({
      gotoError: new Error("Navigation failed")
    });

    const report = await service.auditSelectors({ profileName: "default" });

    expect(report.pass_count).toBe(0);
    expect(report.fail_count).toBe(1);
    expect(report.results[0]).toMatchObject({
      page: "feed",
      selector_key: "selector_group",
      status: "fail",
      error:
        "Could not load the feed page: Navigation failed. Refresh the LinkedIn session or attached browser and rerun the selector audit."
    });
    expect(report.results[0]?.strategies.primary.error).toBe(
      "Could not load the feed page: Navigation failed. Refresh the LinkedIn session or attached browser and rerun the selector audit."
    );
  });

  it("surfaces navigation timeout guidance when page loading times out", async () => {
    const { service } = await createSelectorAuditTestHarness({
      gotoError: new playwrightErrors.TimeoutError("Navigation timeout")
    });

    const report = await service.auditSelectors({ profileName: "default" });

    expect(report.results[0]?.error).toBe(
      "Timed out after 15000ms loading the feed page. Confirm the LinkedIn session can open https://example.test/feed and rerun the selector audit."
    );
  });

  it("fills in missing strategy slots for partial selector definitions", async () => {
    const registry = [
      createSelectorAuditPageDefinition({
        page: "feed",
        selectors: [
          createSelectorAuditSelectorDefinition({
            key: "selector_group",
            description: "Selector group",
            candidates: [
              createSelectorAuditCandidate({
                strategy: "secondary",
                key: "secondary-key",
                selectorHint: "secondary",
                selector: "secondary"
              })
            ]
          })
        ]
      })
    ];

    const { service } = await createSelectorAuditTestHarness({
      registry,
      visibleSelectors: ["secondary"]
    });

    const report = await service.auditSelectors({ profileName: "default" });
    const [result] = report.results;

    expect(result).toMatchObject({
      status: "pass",
      matched_strategy: "secondary",
      matched_selector_key: "secondary-key",
      fallback_used: "secondary-key",
      fallback_strategy: "secondary"
    });
    expect(result?.strategies.primary).toMatchObject({
      status: "fail",
      selector_key: "missing-primary",
      error: "Primary selector missing from registry."
    });
    expect(result?.strategies.secondary).toMatchObject({
      status: "pass",
      selector_key: "secondary-key"
    });
    expect(result?.strategies.tertiary).toMatchObject({
      status: "fail",
      selector_key: "missing-tertiary",
      error: "Tertiary selector missing from registry."
    });
  });

  it("propagates authentication failures before opening a browser context", async () => {
    const authError = new Error("LinkedIn session expired");
    const { runtime, service } = await createSelectorAuditTestHarness({
      authError,
      visibleSelectors: ["primary"]
    });

    await expect(
      service.auditSelectors({ profileName: "default" })
    ).rejects.toThrow("LinkedIn session expired");

    expect(runtime.profileManager.runWithContext).not.toHaveBeenCalled();
  });

  it("rejects invalid profile names before opening a browser context", async () => {
    const { runtime, service } = await createSelectorAuditTestHarness({
      visibleSelectors: ["primary"]
    });

    await expect(
      service.auditSelectors({ profileName: "../default" })
    ).rejects.toThrow("profile must not contain path separators or relative path segments.");

    expect(runtime.auth.ensureAuthenticated).not.toHaveBeenCalled();
    expect(runtime.profileManager.runWithContext).not.toHaveBeenCalled();
  });

  it("keeps auditing later selector groups when a locator factory throws", async () => {
    const brokenPrimaryCandidate: SelectorAuditCandidate = {
      strategy: "primary",
      key: "broken-primary",
      selectorHint: "broken-primary",
      locatorFactory: () => {
        throw new Error("Broken locator factory");
      }
    };

    const registry = [
      createSelectorAuditPageDefinition({
        page: "feed",
        selectors: [
          createSelectorAuditSelectorDefinition({
            key: "broken_selector",
            description: "Broken selector",
            candidates: [
              brokenPrimaryCandidate,
              createSelectorAuditCandidate({
                strategy: "secondary",
                key: "broken-secondary",
                selectorHint: "broken-secondary",
                selector: "broken-secondary"
              }),
              createSelectorAuditCandidate({
                strategy: "tertiary",
                key: "broken-tertiary",
                selectorHint: "broken-tertiary",
                selector: "broken-tertiary"
              })
            ]
          }),
          createSelectorAuditSelectorDefinition({
            key: "healthy_selector",
            description: "Healthy selector",
            candidates: [
              createSelectorAuditCandidate({
                strategy: "primary",
                key: "healthy-primary",
                selectorHint: "healthy-primary",
                selector: "healthy-primary"
              }),
              createSelectorAuditCandidate({
                strategy: "secondary",
                key: "healthy-secondary",
                selectorHint: "healthy-secondary",
                selector: "healthy-secondary"
              }),
              createSelectorAuditCandidate({
                strategy: "tertiary",
                key: "healthy-tertiary",
                selectorHint: "healthy-tertiary",
                selector: "healthy-tertiary"
              })
            ]
          })
        ]
      })
    ];

    const { service } = await createSelectorAuditTestHarness({
      registry,
      visibleSelectors: ["healthy-primary"]
    });

    const report = await service.auditSelectors({ profileName: "default" });

    expect(report.pass_count).toBe(1);
    expect(report.fail_count).toBe(1);
    expect(report.results[0]).toMatchObject({
      selector_key: "broken_selector",
      status: "fail"
    });
    expect(report.results[0]?.strategies.primary.error).toContain(
      "Broken locator factory"
    );
    expect(report.results[1]).toMatchObject({
      selector_key: "healthy_selector",
      status: "pass",
      matched_strategy: "primary"
    });
  });

  it("rejects invalid timeout options", async () => {
    const { runtime } = await createSelectorAuditTestHarness();

    expect(
      () =>
        new LinkedInSelectorAuditService(
          runtime as unknown as LinkedInSelectorAuditRuntime,
          {
            candidateTimeoutMs: 0
          }
        )
    ).toThrow("candidateTimeoutMs must be a positive integer number of milliseconds.");
  });

  it("surfaces selector timeout guidance when selector checks time out", async () => {
    const { service } = await createSelectorAuditTestHarness({
      locatorErrors: {
        primary: new playwrightErrors.TimeoutError("Primary timeout"),
        secondary: new playwrightErrors.TimeoutError("Secondary timeout"),
        tertiary: new playwrightErrors.TimeoutError("Tertiary timeout")
      }
    });

    const report = await service.auditSelectors({ profileName: "default" });

    expect(report.results[0]?.strategies.primary.error).toBe(
      "Timed out after 10ms waiting for primary selector primary-key (primary) to become visible. Confirm the page is loaded and authenticated, then rerun the selector audit."
    );
  });

  it("keeps failure reporting intact when artifact capture steps fail", async () => {
    const { service } = await createSelectorAuditTestHarness({
      accessibilitySnapshotError: new Error("Accessibility tree unavailable"),
      contentError: new Error("DOM snapshot unavailable"),
      screenshotError: new Error("Screenshot unavailable")
    });

    const report = await service.auditSelectors({ profileName: "default" });

    expect(report.fail_count).toBe(1);
    expect(report.results[0]?.failure_artifacts).toMatchObject({
      capture_warnings: [
        "Could not capture the screenshot for selector_group on feed: Screenshot unavailable.",
        "Could not capture the DOM snapshot for selector_group on feed: DOM snapshot unavailable.",
        "Could not capture the accessibility snapshot for selector_group on feed: Accessibility tree unavailable."
      ]
    });
    await expect(stat(report.report_path)).resolves.toBeTruthy();
  });

  it("rejects duplicate strategies in injected selector registries", async () => {
    await expect(
      createSelectorAuditTestHarness({
        registry: [
          createSelectorAuditPageDefinition({
            page: "feed",
            selectors: [
              createSelectorAuditSelectorDefinition({
                key: "selector_group",
                description: "Selector group",
                candidates: [
                  createSelectorAuditCandidate({
                    strategy: "primary",
                    key: "primary-one",
                    selectorHint: "primary-one",
                    selector: "primary-one"
                  }),
                  createSelectorAuditCandidate({
                    strategy: "primary",
                    key: "primary-two",
                    selectorHint: "primary-two",
                    selector: "primary-two"
                  })
                ]
              })
            ]
          })
        ]
      })
    ).rejects.toThrow("Duplicate selector audit strategy primary on feed:selector_group.");
  });

  it.each([
    {
      name: "duplicate page definitions",
      message: "Duplicate selector audit page definition: feed",
      registry: [
        createSelectorAuditPageDefinition({
          page: "feed",
          selectors: [
            createSelectorAuditSelectorDefinition({
              key: "selector_group",
              candidates: [
                createSelectorAuditCandidate({
                  strategy: "primary",
                  selector: "primary"
                })
              ]
            })
          ]
        }),
        createSelectorAuditPageDefinition({
          page: "feed",
          selectors: [
            createSelectorAuditSelectorDefinition({
              key: "selector_group_two",
              candidates: [
                createSelectorAuditCandidate({
                  strategy: "primary",
                  selector: "primary-two"
                })
              ]
            })
          ]
        })
      ]
    },
    {
      name: "duplicate selector keys",
      message: "Duplicate selector audit key selector_group on feed.",
      registry: [
        createSelectorAuditPageDefinition({
          page: "feed",
          selectors: [
            createSelectorAuditSelectorDefinition({
              key: "selector_group",
              candidates: [
                createSelectorAuditCandidate({
                  strategy: "primary",
                  selector: "primary"
                })
              ]
            }),
            createSelectorAuditSelectorDefinition({
              key: "selector_group",
              candidates: [
                createSelectorAuditCandidate({
                  strategy: "secondary",
                  selector: "secondary"
                })
              ]
            })
          ]
        })
      ]
    },
    {
      name: "duplicate candidate keys",
      message:
        "Duplicate selector audit candidate key duplicate on feed:selector_group.",
      registry: [
        createSelectorAuditPageDefinition({
          page: "feed",
          selectors: [
            createSelectorAuditSelectorDefinition({
              key: "selector_group",
              candidates: [
                createSelectorAuditCandidate({
                  strategy: "primary",
                  key: "duplicate",
                  selector: "primary"
                }),
                createSelectorAuditCandidate({
                  strategy: "secondary",
                  key: "duplicate",
                  selector: "secondary"
                })
              ]
            })
          ]
        })
      ]
    },
    {
      name: "pages without selectors",
      message: "Selector audit page feed has no selectors.",
      registry: [
        createSelectorAuditPageDefinition({
          page: "feed",
          selectors: []
        })
      ]
    },
    {
      name: "selector groups without candidates",
      message: "Selector audit key selector_group on feed has no candidates.",
      registry: [
        createSelectorAuditPageDefinition({
          page: "feed",
          selectors: [
            createSelectorAuditSelectorDefinition({
              key: "selector_group",
              candidates: []
            })
          ]
        })
      ]
    }
  ])("rejects malformed registry input: $name", async ({ message, registry }) => {
    await expect(
      createSelectorAuditTestHarness({
        registry
      })
    ).rejects.toThrow(message);
  });
});
