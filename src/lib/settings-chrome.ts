import type { AppSettingsSection } from "@/state/store";

export function appSettingsNavigation(
  state: { appSettingsOpen: boolean; appSettingsSection: AppSettingsSection },
  action: { open?: boolean; section?: AppSettingsSection },
) {
  const open = action.open ?? !state.appSettingsOpen;
  return {
    appSettingsOpen: open,
    appSettingsSection: action.section ?? (open ? "general" as const : state.appSettingsSection),
    appSettingsPage: open && action.section !== undefined,
  };
}

// Phone setup belongs to the PC; engines live on Connections.
export function friendsSettingsNavVisible(
  id: AppSettingsSection,
  input: { phoneAvailable: boolean },
): boolean {
  if (id === "sync") return false;
  if (id === "companion" && !input.phoneAvailable) return false;
  return true;
}

/** Preserve old section links after regrouping Settings. */
export function resolvedAppSettingsSection(id: AppSettingsSection): AppSettingsSection {
  if (id === "sync") return "account";
  return id;
}
