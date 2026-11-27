import { Suspense, useCallback, useEffect } from "react";

import { useStore, type Bot } from "@/state/store";
import { useChatPreview } from "@/lib/chat-preview";
import { callsSupported, placeCall, showCallChat, useActiveCall, useCallNote, type ActiveCall } from "@/lib/live-call/active";
import { callAudio } from "@/lib/live-call/warm-audio";
import { lazyView } from "@/lib/stale-build";
import { CallButton } from "./CallView";
import { useDesktopCapabilities } from "./DesktopCapabilities";

const LiveCallBar = lazyView(() => import("./LiveCallBar").then((m) => ({ default: m.LiveCallBar })));
const LiveCallBox = lazyView(() => import("./LiveCallBox").then((m) => ({ default: m.LiveCallBox })));
export const warmCallViews = () => Promise.all([LiveCallBar.preload(), LiveCallBox.preload()]);

/** A room calls the caller's own lead bot, else the first visible one. */
export const roomCallBot = (bots: readonly Bot[]): Bot | undefined => bots.find((bot) => bot.chiefOfStaff && !bot.hidden) ?? bots.find((bot) => !bot.hidden);

/** The one way a screen mounts a call: a room call is the bot's own call with the room attached. */
export function useCallControls(bot: Bot | undefined, hidden: boolean, room?: ActiveCall["room"]) {
  const { state } = useStore();
  const voiceCalls = state.config?.features?.voiceCalls === true;
  const preview = useChatPreview();
  const { capabilities, ready } = useDesktopCapabilities();
  const active = useActiveCall();
  const note = useCallNote();
  const on = Boolean(bot && active?.botId === bot.id && (!room || (active.room?.id === room.id && active.room.kind === room.kind)));
  useEffect(() => (on && !hidden && !preview ? showCallChat() : undefined), [hidden, on, preview]);
  const roomId = room?.id;
  const roomKind = room?.kind;
  const roomName = room?.name ?? "";
  // Rooms keep the Gemini voice: only a 1:1 call can be answered by the bot itself.
  const answer = roomId ? undefined : state.config?.liveCall?.answer;
  // A phone's context is born in the tap, the only place it may play from; a desktop hover may have made one already.
  const start = useCallback(() => {
    if (!bot) return;
    placeCall(bot, callAudio(), undefined, roomId && roomKind ? { id: roomId, kind: roomKind, name: roomName } : undefined, answer);
  }, [answer, bot, roomId, roomKind, roomName]);
  if (!bot || !voiceCalls) return { on: false, bar: null, composer: {} };
  const available = ready && capabilities.dictation.available && Boolean(window.ogb?.speechStart);
  return {
    on,
    bar: on
      ? <Suspense fallback={null}><LiveCallBar bot={bot} /></Suspense>
      : note?.botId === bot.id && <p role="alert" className="px-6 pb-2 text-xs text-ink-secondary max-md:px-4">{note.text}</p>,
    composer: {
      callBot: bot,
      call: on ? (box: { closing: boolean }) => <Suspense fallback={null}><LiveCallBox bot={bot} {...box} /></Suspense> : undefined,
      onCall: !on && callsSupported() ? start : undefined,
      callButton: !on && available && !state.config?.gemini?.configured ? <CallButton bot={bot} helpAbove /> : undefined,
    },
  };
}
