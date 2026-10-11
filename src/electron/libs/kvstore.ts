import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { KeyValueStore } from "@angus/letta-client-core";

/**
 * File-backed KeyValueStore (the core's storage contract) over one JSON map
 * in the user data directory. Android implements the same contract over
 * AsyncStorage; the values — profile metadata, active id, migration flag —
 * are plain data, never secrets.
 */
export function fileKeyValueStore(path: string): KeyValueStore {
  const load = (): Record<string, string> => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
  return {
    async get(key) {
      return load()[key] ?? null;
    },
    async set(key, value) {
      const data = load();
      data[key] = value;
      write(data);
    },
    async delete(key) {
      const data = load();
      if (!(key in data)) return;
      delete data[key];
      write(data);
    },
  };
}
