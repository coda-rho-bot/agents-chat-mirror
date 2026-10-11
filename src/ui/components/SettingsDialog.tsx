import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore, type SettingsTab } from "../store";
import { ProfilesPanel } from "./ProfilesPanel";
import { ProvidersPanel } from "./ProvidersPanel";
import { CloseIcon } from "./icons";

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "connection", label: "Profiles" },
  { id: "providers", label: "Model providers" },
];

export function SettingsDialog() {
  const open = useAppStore((state) => state.settingsOpen);
  const tab = useAppStore((state) => state.settingsTab);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const openSettings = useAppStore((state) => state.openSettings);

  return (
    <Dialog.Root open={open} onOpenChange={setSettingsOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100%-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-elevated focus:outline-none"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-base font-semibold text-ink-900">Settings</Dialog.Title>
            <Dialog.Close
              aria-label="Close"
              className="rounded-lg p-1.5 text-muted hover:bg-surface-tertiary hover:text-ink-800"
            >
              <CloseIcon className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div role="tablist" className="mt-3 flex gap-1 border-b border-border">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => openSettings(item.id)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${tab === item.id ? "border-accent font-medium text-ink-900" : "border-transparent text-muted hover:text-ink-800"}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          {/* Mounted per open so the pane always starts from the saved state. */}
          {open && tab === "connection" && <ProfilesPanel />}
          {open && tab === "providers" && <ProvidersPanel />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
