import { safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SecretStore } from "@angus/letta-client-core";

/**
 * Electron-side SecretStore: a safeStorage-encrypted JSON map at a fixed path
 * in userData, implementing the core's SecretStore contract. This generalizes
 * the store that oauth.ts used for the single OAuth credential — one store,
 * keyed `letta.secret.<profileId>` (the Android key scheme), instead of a
 * second parallel mechanism.
 *
 * Without an OS keychain (some Linux setups) the file falls back to plain
 * JSON with 0600 permissions, mirroring settings.ts's `raw:` fallback.
 */

/** Decrypt-then-plain parse, so both storage modes read back. */
export function parseEncryptedJson(buffer: Buffer): Record<string, string> {
  const attempts: string[] = [];
  try {
    attempts.push(safeStorage.decryptString(buffer));
  } catch {
    // Not encrypted (or undecryptable) — try the plain fallback below.
  }
  attempts.push(buffer.toString("utf8"));
  for (const text of attempts) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    } catch {
      // Try the next candidate.
    }
  }
  return {};
}

export function safeStorageSecretStore(path: string): SecretStore {
  const load = (): Record<string, string> => {
    try {
      return parseEncryptedJson(readFileSync(path));
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true });
    const json = JSON.stringify(data);
    writeFileSync(
      path,
      safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json,
      { mode: 0o600 },
    );
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
