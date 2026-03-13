import { describe, expect, it } from "vitest";
import type { LinkedInConnection, LinkedInPendingInvitation } from "../../linkedinConnections.js";
import { setupE2ESuite, skipIfE2EUnavailable } from "./setup.js";

function expectConnectionDataQuality(conn: LinkedInConnection): void {
  expect(conn.full_name.trim().length).toBeGreaterThan(0);
  expect(conn.profile_url).toContain("/in/");
  expect(conn.profile_url.startsWith("https://")).toBe(true);
  expect(conn.profile_url).toContain("linkedin.com");
  expect(typeof conn.headline).toBe("string");
  expect(typeof conn.connected_since).toBe("string");
  expect(typeof conn.vanity_name === "string" || conn.vanity_name === null).toBe(true);
}

function expectPendingInvitationDataQuality(inv: LinkedInPendingInvitation): void {
  expect(inv.full_name.trim().length).toBeGreaterThan(0);
  expect(inv.profile_url).toContain("/in/");
  expect(inv.profile_url.startsWith("https://")).toBe(true);
  expect(inv.profile_url).toContain("linkedin.com");
  expect(typeof inv.headline).toBe("string");
  expect(typeof inv.vanity_name === "string" || inv.vanity_name === null).toBe(true);
  expect(["sent", "received"]).toContain(inv.sent_or_received);
}

describe("Connections E2E", () => {
  const e2e = setupE2ESuite();

  it("list connections returns array with complete populated fields", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const connections = await runtime.connections.listConnections();

    expect(Array.isArray(connections)).toBe(true);
    expect(connections.length).toBeGreaterThan(0);

    for (const conn of connections) {
      expectConnectionDataQuality(conn);
    }

    const [first] = connections;
    if (first) {
      expect(first.full_name.length).toBeGreaterThan(0);
      expect(first.profile_url).toContain("linkedin.com");
      expect(first.headline.length).toBeGreaterThan(0);
      expect(first.connected_since.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it("list with limit respects parameter", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const connections = await runtime.connections.listConnections({ limit: 5 });

    expect(connections.length).toBeLessThanOrEqual(5);

    for (const conn of connections) {
      expect(conn.profile_url.startsWith("https://")).toBe(true);
      expect(conn.profile_url).toContain("linkedin.com");
    }
  }, 60_000);

  it("list pending invitations returns received and sent with filter=all", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const invitations = await runtime.connections.listPendingInvitations({
      filter: "all"
    });

    expect(Array.isArray(invitations)).toBe(true);

    for (const inv of invitations) {
      expectPendingInvitationDataQuality(inv);
    }

    const received = invitations.filter((inv) => inv.sent_or_received === "received");
    const sent = invitations.filter((inv) => inv.sent_or_received === "sent");

    expect(received.length + sent.length).toBe(invitations.length);
  }, 60_000);

  it("list pending invitations with filter=received returns only received", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const invitations = await runtime.connections.listPendingInvitations({
      filter: "received"
    });

    expect(Array.isArray(invitations)).toBe(true);

    for (const inv of invitations) {
      expectPendingInvitationDataQuality(inv);
      expect(inv.sent_or_received).toBe("received");
    }
  }, 60_000);

  it("list pending invitations with filter=sent returns only sent", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const invitations = await runtime.connections.listPendingInvitations({
      filter: "sent"
    });

    expect(Array.isArray(invitations)).toBe(true);

    for (const inv of invitations) {
      expectPendingInvitationDataQuality(inv);
      expect(inv.sent_or_received).toBe("sent");
    }
  }, 60_000);

  it("connection vanity_name matches profile_url slug", async (context) => {
    skipIfE2EUnavailable(e2e, context);
    const runtime = e2e.runtime();
    const connections = await runtime.connections.listConnections({ limit: 5 });

    for (const conn of connections) {
      if (conn.vanity_name) {
        expect(conn.profile_url).toContain(`/in/${conn.vanity_name}`);
      }
    }
  }, 60_000);
});
