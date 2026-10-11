import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Settings = typeof import("../../src/electron/libs/settings");
type Profiles = typeof import("../../src/electron/libs/profiles");

let userData: string;
let encryptionAvailable: boolean;
let settings: Settings;
let profiles: Profiles;

// A stand-in for the OS keychain: reversible, and clearly not the plain text.
vi.mock("electron", () => ({
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value: string) => Buffer.from(value.split("").reverse().join("")),
    decryptString: (value: Buffer) => value.toString().split("").reverse().join(""),
  },
}));

const savedFile = () => readFileSync(join(userData, "settings.json"), "utf8");

/** Load the module again, as a restarted app would. */
async function restart() {
  vi.resetModules();
  settings = await import("../../src/electron/libs/settings");
  profiles = await import("../../src/electron/libs/profiles");
}

beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), "oss-ui-settings-"));
  encryptionAvailable = true;
  for (const name of [
    "LETTA_BACKEND",
    "LETTA_API_KEY",
    "LETTA_BASE_URL",
    "LETTA_SERVER_URL",
    "LETTA_SERVER_TOKEN",
    "LETTA_APP_SERVER_TOKEN",
  ]) {
    vi.stubEnv(name, "");
  }
  await restart();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(userData, { recursive: true, force: true });
});

describe("backend selection", () => {
  it("defaults to the local backend", () => {
    expect(settings.getSettings()).toMatchObject({ backend: "local", hasApiKey: false, permissionMode: "standard" });
  });

  it("uses Letta Cloud when only an API key is in the environment", () => {
    vi.stubEnv("LETTA_API_KEY", "sk-env");
    expect(settings.getConnectionConfig()).toMatchObject({ backend: "cloud", apiKey: "sk-env" });
  });

  it("follows LETTA_BACKEND, and ignores a value it does not know", () => {
    vi.stubEnv("LETTA_BACKEND", "REMOTE");
    vi.stubEnv("LETTA_SERVER_URL", "ws://server:4500");
    expect(settings.getConnectionConfig()).toMatchObject({ backend: "remote", serverUrl: "ws://server:4500" });

    vi.stubEnv("LETTA_BACKEND", "nonsense");
    expect(settings.getConnectionConfig().backend).toBe("local");
  });

  it("lets a saved choice win over the environment", () => {
    vi.stubEnv("LETTA_BACKEND", "cloud");
    settings.updateSettings({ backend: "local" });
    expect(settings.getSettings().backend).toBe("local");
  });

  it("accepts either name for the server token", () => {
    vi.stubEnv("LETTA_APP_SERVER_TOKEN", "from-docs");
    expect(settings.getConnectionConfig().serverToken).toBe("from-docs");
    vi.stubEnv("LETTA_SERVER_TOKEN", "preferred");
    expect(settings.getConnectionConfig().serverToken).toBe("preferred");
  });
});

describe("secrets", () => {
  it("stores the API key encrypted and reads it back after a restart", async () => {
    settings.updateSettings({ backend: "cloud", apiKey: " sk-secret " });
    expect(savedFile()).not.toContain("sk-secret");
    expect(settings.getSettings().hasApiKey).toBe(true);

    await restart();
    expect(settings.getConnectionConfig().apiKey).toBe("sk-secret");
  });

  it("still works when the system has no keychain", async () => {
    encryptionAvailable = false;
    settings.updateSettings({ serverToken: "token-1" });
    await restart();
    expect(settings.getConnectionConfig().serverToken).toBe("token-1");
  });

  it("clears a secret when given null and keeps it when left out", () => {
    settings.updateSettings({ apiKey: "sk-secret" });
    settings.updateSettings({ permissionMode: "acceptEdits" });
    expect(settings.getSettings().hasApiKey).toBe(true);

    settings.updateSettings({ apiKey: null });
    expect(settings.getSettings().hasApiKey).toBe(false);
  });
});

describe("updateSettings", () => {
  it("reports when the connection has to be rebuilt", () => {
    expect(settings.updateSettings({ backend: "remote", serverUrl: "ws://a:1" }).connectionChanged).toBe(true);
    expect(settings.updateSettings({ serverUrl: "ws://a:1" }).connectionChanged).toBe(false);
    expect(settings.updateSettings({ permissionMode: "unrestricted" }).connectionChanged).toBe(false);
    expect(settings.updateSettings({ serverToken: "t" }).connectionChanged).toBe(true);
  });

  it("ignores a permission mode it does not know", () => {
    settings.updateSettings({ permissionMode: "everything" as never });
    expect(settings.getPermissionMode()).toBe("standard");
  });

  it("remembers a selected agent for each backend separately", () => {
    settings.updateSettings({ agentId: "agent-local" });
    settings.updateSettings({ backend: "remote", serverUrl: "ws://a:1" });
    expect(settings.getSettings().agentId).toBeNull();

    settings.updateSettings({ agentId: "agent-remote" });
    settings.updateSettings({ backend: "local" });
    expect(settings.getSettings().agentId).toBe("agent-local");

    settings.setAgentId(null);
    expect(settings.getSettings().agentId).toBeNull();
  });
});

describe("working folders", () => {
  it("remembers each chat's folder and the most recent folders first", () => {
    settings.rememberCwd("conv-1", "/a");
    settings.rememberCwd("conv-2", "/b");
    settings.rememberCwd("conv-3", "/a");

    expect(settings.getConversationCwd("conv-2")).toBe("/b");
    expect(settings.getSettings().recentCwds).toEqual(["/a", "/b"]);
  });

  it("keeps a short list of recent folders", () => {
    for (let index = 0; index < 12; index++) settings.rememberCwd(`conv-${index}`, `/dir-${index}`);
    const recent = settings.getSettings().recentCwds;
    expect(recent).toHaveLength(8);
    expect(recent[0]).toBe("/dir-11");
  });

  it("forgets a chat's folder when the chat is removed", () => {
    settings.rememberCwd("conv-1", "/a");
    settings.forgetConversation("conv-1");
    expect(settings.getConversationCwd("conv-1")).toBeNull();
  });
});

describe("profiles", () => {
  const cloud = (id: string, url = "") => ({
    id,
    type: "cloud" as const,
    name: "Work",
    url,
    authMethod: "api_key" as const,
    createdAt: 1,
  });

  async function activate(id: string) {
    await profiles.setActiveProfileId(id);
    await profiles.loadProfiles();
  }

  it("derives the connection config from an active cloud profile", async () => {
    const id = profiles.newProfileId();
    await profiles.saveProfile(cloud(id, "https://api.example.com"), "sk-1");
    await activate(id);
    expect(settings.getConnectionConfig()).toEqual({
      backend: "cloud",
      apiKey: "",
      serverUrl: "",
      serverToken: "",
      apiBaseUrl: "https://api.example.com",
    });
    expect(settings.getSettings()).toMatchObject({
      hasApiKey: true,
      hasServerToken: false,
      activeProfileId: id,
      backend: "cloud",
    });
  });

  it("derives the connection config from an active remote profile", async () => {
    const id = profiles.newProfileId();
    await profiles.saveProfile(
      { id, type: "remote", name: "Server", url: "ws://127.0.0.1:4500", createdAt: 1 },
      "tok-1",
    );
    await activate(id);
    expect(settings.getConnectionConfig()).toEqual({
      backend: "remote",
      apiKey: "",
      serverUrl: "ws://127.0.0.1:4500",
      serverToken: "",
      apiBaseUrl: "",
    });
    expect(settings.getSettings()).toMatchObject({ hasServerToken: true, hasApiKey: false });
  });

  it("ignores environment variables while a profile is active", async () => {
    vi.stubEnv("LETTA_API_KEY", "sk-env");
    const id = profiles.newProfileId();
    await profiles.saveProfile(cloud(id), "sk-profile");
    await activate(id);
    expect(settings.getConnectionConfig()).toMatchObject({ backend: "cloud", apiKey: "" });
    expect(settings.getSettings().hasApiKey).toBe(true);

    await profiles.deleteProfile(id);
    await profiles.loadProfiles();
    expect(settings.getConnectionConfig()).toMatchObject({ apiKey: "sk-env" });
  });

  it("remembers the selected agent per profile", async () => {
    const a = profiles.newProfileId();
    const b = profiles.newProfileId();
    await profiles.saveProfile(cloud(a), null);
    await profiles.saveProfile(cloud(b), null);

    await activate(a);
    settings.updateSettings({ agentId: "agent-a" });
    await activate(b);
    expect(settings.getSettings().agentId).toBeNull();
    await activate(a);
    expect(settings.getSettings().agentId).toBe("agent-a");
  });

  it("ignores legacy connection fields while a profile is active", async () => {
    const id = profiles.newProfileId();
    await profiles.saveProfile(cloud(id), "sk-1");
    await activate(id);

    const result = settings.updateSettings({ backend: "local", apiKey: "sk-other" });
    expect(result.connectionChanged).toBe(false);
    expect(settings.getConnectionConfig().backend).toBe("cloud");

    settings.updateSettings({ permissionMode: "unrestricted" });
    expect(settings.getPermissionMode()).toBe("unrestricted");
  });
});

describe("legacy migration", () => {
  /** Write a legacy oauth-credential.bin the way oauth.ts did (mock reverses). */
  function writeLegacyBin(credential: object) {
    const json = JSON.stringify({ credential: JSON.stringify(credential) });
    writeFileSync(
      join(userData, "oauth-credential.bin"),
      Buffer.from(json.split("").reverse().join("")),
    );
  }

  it("migrates a cloud OAuth sign-in into an active oauth profile", async () => {
    settings.updateSettings({ backend: "cloud", apiKey: "stale-access-token", agentId: "agent-cloud" });
    writeLegacyBin({
      kind: "oauth",
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: Date.now() + 3_600_000,
    });

    await settings.migrateLegacySettings();
    const list = await profiles.listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      type: "cloud",
      authMethod: "oauth",
      name: "Letta Cloud",
      url: "https://api.letta.com",
    });
    const id = list[0].id;
    expect(await profiles.getActiveProfileId()).toBe(id);
    expect(await profiles.hasSecret(id)).toBe(true);
    expect(settings.getSettings()).toMatchObject({
      activeProfileId: id,
      backend: "cloud",
      hasApiKey: true,
      agentId: "agent-cloud",
    });

    // Non-destructive: the legacy files survive a failed migration path.
    expect(savedFile()).toContain("apiKey");
    expect(readFileSync(join(userData, "oauth-credential.bin"), "utf8")).toBeTruthy();
  });

  it("migrates a stored cloud API key when there is no OAuth credential", async () => {
    settings.updateSettings({
      backend: "cloud",
      apiKey: "sk-old",
      apiBaseUrl: "https://api.example.com",
    });
    await settings.migrateLegacySettings();
    const [profile] = await profiles.listProfiles();
    expect(profile).toMatchObject({ type: "cloud", authMethod: "api_key", url: "https://api.example.com" });
    expect(await profiles.getProfileSecret(profile.id)).toBe("sk-old");
    expect(settings.getConnectionConfig()).toMatchObject({
      backend: "cloud",
      apiBaseUrl: "https://api.example.com",
    });
  });

  it("migrates a remote server connection, token and all", async () => {
    settings.updateSettings({ backend: "remote", serverUrl: "ws://127.0.0.1:4500", serverToken: "tok" });
    await settings.migrateLegacySettings();
    const [profile] = await profiles.listProfiles();
    expect(profile).toMatchObject({ type: "remote", url: "ws://127.0.0.1:4500", name: "127.0.0.1:4500" });
    expect(await profiles.getProfileSecret(profile.id)).toBe("tok");
    expect(settings.getConnectionConfig()).toMatchObject({
      backend: "remote",
      serverUrl: "ws://127.0.0.1:4500",
    });
  });

  it("migrates nothing for local-only installs, and stays that way", async () => {
    settings.updateSettings({ backend: "local" });
    await settings.migrateLegacySettings();
    expect(await profiles.listProfiles()).toEqual([]);
    expect(settings.getSettings().activeProfileId).toBeNull();

    // The flag keeps a later "delete everything" deleted.
    await profiles.saveProfile(
      { id: profiles.newProfileId(), type: "cloud", name: "Temp", url: "", createdAt: 1 },
      null,
    );
    await profiles.deleteProfile((await profiles.listProfiles())[0].id);
    await settings.migrateLegacySettings();
    expect(await profiles.listProfiles()).toEqual([]);
  });

  it("runs once even across restarts", async () => {
    settings.updateSettings({ backend: "cloud", apiKey: "sk-old" });
    await settings.migrateLegacySettings();
    await restart();
    await settings.migrateLegacySettings();
    expect(await profiles.listProfiles()).toHaveLength(1);
  });
});
