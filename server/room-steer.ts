// A busy room's plain send joins the working member's turn, the same steer a 1:1 send makes.
import type { ProviderInstance } from "./contracts.ts";
import { promptWithReply } from "./replies.ts";
import type { HostedGroup } from "./rooms/asks.ts";
import { hostSend } from "./rooms/send.ts";
import { steersSend } from "./send-deliver.ts";
import { roomResponders, type BotRecord, type GroupRecord, type Message, type Store } from "./store.ts";

export type RoomSteerDeps = {
  store: Pick<Store, "bot" | "group" | "appendMessage" | "patchMessage">;
  instanceForBot?: (bot: BotRecord, threadId?: string) => ProviderInstance | null;
  userName: () => string;
};

/** The steered row, or null when the line should start the room's next turn as before. */
export async function steerRoomSend(
  { store, instanceForBot, userName }: RoomSteerDeps,
  group: GroupRecord,
  text: string,
  replyTo?: Message,
  sendId?: string,
): Promise<Message | null> {
  const busy = group.busyBotId ? store.bot(group.busyBotId) : null;
  if (!busy?.busy) return null;
  const members = group.memberIds.flatMap((id) => store.bot(id) ?? []);
  const [only, ...others] = roomResponders(text, members, { kind: "member", botId: busy.id });
  if (only?.id !== busy.id || others.length) return null;
  const threadId = group.threadId;
  const adapter = instanceForBot?.(busy, threadId)?.adapter;
  if (!steersSend(adapter, busy.busy, false)) return null;
  const steered = await adapter.steer(threadId, promptWithReply(text, replyTo, userName()), undefined, { fromUser: true }).catch(() => false);
  if (!steered) return null;
  const current = store.group(group.id);
  if (current?.threadId !== threadId || current.busyBotId !== busy.id) {
    throw Object.assign(new Error("the running turn ended before the steered message could be recorded"), { status: 409 });
  }
  if (!current.hosted) return store.appendMessage(threadId, { role: "user", kind: "text", text, replyToId: replyTo?.id, sendId, steered: true });
  const { message } = hostSend(current as HostedGroup, text, replyTo, sendId);
  return store.patchMessage(threadId, message.id, { steered: true }) ?? message;
}
