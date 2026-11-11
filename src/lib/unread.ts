import { isShownMessage } from "./shown-message";
import { isVoiceLine, type CallTag } from "../../shared/live-call";
import { listedGroups } from "./sidebar-order";
import type { Message } from "../state/store-types";

type CountedRoom = { dm?: boolean; unread?: boolean; hosted?: { roomId: string }; readAt?: number; messages?: ReadonlyArray<Message> };
type CountedJoinedRoom = { roomId: string; unread?: number };

export function unreadConversationCount(
  bots: Array<{ hidden?: boolean; unread?: boolean }>,
  groups: Array<CountedRoom>,
  joined: ReadonlyArray<CountedJoinedRoom> = [],
): number {
  return bots.filter((bot) => !bot.hidden && bot.unread).length
    + listedGroups(groups).reduce((count, group) => count + (group.hosted ? unreadReplyCount(group.unread, group.readAt, group.messages ?? []) : Number(Boolean(group.unread))), 0)
    + joined.reduce((count, room) => count + (room.unread ?? 0), 0);
}

/** Unread count for the collapsed sidebar's reopen button: the open conversation never counts. */
export function collapsedUnreadCount(
  bots: Array<{ id: string; hidden?: boolean; unread?: boolean }>,
  groups: Array<CountedRoom & { id: string }>,
  currentId: string,
  joined: ReadonlyArray<CountedJoinedRoom> = [],
): number {
  return unreadConversationCount(
    bots.filter((bot) => bot.id !== currentId),
    groups.filter((group) => group.id !== currentId),
    joined.filter((room) => `joined:${room.roomId}` !== currentId),
  );
}

type CountedMessage = { role?: string; kind?: string; summarized?: boolean; at?: number; call?: CallTag; author?: { kind: string } };

const isReply = (message: CountedMessage) => (message.role === "bot" || message.author?.kind === "person") && message.kind === "text" && !isVoiceLine(message) && isShownMessage(message);

/** Shown replies since the chat was last read (since your last message for records without readAt); unread with none still shows 1. */
export function unreadReplyCount(
  unread: boolean | undefined,
  readAt: number | undefined,
  messages: ReadonlyArray<CountedMessage>,
): number {
  if (!unread) return 0;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (readAt === undefined ? message.role === "user" && message.author?.kind !== "person" : (message.at ?? Infinity) <= readAt) break;
    if (isReply(message)) count += 1;
  }
  return Math.max(1, count);
}

/** Just before the last reply, so Mark as Unread counts 1. */
export function markUnreadReadAt(messages: ReadonlyArray<CountedMessage>): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const at = messages[i].at;
    if (isReply(messages[i]) && at !== undefined) return at - 1;
  }
  return undefined;
}

export function formatCollapsedUnreadBadge(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}
