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
