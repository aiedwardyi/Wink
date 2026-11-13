import { DEFAULT_SKIN, HUD_SKIN_IDS, LIGHT_SKIN_IDS, type SkinId } from "./skins";

export type PickerLook = "dark" | "light" | "atelier";

export function pickerLook(skin: SkinId): PickerLook {
  return skin === "atelier" ? "atelier" : LIGHT_SKIN_IDS.has(skin) ? "light" : "dark";
}

/** The skin whose colors the picker borrows, when not the app's own. */
export function pickerLookSkin(skin: SkinId, look: PickerLook): SkinId | undefined {
  if (look === "atelier") return skin === "atelier" ? undefined : "atelier";
  if (look === "light") return LIGHT_SKIN_IDS.has(skin) && skin !== "atelier" ? undefined : "wink-day";
  return HUD_SKIN_IDS.has(skin) ? DEFAULT_SKIN : undefined;
}
