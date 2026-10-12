import type { ApprovalRequest, HomeProbedApproval } from "../types";

/** One "Needs you" card: an approval plus how this client learned of it. */
export type NeedsYouRow = HomeProbedApproval & { source: "live" | "probe" };

/**
 * The canonical five section titles, in order (docs/CLIENT-STRATEGY.md
 * line 67: needs-me-first). The JSX renders from this map so the order is
 * a tested artifact, not inline strings that can drift or duplicate.
 */
export const HOME_SECTION_TITLES = {
  needsYou: "Needs you",
  completed: "Completed since you last looked",
  problems: "Problems",
  schedules: "Next scheduled",
  agents: "Agents",
} as const;

/**
 * The Needs-you rows: live approvals (session events — actionable now) merge
 * with probed approvals (§2.6 discovery — lead to the conversation). Live
 * wins on requestId; oldest first, because the longest-waiting approval is
 * the most stale.
 */
export function selectNeedsYouRows(
  chats: Record<string, { approvals: (ApprovalRequest & { receivedAt: number })[] }>,
  probed: HomeProbedApproval[],
): NeedsYouRow[] {
  const live: NeedsYouRow[] = [];
  for (const [conversationId, chat] of Object.entries(chats)) {
    for (const approval of chat.approvals) {
      live.push({ conversationId, request: approval, receivedAt: approval.receivedAt, source: "live" });
    }
  }
  const seen = new Set(live.map((row) => row.request.requestId));
  return [
    ...live,
    ...probed
      .filter((row) => !seen.has(row.request.requestId))
      .map((row) => ({ ...row, source: "probe" as const })),
  ].sort((a, b) => a.receivedAt - b.receivedAt);
}
