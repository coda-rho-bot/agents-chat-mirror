import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSummary,
  CompletedRow,
  AppSettings,
  ProblemRow,
  ProfileSummary,
  ScheduleSummary,
} from "../../src/ui/types";
import { HOME_SECTION_TITLES, selectNeedsYouRows } from "../../src/ui/lib/home";

type Store = typeof import("../../src/ui/store");

const settings: AppSettings = {
  backend: "local",
  serverUrl: "",
  apiBaseUrl: "",
  hasApiKey: false,
  hasServerToken: false,
  activeProfileId: null,
  permissionMode: "standard",
  agentId: null,
  recentCwds: [],
  defaultCwd: "/home",
};

const profile: ProfileSummary = {
  id: "p-1",
  name: "Cloud",
  type: "cloud",
  url: "https://api.letta.com",
  authMethod: "oauth",
  hasCredential: true,
};

const agents: AgentSummary[] = [
  { id: "agent-1", name: "One", description: null, model: "provider/one" },
];

const schedules: ScheduleSummary[] = [
  {
    id: "sched-1",
    agentId: "agent-1",
    promptPreview: "Review the queue",
    nextScheduledTime: "2026-10-13T09:00:00Z",
    kind: "recurring",
    cronExpression: "0 9 * * *",
  },
];

const probedApprovals = [
  {
    conversationId: "conv-9",
    request: {
      requestId: "req-9",
      toolCallId: null,
      toolName: "Bash",
      input: { command: "deploy" },
      suggestions: [],
    },
    receivedAt: 1_000,
  },
];

const completedRows: CompletedRow[] = [
  {
    conversationId: "conv-1",
    agentId: "agent-1",
    messageId: "message-9",
    preview: "Deploy finished",
    completedAt: "2026-10-12T00:30:00Z",
  },
];

const problemRows: ProblemRow[] = [
  {
    agentId: "agent-1",
    stepId: "step-7",
    errorType: "llm_api_error",
    stopReason: "error",
    origin: null,
    failedAt: "2026-10-12T00:20:00Z",
  },
];

/** A bridge where every request resolves with something sensible. */
function createBridge() {
  return {
    platform: "darwin",
    onEvent: vi.fn(() => () => undefined),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => settings),
    getConnection: vi.fn(async () => ({ status: "connecting", backend: "local" })),
    reconnect: vi.fn(),
    listAgents: vi.fn(async () => agents),
    listSchedules: vi.fn(async () => schedules),
    listPendingApprovals: vi.fn(async () => probedApprovals),
    listCompletedSinceLastLook: vi.fn(async () => completedRows),
    listProblems: vi.fn(async () => problemRows),
    markConversationRead: vi.fn(async () => undefined),
    listProfiles: vi.fn(async () => ({
      settings,
      profiles: [profile],
      activeProfileId: "p-1",
    })),
  };
}

let bridge: ReturnType<typeof createBridge>;
let useAppStore: Store["useAppStore"];

beforeEach(async () => {
  bridge = createBridge();
  vi.stubGlobal("window", { bridge });
  vi.stubGlobal("crypto", { randomUUID: () => "otid-1" });
  vi.resetModules();
  ({ useAppStore } = await import("../../src/ui/store"));
});

describe("home view", () => {
  it("is the launch view", () => {
    expect(useAppStore.getState().view).toBe("home");
  });

  it("renders the canonical five sections, in order, with no duplicates", () => {
    const titles = Object.values(HOME_SECTION_TITLES);
    expect(titles).toEqual([
      "Needs you",
      "Completed since you last looked",
      "Problems",
      "Next scheduled",
      "Agents",
    ]);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("starts both sections honestly loading", () => {
    const { home } = useAppStore.getState();
    expect(home.agents.status).toBe("loading");
    expect(home.schedules.status).toBe("loading");
    expect(home.needsYou.status).toBe("loading");
    expect(home.completed.status).toBe("loading");
    expect(home.problems.status).toBe("loading");
  });

  it("goHome returns to home from a chat", () => {
    const store = useAppStore.getState();
    store.openChat(null);
    expect(useAppStore.getState().view).toBe("chat");
    useAppStore.getState().goHome();
    expect(useAppStore.getState().view).toBe("home");
  });
});

describe("refreshHome", () => {
  it("fills every section with provenance lines", async () => {
    await useAppStore.getState().refreshHome();
    const { home } = useAppStore.getState();
    expect(home.agents.status).toBe("ready");
    expect(home.agents.rows).toEqual(agents);
    expect(home.agents.provenance).toMatchObject({ source: "live" });
    expect(home.schedules.status).toBe("ready");
    expect(home.schedules.rows).toEqual(schedules);
    expect(home.schedules.provenance).toMatchObject({ source: "rest" });
    expect(home.needsYou.status).toBe("ready");
    expect(home.needsYou.rows).toEqual(probedApprovals);
    expect(home.needsYou.provenance).toMatchObject({ source: "live" });
    expect(home.completed.status).toBe("ready");
    expect(home.completed.rows).toEqual(completedRows);
    expect(home.completed.provenance).toMatchObject({ source: "live" });
    expect(home.problems.status).toBe("ready");
    expect(home.problems.rows).toEqual(problemRows);
    expect(home.problems.provenance).toMatchObject({ source: "rest" });
    expect(typeof home.agents.provenance?.fetchedAt).toBe("number");
  });

  it("keeps one section's failure from blanking the other", async () => {
    bridge.listAgents.mockRejectedValue(new Error("agents down"));
    await useAppStore.getState().refreshHome();
    const { home } = useAppStore.getState();
    expect(home.agents.status).toBe("error");
    expect(home.agents.error).toBe("agents down");
    expect(home.schedules.status).toBe("ready");
    expect(home.schedules.rows).toEqual(schedules);
    expect(home.needsYou.status).toBe("ready");
  });

  it("runs when the connection becomes ready", async () => {
    useAppStore.getState().handleEvent({
      type: "connection",
      state: { status: "ready", backend: "local", detail: "connected", providers: false },
    });
    await vi.waitFor(() => {
      expect(useAppStore.getState().home.agents.status).toBe("ready");
    });
    expect(bridge.listSchedules).toHaveBeenCalled();
  });

  it("feeds the probe into the Needs-you section", async () => {
    await useAppStore.getState().refreshHome();
    expect(bridge.listPendingApprovals).toHaveBeenCalled();
    expect(useAppStore.getState().home.needsYou.rows).toEqual(probedApprovals);
  });
});

describe("selectNeedsYouRows", () => {
  it("merges live and probed approvals, live winning on requestId, oldest first", () => {
    const chats = {
      "conv-1": {
        approvals: [
          {
            requestId: "req-2",
            toolCallId: null,
            toolName: "Bash",
            input: {},
            suggestions: [],
            receivedAt: 2_000,
          },
        ],
      },
    };
    const probed = [
      // Same requestId as the live row — live wins.
      {
        conversationId: "conv-1",
        request: { requestId: "req-2", toolCallId: null, toolName: "Bash", input: {}, suggestions: [] },
        receivedAt: 1_000,
      },
      ...probedApprovals,
    ];
    const rows = selectNeedsYouRows(chats, probed);
    expect(rows.map((row) => row.request.requestId)).toEqual(["req-9", "req-2"]);
    expect(rows.find((row) => row.request.requestId === "req-2")?.source).toBe("live");
  });
});
