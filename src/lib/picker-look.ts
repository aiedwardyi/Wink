import { useSyncExternalStore } from "react";
import { DEFAULT_SKIN, HUD_SKIN_IDS, LIGHT_SKIN_IDS, type SkinId } from "./skins";
import { trackSetting } from "./usage-stats";

export type PickerLook = "dark" | "light" | "atelier";
export const PICKER_LOOKS: readonly PickerLook[] = ["dark", "light", "atelier"];
// A new key: looks saved by the old Settings row (omb-picker-look) stay ignored.
const KEY = "omb-model-picker-look";
const watchers = new Set<() => void>();

function readPickedLook(): PickerLook | null {
  try {
    const value = localStorage.getItem(KEY);
    return PICKER_LOOKS.find((look) => look === value) ?? null;
  } catch {
    return null;
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

export const pickedLook = () => picked;

export function savePickerLook(value: PickerLook): void {
  trackSetting("pickerLook", picked ?? "follow", value, "picker", KEY);
  picked = value;
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // Keep the choice for this session when storage is blocked.
  }
  for (const notify of watchers) notify();
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

/** The look picked in the picker, or null while it follows the theme. */
export function usePickedLook(): PickerLook | null {
  return useSyncExternalStore(subscribe, pickedLook, pickedLook);
}
