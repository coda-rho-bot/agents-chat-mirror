import { useAppStore } from "../store";
import { relativeTime, toolLabel, toolSummary } from "../lib/format";
import { envLabel, selectorMatchesComputer } from "../lib/env";
import { selectNeedsYouRows, type NeedsYouRow } from "../lib/home";
import type {
  AgentSummary,
  CompletedRow,
  HomeSectionState,
  ProblemRow,
  Provenance,
  ScheduleSummary,
} from "../types";

const primaryButton =
  "rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-brand-content transition-opacity hover:opacity-85";
const secondaryButton =
  "rounded-full border border-border bg-surface px-4 py-1.5 text-sm font-medium text-ink-800 hover:bg-surface-tertiary transition-colors";

/** One approval card (doc line 68): who, where, what, how old, what happens. */
function ApprovalCard({ row }: { row: NeedsYouRow }) {
  const conversation = useAppStore(
    (state) => state.conversations.find((item) => item.id === row.conversationId),
  );
  const agentName = useAppStore((state) => state.agents.find((item) => item.id === conversation?.agentId)?.name);
  const selector = useAppStore((state) => state.conversationEnvs[row.conversationId]?.selector);
  const respondApprovalFor = useAppStore((state) => state.respondApprovalFor);
  const openChat = useAppStore((state) => state.openChat);
  const { request } = row;
  const isQuestion = request.toolName === "AskUserQuestion";
  const questions = (request.input as { questions?: { question: string }[] }).questions;

  return (
    <div className="rounded-xl border border-accent/30 bg-surface p-4 shadow-card">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-ink-900">
          {isQuestion ? "Question from " : "Approval needed in "}
          {agentName ?? conversation?.agentId ?? "an agent"}
        </p>
        <span className="text-xs text-muted-light">waiting {relativeTime(row.receivedAt)}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted">
        {conversation?.title ?? row.conversationId} · trigger:{" "}
        {row.source === "live" ? "human" : "unknown"} · {envLabel(selector)}
        {conversation?.cwd ? ` · ${conversation.cwd}` : ""}
      </p>
      <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-tertiary p-2 font-mono text-xs text-ink-800">
        {isQuestion
          ? (questions ?? []).map((question) => question.question).join("\n")
          : toolSummary(request.input) || JSON.stringify(request.input, null, 2)}
      </pre>
      <p className="mt-2 text-xs text-muted">
        {isQuestion
          ? "Answering continues the turn."
          : `Allow runs ${toolLabel(request.toolName)}; deny cancels it with your message.`}
      </p>
      {row.source === "live" && !isQuestion ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className={primaryButton}
            onClick={() => respondApprovalFor(row.conversationId, request.requestId, { behavior: "allow" })}
          >
            Allow
          </button>
          <button
            type="button"
            className={secondaryButton}
            onClick={() =>
              respondApprovalFor(row.conversationId, request.requestId, { behavior: "deny" })
            }
          >
            Deny
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={`${secondaryButton} mt-3`}
          onClick={() => openChat(row.conversationId)}
        >
          {isQuestion ? "Open conversation to answer" : "Open conversation to decide"}
        </button>
      )}
    </div>
  );
}

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
        {state.rows.map((row, index) => (
          <li
            key={
              (row as { id?: string }).id ??
              (row as { conversationId?: string }).conversationId ??
              (row as { stepId?: string }).stepId ??
              index
            }
            className="py-2"
          >
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
  const openChat = useAppStore((state) => state.openChat);
  const openAgentLatest = useAppStore((state) => state.openAgentLatest);
  const conversations = useAppStore((state) => state.conversations);
  const profileSelector = useAppStore(
    ({ profiles, settings }) => {
      const id = settings?.activeProfileId;
      return id ? profiles.find((item) => item.id === id)?.computerSelector : undefined;
    },
  );
  const computers = useAppStore((state) => state.computers);
  const needsYouRows = useAppStore((state) =>
    selectNeedsYouRows(state.chats, state.home.needsYou.status === "ready" ? state.home.needsYou.rows : []),
  );
  const agentName = (agentId: string) =>
    home.agents.rows.find((agent) => agent.id === agentId)?.name ?? agentId;
  const conversationTitle = (conversationId: string) =>
    conversations.find((item) => item.id === conversationId)?.title ?? null;
  // Scheduled runs execute on the agent's default env: the account default
  // computer, or Cloud Sandbox when unset. The row shows the configured
  // target plus its online status — the silent-fallback lesson, structural.
  const scheduleTarget = () => {
    const label = envLabel(profileSelector);
    if (profileSelector === null || profileSelector === undefined) return label;
    const computer = computers.find((item) => selectorMatchesComputer(profileSelector, item));
    return computer ? `${label} · ${computer.status}` : `${label} · status unknown`;
  };

  return (
    <main className="flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
        <h1 className="text-lg font-semibold text-ink-900">Home</h1>

        {/* Canonical order (docs/CLIENT-STRATEGY.md): needs-me-first. */}
        <SectionCard title="Needs you">
          {needsYouRows.length > 0 ? (
            <>
              <div className="grid gap-3">
                {needsYouRows.map((row) => (
                  <ApprovalCard key={row.request.requestId} row={row} />
                ))}
              </div>
              <ProvenanceLine provenance={home.needsYou.provenance} />
            </>
          ) : home.needsYou.status === "loading" ? (
            <p className="text-sm text-muted">Checking for approvals…</p>
          ) : home.needsYou.status === "error" ? (
            <p className="text-sm text-error">{home.needsYou.error}</p>
          ) : (
            <p className="text-sm text-muted">No approvals needed right now.</p>
          )}
        </SectionCard>

        <SectionCard title="Completed since you last looked">
          <SectionBody
            state={home.completed}
            loadingLabel="Checking for new outcomes…"
            emptyLabel="Nothing new since your last look."
            renderRow={(row: CompletedRow) => (
              <button
                type="button"
                className="w-full text-left"
                onClick={() => openChat(row.conversationId)}
              >
                <p className="text-sm font-medium text-ink-900">
                  {agentName(row.agentId)}
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs text-ink-800">{row.preview}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {[
                    conversationTitle(row.conversationId),
                    relativeTime(Date.parse(row.completedAt)),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </button>
            )}
          />
        </SectionCard>

        <SectionCard title="Problems">
          <SectionBody
            state={home.problems}
            loadingLabel="Checking for problems…"
            emptyLabel="No problems reported."
            renderRow={(row: ProblemRow) => (
              <button
                type="button"
                className="w-full text-left"
                onClick={() => void openAgentLatest(row.agentId)}
              >
                <p className="text-sm font-medium text-ink-900">
                  {agentName(row.agentId)} hit a failure
                </p>
                <p className="mt-0.5 text-xs text-ink-800">
                  {row.errorType ?? row.stopReason ?? "run failed"}
                  {row.origin ? ` · via ${row.origin}` : ""}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {relativeTime(Date.parse(row.failedAt))} · opens latest conversation
                </p>
              </button>
            )}
          />
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
              <button
                type="button"
                className="w-full text-left"
                onClick={() => void openAgentLatest(schedule.agentId)}
              >
                <p className="text-sm font-medium text-ink-900">
                  {schedule.promptPreview || "Scheduled prompt"}
                </p>
                <p className="text-xs text-muted">
                  {agentName(schedule.agentId)} ·{" "}
                  {schedule.nextScheduledTime
                    ? new Date(schedule.nextScheduledTime).toLocaleString()
                    : "next time pending"}
                  {schedule.kind === "one-time" ? " · one-time" : ""}
                  {schedule.kind === "recurring" && schedule.cronExpression
                    ? ` · ${schedule.cronExpression}`
                    : ""}
                  {` · runs on ${scheduleTarget()}`}
                </p>
              </button>
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
