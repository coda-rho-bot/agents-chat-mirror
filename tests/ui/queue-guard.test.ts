import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBridge, AppSettings, AgentSummary, ConversationSummary } from "../../src/ui/types";

type Store = typeof import("../../src/ui/store");

const settings: AppSettings = {
  backend: "local", serverUrl: "", apiBaseUrl: "", hasApiKey: false, hasServerToken: false,
  activeProfileId: null,
  permissionMode: "standard", agentId: "agent-2", recentCwds: ["/recent"], defaultCwd: "/home",
};
const agents: AgentSummary[] = [
  { id: "agent-1", name: "One", description: null, model: "p/one" },
  { id: "agent-2", name: "Two", description: null, model: "p/two" },
];
const conversation = (id: string): ConversationSummary => ({
  id, title: "T", agentId: "agent-2", updatedAt: 1, archived: false, unread: 0, model: null, cwd: "/recent",
}) as ConversationSummary;

let bridge: AppBridge;
let useAppStore: Store["useAppStore"];
const state = () => useAppStore.getState();

async function connect() {
  (bridge.listConversations as ReturnType<typeof vi.fn>).mockResolvedValue([conversation("conv-1")]);
  await state().bootstrap();
}

beforeEach(async () => {
  bridge = {
    platform: "darwin",
    onEvent: vi.fn(() => () => undefined),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async () => settings),
    getConnection: vi.fn(async () => ({ status: "ready", backend: "local", detail: "d", providers: false })),
    reconnect: vi.fn(),
    listAgents: vi.fn(async () => agents),
    listSchedules: vi.fn(async () => []),
    listPendingApprovals: vi.fn(async () => []),
    listCompletedSinceLastLook: vi.fn(async () => []),
    listProblems: vi.fn(async () => []),
    markConversationRead: vi.fn(async () => undefined),
    listModels: vi.fn(async () => []),
    listProviders: vi.fn(async () => []),
    connectProvider: vi.fn(),
    disconnectProvider: vi.fn(),
    listMemory: vi.fn(async () => ({ enabled: true, files: [] })),
    listConversations: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(async () => conversation("conv-1")),
    listProfiles: vi.fn(async () => ({ settings, profiles: [], activeProfileId: null })),
  } as unknown as AppBridge;
  vi.stubGlobal("window", { bridge });
  vi.stubGlobal("crypto", { randomUUID: () => "otid-1" });
  vi.resetModules();
  ({ useAppStore } = await import("../../src/ui/store"));
});

describe("mid-run send (queue pane semantics)", () => {
  beforeEach(connect);

  it("a send while a turn runs REACHES the runtime — the queue feature must be reachable from the UI", async () => {
    useAppStore.setState({ activeId: "conv-1" });
    // A run is in flight (server-authoritative state).
    state().handleEvent({ type: "turn.started", conversationId: "conv-1" });

    await state().send("queued message");

    expect(bridge.sendMessage).toHaveBeenCalledTimes(1);
  });
});
