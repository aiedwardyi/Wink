// Teammates' own bots in Room details' Bots: everyone's for the host, the room's and this PC's own on a joined room.
import { useState } from "react";

import { useI18n } from "@/lib/i18n";
import { DEFAULT_MAUS_COLOR, type MausColor } from "@/lib/mascot";
import { addMyBot, removeMyBot, removeTeamBot, type JoinedPerson, type JoinedView } from "@/lib/team-rooms";
import type { TeamBot } from "@/state/store-types";
import { useStore } from "@/state/store";

import { BotAvatar } from "./Avatar";
import { DETAILS_BOX, DETAILS_ROW } from "./BotDetailsRows";
import { BotPickerList } from "./BotPickerList";

const NONE = new Set<string>();

function BotRow({ bot, label, onRemove }: { bot: { id: string; name: string; color: string }; label: string; onRemove?: () => void }) {
  const { t } = useI18n();
  return (
    <li data-room-team-bot={bot.id} className={`${DETAILS_ROW} flex items-center gap-3 py-2.5`}>
      <BotAvatar bot={{ name: bot.name, color: (bot.color || DEFAULT_MAUS_COLOR) as MausColor }} state="happy" size={28} motion="none" motionKey={0} animated={false} />
      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("room.removeBot", { name: bot.name })}
          className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
        >
          {t("teamRoom.remove")}
        </button>
      )}
    </li>
  );
}

const ownerLabel = (bot: TeamBot, people: readonly JoinedPerson[], t: ReturnType<typeof useI18n>["t"]) => {
  const owner = people.find((person) => person.id === bot.owner)?.name;
  return owner ? t("teamRoom.botOwner", { name: bot.name, owner }) : bot.name;
};

/** The host's rows: every teammate's bot, which the host can take out. */
export function TeammateBotRows({ roomId, bots, people, onProblem }: { roomId: string; bots: readonly TeamBot[]; people: readonly JoinedPerson[]; onProblem: () => void }) {
  const { t } = useI18n();
  return <>{bots.map((bot) => <BotRow key={bot.id} bot={bot} label={ownerLabel(bot, people, t)} onRemove={() => void removeTeamBot(roomId, bot.id).catch(onProblem)} />)}</>;
}

/** Only for a host that takes teammates' bots. */
export function JoinedBots({ room }: { room: JoinedView }) {
  const { t } = useI18n();
  const { state } = useStore();
  const [picking, setPicking] = useState(false);
  const [problem, setProblem] = useState(false);
  const people = room.state?.people ?? [];
  const mine = room.myBots ?? [];
  const choices = state.bots.filter((bot) => !bot.hidden && !mine.some((added) => added.botId === bot.id));
  const onProblem = () => setProblem(true);
  const add = (botId: string) => {
    setPicking(false);
    void addMyBot(room.roomId, botId).catch(onProblem);
  };
  return (
    <>
      <ul className={DETAILS_BOX} aria-label={t("chrome.bots")}>
        {room.state?.bots.map((bot) => <BotRow key={bot.id} bot={bot} label={bot.name} />)}
        {room.state?.teamBots?.map((bot) => (
          <BotRow key={bot.id} bot={bot} label={ownerLabel(bot, people, t)} onRemove={mine.some((own) => own.id === bot.id) ? () => void removeMyBot(room.roomId, bot.id).catch(onProblem) : undefined} />
        ))}
        {room.status === "joined" && (
          <li className={DETAILS_ROW}>
            <button type="button" data-add-my-bot aria-expanded={picking} onClick={() => setPicking(!picking)} className="w-full text-left text-[14px] font-medium text-accent hover:brightness-110">
              + {t("groupWizard.addBot")}
            </button>
          </li>
        )}
      </ul>
      {picking && <div className={`${DETAILS_BOX} mt-2 p-2`}><BotPickerList bots={choices} picked={NONE} onToggle={add} emptyHint={t("teamRoom.noBotsToAdd")} /></div>}
      {problem && <p role="alert" className="mt-1 px-3 text-[12.5px] text-danger">{t("errors.request")}</p>}
    </>
  );
}
