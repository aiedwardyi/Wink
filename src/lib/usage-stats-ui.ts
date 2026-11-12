import { readGeometry } from "./geometry";
import { loadModelPickerView } from "./model-picker-view";
import { vibrationEnabled } from "./phone-swipe";
import { PICKER_LOOK_KEY } from "./picker-look";
import { rainbowBoxMode } from "./rainbow-box";
import { loadReplyStyle } from "./reply-style";
import { loadSidebarSide } from "./sidebar-preferences";
import { readSkin, readTriedSkins } from "./skins";
import { readUsageMode } from "./usage-preferences";

/** The look settings saved on this screen, for the daily `state` row. */
export function statsUi() {
  let look: string | null = null;
  try { look = localStorage.getItem(PICKER_LOOK_KEY); } catch { /* Follows the theme. */ }
  return {
    skin: readSkin(), shape: readGeometry(), pickerView: loadModelPickerView(),
    pickerLook: look === "dark" || look === "light" || look === "atelier" ? look : "follow",
    replyStyle: loadReplyStyle(), chatBox: rainbowBoxMode(), sidebar: loadSidebarSide(), vibration: vibrationEnabled(),
    usageMode: readUsageMode(), skinsTried: Math.min(99, readTriedSkins().length),
  };
}
