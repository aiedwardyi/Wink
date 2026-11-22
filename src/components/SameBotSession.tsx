// The same-bot call's host: loaded only when a call is placed with "Same bot", so a Gemini voice call never runs this code.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { endCall, startCall, useOnCall } from "@/lib/call";
import { useI18n } from "@/lib/i18n";
import { dropCall, type ActiveCall } from "@/lib/live-call/active";
import { CallAudio } from "@/lib/live-call/audio";
import { MIC_BUSY, MIC_MISSING, VOICE_OUT } from "@/lib/live-call/controller";
import { GeminiLive } from "@/lib/live-call/gemini";
import { SameBotCall } from "@/lib/live-call/same-bot";
import { useCallVolume } from "@/lib/live-call/volume";
import { sendInput } from "@/lib/usage-stats";
import { post, publish, WORDS } from "./LiveCallBar";

export function SameBotSession({ active, bot }: { active: ActiveCall; bot: Bot }) {
  const { state, dispatch } = useStore();
  const { locale } = useI18n();
  const words = WORDS[locale] ?? WORDS.en;
  const onEnd = useCallback((note?: string) => dropCall(active, note), [active]);
  const target = useRef(bot);
  target.current = bot;
  const [live] = useState(() => {
    const audio = new CallAudio(active.sound);
    const call = new SameBotCall({
      botId: bot.id,
      engine: () => new GeminiLive(),
      audio,
      post,
      prefs: bot.call,
      send: (text) => {
        sendInput("call");
        dispatch({ type: "send", botId: target.current.id, text, threadId: target.current.threadId });
      },
    });
    return { call, level: (mic: boolean) => audio.level(mic) };
  });
  const { call } = live;
  const snap = useSyncExternalStore(call.subscribe, call.state, call.state);
  const owner = useOnCall();
  const mounted = useRef(false);
  const configured = Boolean(state.config?.gemini?.configured);
  const messages = visibleMessages(bot);

  useEffect(() => {
    publish(bot.id, live);
    return () => publish(bot.id, undefined);
  }, [bot.id, live]);

  const kicked = useRef(false);
  useEffect(() => {
    if (!state.config || kicked.current) return;
    kicked.current = true;
    void call.start();
  }, [call, state.config]);

  // A Gemini key saved from the chat's key card starts the call it was asked for.
  const keyed = useRef(configured);
  useEffect(() => {
    const added = configured && !keyed.current;
    keyed.current = configured;
    if (added && snap.status === "needsKey") void call.start();
  }, [call, configured, snap.status]);

  useEffect(() => {
    mounted.current = true;
    startCall(bot.id);
    const onVisible = () => call.hidden(document.hidden);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      // StrictMode remounts at once; only a real unmount hangs up.
      queueMicrotask(() => {
        if (mounted.current) return;
        call.end();
        endCall(bot.id);
        onEnd();
      });
    };
  }, [bot.id, call, onEnd]);

  const owned = useRef(false);
  useEffect(() => {
    if (owner === bot.id) owned.current = true;
    if (snap.status !== "ended" && (owner === null || owner === bot.id || !owned.current)) return;
    endCall(bot.id);
    onEnd();
  }, [bot.id, onEnd, owner, snap.status]);

  const quietEnd = snap.status === "failed" && (snap.error === MIC_MISSING || snap.error === MIC_BUSY || snap.error === VOICE_OUT);
  useEffect(() => {
    if (!quietEnd) return;
    endCall(bot.id);
    onEnd(snap.error === MIC_MISSING ? words.micMissing : snap.error === VOICE_OUT ? words.voiceOut : words.micBusy);
  }, [bot.id, quietEnd, onEnd, snap.error, words]);

  useEffect(() => {
    call.observe({ busy: Boolean(bot.busy), messages });
  }, [bot.busy, call, messages]);

  const picks = bot.call;
  const volume = useCallVolume();
  useEffect(() => call.retune(picks ?? {}, volume), [call, picks?.speed, picks?.style, volume]);

  return null;
}
