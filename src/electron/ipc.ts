import { BrowserWindow, dialog, ipcMain } from "electron";
import type { AppEvent, AppRequests, ProfilesResult } from "./types.js";
import {
  applyPermissionMode,
  archiveConversation,
  removeQueuedMessage,
  createAgent,
  deleteAgent,
  getAgent,
  getConnection,
  listAgents,
  listConversations,
  loadHistory,
  reconnect,
  renameConversation,
  respondApproval,
  sendMessage,
  stopTurn,
  updateAgent,
} from "./libs/runtime.js";
import {
  deleteMemoryFile,
  listMemory,
  listMemoryHistory,
  readMemoryFile,
  readMemoryFileAt,
  writeMemoryFile,
} from "./libs/memory.js";
import { connectProvider, disconnectProvider, listModels, listProviders } from "./libs/providers.js";
import { getSettings, updateSettings } from "./libs/settings.js";
import {
  CLOUD_DEFAULT_URL,
  deleteProfile,
  listProfiles,
  newProfileId,
  profileState,
  refreshProfiles,
  saveOAuthProfile,
  saveProfile,
  setActiveProfileId,
  signOutProfile,
  type Profile,
} from "./libs/profiles.js";
import { signInWithLetta } from "./libs/oauth.js";
import { describeError } from "./libs/transcript.js";
import { validateEventFrame } from "./util.js";

type Handlers = {
  [K in keyof AppRequests]: (
    ...args: Parameters<AppRequests[K]>
  ) => ReturnType<AppRequests[K]> | Promise<ReturnType<AppRequests[K]>>;
};

export function broadcast(event: AppEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("app:event", event);
  }
}

/** One round trip: fresh snapshot + settings, so the UI never mixes states. */
async function profilesResult(): Promise<ProfilesResult> {
  await refreshProfiles();
  return { settings: getSettings(), ...profileState() };
}

/** "Letta Cloud", then "Letta Cloud 2", 3, ... for repeat sign-ins. */
async function nextCloudName(): Promise<string> {
  const names = new Set((await listProfiles()).map((profile) => profile.name));
  if (!names.has("Letta Cloud")) return "Letta Cloud";
  for (let count = 2; ; count++) {
    if (!names.has(`Letta Cloud ${count}`)) return `Letta Cloud ${count}`;
  }
}

const handlers: Handlers = {
  getSettings,
  updateSettings: (update) => {
    const { connectionChanged } = updateSettings(update);
    if (update.permissionMode) applyPermissionMode();
    // The renderer follows the reconnect through `connection` events.
    if (connectionChanged) void reconnect();
    return getSettings();
  },
  getConnection,
  reconnect,
  listProfiles: () => profilesResult(),
  saveProfile: async (input) => {
    const type = input.type === "remote" ? "remote" : "cloud";
    const url = input.url.trim() || (type === "cloud" ? CLOUD_DEFAULT_URL : "");
    if (type === "remote" && !url) throw new Error("A server URL is required.");
    const existing = input.id
      ? (await listProfiles()).find((profile) => profile.id === input.id)
      : undefined;
    const profile: Profile = {
      id: existing?.id ?? newProfileId(),
      type,
      name: input.name.trim() || (type === "cloud" ? "Letta Cloud" : "Remote server"),
      url,
      // Editing keeps the auth method; new cloud profiles are API-key ones
      // (OAuth profiles are created by signing in).
      authMethod: type === "cloud" ? (existing?.authMethod ?? "api_key") : undefined,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    await saveProfile(profile, input.secret?.trim() ? input.secret.trim() : null);
    const result = await profilesResult();
    // Editing the active profile may have changed the connection.
    if (result.activeProfileId === profile.id) void reconnect();
    return result;
  },
  deleteProfile: async (profileId) => {
    const wasActive = profileState().activeProfileId === profileId;
    await deleteProfile(profileId);
    const result = await profilesResult();
    if (wasActive) void reconnect();
    return result;
  },
  signOutProfile: async (profileId) => {
    await signOutProfile(profileId);
    const result = await profilesResult();
    if (result.activeProfileId === profileId) void reconnect();
    return result;
  },
  setActiveProfile: async (profileId) => {
    await setActiveProfileId(profileId);
    const result = await profilesResult();
    void reconnect();
    return result;
  },
  oauthSignIn: async (profileId) => {
    try {
      const credential = await signInWithLetta();
      const existing = profileId
        ? (await listProfiles()).find((profile) => profile.id === profileId)
        : undefined;
      const profile: Profile = existing
        ? { ...existing, type: "cloud", authMethod: "oauth" }
        : {
            id: newProfileId(),
            type: "cloud",
            name: await nextCloudName(),
            url: CLOUD_DEFAULT_URL,
            authMethod: "oauth",
            createdAt: Date.now(),
          };
      await saveOAuthProfile(profile, credential);
      await setActiveProfileId(profile.id);
      const result = await profilesResult();
      void reconnect();
      const summary = result.profiles.find((item) => item.id === profile.id);
      if (!summary) throw new Error("Sign-in completed but the profile is missing.");
      return { ok: true as const, profile: summary, ...result };
    } catch (error) {
      return { ok: false as const, error: describeError(error) };
    }
  },
  listAgents,
  createAgent,
  getAgent,
  updateAgent,
  deleteAgent,
  listModels,
  listProviders,
  connectProvider,
  disconnectProvider,
  listMemory,
  readMemoryFile,
  writeMemoryFile,
  deleteMemoryFile,
  listMemoryHistory,
  readMemoryFileAt,
  listConversations,
  loadHistory,
  renameConversation,
  archiveConversation,
  removeQueuedMessage,
  sendMessage,
  stopTurn,
  respondApproval,
  selectDirectory: async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
};

export function registerIpc(): void {
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`app:${name}`, async (event, ...args: unknown[]) => {
      // Errors cross the bridge as data so the renderer sees the real message
      // instead of Electron's "Error invoking remote method" wrapper.
      try {
        validateEventFrame(event.senderFrame);
        const value = await (handler as (...input: unknown[]) => unknown)(...args);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    });
  }
}
