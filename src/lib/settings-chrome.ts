import type { AppSettingsSection } from "@/state/store";
import { showSettingsEnginesNav } from "./friends-chrome";
import { settingsSectionMatches } from "./settings-search";

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
  query: string,
  input: { phoneAvailable: boolean },
): boolean {
  if (id === "sync") return false;
  if (id === "companion" && !input.phoneAvailable) return false;
  if (id === "engines" && !showSettingsEnginesNav()) return false;
  return settingsSectionMatches(id, query);
}

/** Preserve old section links after regrouping Settings. */
export function resolvedAppSettingsSection(id: AppSettingsSection): AppSettingsSection {
  if (id === "sync") return "account";
  if (id === "engines" && !showSettingsEnginesNav()) return "connections";
  return id;
}
