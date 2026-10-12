import type {
  SessionDeviceStatus,
  SessionPendingControlRequest,
} from "@letta-ai/letta-agent-sdk";
import type { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import type { ApprovalRequest, HomeProbedApproval } from "../types.js";

/**
 * The §2.6 approval probe — the home's "Needs you" discovery path.
 *
 * Survey verdict (Oct 12 2026, recorded in PROVENANCE.md): the Cloud REST
 * surface has NO per-agent awaiting-input endpoint (no runs resource;
 * /v1/steps carries pending/success/failed/cancelled but no approval
 * payloads; tools Update Approval is configuration). Pending approvals are
 * SESSION state — the SDK's own docs say decisions "must still resolve
 * through recoverPendingApprovals() and canUseTool". So the home discovers
 * them the §2.6 way: a per-conversation session probe via getDeviceStatus()
 * (the same machinery that restores pending-approval UI on foreground).
 *
 * The probe is discovery only. Deciding still routes through the existing
 * approval machinery: live approvals resolve via respondApproval's
 * session-local callback; probed approvals (no live turn here) are surfaced
 * as cards that lead to the conversation, where the existing recovery path
 * (recoverPendingApprovals at send) takes over. No second approval path.
 *
 * Probe sessions attach WITHOUT canUseTool and without device-state options:
 * the probe must never intercept an approval callback or mutate runtime
 * state — it only reads the server-authoritative snapshot.
 */

/** Project one runtime control request to the app's approval shape. */
export function toApprovalRequest(
  pending: SessionPendingControlRequest,
): ApprovalRequest {
  return {
    requestId: pending.requestId,
    toolCallId: pending.toolCallId ?? null,
    toolName: pending.toolName,
    input: pending.toolInput ?? {},
    suggestions: pending.permissionSuggestions ?? [],
  };
}

/** Project a device-status snapshot to probed approval cards. */
export function projectControlRequests(
  status: Pick<SessionDeviceStatus, "pendingControlRequests">,
  conversationId: string,
  now = Date.now(),
): HomeProbedApproval[] {
  return (status.pendingControlRequests ?? []).map((pending) => ({
    conversationId,
    request: toApprovalRequest(pending),
    receivedAt: now,
  }));
}

/**
 * Probe one conversation's pending approvals: attach a bare session, read
 * the authoritative device status, detach. Errors propagate — the caller
 * decides whether a single conversation's probe failure is fatal.
 */
export async function probeConversation(
  sdk: LettaAgentClient,
  conversationId: string,
): Promise<HomeProbedApproval[]> {
  const session = sdk.resumeSession(conversationId);
  try {
    const status = await session.getDeviceStatus();
    return projectControlRequests(status, conversationId);
  } finally {
    session.close();
  }
}
