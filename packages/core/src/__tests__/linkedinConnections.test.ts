import { describe, expect, it } from "vitest";
import {
  SEND_INVITATION_ACTION_TYPE,
  ACCEPT_INVITATION_ACTION_TYPE,
  WITHDRAW_INVITATION_ACTION_TYPE,
  createConnectionActionExecutors
} from "../linkedinConnections.js";

describe("Connection action type constants", () => {
  it("has correct send invitation action type", () => {
    expect(SEND_INVITATION_ACTION_TYPE).toBe("connections.send_invitation");
  });

  it("has correct accept invitation action type", () => {
    expect(ACCEPT_INVITATION_ACTION_TYPE).toBe("connections.accept_invitation");
  });

  it("has correct withdraw invitation action type", () => {
    expect(WITHDRAW_INVITATION_ACTION_TYPE).toBe("connections.withdraw_invitation");
  });
});

describe("createConnectionActionExecutors", () => {
  it("registers all three action executors", () => {
    const executors = createConnectionActionExecutors();
    expect(Object.keys(executors)).toHaveLength(3);
    expect(executors[SEND_INVITATION_ACTION_TYPE]).toBeDefined();
    expect(executors[ACCEPT_INVITATION_ACTION_TYPE]).toBeDefined();
    expect(executors[WITHDRAW_INVITATION_ACTION_TYPE]).toBeDefined();
  });

  it("each executor has an execute method", () => {
    const executors = createConnectionActionExecutors();
    for (const key of Object.keys(executors)) {
      const executor = executors[key];
      expect(executor).toBeDefined();
      expect(typeof executor!.execute).toBe("function");
    }
  });
});

describe("LinkedInConnection interface shape", () => {
  it("validates a well-formed connection object", () => {
    const connection = {
      vanity_name: "johndoe",
      full_name: "John Doe",
      headline: "Software Engineer",
      profile_url: "https://www.linkedin.com/in/johndoe/",
      connected_since: "Connected 2 months ago"
    };
    expect(connection.vanity_name).toBe("johndoe");
    expect(connection.full_name).toBe("John Doe");
    expect(connection.headline).toBe("Software Engineer");
    expect(typeof connection.profile_url).toBe("string");
    expect(typeof connection.connected_since).toBe("string");
  });

  it("allows null vanity_name", () => {
    const connection = {
      vanity_name: null,
      full_name: "Jane Doe",
      headline: "",
      profile_url: "",
      connected_since: ""
    };
    expect(connection.vanity_name).toBeNull();
  });
});

describe("LinkedInPendingInvitation interface shape", () => {
  it("validates a received invitation", () => {
    const invitation = {
      vanity_name: "janedoe",
      full_name: "Jane Doe",
      headline: "Product Manager",
      profile_url: "https://www.linkedin.com/in/janedoe/",
      sent_or_received: "received" as const
    };
    expect(invitation.sent_or_received).toBe("received");
    expect(invitation.vanity_name).toBe("janedoe");
  });

  it("validates a sent invitation", () => {
    const invitation = {
      vanity_name: "bobsmith",
      full_name: "Bob Smith",
      headline: "Designer",
      profile_url: "https://www.linkedin.com/in/bobsmith/",
      sent_or_received: "sent" as const
    };
    expect(invitation.sent_or_received).toBe("sent");
  });
});
