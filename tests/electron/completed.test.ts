import { describe, expect, it } from "vitest";
import {
  contentText,
  newOutcomesSince,
  toCompletedRow,
  type WalkMessage,
} from "../../src/electron/libs/completed";

const assistant = (id: string, text: string, date: string): WalkMessage => ({
  id,
  message_type: "assistant_message",
  content: text,
  date,
});

const toolCall = (id: string): WalkMessage => ({
  id,
  message_type: "tool_call_message",
  content: null,
});

describe("contentText", () => {
  it("reads plain string content", () => {
    expect(contentText("Deploy finished")).toBe("Deploy finished");
  });

  it("joins text parts and ignores non-text parts", () => {
    expect(contentText([{ text: "a" }, { text: "b" }, {}])).toBe("a\nb");
  });

  it("is empty for missing content", () => {
    expect(contentText(undefined)).toBe("");
  });
});

describe("newOutcomesSince", () => {
  it("collects assistant messages before the cursor and stops at it", () => {
    const page = [
      assistant("m-3", "third", "2026-10-12T00:03:00Z"),
      toolCall("t-2"),
      assistant("m-2", "second", "2026-10-12T00:02:00Z"),
      assistant("m-1", "seen", "2026-10-12T00:01:00Z"),
    ];
    const fresh = newOutcomesSince(page, "m-1");
    expect(fresh.map((message) => message.id)).toEqual(["m-3", "m-2"]);
  });

  it("treats the whole page as new when the cursor is outside it", () => {
    const page = [assistant("m-3", "third", "2026-10-12T00:03:00Z")];
    expect(newOutcomesSince(page, "m-0")).toHaveLength(1);
  });

  it("treats everything as new with a null cursor (bounded by the page)", () => {
    const page = [assistant("m-3", "third", "2026-10-12T00:03:00Z")];
    expect(newOutcomesSince(page, null)).toHaveLength(1);
  });

  it("skips the technical lifecycle — tool calls are not outcomes", () => {
    expect(newOutcomesSince([toolCall("t-1")], null)).toEqual([]);
  });
});

describe("toCompletedRow", () => {
  it("is one row per conversation, carrying the latest outcome", () => {
    const row = toCompletedRow("conv-1", "agent-1", [
      assistant("m-3", "Deploy finished", "2026-10-12T00:03:00Z"),
      assistant("m-2", "earlier", "2026-10-12T00:02:00Z"),
    ]);
    expect(row).toMatchObject({
      conversationId: "conv-1",
      agentId: "agent-1",
      messageId: "m-3",
      preview: "Deploy finished",
      completedAt: "2026-10-12T00:03:00Z",
    });
  });

  it("falls back to honest copy when the outcome has no text", () => {
    const row = toCompletedRow("conv-1", "agent-1", [
      assistant("m-3", "   ", "2026-10-12T00:03:00Z"),
    ]);
    expect(row?.preview).toBe("Finished a turn");
  });

  it("is null when nothing new completed", () => {
    expect(toCompletedRow("conv-1", "agent-1", [])).toBeNull();
  });
});
