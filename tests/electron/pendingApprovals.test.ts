import { describe, expect, it, vi } from "vitest";
import type { SessionPendingControlRequest } from "@letta-ai/letta-agent-sdk";
import {
  probeConversation,
  projectControlRequests,
  toApprovalRequest,
} from "../../src/electron/libs/pendingApprovals.js";

const pending = {
  requestId: "req-1",
  toolName: "Bash",
  toolCallId: "call-1",
  toolInput: { command: "deploy" },
  permissionSuggestions: [{ id: "s-1", text: "Always allow deploy" }],
  blockedPath: null,
};

describe("toApprovalRequest", () => {
  it("projects the runtime control request to the app's approval shape", () => {
    expect(toApprovalRequest(pending)).toEqual({
      requestId: "req-1",
      toolCallId: "call-1",
      toolName: "Bash",
      input: { command: "deploy" },
      suggestions: [{ id: "s-1", text: "Always allow deploy" }],
    });
  });

  it("defaults missing optionals instead of passing undefined across the bridge", () => {
    // The wire payload can omit fields even when the declared type requires
    // them — the projection must not pass undefined across the bridge.
    expect(
      toApprovalRequest(
        {
          requestId: "req-2",
          toolName: "Bash",
          toolCallId: undefined,
          toolInput: undefined,
          permissionSuggestions: undefined,
          blockedPath: null,
        } as unknown as SessionPendingControlRequest,
      ),
    ).toEqual({
      requestId: "req-2",
      toolCallId: null,
      toolName: "Bash",
      input: {},
      suggestions: [],
    });
  });
});

describe("projectControlRequests", () => {
  it("stamps each pending request with its conversation and the probe time", () => {
    const rows = projectControlRequests(
      { pendingControlRequests: [pending] },
      "conv-1",
      1_234,
    );
    expect(rows).toEqual([
      {
        conversationId: "conv-1",
        request: toApprovalRequest(pending),
        receivedAt: 1_234,
      },
    ]);
  });

  it("returns empty for a snapshot with nothing pending", () => {
    expect(projectControlRequests({ pendingControlRequests: [] }, "conv-1")).toEqual([]);
  });
});

describe("probeConversation", () => {
  it("attaches a bare session, reads the status, and detaches", async () => {
    const close = vi.fn();
    const sdk = {
      resumeSession: vi.fn(() => ({
        getDeviceStatus: vi.fn(async () => ({ pendingControlRequests: [pending] })),
        close,
      })),
    };
    const rows = await probeConversation(sdk as never, "conv-1");
    expect(sdk.resumeSession).toHaveBeenCalledWith("conv-1");
    expect(rows[0]?.request.requestId).toBe("req-1");
    expect(close).toHaveBeenCalled();
  });

  it("detaches even when the status read fails, and lets the error propagate", async () => {
    const close = vi.fn();
    const sdk = {
      resumeSession: vi.fn(() => ({
        getDeviceStatus: vi.fn(async () => {
          throw new Error("socket died");
        }),
        close,
      })),
    };
    await expect(probeConversation(sdk as never, "conv-1")).rejects.toThrow("socket died");
    expect(close).toHaveBeenCalled();
  });
});
