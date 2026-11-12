import type { Action, AppState, AppSettingsSection } from "../state/store-types";
import { takeVia, trackFeature, trackScreen, trackSend, trackSetting, trackSwitch } from "./usage-stats";

const SECTIONS = {
  account: "settings-account", general: "settings-general", connections: "settings-connections", themes: "settings-themes",
  shortcuts: "settings-shortcuts", companion: "settings-devices", usage: "settings-usage", team: "settings-team",
  "models-index": "settings-model-index", sync: "settings-sync",
} as const satisfies Record<AppSettingsSection, string>;
const flag = (value: boolean | undefined) => (value ? "on" : "off");

/** What a store action says about usage, read against the state before it lands. Ids and counts only, never names or text. */
export function trackAction(action: Action, state: AppState): void {
  switch (action.type) {
    case "select":
      if (action.id === state.selectedId) return;
      trackSwitch("chat");
      return trackScreen(state.groups.some((group) => group.id === action.id) ? "room" : "chat");
    case "send": {
      const bot = () => state.bots.find((candidate) => candidate.id === action.botId);
      return trackSend(action.threadId ?? bot()?.threadId, () => {
        const selection = bot()?.modelSelection;
        return { engine: state.instances.find((instance) => instance.instanceId === selection?.instanceId)?.driverKind, model: selection?.model };
      });
    }
    case "sendGroup":
      return trackSend(action.threadId ?? state.groups.find((group) => group.id === action.groupId)?.threadId);
    case "setModel": {
      const from = state.bots.find((bot) => bot.id === action.botId)?.modelSelection;
      const engine = (id: string | undefined) => state.instances.find((instance) => instance.instanceId === id)?.driverKind;
      if (!from) return;
      const via = takeVia("picker");
      if (from.instanceId !== action.selection.instanceId) trackSwitch("engine", via, engine(from.instanceId), engine(action.selection.instanceId));
      trackSwitch("model", via, from.model, action.selection.model);
      return trackSwitch("effort", via, from.effort ?? "auto", action.selection.effort ?? "auto");
    }
    case "updateBot": {
      const bot = state.bots.find((candidate) => candidate.id === action.botId);
      const { autoApprove, memoryNotes, hidden } = action.patch;
      if (autoApprove !== undefined) trackSetting("approvals", bot?.autoApprove ? "auto" : "ask", autoApprove ? "auto" : "ask");
      if (memoryNotes !== undefined) trackSetting("autoNotes", flag(!memoryNotes), flag(memoryNotes));
      if (hidden && !bot?.hidden) trackFeature("bot.archive");
      return;
    }
    case "toggleAppSettings":
      if (action.open ?? !state.appSettingsOpen) trackScreen(SECTIONS[action.section ?? state.appSettingsSection]);
      return;
    case "toggleSettings":
      if (!(action.open ?? !state.settingsOpen)) return;
      trackFeature("slot.open", { kind: "details" });
      return trackScreen(action.memory ? "memory" : action.avatar ? "avatar" : "details");
    case "toggleInspector":
      if (!(action.open ?? !state.inspectorOpen)) return;
      trackFeature("slot.open", { kind: "inspector" });
      return trackScreen("inspector");
    case "newBot":
      return trackScreen("new-bot");
    case "createGroup":
      return trackFeature("room.create", { n: action.memberIds.length });
    case "deleteBot":
      return trackFeature("bot.delete");
    case "toggleReaction":
      if (!action.message?.reactions?.some((reaction) => reaction.emoji === action.emoji && reaction.by === "user")) trackFeature("reaction.add");
      return;
    case "decideRequest":
      if (action.behavior === "answer") return trackFeature("question.answer");
      return trackFeature("approval.answer", { kind: action.alwaysAllow ? "always" : action.behavior });
    case "answerCard":
    case "answerGroupCard":
      return trackFeature("question.answer");
  }
}
