# Provenance

This repo's counterpart to letta-client-core's ledger: a record of where
app-side surfaces come from and what they are allowed to depend on.

## D1 REST module — src/electron/libs/schedules.ts (Oct 12 2026, Phase 3 home shell)

- **Why app-side REST exists:** the home's "Next scheduled" section needs the
  account's scheduled messages. The Agent SDK has NO schedule/run listing
  surface (verified against @letta-ai/letta-agent-sdk 0.8.39 — no schedules
  client method), so this module reads the public cloud REST API directly:
  `GET /v1/agents/{agent_id}/schedule` (Letta API reference, scheduled
  messages). The response typing in the module is the minimal structural
  subset the projection consumes.
- **ONE module:** all direct-to-cloud REST lives in schedules.ts. Nothing else
  in the app may talk REST to api.letta.com; new REST needs either extend this
  module or get their own ledger entry with a D-ruling.
- **Auth invariant:** the OAuth token is resolved in MAIN via the existing
  transport plumbing (`getProfileSecret` — refresh, single-flight,
  strike-out). Only the projected `ScheduleSummary` crosses the bridge.
  Tokens never cross the bridge and never leave main.
- **Cloud only:** local-backend schedules live on the machine that created
  them and are not in the cloud API, so a non-cloud (or signed-out) profile
  honestly yields an empty list rather than an error.
- **Honest failure:** a non-ok response or unexpected shape throws — the home
  section shows the error state; no silent fallbacks.

## §2.6 approval probe — src/electron/libs/pendingApprovals.ts (Oct 12 2026, Phase 3 P4)

- **Survey verdict:** the Cloud REST surface has NO per-agent awaiting-input
  endpoint. Checked against the Letta API reference (Oct 12 2026): there is no
  runs resource (top-level: Agents, Archives, Blocks, Embeddings, Feedback,
  Files, Folders, Identities, Messages, Metrics, Passages, Schedule, Steps,
  Tools, Trace, Usage); `/v1/steps` carries step statuses
  pending/success/failed/cancelled but no approval payloads; tools
  "Update Approval" is configuration, not pending state. Pending approvals
  are SESSION state — the SDK's own docs say decisions "must still resolve
  through recoverPendingApprovals() and canUseTool". So NO new REST surface
  was added; discovery uses the SDK's §2.6 machinery instead.
- **The probe:** `probeConversation` attaches a bare session (no canUseTool,
  no device-state options — the probe must never intercept an approval
  callback or mutate runtime state), reads `getDeviceStatus()`, and detaches.
  `pendingControlRequests` projects to the app's existing `ApprovalRequest`
  shape, so live and probed approvals share one type and one rendering path.
- **Aggregation bound:** the home probes the most recent conversation per
  agent (cap 20 agents), skipping conversations with live turns (their
  approvals already flow through session events). Sequential, not parallel —
  a reconnect burst of simultaneous session attachments would be antisocial.
  Total probe failure throws (honest section error); partial failure stays
  honest-partial.
- **One approval path:** deciding routes through the EXISTING machinery —
  live cards call `respondApprovalFor` (the same `respondApproval` IPC and
  session-local callback); probed cards (no live turn in this client) lead
  to the conversation, where the existing recovery path
  (`recoverPendingApprovals` at send) takes over. No second approval path.
- **Server-authoritative:** when the runtime advances past an approval
  (activity "Responding" is only reachable after every pending approval of
  the turn resolved), the store drops lingering cards — a card never claims
  "pending" after the server has moved on, and never lingers as local-only
  state.

## D2 REST module — src/electron/libs/steps.ts (Oct 12 2026, Phase 3 P5)

- **Why app-side REST exists:** the home's "Problems" section needs observed
  run failures. The Agent SDK has NO steps surface (verified against
  @letta-ai/letta-agent-sdk 0.8.39 — steps are not a client resource), so
  this module reads the public REST API directly: `GET /v1/steps/` with an
  `agent_id` filter (Letta API reference, List Steps). The endpoint has NO
  status filter parameter — recent steps are fetched newest-first and
  status "failed" is applied client-side. Response typing is the minimal
  structural subset the projection consumes.
- **ONE module:** direct-to-cloud REST lives in schedules.ts (D1) and
  steps.ts (D2) — nothing else may talk REST to api.letta.com; new REST
  gets its own ledger entry with a D-ruling.
- **Auth invariant:** same as D1 — the OAuth token is resolved in MAIN via
  getProfileSecret; only the projected ProblemRow crosses the bridge.
- **Surveyed bounds (honest):** the Schedule payload carries NO
  last-run/missed/failed state (id, agent_id, message(s), callback_url,
  include_return_message_types, max_steps, next_scheduled_time, schedule —
  surveyed Oct 12 2026), and no delivery-failure surface exists in the
  surveyed API. So "missed schedules" and "delivery failures" are NOT
  derivable; failed SCHEDULED runs do surface, since scheduled messages
  execute through the same pipeline and leave steps. Steps carry no
  conversation_id — a Problems row leads to the agent's latest
  conversation, not a specific chat.
- **Honest failure:** a non-ok response or unexpected shape throws — the
  home section shows the error state; no silent fallbacks.

## App-owned read cursors — src/electron/libs/readCursors.ts (Oct 12 2026, Phase 3 P5)

- **Where cursors live:** profiles.json kv (the app's existing metadata
  store), keyed `letta.read.<profileId>.<conversationId>` →
  `{messageId, serverAt}`. Per §3.6, read state lives in OUR storage,
  never agent memory; per §3.3, "new" is decided by comparing message ids
  against the cursor, never inferred from absence. The id drives the
  new-message walk; the server-side date lets the scan skip unchanged
  conversations without a client/server clock comparison.
- **When they advance:** on open (looking at a conversation), and when a
  turn the user is watching finishes (§3.4 — ordinary completion noise is
  the failure mode). Both go through `markConversationRead`, which reads
  the newest message server-side and persists the cursor in main.
- **Baseline-on-first-sync (§3.2):** a conversation with no cursor gets its
  baseline established (cursor = newest message) and surfaces NOTHING —
  the first sync never floods the home with the historical backlog.
- **Completed mapping:** "Completed since you last looked" rides the
  EXISTING SDK message surface (conversations.listMessages, REST-backed) —
  no new REST surface. One row per conversation (§3.1: a turn's lifecycle
  is one row, not one per event; §3.5: tool calls, steps, and subagent
  activity collapse beneath the parent outcome). Scan bound: at most 20
  agents, conversations pruned by the cursor's server-side date before
  any message fetch.
