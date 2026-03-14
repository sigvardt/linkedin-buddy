import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TwoPhaseCommitService,
  TEST_ECHO_ACTION_TYPE,
  TestEchoActionExecutor,
  generateConfirmToken
} from "../twoPhaseCommit.js";
import type { SessionGuardContext, SessionGuardFn } from "../sessionGuard.js";
import { LinkedInBuddyError } from "../errors.js";
import { AssistantDatabase } from "../db/database.js";

describe("TwoPhaseCommitService session guard integration", () => {
  let db: AssistantDatabase;
  let tpc: TwoPhaseCommitService<unknown>;
  let mockGuard: ReturnType<typeof vi.fn<SessionGuardFn>>;

  beforeEach(() => {
    db = new AssistantDatabase(":memory:");
    mockGuard = vi.fn<SessionGuardFn>(async () => undefined);
    tpc = new TwoPhaseCommitService(db, {
      executors: {
        [TEST_ECHO_ACTION_TYPE]: new TestEchoActionExecutor()
      },
      getRuntime: () => ({}),
      sessionGuard: mockGuard
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function prepareEchoAction() {
    return tpc.prepare({
      actionType: TEST_ECHO_ACTION_TYPE,
      target: { profile_name: "default" },
      payload: { text: "hello" },
      preview: { summary: "Echo hello" }
    });
  }

  it("throws AUTH_REQUIRED, marks the action failed, and skips executor when guard rejects", async () => {
    const executeSpy = vi.spyOn(TestEchoActionExecutor.prototype, "execute");
    const guardError = new LinkedInBuddyError(
      "AUTH_REQUIRED",
      "Stored session is not healthy.",
      { guard_source: "session_guard" }
    );
    mockGuard.mockRejectedValueOnce(guardError);

    const prepared = prepareEchoAction();

    await expect(
      tpc.confirmByToken({ confirmToken: prepared.confirmToken, nowMs: 101 })
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED"
    });

    expect(executeSpy).not.toHaveBeenCalled();

    const row = db.getPreparedActionById(prepared.preparedActionId);
    expect(row).toBeDefined();
    expect(row?.status).toBe("failed");
    expect(row?.error_code).toBe("AUTH_REQUIRED");
  });

  it("succeeds and marks action executed when guard passes", async () => {
    const executeSpy = vi.spyOn(TestEchoActionExecutor.prototype, "execute");
    mockGuard.mockResolvedValueOnce(undefined);

    const prepared = prepareEchoAction();
    const result = await tpc.confirmByToken({
      confirmToken: prepared.confirmToken,
      nowMs: 202
    });

    expect(mockGuard).toHaveBeenCalledTimes(1);
    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("executed");

    const row = db.getPreparedActionById(prepared.preparedActionId);
    expect(row).toBeDefined();
    expect(row?.status).toBe("executed");
  });

  it("works normally when sessionGuard is not configured", async () => {
    const executeSpy = vi.spyOn(TestEchoActionExecutor.prototype, "execute");
    const serviceWithoutGuard = new TwoPhaseCommitService(db, {
      executors: {
        [TEST_ECHO_ACTION_TYPE]: new TestEchoActionExecutor()
      },
      getRuntime: () => ({})
    });

    const prepared = serviceWithoutGuard.prepare({
      actionType: TEST_ECHO_ACTION_TYPE,
      target: { profile_name: "default" },
      payload: { text: "hello" },
      preview: { summary: "Echo hello" }
    });

    expect(prepared.confirmToken.startsWith("ct_")).toBe(true);
    expect(generateConfirmToken(8)).toMatch(/^ct_/);

    const result = await serviceWithoutGuard.confirmByToken({
      confirmToken: prepared.confirmToken,
      nowMs: 303
    });

    expect(result.status).toBe("executed");
    expect(executeSpy).toHaveBeenCalledTimes(1);

    const row = db.getPreparedActionById(prepared.preparedActionId);
    expect(row).toBeDefined();
    expect(row?.status).toBe("executed");
  });

  it("passes actionType, actionId, and nowMs to the guard", async () => {
    const prepared = prepareEchoAction();
    const nowMs = 404;
    const expectedContext: SessionGuardContext = {
      actionType: TEST_ECHO_ACTION_TYPE,
      actionId: prepared.preparedActionId,
      nowMs
    };

    await tpc.confirmByToken({ confirmToken: prepared.confirmToken, nowMs });

    expect(mockGuard).toHaveBeenCalledTimes(1);
    expect(mockGuard).toHaveBeenCalledWith(expectedContext);
  });

  it("retains guard_source details for guard AUTH_REQUIRED errors", async () => {
    mockGuard.mockRejectedValueOnce(
      new LinkedInBuddyError("AUTH_REQUIRED", "Guard blocked execution", {
        guard_source: "session_guard"
      })
    );
    const prepared = prepareEchoAction();

    await expect(
      tpc.confirmByToken({ confirmToken: prepared.confirmToken, nowMs: 505 })
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
      details: {
        guard_source: "session_guard"
      }
    });
  });

  it("does not add guard_source details for executor errors", async () => {
    mockGuard.mockResolvedValueOnce(undefined);
    vi.spyOn(TestEchoActionExecutor.prototype, "execute").mockImplementation(() => {
      throw new LinkedInBuddyError("TIMEOUT", "Executor timed out", {
        executor_source: "test_executor"
      });
    });
    const prepared = prepareEchoAction();

    try {
      await tpc.confirmByToken({ confirmToken: prepared.confirmToken, nowMs: 606 });
      expect.unreachable("Expected confirmByToken to throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(LinkedInBuddyError);
      if (!(error instanceof LinkedInBuddyError)) {
        return;
      }
      expect(error.code).toBe("TIMEOUT");
      expect(error.details).not.toHaveProperty("guard_source");
      expect(error.details).toMatchObject({ executor_source: "test_executor" });
    }
  });
});
