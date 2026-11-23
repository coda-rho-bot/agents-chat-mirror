import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const profileFixture = {
  id: "p-1",
  name: "Cloud",
  type: "cloud",
  url: "https://api.letta.com",
  authMethod: "oauth",
  createdAt: 1,
} as const;

vi.mock("../../src/electron/libs/profiles.js", () => ({
  activeProfile: vi.fn(() => profileFixture),
  getProfileSecret: vi.fn(async () => "token-1"),
}));

import {
  firstText,
  listAgentSchedules,
  mergeSchedules,
  toScheduleSummary,
} from "../../src/electron/libs/homeSections";
import type { ScheduleSummary } from "../../src/electron/types";
import { activeProfile, getProfileSecret } from "../../src/electron/libs/profiles.js";

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const rawMessage = (extra: Record<string, unknown> = {}) => ({
  id: "sched-1",
  agent_id: "agent-1",
  message: { messages: [{ content: "Review the queue" }] },
  next_scheduled_time: "2026-10-13T09:00:00Z",
  schedule: { type: "recurring", cron_expression: "0 9 * * *" },
  ...extra,
});

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  vi.mocked(activeProfile).mockImplementation(() => profileFixture);
  vi.mocked(getProfileSecret).mockImplementation(async () => "token-1");
});

describe("listAgentSchedules", () => {
  it("calls the cloud REST endpoint with the bearer token", async () => {
    fetchMock.mockResolvedValue(okResponse({ scheduled_messages: [] }));
    await listAgentSchedules("agent-9");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.letta.com/v1/agents/agent-9/schedule",
      expect.objectContaining({
        headers: { Authorization: "Bearer token-1" },
      }),
    );
  });

  it("projects recurring and one-time records", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        scheduled_messages: [
          rawMessage(),
          rawMessage({
            id: "sched-2",
            next_scheduled_time: null,
            schedule: { type: "one-time", scheduled_at: 1760000000 },
          }),
        ],
      }),
    });
    const schedules = await listAgentSchedules("agent-1");
    expect(schedules).toEqual([
      {
        id: "sched-1",
        agentId: "agent-1",
        promptPreview: "Review the queue",
        nextScheduledTime: "2026-10-13T09:00:00Z",
        kind: "recurring",
        cronExpression: "0 9 * * *",
      },
      {
        id: "sched-2",
        agentId: "agent-1",
        promptPreview: "Review the queue",
        nextScheduledTime: null,
        kind: "one-time",
        cronExpression: null,
      },
    ]);
  });

  it("throws on a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(listAgentSchedules("agent-1")).rejects.toThrow("503");
  });

  it("throws on an unexpected response shape", async () => {
    fetchMock.mockResolvedValue(okResponse({ scheduled_messages: "nope" }));
    await expect(listAgentSchedules("agent-1")).rejects.toThrow("Unexpected");
  });

  it("honestly yields empty for a non-cloud profile", async () => {
    vi.mocked(activeProfile).mockImplementation(() => null);
    expect(await listAgentSchedules("agent-1")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honestly yields empty when signed out", async () => {
    vi.mocked(getProfileSecret).mockImplementation(async () => null);
    expect(await listAgentSchedules("agent-1")).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("toScheduleSummary", () => {
  it("extracts prompt previews from string and array content", () => {
    expect(toScheduleSummary(rawMessage()).promptPreview).toBe("Review the queue");
    expect(
      toScheduleSummary(
        rawMessage({
          message: { messages: [{ content: [{ type: "text", text: "Array text" }] }] },
        }),
      ).promptPreview,
    ).toBe("Array text");
    expect(
      toScheduleSummary(rawMessage({ message: null })).promptPreview,
    ).toBe("");
  });
});

describe("firstText", () => {
  it("handles all content shapes", () => {
    expect(firstText("plain")).toBe("plain");
    expect(firstText([{ text: "a" }, { text: "b" }])).toBe("a");
    expect(firstText([{ no: "text" } as unknown as { text?: string }])).toBe("");
    expect(firstText(undefined)).toBe("");
  });
});

describe("mergeSchedules", () => {
  const row = (id: string, time: string | null): ScheduleSummary => ({
    id,
    agentId: "agent-1",
    promptPreview: "",
    nextScheduledTime: time,
    kind: "recurring",
    cronExpression: null,
  });

  it("sorts soonest first with unscheduled last", () => {
    const merged = mergeSchedules([
      [row("late", "2026-10-15T09:00:00Z"), row("none", null)],
      [row("soon", "2026-10-13T09:00:00Z")],
    ]);
    expect(merged.map((s) => s.id)).toEqual(["soon", "late", "none"]);
  });
});
