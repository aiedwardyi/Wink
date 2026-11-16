import { readGeometry } from "./geometry";
import { loadModelPickerView } from "./model-picker-view";
import { pickedLook } from "./picker-look";
import { vibrationEnabled } from "./phone-swipe";
import { rainbowBoxMode } from "./rainbow-box";
import { loadReplyStyle } from "./reply-style";
import { loadSidebarSide } from "./sidebar-preferences";
import { readSkin, readTriedSkins } from "./skins";
import { readUsageMode } from "./usage-preferences";

/** The look settings saved on this screen, for the daily `state` row. */
export function statsUi() {
  return {
    skin: readSkin(), shape: readGeometry(), pickerView: loadModelPickerView(),
    pickerLook: pickedLook() === "theme" ? "follow" : pickedLook(),
    replyStyle: loadReplyStyle(), chatBox: rainbowBoxMode(), sidebar: loadSidebarSide(), vibration: vibrationEnabled(),
    usageMode: readUsageMode(), skinsTried: Math.min(99, readTriedSkins().length),
  };
}
