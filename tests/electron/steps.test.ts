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

import { listAgentProblems, toProblemRow } from "../../src/electron/libs/steps";
import { activeProfile, getProfileSecret } from "../../src/electron/libs/profiles.js";

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const failedStep = (extra: Record<string, unknown> = {}) => ({
  id: "step-7",
  status: "failed",
  error_type: "llm_api_error",
  stop_reason: "error",
  origin: "schedule",
  created_at: "2026-10-12T00:20:00Z",
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

describe("toProblemRow", () => {
  it("projects a failed step to the bridge-safe row", () => {
    expect(toProblemRow("agent-1", failedStep())).toEqual({
      agentId: "agent-1",
      stepId: "step-7",
      errorType: "llm_api_error",
      stopReason: "error",
      origin: "schedule",
      failedAt: "2026-10-12T00:20:00Z",
    });
  });

  it("ignores steps that did not fail", () => {
    expect(toProblemRow("agent-1", failedStep({ status: "success" }))).toBeNull();
    expect(toProblemRow("agent-1", failedStep({ status: null }))).toBeNull();
  });

  it("defaults missing optionals rather than passing undefined across the bridge", () => {
    expect(toProblemRow("agent-1", failedStep({ error_type: undefined, origin: undefined })))
      .toMatchObject({ errorType: null, origin: null });
  });
});

describe("listAgentProblems", () => {
  it("calls the steps REST endpoint with the bearer token and agent filter", async () => {
    fetchMock.mockResolvedValue(okResponse([]));
    await listAgentProblems("agent-9");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("https://api.letta.com/v1/steps/?")).toBe(true);
    expect(url).toContain("agent_id=agent-9");
    expect(url).toContain("order=desc");
    expect(init.headers).toMatchObject({ Authorization: "Bearer token-1" });
  });

  it("returns the latest failed step, skipping newer successful ones", async () => {
    fetchMock.mockResolvedValue(
      okResponse([failedStep({ id: "step-8", status: "success" }), failedStep()]),
    );
    const row = await listAgentProblems("agent-1");
    expect(row?.stepId).toBe("step-7");
  });

  it("is null when recent steps all succeeded", async () => {
    fetchMock.mockResolvedValue(
      okResponse([failedStep({ id: "step-8", status: "success" })]),
    );
    expect(await listAgentProblems("agent-1")).toBeNull();
  });

  it("honestly yields nothing for a non-cloud profile", async () => {
    vi.mocked(activeProfile).mockImplementation(() => null);
    expect(await listAgentProblems("agent-1")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on a non-ok response — no silent fallback", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    await expect(listAgentProblems("agent-1")).rejects.toThrow("Could not load steps");
  });

  it("throws on an unexpected response shape", async () => {
    fetchMock.mockResolvedValue(okResponse({ not: "an array" }));
    await expect(listAgentProblems("agent-1")).rejects.toThrow("Unexpected steps response");
  });
});
