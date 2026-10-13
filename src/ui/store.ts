import { create } from "zustand";
import { mergeHistory, optimisticUserRow, rowIdentity, upsertRows } from "./lib/rows";
import type {
  AgentSummary,
  AgentUpdate,
  AppEvent,
  AttachmentView,
  AppSettings,
  TestResult,
  ApprovalDecision,
  ApprovalRequest,
  ChatRow,
  ChatTextRow,
  ComputerSelectorField,
  ComputerSummary,
  ConversationEnv,
  ConnectionState,
  ConversationSummary,
  HomeState,
  MemoryFile,
  ModelOption,
  ProfileSave,
  ProfileSummary,
  ProfilesResult,
  ProviderSummary,
  SettingsUpdate,
} from "./types";

const api = window.bridge;

/** Key for the chat that has not been sent yet. */
export const NEW_CHAT = "new";
const HISTORY_PAGE = 100;

export type ChatState = {
  rows: ChatRow[];
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  limit: number;
  running: boolean;
  activity: string | null;
  error: string | null;
  /** Stamped on receipt so the home cards can show age/staleness. */
  approvals: StampedApproval[];
  queue: { id: string; text: string }[];
};

/** An approval plus when this client learned of it. */
export type StampedApproval = ApprovalRequest & { receivedAt: number };

export type MemoryState = {
  loading: boolean;
  error: string | null;
  /** False for agents that do not use file-based memory. */
  enabled: boolean;
  files: MemoryFile[];
};

export type SettingsTab = "connection" | "providers";

const EMPTY_CHAT: ChatState = {
  rows: [],
  loaded: false,
  loading: false,
  hasMore: false,
  limit: HISTORY_PAGE,
  running: false,
  activity: null,
  error: null,
  approvals: [],
  queue: [],
};

type AppState = {
  settings: AppSettings | null;
  connection: ConnectionState | null;
  /** Connection profiles; the built-in local connection is not in this list. */
  profiles: ProfileSummary[];
  profilesLoaded: boolean;
  agents: AgentSummary[];
  agentsLoaded: boolean;
  agentId: string | null;
  models: ModelOption[];
  /** null until loaded, or when the backend manages providers itself. */
  providers: ProviderSummary[] | null;
  /** What the main area shows for the selected agent. */
  view: "home" | "chat" | "memory";
  /** The home view's section data (home is the launch view). */
  home: HomeState;
  memory: MemoryState | null;
  conversations: ConversationSummary[];
  conversationsLoaded: boolean;
  /** null is the new, unsent chat. */
  activeId: string | null;
  chats: Record<string, ChatState>;
  /** Unsent composer text per chat. */
  drafts: Record<string, string>;
  /** Working directory and model picked in the composer but not yet sent. */
  cwdOverrides: Record<string, string>;
  modelOverrides: Record<string, string>;
  /** Environment choice per conversation — the menu's source of truth. */
  conversationEnvs: Record<string, ConversationEnv>;
  /** Cloud computers for the environment menu (loaded lazily on open). */
  computers: ComputerSummary[];
  computersLoading: boolean;
  computersError: string | null;
  /** The first message of a new chat, shown while its conversation is created. */
  pendingFirstMessage: ChatTextRow | null;
  notice: string | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  newAgentOpen: boolean;
  agentSettingsOpen: boolean;

  bootstrap: () => Promise<void>;
  handleEvent: (event: AppEvent) => void;
  /** Internal: apply a profiles round trip to the store. */
  applyProfiles: (result: ProfilesResult) => void;
  loadProfiles: () => Promise<void>;
  /** Run a connection test against a profile's stored credential; the row shows the verdict. */
  testProfileConnection: (profileId: string) => Promise<TestResult>;
  toggleProfilePin: (profileId: string) => Promise<void>;
  switchProfile: (profileId: string | null) => Promise<void>;
  saveProfile: (input: ProfileSave) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  signOutProfile: (profileId: string) => Promise<void>;
  /** Sign in with Letta; targets an existing profile or creates a new one. */
  oauthSignIn: (profileId?: string) => Promise<ProfileSummary>;
  refreshAgents: () => Promise<void>;
  selectAgent: (agentId: string) => Promise<void>;
  createAgent: (input: { name: string; model?: string }) => Promise<void>;
  updateAgent: (update: AgentUpdate) => Promise<AgentSummary>;
  deleteAgent: () => Promise<void>;
  openChat: (conversationId: string | null) => void;
  /** One tap behind every home row that has no conversation of its own. */
  openAgentLatest: (agentId: string) => Promise<void>;
  /** Show the home view (the launch view). */
  goHome: () => void;
  /** Load the home's live sections; each records its own provenance. */
  refreshHome: () => Promise<void>;
  /** Load one conversation's environment choice into the mirror. */
  loadConversationEnv: (conversationId: string) => Promise<void>;
  /** Refresh the cloud computers list for the environment menu. */
  refreshComputers: () => Promise<void>;
  /**
   * Pick the environment for the active conversation: null = Cloud Sandbox.
   * Blocked while the turn is running — per-turn sessions mean the pick
   * applies to the next send, so changing it mid-run would mislead.
   */
  pickEnvironment: (
    selector: ComputerSelectorField | null,
    asDefault?: boolean,
  ) => Promise<void>;
  loadHistory: (conversationId: string, limit?: number) => Promise<void>;
  /** True when the message actually went out; false when gated or failed. */
  send: (text: string, attachments?: AttachmentView[]) => Promise<boolean>;
  stop: () => void;
  respondApproval: (requestId: string, decision: ApprovalDecision) => void;
  /** Same machinery as respondApproval, for a card that is not the active chat. */
  respondApprovalFor: (
    conversationId: string,
    requestId: string,
    decision: ApprovalDecision,
  ) => void;
  removeQueued: (conversationId: string, itemId: string) => void;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  archiveConversation: (conversationId: string) => Promise<void>;
  saveSettings: (update: SettingsUpdate) => Promise<void>;
  loadProviders: () => Promise<void>;
  connectProvider: (input: {
    providerId: string;
    authMethodId?: string;
    fields: Record<string, string>;
  }) => Promise<void>;
  disconnectProvider: (input: { providerId: string; providerName?: string }) => Promise<void>;
  openMemory: () => void;
  loadMemory: () => Promise<void>;
  saveMemoryFile: (path: string, content: string) => Promise<void>;
  deleteMemoryFile: (path: string) => Promise<void>;
  openSettings: (tab: SettingsTab) => void;
  reconnect: () => void;
  pickCwd: () => Promise<void>;
  pickImages: () => Promise<{ attachments: AttachmentView[]; skipped: string[] }>;
  setCwd: (cwd: string) => void;
  setModel: (handle: string) => void;
  setDraft: (text: string) => void;
  setNotice: (notice: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean) => void;
  setAgentSettingsOpen: (open: boolean) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patchChat(
  state: AppState,
  conversationId: string,
  patch: (chat: ChatState) => Partial<ChatState>,
): Pick<AppState, "chats"> {
  const chat = state.chats[conversationId] ?? EMPTY_CHAT;
  return { chats: { ...state.chats, [conversationId]: { ...chat, ...patch(chat) } } };
}

function upsertConversation(
  list: ConversationSummary[],
  conversation: ConversationSummary,
): ConversationSummary[] {
  return [conversation, ...list.filter((item) => item.id !== conversation.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

/** Both home sections start honestly "loading" until their fetch lands. */
const HOME_INITIAL: HomeState = {
  agents: { status: "loading", rows: [], provenance: null, error: null },
  schedules: { status: "loading", rows: [], provenance: null, error: null },
  needsYou: { status: "loading", rows: [], provenance: null, error: null },
  completed: { status: "loading", rows: [], provenance: null, error: null },
  problems: { status: "loading", rows: [], provenance: null, error: null },
};

const CLEARED = {
  agents: [],
  agentsLoaded: false,
  agentId: null,
  models: [],
  providers: null,
  view: "home",
  home: HOME_INITIAL,
  memory: null,
  conversations: [],
  conversationsLoaded: false,
  activeId: null,
  chats: {},
  conversationEnvs: {},
  computers: [],
  computersLoading: false,
  computersError: null,
  pendingFirstMessage: null,
} satisfies Partial<AppState>;


export const useAppStore = create<AppState>((set, get) => ({
  settings: null,
  connection: null,
  profiles: [],
  profilesLoaded: false,
  ...CLEARED,
  drafts: {},
  cwdOverrides: {},
  modelOverrides: {},
  notice: null,
  settingsOpen: false,
  settingsTab: "connection",
  newAgentOpen: false,
  agentSettingsOpen: false,

  bootstrap: async () => {
    // listProfiles returns settings + profiles in one snapshot, so the two
    // can never disagree about which profile is active.
    const [profileState, connection] = await Promise.all([
      api.listProfiles(),
      api.getConnection(),
    ]);
    set({
      settings: profileState.settings,
      profiles: profileState.profiles,
      profilesLoaded: true,
    });
    get().handleEvent({ type: "connection", state: connection });
  },

  handleEvent: (event) => {
    switch (event.type) {
      case "connection": {
        const previous = get().connection;
        set({ connection: event.state });
        if (event.state.status === "ready" && previous?.status !== "ready") {
          void get().refreshAgents();
          void get().refreshHome();
        } else if (event.state.status !== "ready" && previous?.status === "ready") {
          // Agents and conversations belong to the backend that just went away.
          set(CLEARED);
        }
        break;
      }
      case "turn.started":
        set((state) =>
          patchChat(state, event.conversationId, () => ({
            running: true,
            error: null,
            activity: "Starting",
          })),
        );
        break;
      case "turn.rows":
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            rows: upsertRows(chat.rows, event.rows),
          })),
        );
        break;
      case "turn.rows.removed": {
        const removed = new Set(event.keys);
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            rows: chat.rows.filter((row) => !removed.has(row.key)),
          })),
        );
        break;
      }
      case "turn.activity":
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            activity: event.activity,
            // Server-authoritative "resolved elsewhere": the runtime only
            // reports Responding (post-tool generation) after every pending
            // approval of this turn has been resolved — and no new approval
            // can fire mid-generation. If cards are still up, another client
            // resolved them; drop them rather than let a dead card linger.
            approvals:
              event.activity === "Responding" && chat.approvals.length > 0
                ? []
                : chat.approvals,
          })),
        );
        break;
      case "turn.queue":
        set((state) =>
          patchChat(state, event.conversationId, () => ({ queue: event.queue })),
        );
        break;
      case "turn.finished":
        set((state) =>
          patchChat(state, event.conversationId, () => ({
            running: false,
            activity: null,
            approvals: [],
            error: event.error ?? null,
          })),
        );
        // The user watched this turn finish — it counts as looked at (§3.4:
        // ordinary completion noise is the failure mode, not the goal).
        if (event.conversationId === get().activeId) {
          void api.markConversationRead(event.conversationId);
        }
        // The agent may have rewritten its memory during the turn.
        if (get().view === "memory") void get().loadMemory();
        break;
      case "approval.requested":
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            approvals: [
              ...chat.approvals.filter((item) => item.requestId !== event.request.requestId),
              { ...event.request, receivedAt: Date.now() },
            ],
          })),
        );
        break;
      case "approval.resolved":
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            approvals: chat.approvals.filter((item) => item.requestId !== event.requestId),
          })),
        );
        break;
      case "conversation.updated":
        if (event.conversation.agentId !== get().agentId) break;
        set((state) => ({
          conversations: upsertConversation(state.conversations, event.conversation),
        }));
        break;
      case "menu":
        if (event.command === "new-chat") get().openChat(null);
        else get().openSettings("connection");
        break;
      case "profile.signed-out": {
        const profile = get().profiles.find((item) => item.id === event.profileId);
        set({
          notice: `Signed out of ${profile?.name ?? "Letta Cloud"} — sign in again to reconnect.`,
        });
        void get().loadProfiles();
        break;
      }
    }
  },

  applyProfiles: (result: ProfilesResult) => {
    set({ settings: result.settings, profiles: result.profiles, profilesLoaded: true });
  },

  loadProfiles: async () => {
    get().applyProfiles(await api.listProfiles());
  },

  // The main process reconnects on these; the renderer follows through
  // `connection` events (agents/conversations clear and reload on ready).
  testProfileConnection: async (profileId) => {
    const verdict = await api.testProfileConnection(profileId);
    // Refresh so the row's status dot reflects the persisted verdict.
    get().applyProfiles(await api.listProfiles());
    return verdict;
  },

  toggleProfilePin: async (profileId) => {
    get().applyProfiles(await api.toggleProfilePin(profileId));
  },

  switchProfile: async (profileId) => {
    get().applyProfiles(await api.setActiveProfile(profileId));
  },

  saveProfile: async (input) => {
    get().applyProfiles(await api.saveProfile(input));
  },

  deleteProfile: async (profileId) => {
    get().applyProfiles(await api.deleteProfile(profileId));
  },

  signOutProfile: async (profileId) => {
    get().applyProfiles(await api.signOutProfile(profileId));
  },

  oauthSignIn: async (profileId) => {
    const result = await api.oauthSignIn(profileId);
    if (!result.ok) throw new Error(result.error);
    get().applyProfiles(result);
    return result.profile;
  },

  refreshAgents: async () => {
    try {
      const [agents, settings] = await Promise.all([api.listAgents(), api.getSettings()]);
      set({ agents, agentsLoaded: true, settings });
      void api
        .listModels()
        .then((models) => set({ models }))
        .catch(() => undefined);
      const connection = get().connection;
      if (connection?.status === "ready" && connection.providers) void get().loadProviders();

      const agentId =
        agents.find((agent) => agent.id === settings.agentId)?.id ?? agents[0]?.id ?? null;
      if (agentId) await get().selectAgent(agentId);
      else {
        set({
          agentId: null,
          conversations: [],
          conversationsLoaded: true,
          activeId: null,
          // No agents to chat with — home is the honest landing.
          view: "home",
          memory: null,
        });
      }
    } catch (error) {
      set({ agentsLoaded: true, notice: errorMessage(error) });
    }
  },

  selectAgent: async (agentId) => {
    set({
      agentId,
      conversations: [],
      conversationsLoaded: false,
      activeId: null,
      pendingFirstMessage: null,
      view: "chat",
      memory: null,
    });
    void api
      .updateSettings({ agentId })
      .then((settings) => set({ settings }))
      .catch(() => undefined);
    try {
      const conversations = await api.listConversations(agentId);
      if (get().agentId === agentId) set({ conversations, conversationsLoaded: true });
    } catch (error) {
      if (get().agentId === agentId) {
        set({ conversationsLoaded: true, notice: errorMessage(error) });
      }
    }
  },

  createAgent: async (input) => {
    const agent = await api.createAgent(input);
    set((state) => ({ agents: [agent, ...state.agents.filter((item) => item.id !== agent.id)] }));
    await get().selectAgent(agent.id);
  },

  // Update and delete reject on failure so the dialog can show the reason.
  updateAgent: async (update) => {
    const { agentId } = get();
    if (!agentId) throw new Error("No agent is selected.");
    const agent = await api.updateAgent(agentId, update);
    set((state) => ({
      agents: state.agents.map((item) => (item.id === agent.id ? agent : item)),
    }));
    return agent;
  },

  deleteAgent: async () => {
    const { agentId } = get();
    if (!agentId) return;
    await api.deleteAgent(agentId);
    set({ agentSettingsOpen: false });
    // Picks another agent, or shows the "create your first agent" screen.
    await get().refreshAgents();
  },

  openChat: (conversationId) => {
    set({ activeId: conversationId, view: "chat" });
    if (!conversationId) return;
    const chat = get().chats[conversationId];
    if (!chat?.loaded && !chat?.loading) void get().loadHistory(conversationId);
    void get().loadConversationEnv(conversationId);
    // Looking advances the read cursor (§3.3) — app-owned, in main.
    if (conversationId) void api.markConversationRead(conversationId);
  },

  openAgentLatest: async (agentId) => {
    const conversations = await api.listConversations(agentId);
    if (conversations[0]) get().openChat(conversations[0].id);
  },

  goHome: () => {
    set({ view: "home" });
  },

  refreshHome: async () => {
    // Each section records its own truth: what it fetched, how, and when.
    // A failure in one section never blanks the other.
    const [
      agentsResult,
      schedulesResult,
      approvalsResult,
      completedResult,
      problemsResult,
    ] = await Promise.allSettled([
      api.listAgents(),
      api.listSchedules(),
      api.listPendingApprovals(),
      api.listCompletedSinceLastLook(),
      api.listProblems(),
    ]);
    const fetchedAt = Date.now();
    set(() => ({
      home: {
        agents:
          agentsResult.status === "fulfilled"
            ? {
                status: "ready",
                rows: agentsResult.value,
                provenance: { source: "live", fetchedAt },
                error: null,
              }
            : {
                status: "error",
                rows: [],
                provenance: null,
                error: errorMessage(agentsResult.reason),
              },
        schedules:
          schedulesResult.status === "fulfilled"
            ? {
                status: "ready",
                rows: schedulesResult.value,
                provenance: { source: "rest", fetchedAt },
                error: null,
              }
            : {
                status: "error",
                rows: [],
                provenance: null,
                error: errorMessage(schedulesResult.reason),
              },
        needsYou:
          approvalsResult.status === "fulfilled"
            ? {
                status: "ready",
                rows: approvalsResult.value,
                provenance: { source: "live", fetchedAt },
                error: null,
              }
            : {
                status: "error",
                rows: [],
                provenance: null,
                error: errorMessage(approvalsResult.reason),
              },
        completed:
          completedResult.status === "fulfilled"
            ? {
                status: "ready",
                rows: completedResult.value,
                provenance: { source: "live", fetchedAt },
                error: null,
              }
            : {
                status: "error",
                rows: [],
                provenance: null,
                error: errorMessage(completedResult.reason),
              },
        problems:
          problemsResult.status === "fulfilled"
            ? {
                status: "ready",
                rows: problemsResult.value,
                provenance: { source: "rest", fetchedAt },
                error: null,
              }
            : {
                status: "error",
                rows: [],
                provenance: null,
                error: errorMessage(problemsResult.reason),
              },
      },
    }));
    // Schedule rows show the configured target's online status; computers
    // load lazily elsewhere, so a cloud home refresh ensures they are in.
    if (schedulesResult.status === "fulfilled" && schedulesResult.value.length > 0) {
      void get().refreshComputers();
    }
  },

  loadConversationEnv: async (conversationId) => {
    const env = await api.getConversationEnv(conversationId);
    set((state) => ({ conversationEnvs: { ...state.conversationEnvs, [conversationId]: env } }));
  },

  refreshComputers: async () => {
    set({ computersLoading: true, computersError: null });
    try {
      set({ computers: await api.listComputers(), computersLoading: false });
    } catch (error) {
      set({
        computers: [],
        computersLoading: false,
        computersError: error instanceof Error ? error.message : "Couldn't load computers.",
      });
    }
  },

  pickEnvironment: async (selector, asDefault) => {
    const conversationId = get().activeId;
    if (!conversationId) return;
    if (get().chats[conversationId]?.running) {
      set({ notice: "Wait for the current run to finish before changing the environment." });
      return;
    }
    try {
      const env = await api.setConversationEnv(conversationId, selector);
      set((state) => ({
        conversationEnvs: { ...state.conversationEnvs, [conversationId]: env },
      }));
      if (asDefault) get().applyProfiles(await api.setProfileEnvDefault(selector));
    } catch (error) {
      set({
        notice: error instanceof Error ? error.message : "Couldn't save the environment choice.",
      });
    }
  },

  loadHistory: async (conversationId, limit) => {
    const pageSize = limit ?? get().chats[conversationId]?.limit ?? HISTORY_PAGE;
    set((state) => patchChat(state, conversationId, () => ({ loading: true, limit: pageSize })));
    try {
      const history = await api.loadHistory(conversationId, pageSize);
      set((state) =>
        patchChat(state, conversationId, (chat) => ({
          rows: mergeHistory(history.rows, chat.rows),
          loaded: true,
          loading: false,
          hasMore: history.hasMore,
          running: history.running,
          activity: history.running ? (chat.activity ?? history.activity) : null,
          approvals: history.approvals.map((request) => ({
            ...request,
            receivedAt: Date.now(),
          })),
        })),
      );
    } catch (error) {
      set((state) =>
        patchChat(state, conversationId, () => ({
          loaded: true,
          loading: false,
          error: errorMessage(error),
        })),
      );
    }
  },

  send: async (rawText, attachments = []) => {
    const text = rawText.trim();
    const state = get();
    const { agentId, activeId } = state;
    if ((!text && attachments.length === 0) || !agentId) return false;
    let sent = false;
    const key = activeId ?? NEW_CHAT;
    // Mid-run sends queue server-side for EXISTING conversations — do not
    // gate on running there (PR #8; matches the runtime change). The
    // first-message path still needs its single-flight guard.
    if (activeId ? false : state.pendingFirstMessage) return false;

    const otid = crypto.randomUUID();
    const userRow = optimisticUserRow(text, otid, attachments);
    const cwd = selectCwd(state, key);
    const pickedModel = state.modelOverrides[key];
    const currentModel = state.conversations.find((item) => item.id === activeId)?.model;
    const model = pickedModel && pickedModel !== currentModel ? pickedModel : undefined;

    const clearComposer = (id: string) => (current: AppState) => {
      const drafts = { ...current.drafts };
      const cwdOverrides = { ...current.cwdOverrides };
      const modelOverrides = { ...current.modelOverrides };
      delete drafts[id];
      delete cwdOverrides[id];
      delete modelOverrides[id];
      return { drafts, cwdOverrides, modelOverrides };
    };

    if (activeId) {
      set((current) => ({
        ...clearComposer(activeId)(current),
        ...patchChat(current, activeId, (chat) => ({
          rows: upsertRows(chat.rows, [userRow]),
          running: true,
          error: null,
          activity: "Starting",
        })),
      }));
    } else {
      set((current) => ({ ...clearComposer(NEW_CHAT)(current), pendingFirstMessage: userRow }));
    }

    try {
      const conversation = await api.sendMessage({
        agentId,
        conversationId: activeId,
        text,
        otid,
        cwd,
        ...(model ? { model } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      set((current) => ({
        conversations: upsertConversation(current.conversations, {
          ...conversation,
          model: model ?? conversation.model,
        }),
        ...(activeId
          ? {}
          : {
              // The turn may already be streaming into this conversation; the
              // first message always leads it.
              ...patchChat(current, conversation.id, (chat) => ({
                rows: upsertRows([userRow], chat.rows),
                loaded: true,
              })),
              pendingFirstMessage: null,
              activeId:
                current.pendingFirstMessage === userRow && current.activeId === null
                  ? conversation.id
                  : current.activeId,
            }),
      }));
      sent = true;
    } catch (error) {
      // Nothing was sent: put the message back in the composer.
      set((current) => ({
        drafts: { ...current.drafts, [key]: current.drafts[key] || text },
        notice: errorMessage(error),
        ...(activeId
          ? patchChat(current, activeId, (chat) => ({
              rows: chat.rows.filter((row) => rowIdentity(row) !== rowIdentity(userRow)),
              running: false,
              activity: null,
            }))
          : { pendingFirstMessage: null }),
      }));
    }
    return sent;
  },

  stop: () => {
    const { activeId } = get();
    if (activeId) void api.stopTurn(activeId);
  },

  respondApproval: (requestId, decision) => {
    const { activeId } = get();
    if (!activeId) return;
    set((state) =>
      patchChat(state, activeId, (chat) => ({
        approvals: chat.approvals.filter((item) => item.requestId !== requestId),
      })),
    );
    void api.respondApproval(activeId, requestId, decision);
  },

  respondApprovalFor: (conversationId, requestId, decision) => {
    set((state) =>
      patchChat(state, conversationId, (chat) => ({
        approvals: chat.approvals.filter((item) => item.requestId !== requestId),
      })),
    );
    void api.respondApproval(conversationId, requestId, decision);
  },

  removeQueued: (conversationId, itemId) => {
    // Optimistic-hide; the server's next queue_update confirms (or restores).
    set((state) =>
      patchChat(state, conversationId, (chat) => ({
        queue: chat.queue.filter((item) => item.id !== itemId),
      })),
    );
    void api.removeQueuedMessage(conversationId, itemId);
  },

  renameConversation: async (conversationId, title) => {
    try {
      const conversation = await api.renameConversation(conversationId, title);
      set((state) => ({
        conversations: state.conversations.map((item) =>
          item.id === conversationId ? { ...item, title: conversation.title } : item,
        ),
      }));
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  archiveConversation: async (conversationId) => {
    try {
      await api.archiveConversation(conversationId);
      set((state) => {
        const chats = { ...state.chats };
        delete chats[conversationId];
        return {
          chats,
          conversations: state.conversations.filter((item) => item.id !== conversationId),
          activeId: state.activeId === conversationId ? null : state.activeId,
        };
      });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  saveSettings: async (update) => {
    set({ settings: await api.updateSettings(update) });
  },

  loadProviders: async () => {
    try {
      set({ providers: await api.listProviders() });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  // Connect and disconnect reject on failure so the form can show the reason.
  connectProvider: async (input) => {
    set({ providers: await api.connectProvider(input) });
    set({ models: await api.listModels(true) });
  },

  disconnectProvider: async (input) => {
    set({ providers: await api.disconnectProvider(input) });
    set({ models: await api.listModels(true) });
  },

  openMemory: () => {
    set({ view: "memory" });
    void get().loadMemory();
  },

  loadMemory: async () => {
    const { agentId } = get();
    if (!agentId) return;
    set((state) => ({
      memory: { ...(state.memory ?? { enabled: true, files: [] }), loading: true, error: null },
    }));
    try {
      const overview = await api.listMemory(agentId);
      if (get().agentId === agentId) set({ memory: { ...overview, loading: false, error: null } });
    } catch (error) {
      if (get().agentId !== agentId) return;
      set((state) => ({
        memory: {
          enabled: state.memory?.enabled ?? true,
          files: state.memory?.files ?? [],
          loading: false,
          error: errorMessage(error),
        },
      }));
    }
  },

  saveMemoryFile: async (path, content) => {
    const { agentId } = get();
    if (!agentId) return;
    await api.writeMemoryFile(agentId, path, content);
    await get().loadMemory();
  },

  deleteMemoryFile: async (path) => {
    const { agentId } = get();
    if (!agentId) return;
    await api.deleteMemoryFile(agentId, path);
    await get().loadMemory();
  },

  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab }),

  reconnect: () => {
    void api.reconnect();
  },

  pickCwd: async () => {
    const directory = await api.selectDirectory();
    if (directory) get().setCwd(directory);
  },
  pickImages: async () => {
    const picked = await api.selectImages();
    if (picked.skipped.length > 0) get().setNotice(picked.skipped.join("\n"));
    return picked;
  },

  setCwd: (cwd) =>
    set((state) => ({
      cwdOverrides: { ...state.cwdOverrides, [state.activeId ?? NEW_CHAT]: cwd },
    })),

  setModel: (handle) =>
    set((state) => ({
      modelOverrides: { ...state.modelOverrides, [state.activeId ?? NEW_CHAT]: handle },
    })),

  setDraft: (text) =>
    set((state) => ({ drafts: { ...state.drafts, [state.activeId ?? NEW_CHAT]: text } })),

  setNotice: (notice) => set({ notice }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setNewAgentOpen: (newAgentOpen) => set({ newAgentOpen }),
  setAgentSettingsOpen: (agentSettingsOpen) => set({ agentSettingsOpen }),
}));

// --- Selectors --------------------------------------------------------------

type Selectable = Pick<
  AppState,
  "settings" | "conversations" | "cwdOverrides" | "modelOverrides" | "agents" | "agentId"
>;

/** Working directory the next message in a chat will run in. */
export function selectCwd(state: Selectable, key: string): string {
  return (
    state.cwdOverrides[key] ??
    state.conversations.find((item) => item.id === key)?.cwd ??
    state.settings?.recentCwds[0] ??
    state.settings?.defaultCwd ??
    ""
  );
}

/** Model the next message in a chat will use. */
export function selectModel(state: Selectable, key: string): string | null {
  return (
    state.modelOverrides[key] ??
    state.conversations.find((item) => item.id === key)?.model ??
    state.agents.find((agent) => agent.id === state.agentId)?.model ??
    null
  );
}

export { EMPTY_CHAT };
