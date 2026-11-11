import { useCallback, useEffect, useState } from "react";
import { Phone } from "lucide-react";

import { useStore } from "@/state/store";
import { endCall } from "@/lib/call";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import type { RoomLine } from "@/lib/team-rooms";
import type { CallRoom } from "../../shared/live-call";
import { LiveCallBar } from "./LiveCallBar";
import { LiveCallBox } from "./LiveCallBox";

export function useRoomCall(room: CallRoom & { name: string }, lines: RoomLine[], enabled: boolean) {
  const { state } = useStore();
  const { t } = useI18n();
  const [live, setLive] = useState<{ botId: string; roomId: string; ctx: AudioContext } | null>(null);
  const [note, setNote] = useState<string>();
  const onEnd = useCallback((text?: string) => { setLive(null); setNote((before) => text ?? before); }, []);
  const bot = live ? state.bots.find((bot) => bot.id === live.botId && !bot.hidden) : state.bots.find((bot) => bot.chiefOfStaff && !bot.hidden) ?? state.bots.find((bot) => !bot.hidden);
  const active = enabled && live?.roomId === room.id && Boolean(bot);

  useEffect(() => { setLive(null); setNote(undefined); }, [room.id, room.kind]);

  return {
    button: enabled && bot ? (
      <button
        type="button"
        aria-pressed={active}
        aria-label={t("teamRoom.call", { name: bot.name })}
        title={t("teamRoom.call", { name: bot.name })}
        onClick={() => {
          if (active) { endCall(bot.id); return onEnd(); }
          const ctx = new AudioContext();
          void ctx.resume();
          setNote(undefined);
          setLive({ botId: bot.id, roomId: room.id, ctx });
        }}
        className={cn("flex size-9 shrink-0 items-center justify-center rounded-full max-md:hidden", active ? "bg-accent/15 text-accent" : "text-ink-secondary hover:bg-raised hover:text-ink")}
      >
        <Phone size={18} />
      </button>
    ) : null,
    bar: active && bot && live ? <LiveCallBar key={`${room.kind}:${room.id}:${bot.id}`} bot={bot} ctx={live.ctx} room={{ ...room, lines }} onEnd={onEnd} /> : note ? <p role="status" className="px-6 pb-2 text-xs text-ink-secondary">{note}</p> : null,
    box: active && bot ? (empty: boolean) => <LiveCallBox bot={bot} empty={empty} closing={false} /> : undefined,
  };
}
