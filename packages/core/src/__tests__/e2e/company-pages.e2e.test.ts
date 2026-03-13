import { describe, expect, it } from "vitest";
import {
  callMcpTool,
  getDefaultProfileName,
  getLastJsonObject,
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

describe("Company Pages E2E (read operations)", () => {
  const e2e = setupE2ESuite();
  const profileName = getDefaultProfileName();

  it("view company page returns all expected fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const company = await runtime.companyPages.viewCompanyPage({
      profileName,
      target: getCompanyTarget()
    });

    expect(company.name.length).toBeGreaterThan(0);
    expect(company.company_url).toContain("linkedin.com/company/");
    expect(company.about_url).toContain("/about/");
    expect(company.slug).toBeTruthy();
    expect(typeof company.industry).toBe("string");
    expect(typeof company.location).toBe("string");
    expect(typeof company.follower_count).toBe("string");
    expect(typeof company.employee_count).toBe("string");
    expect(typeof company.website).toBe("string");
    expect(typeof company.headquarters).toBe("string");
    expect(typeof company.specialties).toBe("string");
    expect(typeof company.overview).toBe("string");
    expect(["following", "not_following", "unknown"]).toContain(
      company.follow_state
    );
  }, 60_000);

  it("view accepts full company URL", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const target = getCompanyTarget();
    const company = await runtime.companyPages.viewCompanyPage({
      profileName,
      target: `https://www.linkedin.com/company/${target}/`
    });

    expect(company.name.length).toBeGreaterThan(0);
    expect(company.slug).toBe(target);
  }, 60_000);

  it("view accepts /company/ path format", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const target = getCompanyTarget();
    const company = await runtime.companyPages.viewCompanyPage({
      profileName,
      target: `/company/${target}/`
    });

    expect(company.name.length).toBeGreaterThan(0);
    expect(company.slug).toBe(target);
  }, 60_000);

  it("view populates industry and follower data for well-known companies", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const company = await runtime.companyPages.viewCompanyPage({
      profileName,
      target: getCompanyTarget()
    });

    expect(company.industry.length).toBeGreaterThan(0);
    expect(company.follower_count.length).toBeGreaterThan(0);
  }, 60_000);

  it("view returns consistent slug across URL formats", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const target = getCompanyTarget();

    const fromSlug = await runtime.companyPages.viewCompanyPage({
      profileName,
      target
    });
    const fromUrl = await runtime.companyPages.viewCompanyPage({
      profileName,
      target: `https://www.linkedin.com/company/${target}/`
    });

    expect(fromSlug.slug).toBe(fromUrl.slug);
    expect(fromSlug.name).toBe(fromUrl.name);
  }, 120_000);

  it("follow_state is a recognized value", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const company = await runtime.companyPages.viewCompanyPage({
      profileName,
      target: getCompanyTarget()
    });

    expect(["following", "not_following", "unknown"]).toContain(
      company.follow_state
    );
  }, 60_000);

  it("CLI company view returns structured JSON", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await runCliCommand([
      "company",
      "view",
      getCompanyTarget(),
      "--profile",
      profileName
    ]);

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);

    const payload = getLastJsonObject(result.stdout);
    expect(payload).toMatchObject({
      profile_name: profileName,
      company: {
        name: expect.any(String),
        company_url: expect.stringContaining("linkedin.com/company/"),
        follow_state: expect.stringMatching(
          /^(following|not_following|unknown)$/
        )
      }
    });

    const company = payload.company as Record<string, unknown>;
    expect(typeof company.industry).toBe("string");
    expect(typeof company.slug).toBe("string");
  }, 60_000);

  it("MCP company view returns structured payload", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const result = await callMcpTool(MCP_TOOL_NAMES.companyView, {
      profileName,
      target: getCompanyTarget()
    });

    expect(result.isError).toBe(false);
    expect(result.payload).toMatchObject({
      profile_name: profileName,
      company: {
        name: expect.any(String),
        company_url: expect.stringContaining("linkedin.com/company/"),
        follow_state: expect.stringMatching(
          /^(following|not_following|unknown)$/
        )
      }
    });

    const company = result.payload.company as Record<string, unknown>;
    expect(typeof company.industry).toBe("string");
    expect(typeof company.slug).toBe("string");
  }, 60_000);
});
