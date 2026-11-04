import { routineChatOnScreen } from "@/lib/routine-ring";
import { isShownMessage } from "@/lib/shown-message";
import { shouldClearSelectedUnread } from "./store-transforms";
import type { AppState, Message } from "./store-types";

type ReadRecord = { threadId?: string; unread?: boolean; readAt?: number };
type CoveredFrame = { kind: string; threadId?: string; message?: Message; bot?: { id: string }; group?: { id: string } };

export function createViewedReplies() {
  const pending = new Map<string, number>();
  return {
    note(state: AppState, threadId: string, message: Message, windowActive: boolean) {
      if (!windowActive || !routineChatOnScreen(state) || message.role !== "bot" || message.kind !== "text" || !isShownMessage(message) || message.at === undefined) return;
      const owner = [...state.bots, ...state.groups].find((record) => record.threadId === threadId);
      if (!owner || owner.id !== state.selectedId) return;
      pending.set(threadId, Math.max(pending.get(threadId) ?? -Infinity, owner.readAt ?? -Infinity, message.at));
    },
    patch(record: ReadRecord, clearUnread: boolean) {
      const readAt = pending.get(record.threadId ?? "");
      const patch: { unread?: false; readAt?: number } = clearUnread ? { unread: false } : {};
      if (readAt !== undefined) {
        if ((record.readAt ?? -Infinity) >= readAt) pending.delete(record.threadId!);
        else patch.readAt = readAt;
      }
      // Keep the boundary until a record frame acknowledges it.
      Object.assign(record, patch);
      return patch.unread === false || patch.readAt !== undefined ? patch : null;
    },
    coveredPatch(state: AppState, frames: readonly CoveredFrame[], windowActive: boolean) {
      const bot = state.bots.find((record) => record.id === state.selectedId);
      const record = bot ?? state.groups.find((record) => record.id === state.selectedId);
      if (!record || !frames.some((frame) => frame.threadId === record.threadId || frame.bot?.id === record.id || frame.group?.id === record.id)) return null;
      for (const frame of frames) {
        if (frame.kind === "message" && frame.message && frame.threadId) this.note(state, frame.threadId, frame.message, windowActive);
      }
      const patch = this.patch({ ...record }, shouldClearSelectedUnread(state, record, windowActive));
      return patch ? { path: `/api/${bot ? "bots" : "groups"}/${record.id}`, patch } : null;
    },
    forget(threadId: string) {
      pending.delete(threadId);
    },
  };
}
