// Teammates' own bots in a team room: this PC's on a joined room, everyone's for the host.
import { useState } from "react";
import { Plus } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { DEFAULT_MAUS_COLOR, type MausColor } from "@/lib/mascot";
import { addMyBot, removeMyBot, removeTeamBot, type JoinedPerson, type JoinedView } from "@/lib/team-rooms";
import type { TeamBot } from "@/state/store-types";
import { useStore } from "@/state/store";

import { BotAvatar } from "./Avatar";
import { BotPickerList } from "./BotPickerList";

const NONE = new Set<string>();

function BotRow({ bot, label, onRemove }: { bot: { name: string; color: string }; label: string; onRemove: () => void }) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-raised/50">
      <BotAvatar bot={{ name: bot.name, color: (bot.color || DEFAULT_MAUS_COLOR) as MausColor }} state="happy" size={22} motion="none" motionKey={0} animated={false} />
      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("teamRoom.removeBotNamed", { name: bot.name })}
        className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
      >
        {t("teamRoom.remove")}
      </button>
    </li>
  );
}

/** Only for a host that takes teammates' bots. */
export function MyRoomBots({ room, onProblem }: { room: JoinedView; onProblem: () => void }) {
  const { t } = useI18n();
  const { state } = useStore();
  const [picking, setPicking] = useState(false);
  const listed = room.state?.teamBots ?? [];
  const mine = (room.myBots ?? []).flatMap((bot) => {
    const roomBot = listed.find((candidate) => candidate.id === bot.id);
    return roomBot ? [{ ...bot, roomBot }] : [];
  });
  const choices = state.bots.filter((bot) => !bot.hidden && !mine.some((added) => added.botId === bot.id));
  const add = (botId: string) => {
    setPicking(false);
    void addMyBot(room.roomId, botId).catch(onProblem);
  };
  return (
    <section data-my-room-bots className="mt-3">
      <div className="mb-1 px-2 text-[12.5px] font-medium text-ink-secondary">{t("teamRoom.yourBots")}</div>
      <ul className="flex flex-col gap-0.5" aria-label={t("teamRoom.yourBots")}>
        {mine.map((bot) => <BotRow key={bot.id} bot={bot.roomBot} label={bot.roomBot.name} onRemove={() => void removeMyBot(room.roomId, bot.id).catch(onProblem)} />)}
      </ul>
      {picking ? <BotPickerList bots={choices} picked={NONE} onToggle={add} emptyHint={t("teamRoom.noBotsToAdd")} /> : (
        <button
          type="button"
          data-add-my-bot
          onClick={() => setPicking(true)}
          className="mt-1 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-medium text-accent hover:bg-raised/50"
        >
          <Plus size={15} />
          {t("teamRoom.addMyBot")}
        </button>
      )}
    </section>
  );
}

/** The host's view: every teammate's bot, which the host can take out. */
export function TeammateBots({ roomId, bots, people, onProblem }: { roomId: string; bots: readonly TeamBot[]; people: readonly JoinedPerson[]; onProblem: () => void }) {
  const { t } = useI18n();
  if (!bots.length) return null;
  return (
    <section data-teammate-bots className="mt-3">
      <div className="mb-1 px-2 text-[12.5px] font-medium text-ink-secondary">{t("teamRoom.teammateBots")}</div>
      <ul className="flex flex-col gap-0.5" aria-label={t("teamRoom.teammateBots")}>
        {bots.map((bot) => {
          const owner = people.find((person) => person.id === bot.owner)?.name;
          return <BotRow key={bot.id} bot={bot} label={owner ? t("teamRoom.botOwner", { name: bot.name, owner }) : bot.name} onRemove={() => void removeTeamBot(roomId, bot.id).catch(onProblem)} />;
        })}
      </ul>
    </section>
  );
}
