import { activeProfile, getProfileSecret } from "./profiles.js";
import type { ProblemRow } from "../types.js";

/**
 * The D2 REST module — app-side REST to Letta Cloud for run failures.
 *
 * Why this exists: the home's "Problems" section needs observed run
 * failures. The Agent SDK has NO steps surface (verified against
 * @letta-ai/letta-agent-sdk 0.8.39 — steps are not a client resource), so
 * this module reads the public REST API directly: GET /v1/steps/ with an
 * agent_id filter (Letta API reference, List Steps). The endpoint has NO
 * status filter parameter — recent steps are fetched newest-first and
 * status "failed" is applied client-side. The response shape below is the
 * minimal structural typing of that endpoint. Provenance ledger:
 * PROVENANCE.md.
 *
 * Surveyed bounds (Oct 12 2026, recorded in PROVENANCE.md): the Schedule
 * payload carries NO last-run/missed/failed state, and no delivery-failure
 * surface exists in the surveyed API — so "missed schedules" and "delivery
 * failures" are NOT derivable. Failed SCHEDULED runs do surface here:
 * scheduled messages execute through the same pipeline and leave steps.
 * Steps carry no conversation_id — the row leads to the agent, not a chat.
 *
 * Auth invariant (same as D1): the OAuth token is resolved HERE, in main,
 * through getProfileSecret. Only the projected ProblemRow crosses the
 * bridge; tokens never cross the bridge and never leave main.
 *
 * Cloud only: a non-cloud (or signed-out) profile honestly yields an
 * empty list rather than an error.
 */

/** Minimal structural typing of the REST response (unknown fields ignored). */
interface RawStep {
  id: string;
  status?: string | null;
  error_type?: string | null;
  stop_reason?: string | null;
  origin?: string | null;
  created_at?: string | null;
}

/** The latest observed failure for one agent, or null when recent steps all succeeded. */
export function toProblemRow(agentId: string, raw: RawStep): ProblemRow | null {
  if (raw.status !== "failed") return null;
  return {
    agentId,
    stepId: raw.id,
    errorType: raw.error_type ?? null,
    stopReason: raw.stop_reason ?? null,
    origin: raw.origin ?? null,
    failedAt: raw.created_at ?? new Date().toISOString(),
  };
}

/**
 * One agent's latest failed step from its most recent steps, newest first.
 * Collapses a failed turn's step noise into one actionable row (§3.1/§3.5).
 */
export async function listAgentProblems(agentId: string): Promise<ProblemRow | null> {
  const profile = activeProfile();
  if (!profile || profile.type !== "cloud") return null;
  const secret = await getProfileSecret(profile.id);
  if (!secret) return null;
  const base = profile.url.replace(/\/$/, "");
  const params = new URLSearchParams({ agent_id: agentId, limit: "20", order: "desc" });
  const response = await fetch(`${base}/v1/steps/?${params}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Could not load steps from Letta Cloud (${response.status}).`);
  }
  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    throw new Error("Unexpected steps response from Letta Cloud.");
  }
  const steps = body as RawStep[];
  for (const step of steps) {
    const row = toProblemRow(agentId, step);
    if (row) return row;
  }
  return null;
}
