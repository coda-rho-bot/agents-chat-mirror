import { app, safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AppSettings, BackendKind, PermissionMode, SettingsUpdate } from "../types.js";
import {
  CLOUD_DEFAULT_URL,
  activeProfile,
  loadProfiles,
  markMigrationDone,
  migrationDone,
  newProfileId,
  profileHasSecret,
  readLegacyOAuthCredential,
  saveOAuthProfile,
  saveProfile,
  setActiveProfileId,
  type Profile,
} from "./profiles.js";

/**
 * App settings, persisted as JSON in the user data directory.
 *
 * Environment variables (LETTA_BACKEND, LETTA_API_KEY, LETTA_BASE_URL,
 * LETTA_SERVER_URL, LETTA_SERVER_TOKEN or LETTA_APP_SERVER_TOKEN) act as defaults for anything the user
 * has not set in the Settings dialog, so a `.env` file keeps working in
 * development.
 */

type StoredSettings = {
  backend?: BackendKind;
  serverUrl?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  serverToken?: string;
  permissionMode?: PermissionMode;
  /** Remembered agent per connection — keyed by profile id, or by backend when profile-less. */
  agentIds?: Record<string, string>;
  recentCwds?: string[];
  conversationCwds?: Record<string, string>;
};

export type ConnectionConfig = {
  backend: BackendKind;
  serverUrl: string;
  serverToken: string;
  apiKey: string;
  apiBaseUrl: string;
};

const BACKENDS: BackendKind[] = ["local", "cloud", "remote"];
const PERMISSION_MODES: PermissionMode[] = ["standard", "acceptEdits", "unrestricted", "strict"];
const MAX_RECENT_CWDS = 8;
const MAX_CONVERSATION_CWDS = 500;

let cache: StoredSettings | null = null;

function settingsPath(): string {
  return join(app.getPath("userData"), "settings.json");
}

function load(): StoredSettings {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(settingsPath(), "utf8")) as StoredSettings;
  } catch {
    cache = {};
  }
  return cache;
}

function save(next: StoredSettings): void {
  cache = next;
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
}

// Secrets are encrypted with the OS keychain when it is available. Without one
// (some Linux setups) they fall back to the 0600 settings file.
function encodeSecret(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(value).toString("base64")}`;
  }
  return `raw:${value}`;
}

function decodeSecret(stored: string | undefined): string {
  if (!stored) return "";
  try {
    if (stored.startsWith("enc:")) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    }
    if (stored.startsWith("raw:")) return stored.slice(4);
  } catch {
    // An undecryptable secret (e.g. a keychain reset) is treated as unset.
  }
  return "";
}

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

export function getConnectionConfig(): ConnectionConfig {
  const profile = activeProfile();
  if (profile) {
    // A profile owns the connection; its secret resolves at connect time
    // (runtime.ts) and never leaves the main process through this shape.
    return profile.type === "cloud"
      ? { backend: "cloud", apiKey: "", serverUrl: "", serverToken: "", apiBaseUrl: profile.url || "" }
      : { backend: "remote", apiKey: "", serverUrl: profile.url, serverToken: "", apiBaseUrl: "" };
  }
  const stored = load();
  const apiKey = decodeSecret(stored.apiKey) || env("LETTA_API_KEY");
  const envBackend = env("LETTA_BACKEND").toLowerCase() as BackendKind;
  const backend =
    stored.backend ??
    (BACKENDS.includes(envBackend) ? envBackend : apiKey ? "cloud" : "local");
  return {
    backend,
    apiKey,
    serverUrl: stored.serverUrl ?? env("LETTA_SERVER_URL"),
    serverToken:
      decodeSecret(stored.serverToken) ||
      env("LETTA_SERVER_TOKEN") ||
      env("LETTA_APP_SERVER_TOKEN"),
    apiBaseUrl: stored.apiBaseUrl ?? env("LETTA_BASE_URL"),
  };
}

export function getSettings(): AppSettings {
  const stored = load();
  const profile = activeProfile();
  const config = getConnectionConfig();
  const agentKey = profile?.id ?? config.backend;
  return {
    backend: config.backend,
    serverUrl: config.serverUrl,
    apiBaseUrl: config.apiBaseUrl,
    hasApiKey: profile
      ? profile.type === "cloud" && profileHasSecret(profile.id)
      : config.apiKey.length > 0,
    hasServerToken: profile
      ? profile.type === "remote" && profileHasSecret(profile.id)
      : config.serverToken.length > 0,
    permissionMode: stored.permissionMode ?? "standard",
    agentId:
      stored.agentIds?.[agentKey] ??
      (profile ? stored.agentIds?.[config.backend] : undefined) ??
      null,
    recentCwds: stored.recentCwds ?? [],
    defaultCwd: homedir(),
    activeProfileId: profile?.id ?? null,
  };
}

/** Apply an update and report whether the backend connection must be rebuilt. */
export function updateSettings(update: SettingsUpdate): { connectionChanged: boolean } {
  const profile = activeProfile();
  const before = profile ? null : JSON.stringify(getConnectionConfig());
  const next: StoredSettings = { ...load() };

  // Connection fields belong to the active profile (edited via the profiles
  // pane); with none active they keep their pre-profiles meaning. Permission
  // mode and agent selection always apply.
  if (!profile) {
    if (update.backend && BACKENDS.includes(update.backend)) next.backend = update.backend;
    if (update.serverUrl !== undefined) next.serverUrl = update.serverUrl.trim();
    if (update.apiBaseUrl !== undefined) next.apiBaseUrl = update.apiBaseUrl.trim();
    if (update.apiKey !== undefined) {
      next.apiKey = update.apiKey ? encodeSecret(update.apiKey.trim()) : undefined;
    }
    if (update.serverToken !== undefined) {
      next.serverToken = update.serverToken ? encodeSecret(update.serverToken.trim()) : undefined;
    }
  }
  if (update.permissionMode && PERMISSION_MODES.includes(update.permissionMode)) {
    next.permissionMode = update.permissionMode;
  }
  save(next);

  if (update.agentId !== undefined) setAgentId(update.agentId);
  return {
    connectionChanged: profile ? false : before !== JSON.stringify(getConnectionConfig()),
  };
}

export function setAgentId(agentId: string | null): void {
  const stored = load();
  const key = activeProfile()?.id ?? getConnectionConfig().backend;
  const agentIds = { ...stored.agentIds };
  if (agentId) agentIds[key] = agentId;
  else delete agentIds[key];
  save({ ...stored, agentIds });
}

// --- Migration --------------------------------------------------------------
// One-shot: fold the pre-profiles single-connection settings into a profile.
// Guarded by a flag so deleting every profile later stays deleted; legacy
// fields are never removed — with no profile active they remain the
// connection, byte-identical to the pre-profiles behavior.

export async function migrateLegacySettings(): Promise<void> {
  await loadProfiles();
  if (await migrationDone()) return;
  await migrateStoredConnection();
  await markMigrationDone();
  await loadProfiles();
}

async function migrateStoredConnection(): Promise<void> {
  const stored = load();
  if (stored.backend === "cloud") {
    // A persisted OAuth credential wins over the stored key: sign-in wrote
    // both, and the credential is the live refreshable mechanism.
    const credential = await readLegacyOAuthCredential();
    if (credential) {
      const profile: Profile = {
        id: newProfileId(),
        type: "cloud",
        name: "Letta Cloud",
        url: CLOUD_DEFAULT_URL,
        authMethod: "oauth",
        createdAt: Date.now(),
      };
      await saveOAuthProfile(profile, credential);
      await finishMigration(profile, stored);
      return;
    }
    const apiKey = decodeSecret(stored.apiKey);
    if (apiKey) {
      const profile: Profile = {
        id: newProfileId(),
        type: "cloud",
        name: "Letta Cloud",
        url: stored.apiBaseUrl?.trim() || CLOUD_DEFAULT_URL,
        authMethod: "api_key",
        createdAt: Date.now(),
      };
      await saveProfile(profile, apiKey);
      await finishMigration(profile, stored);
      return;
    }
  }
  if (stored.backend === "remote" && stored.serverUrl) {
    const profile: Profile = {
      id: newProfileId(),
      type: "remote",
      name: remoteName(stored.serverUrl),
      url: stored.serverUrl,
      createdAt: Date.now(),
    };
    const token = decodeSecret(stored.serverToken);
    await saveProfile(profile, token || null);
    await finishMigration(profile, stored);
  }
  // Local-only and fresh installs migrate nothing; the built-in local
  // connection keeps working exactly as before.
}

async function finishMigration(profile: Profile, stored: StoredSettings): Promise<void> {
  await setActiveProfileId(profile.id);
  // Grandfather the remembered agent selection into the new profile key.
  const legacyKey = profile.type === "remote" ? "remote" : "cloud";
  const agentId = stored.agentIds?.[legacyKey];
  if (agentId) {
    const agentIds = { ...load().agentIds, [profile.id]: agentId };
    save({ ...load(), agentIds });
  }
}

function remoteName(url: string): string {
  try {
    return new URL(url).host || "Remote server";
  } catch {
    return "Remote server";
  }
}

export function getPermissionMode(): PermissionMode {
  return load().permissionMode ?? "standard";
}

export function getConversationCwd(conversationId: string): string | null {
  return load().conversationCwds?.[conversationId] ?? null;
}

/** Remember the working directory a conversation ran in. */
export function rememberCwd(conversationId: string, cwd: string): void {
  const stored = load();
  if (stored.conversationCwds?.[conversationId] === cwd && stored.recentCwds?.[0] === cwd) return;

  const recentCwds = [cwd, ...(stored.recentCwds ?? []).filter((item) => item !== cwd)].slice(
    0,
    MAX_RECENT_CWDS,
  );
  const entries = Object.entries({ ...stored.conversationCwds, [conversationId]: cwd });
  const conversationCwds = Object.fromEntries(entries.slice(-MAX_CONVERSATION_CWDS));
  save({ ...stored, recentCwds, conversationCwds });
}

export function forgetConversation(conversationId: string): void {
  const stored = load();
  if (!stored.conversationCwds?.[conversationId]) return;
  const conversationCwds = { ...stored.conversationCwds };
  delete conversationCwds[conversationId];
  save({ ...stored, conversationCwds });
}
