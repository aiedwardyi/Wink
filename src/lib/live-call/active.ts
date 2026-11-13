// The live call outlives the chat it started in: a host above every view owns it, chats and the widget only read it.
import { useSyncExternalStore } from "react";

import type { Bot } from "@/state/store-types";
import { trackScreen } from "../usage-stats";

/** `bot` is the bot as it was when called, for a store that has not listed it yet. */
export type ActiveCall = { id: number; botId: string; bot: Bot; ctx: AudioContext };

let calls = 0;
let call: ActiveCall | null = null;
let note: { botId: string; text: string } | null = null;
let inView = 0;
const watchers = new Set<() => void>();

function notify() {
  for (const fn of [...watchers]) fn();
}

function watch(fn: () => void) {
  watchers.add(fn);
  return () => { watchers.delete(fn); };
}

// An http page on a phone has no mic API, so a Call button there could only fail.
export function callsSupported(): boolean {
  return typeof AudioContext !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

export function placeCall(bot: Bot, ctx: AudioContext): ActiveCall {
  call = { id: ++calls, botId: bot.id, bot, ctx };
  trackScreen("live-call");
  note = null;
  notify();
  return call;
}

/** Only drops this call: a late teardown of an old one never hangs up a newer one. */
export function dropCall(ended: ActiveCall, text?: string) {
  if (call !== ended) return;
  call = null;
  if (text) note = { botId: ended.botId, text };
  notify();
}


/** The call's own chat is on screen while any returned release is unused. */
export function showCallChat(): () => void {
  inView++;
  notify();
  return () => {
    inView--;
    notify();
  };
}

export function useActiveCall(): ActiveCall | null {
  return useSyncExternalStore(watch, () => call, () => null);
}

export function useCallNote(): { botId: string; text: string } | null {
  return useSyncExternalStore(watch, () => note, () => null);
}

export function useCallChatShown(): boolean {
  return useSyncExternalStore(watch, () => inView > 0, () => false);
}
