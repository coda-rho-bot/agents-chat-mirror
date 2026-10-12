import { useAppStore } from "../store";
import { relativeTime } from "../lib/format";
import type { AgentSummary, HomeSectionState, Provenance, ScheduleSummary } from "../types";

/** The provenance line every home row carries — how and when it was fetched. */
function ProvenanceLine({ provenance }: { provenance: Provenance | null }) {
  if (!provenance) return null;
  const label =
    provenance.source === "live"
      ? "Live"
      : provenance.source === "rest"
        ? "REST api.letta.com"
        : "Cached";
  return (
    <p className="text-xs text-muted-light">
      {label} · {relativeTime(provenance.fetchedAt)}
    </p>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <h2 className="mb-2 text-sm font-semibold text-ink-900">{title}</h2>
      {children}
    </section>
  );
}

/** One section's honest state: loading, its error, or its rows. */
function SectionBody<Row>(props: {
  state: HomeSectionState<Row>;
  loadingLabel: string;
  emptyLabel: string;
  renderRow: (row: Row) => React.ReactNode;
  provenanceNote?: boolean;
}) {
  const { state, loadingLabel, emptyLabel, renderRow } = props;
  if (state.status === "loading") {
    return <p className="text-sm text-muted">{loadingLabel}</p>;
  }
  if (state.status === "error") {
    return <p className="text-sm text-error">{state.error}</p>;
  }
  if (state.rows.length === 0) {
    return <p className="text-sm text-muted">{emptyLabel}</p>;
  }
  return (
    <>
      <ul className="divide-y divide-border">
        {state.rows.map((row) => (
          <li key={(row as { id: string }).id} className="py-2">
            {renderRow(row)}
          </li>
        ))}
      </ul>
      {props.provenanceNote !== false && <ProvenanceLine provenance={state.provenance} />}
    </>
  );
}

/** The launch view: a read-only account overview, five sections in spec order. */
export function HomeView() {
  const home = useAppStore((state) => state.home);
  const agentName = (agentId: string) =>
    home.agents.rows.find((agent) => agent.id === agentId)?.name ?? agentId;

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <h1 className="text-lg font-semibold text-ink-900">Home</h1>

        {/* Canonical order (docs/CLIENT-STRATEGY.md): needs-me-first. The
            first three sections are P4/P5 panes — honest states only. */}
        <SectionCard title="Needs you">
          <p className="text-sm text-muted">No approvals needed right now.</p>
        </SectionCard>

        <SectionCard title="Completed since you last looked">
          <p className="text-sm text-muted">Nothing new since your last look.</p>
        </SectionCard>

        <SectionCard title="Problems">
          <p className="text-sm text-muted">No problems reported.</p>
        </SectionCard>

        <SectionCard title="Next scheduled">
          <SectionBody
            state={home.schedules}
            loadingLabel="Loading schedules…"
            emptyLabel="No scheduled prompts."
            renderRow={(schedule: ScheduleSummary) => (
              <div>
                <p className="text-sm font-medium text-ink-900">
                  {schedule.promptPreview || "Scheduled prompt"}
                </p>
                <p className="text-xs text-muted">
                  {agentName(schedule.agentId)} ·{" "}
                  {schedule.nextScheduledTime
                    ? new Date(schedule.nextScheduledTime).toLocaleString()
                    : "next time pending"}
                  {schedule.kind === "recurring" && schedule.cronExpression
                    ? ` · ${schedule.cronExpression}`
                    : ""}
                </p>
              </div>
            )}
          />
        </SectionCard>

        <SectionCard title="Agents">
          <SectionBody
            state={home.agents}
            loadingLabel="Loading agents…"
            emptyLabel="No agents yet — create one to get started."
            renderRow={(agent: AgentSummary) => (
              <div>
                <p className="text-sm font-medium text-ink-900">{agent.name}</p>
                {agent.model && <p className="text-xs text-muted">{agent.model}</p>}
              </div>
            )}
          />
        </SectionCard>
      </div>
    </main>
  );
}
