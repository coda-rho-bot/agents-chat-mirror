import {
  loadConversationEnv as coreLoad,
  saveConversationEnv as coreSave,
  type ComputerSelectorField,
  type ConversationEnv,
} from "@angus/letta-client-core";
import type { Computer, ComputerSelector, LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { activeProfile, kv, saveProfile } from "./profiles.js";
import type { ComputerSummary } from "../types.js";

/**
 * Per-conversation environment (computer) selection — desktop adapter over
 * the core module (@angus/letta-client-core env/conversationEnv), the same
 * adapter-threading the Android app uses (coda/agents-chat
 * src/lib/conversationEnv.ts over AsyncStorage). The logic — key scheme
 * (`letta.env.<id>`), sandbox/JSON/inherit semantics, the isSelector shape
 * guard — lives in the core; this file only supplies the desktop's
 * KeyValueStore (the profiles.json metadata store, single-store parity with
 * Android) and the Cloud computers listing. PROVENANCE: the ComputerSummary
 * projection and the account-default write are adapted from the Android
 * lineage (agents-chat src/lib/letta/api.ts listComputers, chat.tsx
 * selectEnvironment's asDefault branch) — extraction candidates for a later
 * core tier, same discipline as the attachments constants.
 */

/** The environment choice for one conversation. */
export async function getConversationEnv(
  conversationId: string,
): Promise<ConversationEnv> {
  return coreLoad(kv(), conversationId);
}

/** Persist an explicit choice: null = Cloud Sandbox, selector = a computer. */
export async function setConversationEnv(
  conversationId: string,
  selector: ComputerSelectorField | null,
): Promise<ConversationEnv> {
  await coreSave(kv(), conversationId, selector);
  return { selector };
}

/** Display projection of the SDK's Computer record (Android's shape). */
export function toComputerSummary(record: Computer): ComputerSummary {
  return {
    deviceId: record.deviceId,
    name: record.name,
    connectionId: record.connectionId,
    status: record.status,
  };
}

/**
 * List computers registered with this Letta Cloud account. Cloud only —
 * the SDK's `client.computers` throws on any other backend, which callers
 * surface as an error state rather than an empty list.
 */
export async function listComputers(client: LettaAgentClient): Promise<ComputerSummary[]> {
  const result = await client.computers.list({ limit: 50 });
  return result.computers.map(toComputerSummary);
}

/**
 * The account-level default for NEW conversations (the sheet's "use for
 * new conversations" checkbox). null clears it — a cleared default means
 * the SDK-managed sandbox, matching the Android write
 * (`computerSelector: selector ?? undefined`). Existing conversations keep
 * their own per-conversation choice regardless.
 */
export async function setProfileEnvDefault(
  selector: ComputerSelectorField | null,
): Promise<void> {
  const profile = activeProfile();
  if (!profile) return;
  await saveProfile({ ...profile, computerSelector: selector ?? undefined }, null);
}

/**
 * The `computer` option a new session carries: the conversation's explicit
 * choice first (null = Cloud Sandbox), then the account default; no choice
 * at all means the SDK provisions its managed sandbox. The SDK resolves a
 * deviceId selector to the device's CURRENT connection lease at attach time
 * and fails loudly when the device is offline (resolveExplicitConnection is
 * the only branch — a set selector can never fall back to a sandbox).
 */
export function sessionComputerOption(
  conv: ConversationEnv,
  profileDefault?: ComputerSelectorField,
): ComputerSelector | undefined {
  const effective = conv.selector === undefined ? profileDefault : conv.selector;
  return effective === null || effective === undefined ? undefined : effective;
}
