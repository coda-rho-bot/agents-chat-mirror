import type { ComputerSelectorField, ComputerSummary, ConversationEnv } from "../types";

/**
 * Pure helpers for the environment menu. The label/check logic mirrors the
 * main process's sessionComputerOption (src/electron/libs/env.ts): the
 * conversation's explicit choice first, else the account default, else the
 * SDK's managed sandbox.
 */

/** The environment the NEXT send in this conversation will use. */
export function effectiveSelector(
  conv: ConversationEnv | undefined,
  profileDefault?: ComputerSelectorField,
): ComputerSelectorField | null | undefined {
  const selector = conv?.selector;
  return selector === undefined ? profileDefault : selector;
}

/** Chip and menu label for an environment choice. */
export function envLabel(selector: ComputerSelectorField | null | undefined): string {
  if (selector === null || selector === undefined) return "Cloud Sandbox";
  if (typeof selector === "string") return selector;
  if ("name" in selector && selector.name) return selector.name;
  if ("deviceId" in selector) return selector.deviceId;
  if ("id" in selector) return selector.id;
  if ("connectionId" in selector) return selector.connectionId;
  return "Computer";
}

/** Whether a menu computer is the one a selector points at (deviceId-first). */
export function selectorMatchesComputer(
  selector: ComputerSelectorField | null | undefined,
  computer: ComputerSummary,
): boolean {
  return (
    typeof selector === "object" &&
    selector !== null &&
    "deviceId" in selector &&
    selector.deviceId === computer.deviceId
  );
}

/**
 * One row per device, preferring its online record — a device can appear
 * twice (a stale offline record alongside a fresh online one). The menu only
 * offers online computers; the SDK fails loudly if one goes offline before
 * the send attaches.
 */
export function dedupeComputers(computers: ComputerSummary[]): ComputerSummary[] {
  const byDevice = new Map<string, ComputerSummary>();
  for (const computer of computers) {
    const existing = byDevice.get(computer.deviceId);
    if (!existing || (existing.status !== "online" && computer.status === "online")) {
      byDevice.set(computer.deviceId, computer);
    }
  }
  return [...byDevice.values()];
}
