/**
 * The contract between the Electron main process and the renderer.
 * Types only - the renderer imports this file with `import type`.
 */

import type { PermissionMode } from "@letta-ai/letta-agent-sdk";

export type { PermissionMode };

/**
 * Where agents live and where their tools run:
 * - local:  agents stored on this machine, tools run on this machine
 * - cloud:  agents stored in Letta Cloud, tools run on this machine
 * - remote: a self-hosted Letta app server owns both
 */
export type BackendKind = "local" | "cloud" | "remote";

export type AppSettings = {
  backend: BackendKind;
  serverUrl: string;
  apiBaseUrl: string;
  /** Secrets never leave the main process; the renderer only learns whether one is set. */
  hasApiKey: boolean;
  hasServerToken: boolean;
  /** The active connection profile; null = the built-in local connection. */
  activeProfileId: string | null;
  permissionMode: PermissionMode;
  /** Agent selected for the current profile (or backend, when profile-less). */
  agentId: string | null;
  recentCwds: string[];
  defaultCwd: string;
};

export type SettingsUpdate = {
  backend?: BackendKind;
  serverUrl?: string;
  apiBaseUrl?: string;
  /** A string replaces the saved secret, null clears it, undefined keeps it. */
  apiKey?: string | null;
  serverToken?: string | null;
  permissionMode?: PermissionMode;
  agentId?: string | null;
};

/** A connection profile, as the renderer sees it — no secrets, only presence. */
export type ProfileSummary = {
  id: string;
  name: string;
  type: "cloud" | "remote";
  /** Cloud: API base URL. Remote: WebSocket URL. */
  url: string;
  authMethod: "oauth" | "api_key" | null;
  hasCredential: boolean;
  /** Cloud only: the environment new conversations route to. */
  computerSelector?: ComputerSelectorField;
};

/**
 * Mirrors of the core's environment-selection types
 * (@angus/letta-client-core env/selector.ts + env/conversationEnv.ts). The
 * renderer project compiles without node types, so this shared boundary
 * re-declares the shapes rather than importing the core source; the electron
 * project's IPC handler assignability compile-checks the mirror against the
 * real core types, so drift fails the build instead of slipping through.
 */
export type ComputerSelectorField =
  | string
  | { name: string }
  | { deviceId: string }
  | { id: string }
  | { connectionId: string; name?: string }
  /** Preferred: stable device identity + display name; the connection lease
   *  is resolved at session-attach time (leases change on remote restarts). */
  | { deviceId: string; connectionId: string; name?: string };

export type ConversationEnv = {
  /** null = explicit Cloud Sandbox; undefined = inherit profile default. */
  selector: ComputerSelectorField | null | undefined;
};

/**
 * Mirror of the core's ComputerSummary (env/computers.ts) — the renderer
 * project compiles without node types, so this shared boundary re-declares
 * the shape rather than importing the core source; the electron project's
 * IPC handler assignability compile-checks the mirror against the core's
 * type, so drift fails the build.
 */
export type ComputerSummary = {
  /** Stable identifier for the physical device across reconnects. */
  deviceId: string;
  /** Human-readable computer name. */
  name: string;
  /** Current online connection lease (null when offline). */
  connectionId: string | null;
  status: "online" | "offline";
};

/** How a home row's data was fetched — the home's honesty element. */
export type Provenance = {
  /** live: SDK stream surface; rest: direct cloud REST; cached: stored result. */
  source: "live" | "rest" | "cached";
  /** When the fetch completed (ms epoch). */
  fetchedAt: number;
};

/** A scheduled message from the cloud REST API (the D1 module's projection). */
export type ScheduleSummary = {
  id: string;
  agentId: string;
  /** Best-effort first-message text; empty when the shape is unexpected. */
  promptPreview: string;
  /** ISO time of the next fire; null when the server has not computed one. */
  nextScheduledTime: string | null;
  kind: "one-time" | "recurring";
  cronExpression: string | null;
};

/**
 * A pending approval discovered by the §2.6 probe (no live turn in this
 * client — the runtime is still waiting, possibly on another client).
 */
export type HomeProbedApproval = {
  conversationId: string;
  /** Owning agent (probe-relay attribution; optional for shape compatibility). */
  agentId?: string | null;
  request: ApprovalRequest;
  /** When the probe observed it (ms epoch). */
  receivedAt: number;
};

/** One material outcome completed since the conversation's read cursor. */
export type CompletedRow = {
  conversationId: string;
  agentId: string;
  /** The latest new assistant message (one row per conversation, §3.1). */
  messageId: string;
  /** Best-effort text of that outcome. */
  preview: string;
  /** Server-side date (ISO) of that outcome. */
  completedAt: string;
};

/** One observed run failure (latest failed step per agent, collapsed). */
export type ProblemRow = {
  agentId: string;
  stepId: string;
  errorType: string | null;
  stopReason: string | null;
  /** The surface that initiated the failed step, when reported. */
  origin: string | null;
  /** Server-side date (ISO) of the failed step. */
  failedAt: string;
};

/** One home section's honest state: loading, ready with provenance, or error. */
export type HomeSectionState<Row> = {
  status: "loading" | "ready" | "error";
  rows: Row[];
  provenance: Provenance | null;
  error: string | null;
};

/** The home view's data: sections 1-2 (sections 3-5 are P4/P5 panes). */
export type HomeState = {
  agents: HomeSectionState<AgentSummary>;
  schedules: HomeSectionState<ScheduleSummary>;
  /** Probed approvals; live approvals flow reactively via chat state. */
  needsYou: HomeSectionState<HomeProbedApproval>;
  /** Material outcomes newer than each conversation's read cursor. */
  completed: HomeSectionState<CompletedRow>;
  /** Observed run failures (steps), newest first. */
  problems: HomeSectionState<ProblemRow>;
};

/** Profile mutations: a string replaces the stored secret, omitted keeps it. */
export type ProfileSave = {
  /** Omitted (or unknown) creates a new profile. */
  id?: string;
  type: "cloud" | "remote";
  name: string;
  url: string;
  secret?: string;
};

/** Everything a profile mutation returns, so the UI updates in one round trip. */
export type ProfilesResult = {
  settings: AppSettings;
  profiles: ProfileSummary[];
  activeProfileId: string | null;
};

export type OAuthSignInResult =
  | ({ ok: true; profile: ProfileSummary } & ProfilesResult)
  | { ok: false; error: string };

export type ConnectionState =
  | { status: "connecting"; backend: BackendKind }
  | {
      status: "ready";
      backend: BackendKind;
      detail: string;
      /** True when the server keeps its own model provider keys (the local backend). */
      providers: boolean;
    }
  | { status: "error"; backend: BackendKind; error: string };

export type AgentSummary = {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
};

export type AgentDetails = AgentSummary & {
  /** The agent's full system prompt. */
  system: string;
};

/** Fields left out are not changed. */
export type AgentUpdate = {
  name?: string;
  description?: string;
  /** Default model for new chats. */
  model?: string;
  system?: string;
};

export type ModelOption = {
  id: string;
  handle: string;
  label: string;
};

export type ProviderField = {
  key: string;
  label: string;
  placeholder: string | null;
  secret: boolean;
  required: boolean;
};

export type ProviderAuthMethod = {
  id: string;
  label: string;
  description: string;
  fields: ProviderField[];
};

export type ProviderSummary = {
  id: string;
  name: string;
  description: string;
  /** Subscription sign-in. These are connected from the Letta CLI, not here. */
  oauth: boolean;
  fields: ProviderField[];
  /** Set instead of `fields` when a provider offers more than one way to authenticate. */
  authMethods: ProviderAuthMethod[];
  connections: Array<{ name: string; authType: "api" | "oauth" | null; baseUrl: string | null }>;
};

export type MemoryFile = {
  /** Path relative to the agent's memory folder. */
  path: string;
  /** System files are always in the agent's context. */
  system: boolean;
  description: string | null;
  /** The body, without the file's header. Use readMemoryFile for the whole file. */
  content: string;
  size: number;
  kind: "markdown" | "image";
};

export type MemoryOverview = {
  /** False for agents that do not use file-based memory. */
  enabled: boolean;
  files: MemoryFile[];
};

export type MemoryCommit = {
  sha: string;
  message: string;
  timestamp: number;
  author: string | null;
};

export type ConversationSummary = {
  id: string;
  agentId: string;
  title: string;
  updatedAt: number;
  model: string | null;
  cwd: string | null;
};

export type ChatTextRow = {
  kind: "user" | "assistant" | "reasoning";
  key: string;
  text: string;
  /** Correlates an optimistic user row with the message Letta persists. */
  otid?: string;
  /** Images sent with this row — present on user rows only. */
  images?: AttachmentView[];
};

/** An image attachment as the renderer stages it — base64 data, never a path. */
export type AttachmentView = {
  id: string;
  name: string;
  data: string;
  mediaType: "image/jpeg";
  width: number;
  height: number;
};

export type ChatToolRow = {
  kind: "tool_call";
  key: string;
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: "streaming" | "ready" | "complete";
  result?: { content: string; isError: boolean };
};

export type ChatRow = ChatTextRow | ChatToolRow;

export type ApprovalRequest = {
  requestId: string;
  toolCallId: string | null;
  toolName: string;
  input: Record<string, unknown>;
  /** "Don't ask again" style grants offered by the runtime. */
  suggestions: Array<{ id: string; text: string }>;
};

export type ApprovalDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; suggestionIds?: string[] }
  | { behavior: "deny"; message?: string };

export type HistoryResult = {
  rows: ChatRow[];
  hasMore: boolean;
  running: boolean;
  activity: string | null;
  approvals: ApprovalRequest[];
};

export type SendMessageInput = {
  agentId: string;
  /** null starts a new conversation. */
  conversationId: string | null;
  text: string;
  otid: string;
  cwd: string;
  model?: string;
  /** Images to send with the message; empty text is allowed when present. */
  attachments?: AttachmentView[];
};

/** Main -> renderer push events. */
export type AppEvent =
  | { type: "connection"; state: ConnectionState }
  | { type: "turn.started"; conversationId: string }
  | { type: "turn.rows"; conversationId: string; rows: ChatRow[] }
  | { type: "turn.rows.removed"; conversationId: string; keys: string[] }
  | { type: "turn.activity"; conversationId: string; activity: string | null }
  | { type: "turn.finished"; conversationId: string; error?: string }
  | { type: "turn.queue"; conversationId: string; queue: QueuedItem[] }
  | { type: "approval.requested"; conversationId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; conversationId: string; requestId: string }
  | { type: "conversation.updated"; conversation: ConversationSummary }
  | { type: "profile.signed-out"; profileId: string }
  | { type: "menu"; command: "new-chat" | "settings" };


/** Renderer -> main requests. Every method is an `ipcRenderer.invoke` round trip. */
/** A queued follow-up, from the server's queue_update frames. */
export type QueuedItem = { id: string; text: string };

export type AppRequests = {
  getSettings(): AppSettings;
  updateSettings(update: SettingsUpdate): AppSettings;
  getConnection(): ConnectionState;
  reconnect(): ConnectionState;
  listProfiles(): ProfilesResult;
  saveProfile(input: ProfileSave): ProfilesResult;
  deleteProfile(profileId: string): ProfilesResult;
  signOutProfile(profileId: string): ProfilesResult;
  /** null switches to the built-in local connection. */
  setActiveProfile(profileId: string | null): ProfilesResult;
  /** Sign in with Letta; targets an existing profile or creates a new one. */
  oauthSignIn(profileId?: string): OAuthSignInResult;
  /** Cloud only; throws on other backends (the chip renders cloud-only). */
  listComputers(): ComputerSummary[];
  /** The environment choice for one conversation. */
  getConversationEnv(conversationId: string): ConversationEnv;
  /** Persist an explicit choice: null = Cloud Sandbox, selector = a computer. */
  setConversationEnv(
    conversationId: string,
    selector: ComputerSelectorField | null,
  ): ConversationEnv;
  /** Set/clear the account default for new conversations. */
  setProfileEnvDefault(selector: ComputerSelectorField | null): ProfilesResult;
  removeQueuedMessage(conversationId: string, itemId: string): void;
  listAgents(): AgentSummary[];
  /** Scheduled messages across the account's agents (cloud REST, D1 module). */
  listSchedules(): Promise<ScheduleSummary[]>;
  /** §2.6 probe: approvals pending on the runtime with no live turn here. */
  listPendingApprovals(): Promise<HomeProbedApproval[]>;
  /** §3.1 outcomes newer than each conversation's app-owned read cursor. */
  listCompletedSinceLastLook(): Promise<CompletedRow[]>;
  /** Observed run failures via the D2 steps module, newest first. */
  listProblems(): Promise<ProblemRow[]>;
  /** Advance the conversation's read cursor to its newest message (§3.3). */
  markConversationRead(conversationId: string): Promise<void>;
  createAgent(input: { name: string; model?: string }): AgentSummary;
  getAgent(agentId: string): AgentDetails;
  updateAgent(agentId: string, update: AgentUpdate): AgentSummary;
  deleteAgent(agentId: string): void;
  listModels(refresh?: boolean): ModelOption[];
  listProviders(): ProviderSummary[];
  connectProvider(input: {
    providerId: string;
    authMethodId?: string;
    fields: Record<string, string>;
  }): ProviderSummary[];
  disconnectProvider(input: { providerId: string; providerName?: string }): ProviderSummary[];
  listMemory(agentId: string): MemoryOverview;
  readMemoryFile(agentId: string, path: string): string;
  writeMemoryFile(agentId: string, path: string, content: string): void;
  deleteMemoryFile(agentId: string, path: string): void;
  listMemoryHistory(agentId: string, path: string): MemoryCommit[];
  readMemoryFileAt(agentId: string, path: string, sha: string): string;
  listConversations(agentId: string): ConversationSummary[];
  loadHistory(conversationId: string, limit: number): HistoryResult;
  renameConversation(conversationId: string, title: string): ConversationSummary;
  archiveConversation(conversationId: string): void;
  sendMessage(input: SendMessageInput): ConversationSummary;
  /** Pick image files (native dialog) and run intake; skipped files come back with reasons. */
  selectImages(): { attachments: AttachmentView[]; skipped: string[] };
  stopTurn(conversationId: string): void;
  respondApproval(conversationId: string, requestId: string, decision: ApprovalDecision): void;
  selectDirectory(): string | null;
};

export type AppBridge = {
  [K in keyof AppRequests]: (
    ...args: Parameters<AppRequests[K]>
  ) => Promise<ReturnType<AppRequests[K]>>;
} & {
  onEvent(listener: (event: AppEvent) => void): () => void;
  platform: string;
};
