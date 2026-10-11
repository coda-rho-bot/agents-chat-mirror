import { BrowserWindow, dialog, ipcMain } from "electron";
import type { AppEvent, AppRequests } from "./types.js";
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
import { persistOAuthCredential, signInWithLetta } from "./libs/oauth.js";
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
  oauthSignIn: async () => {
    try {
      const credential = await signInWithLetta();
      // Persist the FULL credential (access + refresh + expiry) so the
      // refresh hook (follow-up) has something to refresh with. The app's
      // cloud connection still takes the access token as its API key.
      persistOAuthCredential(credential);
      return { ok: true as const, apiKey: credential.accessToken };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
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
