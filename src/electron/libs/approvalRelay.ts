import type { HomeProbedApproval } from "../types.js";

/**
 * The P4 probe-relay: the desktop is the fleet's approval-discovery source
 * (D4 ruling — the Cloud REST surface has no awaiting-input endpoint, and
 * /v1/steps is broken upstream), so it probes pending approvals on a
 * minutes-bounded cadence and relays NEW ones to the delivery service's
 * POST /events ingestion. The service stores the event and pushes it to
 * registered mobile devices; the desktop's own poll loop carries it to the
 * home + OS notification. Deciding still routes through the existing
 * approval machinery — this relay is discovery distribution, never a second
 * approval path.
 *
 * Cadence is minutes-bounded (D4: the probe is a per-agent session attach —
 * heavyweight, never seconds). Failures are honest-quiet (D6 doctrine):
 * a failed cycle logs and retries on the next tick; a failed send leaves
 * the approval unmarked so it retries instead of silently dropping.
 */

/** One approval event, as the service's ingestion contract accepts it. */
export type ApprovalIngest = {
  kind: "approval";
  conversationId: string | null;
  agentId: string;
  requestId: string;
  summary: string;
  at?: string;
};

export type ApprovalRelayDeps = {
  /** The probe scan (runtime's listPendingApprovals — agent-attributed). */
  probe: () => Promise<HomeProbedApproval[]>;
  /** POST one approval event to the service's ingestion. Throws on failure. */
  send: (event: ApprovalIngest) => Promise<void>;
  /** Persisted relayed-requestId set (prune window applies). */
  kv: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> };
  log: (message: string) => void;
  /** Relay cadence in ms — minutes-bounded per D4. */
  intervalMs: number;
  /** Prune relayed entries older than this (default 7 days). */
  pruneMs?: number;
};

export type ApprovalRelay = { stop: () => void };

const RELAYED_KEY = "letta.delivery.relayedApprovals";
const DEFAULT_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/** Project one probed approval to the service's ingestion shape. */
export function toIngest(approval: HomeProbedApproval, now = new Date()): ApprovalIngest {
  return {
    kind: "approval",
    conversationId: approval.conversationId,
    agentId: approval.agentId ?? "",
    requestId: approval.request.requestId,
    summary: `${approval.request.toolName} is waiting for your decision`,
    at: now.toISOString(),
  };
}

/** Load the relayed map from kv, pruning entries older than the window. */
async function loadRelayed(
  kv: ApprovalRelayDeps["kv"],
  pruneMs: number,
  now = Date.now(),
): Promise<Record<string, number>> {
  const raw = await kv.get(RELAYED_KEY);
  let map: Record<string, number> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [requestId, at] of Object.entries(parsed)) {
        if (typeof at === "number" && now - at < pruneMs) map[requestId] = at;
      }
    } catch {
      // Corrupt store = empty (same doctrine as the read cursors).
    }
  }
  return map;
}

/**
 * Starts the relay loop: one cycle immediately (approvals pending NOW
 * reach phones fast), then every intervalMs. Returns the stop handle —
 * the loop dies with the app (D6: while-running, no daemon).
 */
export async function startApprovalRelay(deps: ApprovalRelayDeps): Promise<ApprovalRelay> {
  const pruneMs = deps.pruneMs ?? DEFAULT_PRUNE_MS;
  let relayed = await loadRelayed(deps.kv, pruneMs);

  const persist = async () => {
    await deps.kv.set(RELAYED_KEY, JSON.stringify(relayed));
  };

  const cycle = async () => {
    let pending: HomeProbedApproval[];
    try {
      pending = await deps.probe();
    } catch (error) {
      deps.log(`approval probe failed, will retry next cycle: ${String(error)}`);
      return;
    }
    let changed = false;
    for (const approval of pending) {
      const requestId = approval.request.requestId;
      if (requestId in relayed) continue;
      const ingest = toIngest(approval);
      if (!ingest.agentId) {
        // The probe scan tags agentId; an untagged approval never reaches
        // the service (its contract requires agentId) — skip honestly.
        deps.log(`skipping relay of untagged approval ${requestId}`);
        continue;
      }
      try {
        await deps.send(ingest);
        relayed[requestId] = Date.now();
        changed = true;
      } catch (error) {
        deps.log(`relay send failed for ${requestId}, will retry next cycle: ${String(error)}`);
      }
    }
    if (changed) await persist();
  };

  await cycle();
  const timer = setInterval(() => void cycle(), deps.intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
