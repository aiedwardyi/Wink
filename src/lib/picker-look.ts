import { useSyncExternalStore } from "react";
import { DEFAULT_SKIN, HUD_SKIN_IDS, LIGHT_SKIN_IDS, type SkinId } from "./skins";
import { trackSetting } from "./usage-stats";

export type PickerLook = "dark" | "light" | "atelier";
export type PickerLookChoice = "theme" | PickerLook;
export const PICKER_LOOK_CHOICES: readonly PickerLookChoice[] = ["theme", "dark", "light", "atelier"];
// A new key: looks saved by the old Settings row (omb-picker-look) stay ignored.
const KEY = "omb-model-picker-look";
const watchers = new Set<() => void>();

function readPickedLook(): PickerLookChoice {
  try {
    const value = localStorage.getItem(KEY);
    return PICKER_LOOK_CHOICES.find((look) => look === value) ?? "theme";
  } catch {
    return "theme";
  }
}

let picked = readPickedLook();

export function pickerLook(skin: SkinId): PickerLook {
  return skin === "atelier" ? "atelier" : LIGHT_SKIN_IDS.has(skin) ? "light" : "dark";
}

/** The skin whose colors the picker borrows, when not the app's own. */
export function pickerLookSkin(skin: SkinId, look: PickerLook): SkinId | undefined {
  if (look === "atelier") return skin === "atelier" ? undefined : "atelier";
  if (look === "light") return LIGHT_SKIN_IDS.has(skin) && skin !== "atelier" ? undefined : "wink-day";
  return HUD_SKIN_IDS.has(skin) ? DEFAULT_SKIN : undefined;
}

export function shownPickerLook(choice: PickerLookChoice, skin: SkinId): PickerLook {
  return choice === "theme" ? pickerLook(skin) : choice;
}

export const pickedLook = () => picked;

export function savePickerLook(value: PickerLookChoice): void {
  const stat = (choice: PickerLookChoice) => choice === "theme" ? "follow" : choice;
  trackSetting("pickerLook", stat(picked), stat(value), "picker", KEY);
  picked = value;
  try {
    if (value === "theme") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, value);
  } catch {
    // Keep the choice for this session when storage is blocked.
  }
  for (const notify of watchers) notify();
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

export function usePickedLook(): PickerLookChoice {
  return useSyncExternalStore(subscribe, pickedLook, pickedLook);
}
