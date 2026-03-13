import { describe, expect, it } from "vitest";
import {
  FOLLOW_COMPANY_PAGE_ACTION_TYPE,
  UNFOLLOW_COMPANY_PAGE_ACTION_TYPE
} from "../../linkedinCompanyPages.js";
import { LinkedInBuddyError } from "../../errors.js";
import {
  callMcpTool,
  expectPreparedAction,
  getDefaultProfileName,
  getLastJsonObject,
  isOptInEnabled,
  MCP_TOOL_NAMES,
  runCliCommand
} from "./helpers.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

const DEFAULT_COMPANY_TARGET = "microsoft";

function getCompanyTarget(): string {
  const env = process.env.LINKEDIN_E2E_COMPANY_TARGET;
  return typeof env === "string" && env.trim().length > 0
    ? env.trim()
    : DEFAULT_COMPANY_TARGET;
}

function getCompanyFollowTarget(): string {
  const env = process.env.LINKEDIN_E2E_COMPANY_FOLLOW_TARGET;
  return typeof env === "string" && env.trim().length > 0
    ? env.trim()
    : getCompanyTarget();
}

const companyFollowConfirmEnabled = isOptInEnabled(
  "LINKEDIN_E2E_ENABLE_COMPANY_FOLLOW_CONFIRM"
);
const companyFollowConfirmTest = companyFollowConfirmEnabled ? it : it.skip;

describe("Company Pages Write E2E (2PC follow/unfollow)", () => {
  const e2e = setupE2ESuite();
  const profileName = getDefaultProfileName();

  it("prepare follow returns valid preview", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetCompany = getCompanyTarget();

    const prepared = runtime.companyPages.prepareFollowCompanyPage({
      profileName,
      targetCompany
    });

    expectPreparedAction(prepared);
  });

  it("prepare unfollow returns valid preview", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetCompany = getCompanyTarget();

    const prepared = runtime.companyPages.prepareUnfollowCompanyPage({
      profileName,
      targetCompany
    });

    expectPreparedAction(prepared);
  });

  it("prepare follow preview summary includes company target", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetCompany = getCompanyTarget();

    const prepared = runtime.companyPages.prepareFollowCompanyPage({
      profileName,
      targetCompany
    });

    expect(String(prepared.preview.summary)).toContain(targetCompany);
  });

  it("prepare unfollow preview summary includes company target", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetCompany = getCompanyTarget();

    const prepared = runtime.companyPages.prepareUnfollowCompanyPage({
      profileName,
      targetCompany
    });

    expect(String(prepared.preview.summary)).toContain(targetCompany);
  });

  it("prepare follow preview target includes normalized company URL", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetCompany = getCompanyTarget();

    const prepared = runtime.companyPages.prepareFollowCompanyPage({
      profileName,
      targetCompany
    });

    const target = prepared.preview.target as Record<string, unknown>;
    expect(target.company_url).toContain("linkedin.com/company/");
    expect(target.target_company).toBe(targetCompany);
  });

  it("prepare unfollow preview target includes normalized company URL", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetCompany = getCompanyTarget();

    const prepared = runtime.companyPages.prepareUnfollowCompanyPage({
      profileName,
      targetCompany
    });

    const target = prepared.preview.target as Record<string, unknown>;
    expect(target.company_url).toContain("linkedin.com/company/");
    expect(target.target_company).toBe(targetCompany);
  });

  it("prepare follow and unfollow return distinct action IDs and tokens", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const targetCompany = getCompanyTarget();

    const follow = runtime.companyPages.prepareFollowCompanyPage({
      profileName,
      targetCompany
    });
    const unfollow = runtime.companyPages.prepareUnfollowCompanyPage({
      profileName,
      targetCompany
    });

    expect(follow.preparedActionId).not.toBe(unfollow.preparedActionId);
    expect(follow.confirmToken).not.toBe(unfollow.confirmToken);
  });

  it("prepare follow with empty target throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.companyPages.prepareFollowCompanyPage({
        profileName,
        targetCompany: ""
      });
    }).toThrow(LinkedInBuddyError);

    try {
      runtime.companyPages.prepareFollowCompanyPage({
        profileName,
        targetCompany: ""
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      expect((error as LinkedInBuddyError).code).toBe(
        "ACTION_PRECONDITION_FAILED"
      );
    }
  });

  it("prepare unfollow with empty target throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.companyPages.prepareUnfollowCompanyPage({
        profileName,
        targetCompany: ""
      });
    }).toThrow(LinkedInBuddyError);

    try {
      runtime.companyPages.prepareUnfollowCompanyPage({
        profileName,
        targetCompany: ""
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      expect((error as LinkedInBuddyError).code).toBe(
        "ACTION_PRECONDITION_FAILED"
      );
    }
  });

  it("prepare follow with whitespace-only target throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.companyPages.prepareFollowCompanyPage({
        profileName,
        targetCompany: "   "
      });
    }).toThrow(LinkedInBuddyError);
  });

  it("prepare unfollow with whitespace-only target throws ACTION_PRECONDITION_FAILED", (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();

    expect(() => {
      runtime.companyPages.prepareUnfollowCompanyPage({
        profileName,
        targetCompany: "   "
      });
    }).toThrow(LinkedInBuddyError);
  });

  it("CLI company follow returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand([
      "company",
      "follow",
      getCompanyTarget(),
      "--profile",
      profileName
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(getLastJsonObject(result.stdout)).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  it("CLI company unfollow returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand([
      "company",
      "unfollow",
      getCompanyTarget(),
      "--profile",
      profileName
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(getLastJsonObject(result.stdout)).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  it("MCP company prepare follow returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.companyPrepareFollow, {
      profileName,
      targetCompany: getCompanyTarget()
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  it("MCP company prepare unfollow returns prepared action", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.companyPrepareUnfollow, {
      profileName,
      targetCompany: getCompanyTarget()
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      preparedActionId: expect.stringMatching(/^pa_/),
      confirmToken: expect.stringMatching(/^ct_/)
    });
  });

  companyFollowConfirmTest(
    "follows a company via prepare → confirm",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();
      const targetCompany = getCompanyFollowTarget();

      const prepared = runtime.companyPages.prepareFollowCompanyPage({
        profileName,
        targetCompany,
        operatorNote: "Automated E2E company follow test"
      });

      expectPreparedAction(prepared);

      const result = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken
      });

      expect(result.status).toBe("executed");
      expect(result.actionType).toBe(FOLLOW_COMPANY_PAGE_ACTION_TYPE);
      expect(result.result).toMatchObject({
        status: "company_followed"
      });
    },
    120_000
  );

  companyFollowConfirmTest(
    "unfollows a company via prepare → confirm",
    async (context) => {
      skipIfE2EUnavailable(e2e, context);
      const runtime = e2e.runtime();
      const targetCompany = getCompanyFollowTarget();

      const prepared = runtime.companyPages.prepareUnfollowCompanyPage({
        profileName,
        targetCompany,
        operatorNote: "Automated E2E company unfollow test"
      });

      expectPreparedAction(prepared);

      const result = await runtime.twoPhaseCommit.confirmByToken({
        confirmToken: prepared.confirmToken
      });

      expect(result.status).toBe("executed");
      expect(result.actionType).toBe(UNFOLLOW_COMPANY_PAGE_ACTION_TYPE);
      expect(result.result).toMatchObject({
        status: "company_unfollowed"
      });
    },
    120_000
  );
});
