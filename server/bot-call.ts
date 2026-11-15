// A bot blocked on the user rings their phone: a call-style push, rung again while nobody answers.
import { randomUUID } from "node:crypto";

import { buildNotification, type NotifyBot } from "./notify.ts";
import type { TaskResumePacket } from "./task-state.ts";
import { pushPayload, type PushPayload } from "./web-push.ts";

export const CALL_RINGS = 3;
export const CALL_RING_GAP_MS = 45_000;

type Blocker = TaskResumePacket["blockers"][number];
type Ringing = { id: string; botId: string; timer?: ReturnType<typeof setTimeout> };

export type BotCallDeps = {
  send: (payload: PushPayload) => void;
  /** The room a thread belongs to, so a device that muted it stays quiet. */
  chat: (threadId: string) => string | undefined;
  skip: (threadId: string) => boolean;
};

const calls = (blocker: Blocker) => blocker.kind === "login" || blocker.kind === "engine";
const keyOf = (blocker: Blocker) => `${blocker.kind}\n${blocker.note}`;

/** `ring` 1..CALL_RINGS is the call; past that it is the plain alert left behind on the same tag. */
export function botCallPayload(bot: NotifyBot, threadId: string, note: string, call: { id: string; ring: number; chat?: string }, at = Date.now()): PushPayload | null {
  const alert = buildNotification("question", bot, threadId, note);
  if (!alert) return null;
  const base = pushPayload({ title: alert.title, message: alert.body, icon: alert.icon }, { botId: bot.id, threadId }, call.chat, at);
  const tag = `wink-call:${bot.id}`;
  if (call.ring > CALL_RINGS) return { ...base, title: `${bot.name} needs you`, tag };
  const url = new URL(base.url, "http://wink");
  url.searchParams.set("call", base.body);
  return { ...base, title: `📞 ${bot.name} is calling`, tag, url: `${url.pathname}${url.search}`, call: call.id };
}

export function createBotCalls(deps: BotCallDeps) {
  const threads = new Map<string, Map<string, Ringing>>();

  const ring = (ringing: Ringing, bot: NotifyBot, threadId: string, note: string, n: number) => {
    const payload = botCallPayload(bot, threadId, note, { id: ringing.id, ring: n, chat: deps.chat(threadId) });
    if (!payload) return;
    deps.send(payload);
    ringing.timer = n <= CALL_RINGS ? setTimeout(() => ring(ringing, bot, threadId, note, n + 1), CALL_RING_GAP_MS) : undefined;
  };

  return {
    /** One call per login or engine blocker a write adds; a blocker the write drops stops its rings. */
    blockers(bot: NotifyBot, threadId: string, before: readonly Blocker[], after: readonly Blocker[]) {
      const thread = threads.get(threadId) ?? new Map<string, Ringing>();
      const live = new Set(after.filter(calls).map(keyOf));
      for (const [key, ringing] of thread) {
        if (live.has(key)) continue;
        clearTimeout(ringing.timer);
        thread.delete(key);
      }
      const had = new Set(before.map(keyOf));
      for (const blocker of after.filter(calls)) {
        const key = keyOf(blocker);
        if (had.has(key) || thread.has(key) || deps.skip(threadId)) continue;
        const ringing: Ringing = { id: randomUUID(), botId: bot.id };
        thread.set(key, ringing);
        ring(ringing, bot, threadId, blocker.note, 1);
      }
      if (thread.size) threads.set(threadId, thread);
      else threads.delete(threadId);
    },
    /** Picking up a call from this bot stops its rings; the blocker still counts as called. */
    answered(botId: string) {
      for (const thread of threads.values()) {
        for (const ringing of thread.values()) {
          if (ringing.botId !== botId) continue;
          clearTimeout(ringing.timer);
          ringing.timer = undefined;
        }
      }
    },
  };
}

export type BotCalls = ReturnType<typeof createBotCalls>;
