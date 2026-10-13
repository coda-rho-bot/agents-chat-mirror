import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthCredential } from "@angus/letta-client-core";

type Profiles = typeof import("../../src/electron/libs/profiles");

let userData: string;
let encryptionAvailable: boolean;
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

const refreshOAuthCredential = vi.fn();
const revokeOAuthCredential = vi.fn();

// Stable identity across vi.resetModules, so instanceof in profiles.ts holds.
class FakeOAuthTokenError extends Error {}

// The token endpoints stay mocked; parsing stays real.
vi.mock("@angus/letta-client-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@angus/letta-client-core")>()),
  OAuthTokenError: FakeOAuthTokenError,
  refreshOAuthCredential: (...args: unknown[]) => refreshOAuthCredential(...(args as [])),
  revokeOAuthCredential: (...args: unknown[]) => revokeOAuthCredential(...(args as [])),
}));

const HOUR = 3_600_000;

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return { kind: "oauth", accessToken: "at-1", refreshToken: "rt-1", expiresAt: Date.now() + HOUR, ...overrides };
}

/** Load the module again, as a restarted app would. */
async function restart() {
  vi.resetModules();
  profiles = await import("../../src/electron/libs/profiles");
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), "oss-ui-profiles-"));
  encryptionAvailable = true;
  refreshOAuthCredential.mockReset();
  revokeOAuthCredential.mockReset();
  await restart();
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe("profile storage", () => {
  it("saves and lists profiles across a restart", async () => {
    const id = profiles.newProfileId();
    await profiles.saveProfile(
      { id, type: "cloud" as const, name: "Work", url: "https://api.letta.com", authMethod: "api_key" as const, createdAt: 1 },
      "sk-1",
    );
    await restart();
    const list = await profiles.listProfiles();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, name: "Work", authMethod: "api_key" });
  });

  it("keeps secrets out of the metadata file", async () => {
    await profiles.saveProfile(
      { id: profiles.newProfileId(), type: "cloud" as const, name: "Work", url: "", authMethod: "api_key" as const, createdAt: 1 },
      "sk-secret-value",
    );
    const metadata = readFileSync(join(userData, "profiles.json"), "utf8");
    expect(metadata).toContain("Work");
    expect(metadata).not.toContain("sk-secret-value");
  });

  it("round-trips a plain secret, keeping it when an edit passes null or empty", async () => {
    const id = profiles.newProfileId();
    const base = { id, type: "cloud" as const, name: "Work", url: "", authMethod: "api_key" as const, createdAt: 1 };
    await profiles.saveProfile(base, "sk-1");
    expect(await profiles.getProfileSecret(id)).toBe("sk-1");

    await profiles.saveProfile({ ...base, name: "Renamed" }, null);
    expect((await profiles.listProfiles())[0].name).toBe("Renamed");
    expect(await profiles.getProfileSecret(id)).toBe("sk-1");

    await profiles.saveProfile({ ...base, name: "" }, "");
    expect(await profiles.getProfileSecret(id)).toBe("sk-1");

    await restart();
    expect(await profiles.getProfileSecret(id)).toBe("sk-1");
  });

  it("still round-trips secrets when the system has no keychain", async () => {
    encryptionAvailable = false;
    const id = profiles.newProfileId();
    await profiles.saveProfile(
      { id, type: "cloud" as const, name: "Work", url: "", authMethod: "api_key" as const, createdAt: 1 },
      "sk-plain",
    );
    await restart();
    expect(await profiles.getProfileSecret(id)).toBe("sk-plain");
    // The fallback file is plain JSON with restrictive permissions.
    expect(readFileSync(join(userData, "profile-secrets.bin"), "utf8")).toContain("sk-plain");
  });
});

describe("oauth credentials", () => {
  it("returns a live access token without refreshing", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(
      { id, type: "cloud" as const, name: "Letta Cloud", url: "", createdAt: 1 },
      credential({ accessToken: "at-fresh" }),
    );
    expect(await profiles.getProfileSecret(id)).toBe("at-fresh");
    expect(refreshOAuthCredential).not.toHaveBeenCalled();
  });

  it("refreshes an expired credential once (single-flight) and persists the rotation", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(
      { id, type: "cloud" as const, name: "Letta Cloud", url: "", createdAt: 1 },
      credential({ accessToken: "stale", expiresAt: Date.now() - 1_000 }),
    );
    refreshOAuthCredential.mockResolvedValue(credential({ accessToken: "at-new", refreshToken: "rt-new" }));

    const [first, second] = await Promise.all([
      profiles.getProfileSecret(id),
      profiles.getProfileSecret(id),
    ]);
    expect(first).toBe("at-new");
    expect(second).toBe("at-new");
    expect(refreshOAuthCredential).toHaveBeenCalledTimes(1);

    await restart();
    refreshOAuthCredential.mockClear();
    expect(await profiles.getProfileSecret(id)).toBe("at-new");
    expect(refreshOAuthCredential).not.toHaveBeenCalled();
  });

  it("swallows a failed refresh and keeps the stored credential", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(
      { id, type: "cloud" as const, name: "Letta Cloud", url: "", createdAt: 1 },
      credential({ expiresAt: Date.now() - 1_000 }),
    );
    refreshOAuthCredential.mockRejectedValue(new Error("network down"));
    expect(await profiles.getProfileSecret(id)).toBeNull();
    expect(await profiles.hasSecret(id)).toBe(true);
  });
});

describe("deletion", () => {
  it("waits out an in-flight refresh and revokes the rotated credential", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(
      { id, type: "cloud" as const, name: "Letta Cloud", url: "", createdAt: 1 },
      credential({ expiresAt: Date.now() - 1_000 }),
    );
    let resolveRefresh!: (value: OAuthCredential) => void;
    refreshOAuthCredential.mockImplementation(
      () => new Promise<OAuthCredential>((resolve) => { resolveRefresh = resolve; }),
    );

    const secretCall = profiles.getProfileSecret(id);
    await flush(); // let the refresh flight register
    const deletion = profiles.deleteProfile(id);
    resolveRefresh(credential({ accessToken: "at-new", refreshToken: "rt-new" }));
    const [secret] = await Promise.all([secretCall, deletion]);

    expect(secret).toBe("at-new");
    expect(revokeOAuthCredential).toHaveBeenCalledTimes(1);
    expect(revokeOAuthCredential.mock.calls[0][0]).toMatchObject({ refreshToken: "rt-new" });
    expect(await profiles.listProfiles()).toEqual([]);
    expect(await profiles.hasSecret(id)).toBe(false);
    expect(await profiles.getActiveProfileId()).toBeNull();
  });

  it("revokes best-effort and still deletes when the account is offline", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(
      { id, type: "cloud" as const, name: "Letta Cloud", url: "", createdAt: 1 },
      credential(),
    );
    revokeOAuthCredential.mockRejectedValue(new Error("offline"));
    await profiles.deleteProfile(id);
    expect(await profiles.listProfiles()).toEqual([]);
    expect(await profiles.hasSecret(id)).toBe(false);
  });

  it("keeps the active selection when deleting a different profile", async () => {
    const active = profiles.newProfileId();
    const other = profiles.newProfileId();
    const base = { type: "cloud" as const, name: "P", url: "", authMethod: "api_key" as const, createdAt: 1 };
    await profiles.saveProfile({ ...base, id: active }, "sk-a");
    await profiles.saveProfile({ ...base, id: other }, "sk-b");
    await profiles.setActiveProfileId(active);
    await profiles.deleteProfile(other);
    expect(await profiles.getActiveProfileId()).toBe(active);
    expect(await profiles.listProfiles()).toHaveLength(1);
  });
});

describe("snapshot", () => {
  it("exposes the active profile and credential presence synchronously", async () => {
    const a = profiles.newProfileId();
    const b = profiles.newProfileId();
    const base = { type: "cloud" as const, name: "P", url: "", authMethod: "api_key" as const, createdAt: 1 };
    await profiles.saveProfile({ ...base, id: a }, "sk-a");
    await profiles.saveProfile({ ...base, id: b }, null);
    await profiles.setActiveProfileId(b);
    await profiles.loadProfiles();

    expect(profiles.activeProfile()?.id).toBe(b);
    expect(profiles.profileHasSecret(a)).toBe(true);
    expect(profiles.profileHasSecret(b)).toBe(false);
    expect(profiles.snapshotProfiles()).toHaveLength(2);
  });

  it("is null before load and when nothing is active", async () => {
    expect(profiles.activeProfile()).toBeNull();
    await profiles.loadProfiles();
    expect(profiles.activeProfile()).toBeNull();
  });
});

describe("misc", () => {
  it("generates distinct ids", () => {
    expect(profiles.newProfileId()).not.toBe(profiles.newProfileId());
  });

  it("marks migration done exactly once across restarts", async () => {
    expect(await profiles.migrationDone()).toBe(false);
    await profiles.markMigrationDone();
    expect(await profiles.migrationDone()).toBe(true);
    await restart();
    expect(await profiles.migrationDone()).toBe(true);
  });
});

describe("refresh-failure sign-out", () => {
  const expired = () => credential({ expiresAt: Date.now() - 1_000 });
  const profileOf = (id: string) => ({ id, type: "cloud" as const, name: "Letta Cloud", url: "", createdAt: 1 });

  it("keeps the credential after a single refused refresh", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(profileOf(id), expired());
    refreshOAuthCredential.mockRejectedValue(new FakeOAuthTokenError("invalid_grant"));
    expect(await profiles.getProfileSecret(id)).toBeNull();
    expect(await profiles.hasSecret(id)).toBe(true);
  });

  it("clears the credential and fires sign-out after two consecutive refusals", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(profileOf(id), expired());
    const signedOut = vi.fn();
    profiles.onProfileSignedOut(signedOut);
    refreshOAuthCredential.mockRejectedValue(new FakeOAuthTokenError("invalid_grant"));

    expect(await profiles.getProfileSecret(id)).toBeNull();
    expect(await profiles.hasSecret(id)).toBe(true);
    expect(signedOut).not.toHaveBeenCalled();

    expect(await profiles.getProfileSecret(id)).toBeNull();
    expect(await profiles.hasSecret(id)).toBe(false);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(signedOut).toHaveBeenCalledWith(id);
  });

  it("resets the strike count after a successful refresh", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(profileOf(id), expired());
    refreshOAuthCredential.mockRejectedValueOnce(new FakeOAuthTokenError("invalid_grant"));
    expect(await profiles.getProfileSecret(id)).toBeNull();

    // Resolves within the refresh skew, so the next call refreshes again.
    refreshOAuthCredential.mockResolvedValueOnce(
      credential({ accessToken: "at-new", expiresAt: Date.now() + 30_000 }),
    );
    expect(await profiles.getProfileSecret(id)).toBe("at-new");

    refreshOAuthCredential.mockRejectedValueOnce(new FakeOAuthTokenError("invalid_grant"));
    expect(await profiles.getProfileSecret(id)).toBeNull();
    expect(await profiles.hasSecret(id)).toBe(true);
  });

  it("does not strike on network-shaped failures", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(profileOf(id), expired());
    const signedOut = vi.fn();
    profiles.onProfileSignedOut(signedOut);
    refreshOAuthCredential.mockRejectedValue(new TypeError("fetch failed"));

    expect(await profiles.getProfileSecret(id)).toBeNull();
    expect(await profiles.getProfileSecret(id)).toBeNull();
    expect(await profiles.hasSecret(id)).toBe(true);
    expect(signedOut).not.toHaveBeenCalled();
  });
});

describe("sign out", () => {
  const profileOf = (id: string) => ({ id, type: "cloud" as const, name: "Letta Cloud", url: "", createdAt: 1 });

  it("revokes best-effort, clears the secret, and keeps the profile shell", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(profileOf(id), credential());
    revokeOAuthCredential.mockResolvedValue(undefined);

    await profiles.signOutProfile(id);
    expect(revokeOAuthCredential).toHaveBeenCalledTimes(1);
    expect(await profiles.hasSecret(id)).toBe(false);
    expect(await profiles.listProfiles()).toHaveLength(1);

    await profiles.loadProfiles();
    expect(profiles.profileHasSecret(id)).toBe(false);
  });

  it("still signs out when revocation fails (offline)", async () => {
    const id = profiles.newProfileId();
    await profiles.saveOAuthProfile(profileOf(id), credential());
    revokeOAuthCredential.mockRejectedValue(new Error("offline"));

    await profiles.signOutProfile(id);
    expect(await profiles.hasSecret(id)).toBe(false);
  });

  it("rejects sign-out for non-oauth profiles", async () => {
    const id = profiles.newProfileId();
    await profiles.saveProfile(
      { id, type: "cloud", name: "Work", url: "", authMethod: "api_key", createdAt: 1 },
      "sk-1",
    );
    await expect(profiles.signOutProfile(id)).rejects.toThrow(/sign/i);
    expect(await profiles.hasSecret(id)).toBe(true);
  });
});


describe("lastTest and pinned (mobile parity)", () => {
  it("summary carries pinned as a boolean and lastTest when set", async () => {
    await profiles.saveProfile(
      { id: "p-x", type: "cloud", name: "Cloud", url: profiles.CLOUD_DEFAULT_URL, authMethod: "api_key", createdAt: Date.now() },
      "sk-1",
    );
    await profiles.refreshProfiles();
    const state = profiles.profileState();
    expect(state.profiles[0].pinned).toBe(false);
    expect(state.profiles[0].lastTest).toBeUndefined();

    // Simulate what ipc.testProfileConnection does: write lastTest + pinned.
    const list = await profiles.listProfiles();
    list[0] = { ...list[0], lastTest: "ok", pinned: true };
    await profiles.writeProfiles(list);
    await profiles.refreshProfiles();
    const updated = profiles.profileState().profiles[0];
    expect(updated.lastTest).toBe("ok");
    expect(updated.pinned).toBe(true);
  });
});
