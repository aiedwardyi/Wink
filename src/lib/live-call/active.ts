// The live call outlives the chat it started in: a host above every view owns it, chats and the widget only read it.
import { useSyncExternalStore } from "react";

import type { Bot } from "@/state/store-types";
import { trackScreen } from "../usage-stats";
import { callAudio } from "./warm-audio";

/** `bot` is the bot as it was when called, for a store that has not listed it yet; `opener` is the blocker a bot call rang about. */
export type ActiveCall = { id: number; botId: string; bot: Bot; ctx: AudioContext; opener?: string };

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

export function placeCall(bot: Bot, ctx: AudioContext, opener?: string): ActiveCall {
  call = { id: ++calls, botId: bot.id, bot, ctx, opener };
  trackScreen("live-call");
  note = null;
  notify();
  return call;
}

/** A tapped bot call: the page may open with no tap of its own yet, so the first one lets the voice play. */
export function answerCall(bot: Bot | undefined, opener: string | null): ActiveCall | null {
  if (!bot || !opener || call || !callsSupported()) return null;
  const ctx = callAudio();
  if (ctx.state === "suspended") addEventListener("pointerdown", () => void ctx.resume(), { once: true });
  void ctx.resume();
  return placeCall(bot, ctx, opener);
}

type Rung = { botId: string; threadId: string; opener: string | null };
const RUNG_MS = 30_000;
let rung: (Rung & { at: number }) | null = null;

/** The voice briefs from the bot's active thread, so a tapped call waits for the switch to its thread to land; one that never lands lapses. */
export function answerOnThread(bots: readonly Bot[], next?: Rung): ActiveCall | null {
  if (next) rung = next.opener ? { ...next, at: Date.now() } : null;
  const want = rung;
  if (!want) return null;
  if (Date.now() - want.at > RUNG_MS) return (rung = null);
  const bot = bots.find((candidate) => candidate.id === want.botId);
  if (bot?.threadId !== want.threadId) return null;
  rung = null;
  return answerCall(bot, want.opener);
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
