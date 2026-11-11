// Someone else's room line alerts this PC after a beat, unless the room got read meanwhile (it was on screen).
import { summarize } from "../../shared/summarize.ts";
import type { Notification } from "../notify.ts";
import type { PhonePing } from "../phone-ping.ts";
import { redactSecretsInText } from "../redact.ts";

export const ROOM_ALERT_MS = 3_000;

/** `chat` is the group id of a hosted room or `joined:<roomId>`; it doubles as the alert's tag. */
export type RoomAlert = { chat: string; threadId: string; room: string; name: string; text: string };

/** With `waiting`, lines inside one wait share a single alert per chat that carries the latest. */
export function alertWhenUnread(alert: RoomAlert, unread: () => boolean, send: ((alert: RoomAlert) => void) | undefined, waitMs = ROOM_ALERT_MS, waiting?: Map<string, RoomAlert>): void {
  if (!send) return;
  const queued = waiting?.has(alert.chat);
  waiting?.set(alert.chat, alert);
  if (queued) return;
  setTimeout(() => {
    const latest = waiting?.get(alert.chat) ?? alert;
    waiting?.delete(alert.chat);
    if (unread()) send(latest);
  }, waitMs).unref?.();
}

export const roomLineText = (text: string, files: ReadonlyArray<{ name: string }> = []) => text.trim() || files.map((file) => file.name).join(", ");

export function roomPing(alert: RoomAlert): PhonePing {
  return { title: alert.room, message: summarize(redactSecretsInText(`${alert.name}: ${alert.text}`)), icon: "" };
}

export function roomNotification(alert: RoomAlert): Notification {
  const ping = roomPing(alert);
  return { kind: "room", botId: alert.chat, botName: alert.room, threadId: alert.threadId, title: ping.title, body: ping.message, icon: "" };
}
