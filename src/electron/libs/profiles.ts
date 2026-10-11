import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OAuthTokenError,
  parseOAuthCredential,
  refreshOAuthCredential,
  revokeOAuthCredential,
  type ComputerSelectorField,
  type KeyValueStore,
  type OAuthCredential,
  type SecretStore,
} from "@angus/letta-client-core";
import { fileKeyValueStore } from "./kvstore.js";
import { parseEncryptedJson, safeStorageSecretStore } from "./secrets.js";

/**
 * Connection profiles — multiple named connections (cloud OAuth, cloud API
 * key, remote server), switchable. A port of the Android implementation
 * (coda/agents-chat src/lib/profiles/profiles.ts): metadata lives in a plain
 * KeyValueStore, secrets only in the SecretStore, keyed by profile id, and
 * are never logged, rendered, or exported.
 *
 * The local backend is NOT a profile — it is the built-in connection that is
 * active when no profile is selected (Android has no local backend).
 */

export type ProfileType = "cloud" | "remote";
export type CloudAuthMethod = "oauth" | "api_key";

export interface Profile {
  id: string;
  type: ProfileType;
  name: string;
  /** Cloud: API base URL (default https://api.letta.com). Remote: WebSocket URL. */
  url: string;
  /** Cloud only; profiles created before OAuth support omit it and stay API-key profiles. */
  authMethod?: CloudAuthMethod;
  /**
   * Cloud only: the environment NEW conversations route to (their sessions
   * pass it as the SDK `computer` option). undefined = SDK-managed sandbox.
   * Existing conversations keep their own per-conversation choice.
   */
  computerSelector?: ComputerSelectorField;
  createdAt: number;
}

const INDEX_KEY = "letta.profiles.v1";
const ACTIVE_KEY = "letta.profiles.active.v1";
const MIGRATED_KEY = "letta.profiles.migrated.v1";
const secretKey = (id: string) => `letta.secret.${id}`;

export const CLOUD_DEFAULT_URL = "https://api.letta.com";

/** Refresh when the token expires within this window (matches the desktop skew). */
const REFRESH_SKEW_MS = 60_000;

let kvStore: KeyValueStore | null = null;
let secretStore: SecretStore | null = null;

/** The metadata store — plain data, never secrets. Shared with the env keys. */
export function kv(): KeyValueStore {
  kvStore ??= fileKeyValueStore(join(app.getPath("userData"), "profiles.json"));
  return kvStore;
}

function secrets(): SecretStore {
  secretStore ??= safeStorageSecretStore(join(app.getPath("userData"), "profile-secrets.bin"));
  return secretStore;
}

// --- Metadata ---------------------------------------------------------------

export async function listProfiles(): Promise<Profile[]> {
  const raw = await kv().get(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Profile[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeProfiles(profiles: Profile[]): Promise<void> {
  await kv().set(INDEX_KEY, JSON.stringify(profiles));
}

export async function saveProfile(profile: Profile, secret: string | null): Promise<void> {
  const profiles = await listProfiles();
  const index = profiles.findIndex((p) => p.id === profile.id);
  if (index === -1) profiles.push(profile);
  else profiles[index] = profile;
  await writeProfiles(profiles);
  // Empty secret means "keep the stored one" when editing.
  if (secret !== null && secret.length > 0) {
    await secrets().set(secretKey(profile.id), secret);
    // A fresh credential resets any accumulated refresh-failure strikes.
    failureStrikes.delete(profile.id);
  }
}

export async function saveOAuthProfile(
  profile: Profile,
  credential: OAuthCredential,
): Promise<void> {
  await saveProfile(
    { ...profile, type: "cloud", url: CLOUD_DEFAULT_URL, authMethod: "oauth" },
    JSON.stringify(credential),
  );
}

export async function deleteProfile(id: string): Promise<void> {
  deleting.add(id);
  try {
    // A refresh can rotate the refresh token. Wait for it, then revoke the
    // newest stored credential so deletion cannot leave a valid session or
    // let the refresh write the credential back after local cleanup.
    try {
      await refreshes.get(id);
    } catch {
      // Revoke the last stored credential below when refresh failed.
    }
    const raw = await secrets().get(secretKey(id));
    const oauth = raw ? parseOAuthCredential(raw) : null;
    if (oauth) {
      try {
        await revokeOAuthCredential(oauth);
      } catch {
        // Local deletion must still work when the account is offline.
      }
    }
    const profiles = (await listProfiles()).filter((p) => p.id !== id);
    await writeProfiles(profiles);
    await secrets().delete(secretKey(id));
    if ((await getActiveProfileId()) === id) {
      await setActiveProfileId(null);
    }
  } finally {
    deleting.delete(id);
  }
}

// --- Secrets ----------------------------------------------------------------

const refreshes = new Map<string, Promise<string | null>>();
const deleting = new Set<string>();
/** Consecutive refresh refusals per profile; two signs the session out. */
const failureStrikes = new Map<string, number>();

let signedOutNotifier: ((profileId: string) => void) | null = null;

/** Register the listener fired when a profile's OAuth session is cleared. */
export function onProfileSignedOut(listener: (profileId: string) => void): void {
  signedOutNotifier = listener;
}

/**
 * The profile's secret, resolved at connect time. Plain API keys and server
 * tokens pass through; OAuth credentials return a live access token,
 * refreshing (single-flight, per profile) when expired. Returns null when
 * there is no secret — callers surface the ordinary auth error.
 *
 * A refused refresh (the server rejecting the token — OAuthTokenError, which
 * the pinned core throws for any non-ok token response) counts as a strike;
 * two consecutive refusals clear the credential and fire sign-out, so one
 * transient server error never signs the user out. Network-shaped failures
 * (offline, DNS) strike nothing.
 */
export async function getProfileSecret(id: string): Promise<string | null> {
  if (deleting.has(id)) return null;
  const raw = await secrets().get(secretKey(id));
  if (!raw || deleting.has(id)) return null;
  const oauth = parseOAuthCredential(raw);
  if (!oauth) return raw;
  if (oauth.expiresAt - REFRESH_SKEW_MS > Date.now()) return oauth.accessToken;
  const existing = refreshes.get(id);
  if (existing) return existing;
  const refresh = refreshOAuthCredential(oauth)
    .then(async (refreshed) => {
      await secrets().set(secretKey(id), JSON.stringify(refreshed));
      failureStrikes.delete(id);
      return refreshed.accessToken;
    })
    .catch(async (error) => {
      if (error instanceof OAuthTokenError) {
        const strikes = (failureStrikes.get(id) ?? 0) + 1;
        if (strikes >= 2) {
          failureStrikes.delete(id);
          await secrets().delete(secretKey(id));
          void refreshProfiles();
          signedOutNotifier?.(id);
        } else {
          failureStrikes.set(id, strikes);
        }
      }
      return null;
    })
    .finally(() => {
      refreshes.delete(id);
    });
  refreshes.set(id, refresh);
  return refresh;
}

/**
 * Sign out of a cloud OAuth profile: revoke the credential best-effort and
 * drop the stored secret. The profile shell remains, for a fresh sign-in.
 */
export async function signOutProfile(id: string): Promise<void> {
  const profile = (await listProfiles()).find((p) => p.id === id);
  if (!profile) return;
  if (profile.authMethod !== "oauth") {
    throw new Error("Only Letta Cloud sign-in profiles can sign out.");
  }
  deleting.add(id);
  try {
    // Wait out an in-flight refresh so it cannot write the credential back.
    try {
      await refreshes.get(id);
    } catch {
      // Revoke the last stored credential below.
    }
    const raw = await secrets().get(secretKey(id));
    const oauth = raw ? parseOAuthCredential(raw) : null;
    if (oauth) {
      try {
        await revokeOAuthCredential(oauth);
      } catch {
        // Local sign-out must still work when the account is offline.
      }
    }
    await secrets().delete(secretKey(id));
  } finally {
    deleting.delete(id);
  }
  await refreshProfiles();
}

export async function hasSecret(id: string): Promise<boolean> {
  return (await secrets().get(secretKey(id))) !== null;
}

// --- Active profile ---------------------------------------------------------

export async function getActiveProfileId(): Promise<string | null> {
  return kv().get(ACTIVE_KEY);
}

export async function setActiveProfileId(id: string | null): Promise<void> {
  if (id === null) await kv().delete(ACTIVE_KEY);
  else await kv().set(ACTIVE_KEY, id);
}

export function newProfileId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// --- Migration flag ---------------------------------------------------------

/** One-shot guard so a later "delete every profile" stays deleted. */
export async function migrationDone(): Promise<boolean> {
  return (await kv().get(MIGRATED_KEY)) !== null;
}

export async function markMigrationDone(): Promise<void> {
  await kv().set(MIGRATED_KEY, "1");
}

/**
 * The pre-profiles OAuth credential (oauth.ts's single-credential store).
 * Read-only, for the one-shot migration into a profile secret; the legacy
 * file itself is left in place so a failed migration destroys nothing.
 */
export async function readLegacyOAuthCredential(): Promise<OAuthCredential | null> {
  try {
    const raw = readFileSync(join(app.getPath("userData"), "oauth-credential.bin"));
    const stored = parseEncryptedJson(raw);
    return stored.credential ? parseOAuthCredential(stored.credential) : null;
  } catch {
    return null;
  }
}

// --- Snapshot ---------------------------------------------------------------
// getConnectionConfig() is synchronous, so the main process keeps an
// in-memory snapshot of the profile metadata; every mutation refreshes it.

type Snapshot = {
  profiles: Profile[];
  activeId: string | null;
  hasCredential: Record<string, boolean>;
};

let snapshot: Snapshot | null = null;

export async function loadProfiles(): Promise<void> {
  const [profiles, activeId] = await Promise.all([listProfiles(), getActiveProfileId()]);
  const hasCredential: Record<string, boolean> = {};
  for (const profile of profiles) {
    hasCredential[profile.id] = await hasSecret(profile.id);
  }
  snapshot = { profiles, activeId, hasCredential };
}

/** Re-read the stores into the snapshot; call after any mutation. */
export async function refreshProfiles(): Promise<void> {
  await loadProfiles();
}

/** The active profile, or null for the built-in local connection. */
export function activeProfile(): Profile | null {
  const current = snapshot;
  if (!current) return null;
  return current.profiles.find((p) => p.id === current.activeId) ?? null;
}

/** Whether the profile has a stored secret (snapshot; renderer-safe boolean). */
export function profileHasSecret(id: string): boolean {
  return snapshot?.hasCredential[id] ?? false;
}

export function snapshotProfiles(): Profile[] {
  return snapshot?.profiles ?? [];
}

/** Renderer-safe summaries (metadata + credential presence, never secrets). */
export function profileState(): {
  profiles: Array<{
    id: string;
    name: string;
    type: ProfileType;
    url: string;
    authMethod: CloudAuthMethod | null;
    hasCredential: boolean;
    computerSelector?: ComputerSelectorField;
  }>;
  activeProfileId: string | null;
} {
  const current = snapshot;
  if (!current) return { profiles: [], activeProfileId: null };
  return {
    profiles: current.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      url: p.url,
      authMethod: p.authMethod ?? null,
      hasCredential: current.hasCredential[p.id] ?? false,
      ...(p.computerSelector !== undefined ? { computerSelector: p.computerSelector } : {}),
    })),
    activeProfileId: current.activeId,
  };
}
