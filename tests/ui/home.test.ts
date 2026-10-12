import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentSummary,
  AppSettings,
  ProfileSummary,
  ScheduleSummary,
} from "../../src/ui/types";

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

  it("starts both sections honestly loading", () => {
    const { home } = useAppStore.getState();
    expect(home.agents.status).toBe("loading");
    expect(home.schedules.status).toBe("loading");
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
  it("fills both sections with provenance lines", async () => {
    await useAppStore.getState().refreshHome();
    const { home } = useAppStore.getState();
    expect(home.agents.status).toBe("ready");
    expect(home.agents.rows).toEqual(agents);
    expect(home.agents.provenance).toMatchObject({ source: "live" });
    expect(home.schedules.status).toBe("ready");
    expect(home.schedules.rows).toEqual(schedules);
    expect(home.schedules.provenance).toMatchObject({ source: "rest" });
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
});
