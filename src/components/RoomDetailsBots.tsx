// Room details' Bots: the bots in the room, and Add bot for the rest, applied at once.
import { useEffect, useMemo, useRef, useState } from "react";

import { newBotPayload, resolveWizardModel, type EnginePick } from "@/lib/group-wizard";
import { useI18n } from "@/lib/i18n";
import { roomPeople, roomTeamBots } from "@/lib/team-rooms";
import { api, useStore, type Bot, type Group } from "@/state/store";

import { BotAvatar } from "./Avatar";
import { DETAILS_BOX, DETAILS_ROW } from "./BotDetailsRows";
import { BotPickerList } from "./BotPickerList";
import { NewBotRow, type NewRow } from "./GroupWizard";
import { WhoAnswersRow } from "./RoomDetailsRows";
import { TeammateBotRows } from "./RoomTeamBots";

export function RoomDetailsBots({ group }: { group: Group }) {
  const { t } = useI18n();
  const { state, dispatch, refreshInstances } = useStore();
  const [rows, setRows] = useState<NewRow[]>([]);
  const [addedNew, setAddedNew] = useState(0);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState(false);
  const nextRowKey = useRef(1);
  const memberIds = useRef(group.memberIds);
  memberIds.current = group.memberIds;

  useEffect(() => {
    void refreshInstances?.();
  }, [refreshInstances]);

  // Archived bots stay listed while they are still members, so they can be taken out.
  const bots = useMemo(
    () => state.bots.filter((b) => !b.hidden || group.memberIds.includes(b.id)),
    [state.bots, group.memberIds],
  );
  const inRoom = bots.filter((b) => group.memberIds.includes(b.id));
  // A shared group with no bots stays open as a people-only room.
  const lastLocked = !group.hosted && group.memberIds.length === 1;

  const setMember = (id: string, on: boolean) => {
    const current = memberIds.current;
    const next = on ? (current.includes(id) ? current : [...current, id]) : current.filter((member) => member !== id);
    if (next === current) return;
    memberIds.current = next;
    dispatch({ type: "patchGroup", groupId: group.id, patch: { memberIds: next } });
  };

  const patchRow = (key: number, patch: Partial<NewRow>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const addBot = async (row: NewRow, pick: EnginePick) => {
    const name = row.name.trim();
    if (!name || row.saving) return;
    patchRow(row.key, { saving: true, error: null });
    try {
      const selection = { instanceId: pick.instance.instanceId, model: resolveWizardModel(pick.instance, row.model) };
      const result: { bot: Bot } = await api("/api/bots", {
        method: "POST",
        body: JSON.stringify({ ...newBotPayload(name, selection), section: group.section?.trim() || undefined }),
      });
      dispatch({ type: "botAdded", bot: result.bot, activate: false, focusComposer: false });
      setMember(result.bot.id, true);
      setAddedNew((count) => count + 1);
      setRows((prev) => prev.filter((candidate) => candidate.key !== row.key));
    } catch (cause) {
      patchRow(row.key, { saving: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  return (
    <>
      <ul className={DETAILS_BOX} aria-label={t("chrome.bots")}>
        {inRoom.map((b) => (
          <li key={b.id} data-room-bot={b.id} className={`${DETAILS_ROW} flex items-center gap-3 py-2.5`}>
            <BotAvatar bot={b} state="happy" size={28} />
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{b.name}</span>
            <button
              type="button"
              onClick={() => setMember(b.id, false)}
              disabled={lastLocked}
              aria-label={t("room.removeBot", { name: b.name })}
              className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-secondary"
            >
              {t("teamRoom.remove")}
            </button>
          </li>
        ))}
        {group.hosted && <TeammateBotRows roomId={group.hosted.roomId} bots={roomTeamBots(group)} people={roomPeople(group)} onProblem={() => setProblem(true)} />}
        <li className={DETAILS_ROW}>
          <button type="button" data-room-add-bot aria-expanded={adding} onClick={() => setAdding(!adding)} className="w-full text-left text-[14px] font-medium text-accent hover:brightness-110">
            + {t("groupWizard.addBot")}
          </button>
        </li>
      </ul>
      {problem && <p role="alert" className="mt-1 px-1 text-[12.5px] text-danger">{t("errors.request")}</p>}
      {lastLocked && <p className="mt-1.5 px-1 text-[12px] text-ink-secondary">{t("room.needsBot")}</p>}
      {adding && (
        <div className={`${DETAILS_BOX} mt-2 p-2`}>
          <BotPickerList
            bots={bots}
            picked={new Set(group.memberIds)}
            emptyHint={t("chrome.createBotFirst")}
            onToggle={(id) => {
              const on = group.memberIds.includes(id);
              if (!on || !lastLocked) setMember(id, !on);
            }}
          />
          {rows.map((row, rowIndex) => (
            <NewBotRow
              key={row.key}
              row={row}
              preferIndex={addedNew + rowIndex}
              instances={state.instances}
              onPatch={(patch) => patchRow(row.key, patch)}
              onAdd={(pick) => void addBot(row, pick)}
            />
          ))}
          <button
            type="button"
            data-manage-create-bot
            onClick={() => {
              const key = nextRowKey.current++;
              setRows((prev) => [...prev, { key, name: "", instanceId: null, model: null, saving: false, error: null }]);
            }}
            className="mt-1 px-2 py-1 text-[13px] font-medium text-accent hover:brightness-110"
          >
            {t("groupWizard.newBot")}
          </button>
        </div>
      )}
      {group.memberIds.length > 0 && <div className={`${DETAILS_BOX} mt-2`}><WhoAnswersRow group={group} bots={inRoom} /></div>}
    </>
  );
}
