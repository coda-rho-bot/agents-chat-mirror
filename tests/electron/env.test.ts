import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import type { Profile } from "../../src/electron/libs/profiles";

type Env = typeof import("../../src/electron/libs/env");

let userData: string;
let env: Env;
/** The profile record the default-write test observes. */
let savedProfile: Profile | null;

// Only app.getPath is needed — env keys share the profiles.json metadata
// store, and saveProfile with a null secret never touches the secret store.
vi.mock("electron", () => ({
  app: { getPath: () => userData },
}));

const fakeProfile: Profile = {
  id: "p1",
  type: "cloud",
  name: "Letta Cloud",
  url: "https://api.letta.com",
  createdAt: 0,
};
// profiles.js is stubbed wholesale: importOriginal would survive
// vi.resetModules with its module-level kvStore singleton bound to the
// FIRST test's tmpdir, silently stale for every test after it. A fresh
// fileKeyValueStore per kv() call reads the current file every time.
vi.mock("../../src/electron/libs/profiles", async () => {
  const { fileKeyValueStore } = await import("../../src/electron/libs/kvstore");
  return {
    activeProfile: () => fakeProfile,
    kv: () => fileKeyValueStore(join(userData, "profiles.json")),
    saveProfile: async (profile: Profile) => {
      savedProfile = profile;
    },
  };
});

beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), "env-"));
  savedProfile = null;
  vi.resetModules();
  env = await import("../../src/electron/libs/env");
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe("conversation env round-trip", () => {
  it("stores an explicit Cloud Sandbox choice", async () => {
    await env.setConversationEnv("c1", null);
    expect(await env.getConversationEnv("c1")).toEqual({ selector: null });
  });

  it("stores a pinned computer and reads it back", async () => {
    const selector = { deviceId: "dev-1", connectionId: "conn-1", name: "MacBook" };
    await env.setConversationEnv("c2", selector);
    expect(await env.getConversationEnv("c2")).toEqual({ selector });
  });

  it("inherits for a conversation that never touched the sheet", async () => {
    expect(await env.getConversationEnv("untouched")).toEqual({ selector: undefined });
  });

  it("recovers to inherit from corrupt stored values", async () => {
    const store = join(userData, "profiles.json");
    writeFileSync(
      store,
      JSON.stringify({
        "letta.env.bad-json": "{not json",
        "letta.env.not-a-selector": "42",
        "letta.env.sandbox": "sandbox",
      }),
    );
    expect(await env.getConversationEnv("bad-json")).toEqual({ selector: undefined });
    expect(await env.getConversationEnv("not-a-selector")).toEqual({ selector: undefined });
    expect(await env.getConversationEnv("sandbox")).toEqual({ selector: null });
  });
});

describe("listComputers", () => {
  it("projects the SDK records to the Android summary shape", async () => {
    const list = vi.fn(async () => ({
      computers: [
        {
          id: "e1",
          deviceId: "dev-1",
          connectionId: "conn-1",
          name: "MacBook",
          status: "online",
          connectedAt: 1,
          lastSeenAt: 2,
        },
      ],
      hasNextPage: false,
    }));
    const client = { computers: { list } } as unknown as LettaAgentClient;
    expect(await env.listComputers(client)).toEqual([
      { deviceId: "dev-1", name: "MacBook", connectionId: "conn-1", status: "online" },
    ]);
    expect(list).toHaveBeenCalledWith({ limit: 50 });
  });

  it("propagates the SDK's cloud-only error", async () => {
    const client = {
      get computers() {
        throw new Error("client.computers is only available with backend: \"cloud\".");
      },
    } as unknown as LettaAgentClient;
    await expect(env.listComputers(client)).rejects.toThrow(/cloud/);
  });
});

describe("setProfileEnvDefault", () => {
  it("writes the default onto the active profile", async () => {
    await env.setProfileEnvDefault({ deviceId: "dev-1", connectionId: "conn-1", name: "MacBook" });
    expect(savedProfile?.id).toBe("p1");
    expect(savedProfile?.computerSelector).toEqual({
      deviceId: "dev-1",
      connectionId: "conn-1",
      name: "MacBook",
    });
  });

  it("clears the default on a Cloud Sandbox pick", async () => {
    await env.setProfileEnvDefault({ deviceId: "dev-1" });
    await env.setProfileEnvDefault(null);
    expect(savedProfile?.computerSelector).toBeUndefined();
  });
});

describe("sessionComputerOption", () => {
  const selector = { deviceId: "dev-1", connectionId: "conn-1", name: "MacBook" };

  it("inherits to the profile default when one is set", () => {
    expect(env.sessionComputerOption({ selector: undefined }, selector)).toBe(selector);
  });

  it("inherits to the managed sandbox when no default is set", () => {
    expect(env.sessionComputerOption({ selector: undefined })).toBeUndefined();
  });

  it("passes a pinned computer through", () => {
    expect(env.sessionComputerOption({ selector }, selector)).toBe(selector);
  });

  it("an explicit Cloud Sandbox overrides the profile default", () => {
    expect(env.sessionComputerOption({ selector: null }, selector)).toBeUndefined();
  });
});
