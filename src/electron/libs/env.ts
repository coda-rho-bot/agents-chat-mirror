import {
  loadConversationEnv as coreLoad,
  saveConversationEnv as coreSave,
} from "@angus/letta-client-core";
import { LettaAgentClient, type ComputerSelector } from "@letta-ai/letta-agent-sdk";
import { getConnectionConfig, load } from "./settings.js";
import { activeProfile, kv, saveProfile } from "./profiles.js";
import { toComputerSummary } from "@angus/letta-client-core";

/**
 * Per-conversation execution environment (computer) selection.
 *
 * The choice is stored in the settings file under `conversationEnvs`:
 *   - absent  → no explicit choice; the session runs wherever the account/
 *              SDK decides (SDK-managed sandbox for cloud conversations)
 *   - null    → explicit Cloud Sandbox
 *   - object  → a computer selector ({ deviceId } preferred; stable across
 *              connection rotations)
 *
 * Per-turn sessions mean a pick made mid-run applies to the NEXT send.
 */

export type ComputerSelectorField = ComputerSelector;

export type ConversationEnv = { selector: ComputerSelectorField | null | undefined };

export type ComputerSummary = {
  id?: string;
  deviceId: string;
  name: string;
  status: "online" | "offline";
  lastSeenAt?: number;
  /** Current online connection lease (null when offline) — the Angus shape. */
  connectionId?: string | null;
};

let cloudComputersClient: LettaAgentClient | null = null;

/** List computers registered with this Letta Cloud account.
 *
 * The app's main client routes cloud sessions through a local app-server
 * (backend: "local" with harnessBackend: "api"), and the SDK's computers
 * client exists only on a direct cloud client — so this builds one
 * dedicated listing client from the saved cloud credentials. */
export async function listComputers(client?: unknown): Promise<ComputerSummary[]> {
  // Tests inject a mock client — honor it directly (Angus signature).
  if (client && typeof (client as { computers?: { list?: unknown } }).computers?.list === "function") {
    const result = (await (client as { computers: { list: (o: unknown) => Promise<{ computers: unknown[] }> } }).computers.list({ limit: 50 }));
    return result.computers.map((c) => toComputerSummary(c as Parameters<typeof toComputerSummary>[0])) as unknown as ComputerSummary[];
  }
  const config = getConnectionConfig();
  if (config.backend !== "cloud") {
    throw new Error("Computers are only available with the Letta Cloud backend.");
  }
  cloudComputersClient ??= new LettaAgentClient({
    backend: "cloud",
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
  });
  const result = await cloudComputersClient.computers.list({ limit: 50 });
  return result.computers.map((computer) => ({
    id: computer.id,
    deviceId: computer.deviceId,
    name: computer.name,
    status: computer.status,
    lastSeenAt: computer.lastSeenAt,
  }));
}

export function getAllConversationEnvs(): Record<string, ComputerSelectorField | null> {
  return { ...(load().conversationEnvs ?? {}) };
}

export async function getConversationEnv(
  conversationId: string,
): Promise<ConversationEnv> {
  return coreLoad(kv(), conversationId);
}

export async function setConversationEnv(
  conversationId: string,
  selector: ComputerSelectorField | null,
): Promise<ConversationEnv> {
  await coreSave(kv(), conversationId, selector);
  return { selector };
}

/** The session option: undefined leaves the SDK's default (managed sandbox). */
export function sessionComputerOption(
  conv: ConversationEnv,
  profileDefault?: ComputerSelectorField,
): ComputerSelector | undefined {
  const effective = conv.selector === undefined ? profileDefault : conv.selector;
  return effective === null || effective === undefined ? undefined : effective;
}


export async function setProfileEnvDefault(
  selector: ComputerSelectorField | null,
): Promise<void> {
  const profile = activeProfile();
  if (!profile) return;
  await saveProfile({ ...profile, computerSelector: selector ?? undefined }, null);
}
