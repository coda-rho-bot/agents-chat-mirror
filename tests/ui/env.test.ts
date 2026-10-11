import { describe, expect, it } from "vitest";
import {
  dedupeComputers,
  effectiveSelector,
  envLabel,
  selectorMatchesComputer,
} from "../../src/ui/lib/env";
import type { ComputerSummary } from "../../src/ui/types";

const computer = (extra: Partial<ComputerSummary> = {}): ComputerSummary => ({
  deviceId: "dev-1",
  name: "MacBook",
  connectionId: "conn-1",
  status: "online",
  ...extra,
});

describe("effectiveSelector", () => {
  it("inherits to the profile default when the conversation has none", () => {
    const d = { deviceId: "dev-1", connectionId: "conn-1", name: "MacBook" };
    expect(effectiveSelector(undefined, d)).toBe(d);
    expect(effectiveSelector({ selector: undefined }, d)).toBe(d);
  });

  it("the conversation's explicit choice wins over the default", () => {
    const d = { deviceId: "dev-1" };
    expect(effectiveSelector({ selector: null }, d)).toBeNull();
  });

  it("no choice and no default is the managed sandbox", () => {
    expect(effectiveSelector(undefined)).toBeUndefined();
  });
});

describe("envLabel", () => {
  it("labels the sandbox and the inherited default identically", () => {
    expect(envLabel(null)).toBe("Cloud Sandbox");
    expect(envLabel(undefined)).toBe("Cloud Sandbox");
  });

  it("prefers the computer's name", () => {
    expect(envLabel({ deviceId: "dev-1", connectionId: "conn-1", name: "MacBook" })).toBe(
      "MacBook",
    );
  });

  it("falls back to the device id when unnamed", () => {
    expect(envLabel({ deviceId: "dev-1", connectionId: "conn-1" })).toBe("dev-1");
  });

  it("labels string selectors directly", () => {
    expect(envLabel("office-mac")).toBe("office-mac");
  });
});

describe("selectorMatchesComputer", () => {
  it("matches by device id", () => {
    expect(selectorMatchesComputer({ deviceId: "dev-1", connectionId: "conn-1" }, computer())).toBe(
      true,
    );
    expect(selectorMatchesComputer({ deviceId: "dev-2" }, computer())).toBe(false);
  });

  it("the sandbox and inherited states match no computer", () => {
    expect(selectorMatchesComputer(null, computer())).toBe(false);
    expect(selectorMatchesComputer(undefined, computer())).toBe(false);
  });
});

describe("dedupeComputers", () => {
  it("keeps the online record when a device appears twice", () => {
    const stale = computer({ connectionId: "conn-old", status: "offline" });
    const fresh = computer({ connectionId: "conn-1", status: "online" });
    expect(dedupeComputers([stale, fresh])).toEqual([fresh]);
    expect(dedupeComputers([fresh, stale])).toEqual([fresh]);
  });

  it("keeps first-seen order across distinct devices", () => {
    const a = computer({ deviceId: "dev-a", name: "A" });
    const b = computer({ deviceId: "dev-b", name: "B" });
    expect(dedupeComputers([b, a])).toEqual([b, a]);
  });
});
