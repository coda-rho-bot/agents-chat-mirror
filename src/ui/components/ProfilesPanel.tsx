import { useState } from "react";
import { useAppStore } from "../store";
import type { ProfileSummary, ProfileSave } from "../types";
import { Spinner } from "./icons";

/**
 * The profiles pane: multiple named connections (cloud OAuth, cloud API key,
 * remote server), switchable, plus the built-in "This computer" connection.
 * Secrets never cross the bridge — the panel only learns whether one exists.
 */

const TYPE_LABELS: Record<ProfileSummary["type"], string> = {
  cloud: "Letta Cloud",
  remote: "Self-hosted",
};

function credentialLabel(profile: ProfileSummary): string {
  if (profile.type === "remote") return profile.hasCredential ? "Token saved" : "No token";
  if (profile.authMethod === "oauth") return profile.hasCredential ? "Signed in" : "Signed out";
  return profile.hasCredential ? "API key saved" : "No API key";
}

type Draft = {
  id?: string;
  type: "cloud" | "remote";
  name: string;
  url: string;
  secret: string;
  /** Set when editing an existing OAuth profile (secret managed by sign-in). */
  oauth: boolean;
};

function draftFrom(profile: ProfileSummary | null): Draft {
  if (!profile) return { type: "cloud", name: "", url: "", secret: "", oauth: false };
  return {
    id: profile.id,
    type: profile.type,
    name: profile.name,
    url: profile.url,
    secret: "",
    oauth: profile.authMethod === "oauth",
  };
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="grid gap-1.5">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

function ProfileRow({
  profile,
  active,
  busy,
  onActivate,
  onEdit,
  onSignOut,
  onRemove,
}: {
  profile: ProfileSummary;
  active: boolean;
  busy: boolean;
  onActivate: () => void;
  onEdit: () => void;
  onSignOut: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 transition-colors ${active ? "border-accent bg-accent-subtle" : "border-border hover:bg-surface-tertiary"}`}
    >
      <input
        type="radio"
        name="profile"
        aria-label={`Use ${profile.name}`}
        className="mt-1 accent-[var(--color-accent)]"
        checked={active}
        disabled={busy}
        onChange={onActivate}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink-900">{profile.name}</span>
          <span className="rounded-full bg-surface-tertiary px-2 py-0.5 text-[10px] font-medium text-muted">
            {TYPE_LABELS[profile.type]}
            {profile.authMethod === "oauth" ? " · sign-in" : ""}
          </span>
        </div>
        <div className="truncate text-xs text-muted">
          {profile.url || "—"} · {credentialLabel(profile)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs">
        <button type="button" className="underline" disabled={busy} onClick={onEdit}>
          Edit
        </button>
        {profile.authMethod === "oauth" && profile.hasCredential && (
          <button type="button" className="underline" disabled={busy} onClick={onSignOut}>
            Sign out
          </button>
        )}
        <button type="button" className="underline" disabled={busy} onClick={onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

export function ProfilesPanel() {
  const profiles = useAppStore((state) => state.profiles);
  const settings = useAppStore((state) => state.settings);
  const connection = useAppStore((state) => state.connection);
  const switchProfile = useAppStore((state) => state.switchProfile);
  const saveProfile = useAppStore((state) => state.saveProfile);
  const deleteProfile = useAppStore((state) => state.deleteProfile);
  const signOutProfile = useAppStore((state) => state.signOutProfile);
  const oauthSignIn = useAppStore((state) => state.oauthSignIn);
  const reconnect = useAppStore((state) => state.reconnect);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeProfileId = settings?.activeProfileId ?? null;
  const editing = draft?.id ? profiles.find((item) => item.id === draft.id) : undefined;

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const remove = (profile: ProfileSummary) => {
    const message = profile.hasCredential
      ? `Remove "${profile.name}"? Its saved sign-in or key is revoked and deleted.`
      : `Remove "${profile.name}"?`;
    if (!window.confirm(message)) return;
    void run(async () => {
      await deleteProfile(profile.id);
      setDraft(null);
    });
  };

  const submit = () => {
    if (!draft) return;
    void run(async () => {
      const input: ProfileSave = {
        ...(draft.id ? { id: draft.id } : {}),
        type: draft.type,
        name: draft.name,
        url: draft.url,
        ...(draft.secret.trim() ? { secret: draft.secret } : {}),
      };
      await saveProfile(input);
      setDraft(null);
    });
  };

  const signIn = (profileId?: string) => {
    void run(async () => {
      await oauthSignIn(profileId);
      setDraft(null);
    });
  };

  const canSave =
    draft !== null && (draft.type === "cloud" || draft.url.trim().length > 0);

  return (
    <div className="mt-4 grid gap-4">
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-xs font-medium text-ink-700">Where your agents live</legend>
        <label
          className={`flex cursor-pointer gap-3 rounded-xl border px-3.5 py-3 transition-colors ${activeProfileId === null ? "border-accent bg-accent-subtle" : "border-border hover:bg-surface-tertiary"}`}
        >
          <input
            type="radio"
            name="profile"
            className="mt-1 accent-[var(--color-accent)]"
            checked={activeProfileId === null}
            disabled={busy}
            onChange={() => void run(() => switchProfile(null))}
          />
          <span>
            <span className="block text-sm font-medium text-ink-900">This computer</span>
            <span className="block text-xs text-muted">
              Agents and their memory are stored on this machine. No account needed.
            </span>
          </span>
        </label>
        {profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            active={activeProfileId === profile.id}
            busy={busy}
            onActivate={() => void run(() => switchProfile(profile.id))}
            onEdit={() => {
              setError(null);
              setDraft(draftFrom(profile));
            }}
            onSignOut={() => void run(() => signOutProfile(profile.id))}
            onRemove={() => remove(profile)}
          />
        ))}
      </fieldset>

      {draft ? (
        <form
          className="grid gap-4 rounded-xl border border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave) submit();
          }}
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-ink-900">
              {editing ? `Edit ${editing.name}` : "Add a profile"}
            </span>
            <button
              type="button"
              className="text-xs underline"
              onClick={() => {
                setDraft(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>

          <div className="grid gap-2">
            {(["cloud", "remote"] as const).map((type) => (
              <label
                key={type}
                className={`flex cursor-pointer gap-3 rounded-xl border px-3.5 py-2.5 transition-colors ${draft.type === type ? "border-accent bg-accent-subtle" : "border-border hover:bg-surface-tertiary"}`}
              >
                <input
                  type="radio"
                  name="draft-type"
                  className="mt-1 accent-[var(--color-accent)]"
                  checked={draft.type === type}
                  onChange={() => setDraft({ ...draft, type })}
                />
                <span>
                  <span className="block text-sm font-medium text-ink-900">
                    {type === "cloud" ? "Letta Cloud" : "Self-hosted server"}
                  </span>
                  <span className="block text-xs text-muted">
                    {type === "cloud"
                      ? "Agents are stored in Letta Cloud. Tools still run on this machine."
                      : "Connect to a Letta app server you run yourself."}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <Field label="Name">
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder={draft.type === "cloud" ? "Letta Cloud" : "Remote server"}
              className="field"
            />
          </Field>

          <Field
            label={draft.type === "cloud" ? "API base URL" : "Server URL"}
            hint={
              draft.type === "cloud"
                ? "Optional. Leave empty for api.letta.com."
                : "Start one with: letta server --backend local --listen ws://127.0.0.1:4500"
            }
          >
            <input
              value={draft.url}
              onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              placeholder={draft.type === "cloud" ? "https://api.letta.com" : "ws://127.0.0.1:4500"}
              className="field font-mono"
            />
          </Field>

          {draft.type === "cloud" ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => signIn(draft.id)}
                >
                  {busy ? "Waiting for browser…" : "Sign in with Letta"}
                </button>
                <span className="text-xs opacity-60">
                  Opens your browser; returns here when signed in.
                </span>
              </div>
              {!draft.oauth && (
                <Field
                  label="API key"
                  hint={
                    editing?.hasCredential
                      ? "A key is saved. Enter a new one to replace it."
                      : "Create one at app.letta.com/settings, or sign in above instead."
                  }
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={draft.secret}
                    onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                    placeholder={editing?.hasCredential ? "Saved" : "sk-let-..."}
                    className="field font-mono"
                  />
                </Field>
              )}
            </>
          ) : (
            <Field
              label="Access token"
              hint={
                editing?.hasCredential
                  ? "A token is saved. Enter a new one to replace it."
                  : "Only needed if the server was started with --ws-auth."
              }
            >
              <input
                type="password"
                autoComplete="off"
                value={draft.secret}
                onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
                placeholder={editing?.hasCredential ? "Saved" : "Optional"}
                className="field font-mono"
              />
            </Field>
          )}

          <div className="flex items-center justify-end gap-3">
            <button type="submit" className="button-primary" disabled={!canSave || busy}>
              Save profile
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="button-secondary justify-self-start"
          disabled={busy}
          onClick={() => {
            setError(null);
            setDraft(draftFrom(null));
          }}
        >
          Add profile
        </button>
      )}

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <div className="min-w-0 flex-1 text-xs" role="status">
          {error ? (
            <span className="text-error">{error}</span>
          ) : !connection || connection.status === "connecting" ? (
            <span className="flex items-center gap-2 text-muted">
              <Spinner className="h-3 w-3" />
              Connecting
            </span>
          ) : connection.status === "ready" ? (
            <span className="text-success">Connected to {connection.detail}</span>
          ) : (
            <span className="flex items-start gap-2 text-error">
              <span className="min-w-0 break-words">{connection.error}</span>
              <button type="button" className="shrink-0 underline" onClick={reconnect}>
                Retry
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
