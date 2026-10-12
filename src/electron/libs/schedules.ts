import { activeProfile, getProfileSecret } from "./profiles.js";
import type { ScheduleSummary } from "../types.js";

/**
 * The D1 REST module — app-side REST to Letta Cloud for schedules.
 *
 * Why this exists: the Agent SDK has NO schedule/run listing surface (verified
 * against @letta-ai/letta-agent-sdk 0.8.39 — no schedules client method), so
 * the home's "Next scheduled" section reads the public REST API directly:
 * GET /v1/agents/{agent_id}/schedule. The response shape below is the minimal
 * structural typing of that endpoint (Letta API reference, scheduled
 * messages). Provenance ledger: PROVENANCE.md.
 *
 * Auth invariant: the OAuth token is resolved HERE, in main, through the
 * existing transport plumbing (getProfileSecret — refresh, single-flight,
 * strike-out). Only the projected ScheduleSummary crosses the bridge; tokens
 * never cross the bridge and never leave main.
 *
 * Cloud only: local-backend schedules live on the machine that created them
 * and are not in the cloud API, so a non-cloud (or signed-out) profile
 * honestly yields an empty list rather than an error.
 */

/** Minimal structural typing of the REST response (unknown fields ignored). */
interface RawScheduledMessage {
  id: string;
  agent_id: string;
  message: {
    messages?: { content?: string | { text?: string }[] }[];
  } | null;
  next_scheduled_time: string | null;
  schedule: {
    type?: string;
    scheduled_at?: number;
    cron_expression?: string;
  } | null;
}

interface RawScheduleListResponse {
  scheduled_messages?: RawScheduledMessage[];
}

/** Best-effort prompt preview: the first message's text content. */
export function firstText(
  content: string | { text?: string }[] | undefined,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.find((part) => typeof part?.text === "string")?.text ?? "";
}

/** Project one raw REST record to the bridge-safe summary. */
export function toScheduleSummary(raw: RawScheduledMessage): ScheduleSummary {
  const schedule = raw.schedule ?? {};
  const recurring = schedule.type === "recurring" || schedule.cron_expression !== undefined;
  return {
    id: raw.id,
    agentId: raw.agent_id,
    promptPreview: firstText(raw.message?.messages?.[0]?.content),
    nextScheduledTime: raw.next_scheduled_time,
    kind: recurring ? "recurring" : "one-time",
    cronExpression: recurring ? (schedule.cron_expression ?? null) : null,
  };
}

/** Merge per-agent lists into one, soonest first; unscheduled last. */
export function mergeSchedules(perAgent: ScheduleSummary[][]): ScheduleSummary[] {
  const all = perAgent.flat();
  return all.sort((a, b) => {
    if (!a.nextScheduledTime && !b.nextScheduledTime) return a.id.localeCompare(b.id);
    if (!a.nextScheduledTime) return 1;
    if (!b.nextScheduledTime) return -1;
    return a.nextScheduledTime.localeCompare(b.nextScheduledTime);
  });
}

/** List one agent's scheduled messages via the cloud REST API. */
export async function listAgentSchedules(agentId: string): Promise<ScheduleSummary[]> {
  const profile = activeProfile();
  if (!profile || profile.type !== "cloud") return [];
  const secret = await getProfileSecret(profile.id);
  if (!secret) return [];
  const base = profile.url.replace(/\/$/, "");
  const response = await fetch(`${base}/v1/agents/${agentId}/schedule`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Could not load schedules from Letta Cloud (${response.status}).`);
  }
  const body = (await response.json()) as RawScheduleListResponse;
  if (!Array.isArray(body.scheduled_messages)) {
    throw new Error("Unexpected schedules response from Letta Cloud.");
  }
  return body.scheduled_messages.map(toScheduleSummary);
}
