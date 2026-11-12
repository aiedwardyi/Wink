import { useSyncExternalStore } from "react";
import { DEFAULT_SKIN, HUD_SKIN_IDS, LIGHT_SKIN_IDS, type SkinId } from "./skins";
import { trackSetting } from "./usage-stats";

export type PickerLook = "dark" | "light" | "atelier";
export const PICKER_LOOK_KEY = "omb-picker-look";
const LOOKS: readonly PickerLook[] = ["dark", "light", "atelier"];
const watchers = new Set<() => void>();

function readPickerLook(): PickerLook | null {
  try {
    const value = localStorage.getItem(PICKER_LOOK_KEY);
    return LOOKS.find((look) => look === value) ?? null;
  } catch {
    return null;
  }
}

let picked = readPickerLook();

export function pickerLook(skin: SkinId): PickerLook {
  return picked ?? (skin === "atelier" ? "atelier" : LIGHT_SKIN_IDS.has(skin) ? "light" : "dark");
}

/** The skin whose colors the picker borrows, when not the app's own. */
export function pickerLookSkin(skin: SkinId, look: PickerLook): SkinId | undefined {
  if (look === "atelier") return skin === "atelier" ? undefined : "atelier";
  if (look === "light") return LIGHT_SKIN_IDS.has(skin) && skin !== "atelier" ? undefined : "wink-day";
  return HUD_SKIN_IDS.has(skin) ? DEFAULT_SKIN : undefined;
}

export function savePickerLook(value: PickerLook): void {
  trackSetting("pickerLook", picked ?? "follow", value, "settings", PICKER_LOOK_KEY);
  picked = value;
  try {
    localStorage.setItem(PICKER_LOOK_KEY, value);
  } catch {
    // Keep the choice for this session when storage is blocked.
  }
  for (const notify of watchers) notify();
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

const pickedLook = () => picked;

export function usePickerLook(skin: SkinId): PickerLook {
  useSyncExternalStore(subscribe, pickedLook, pickedLook);
  return pickerLook(skin);
}
