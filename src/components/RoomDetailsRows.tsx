// Room details' folder and who answers, the settings the setup page asked for, and a phone's way into find.
import { useState } from "react";
import { FolderOpen, Search } from "lucide-react";

import { requestFind } from "@/lib/chat-find";
import { cn } from "@/lib/cn";
import { effectiveDefaultResponder, groupResponseHint } from "@/lib/group-routing";
import { useI18n } from "@/lib/i18n";
import { shortPath } from "@/lib/short-path";
import { api, useStore, type Bot, type Group, type GroupDefaultResponder } from "@/state/store";

import { DETAILS_INPUT, DETAILS_ROW, DetailsLabel } from "./BotDetailsRows";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { ROW_BUTTON } from "./SettingsPrimitives";

/** The PATCH goes straight to the server: it checks the path, and a refused folder must not stick locally. */
export function RoomFolderRow({ group }: { group: Group }) {
  const { t } = useI18n();
  const home = useDesktopCapabilities().capabilities.host.homeDir;
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canPick = Boolean(window.ogb?.pickFolder);
  // undefined = not pinned yet; after the first turn the room keeps the folder it started in
  const locked = group.pinnedCwd !== undefined;
  const folder = locked ? group.pinnedCwd ?? undefined : group.cwd;

  const save = async (cwd: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ cwd }) });
      setDraft(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const pick = async () => {
    const chosen = await window.ogb?.pickFolder?.(group.cwd);
    if (chosen) void save(chosen);
  };

  return (
    <div data-room-folder className={DETAILS_ROW}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[14px] font-medium text-ink">{t("room.folder")}</div>
        {!locked && canPick && (
          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => void pick()} disabled={saving} className={cn(ROW_BUTTON, "gap-1.5 text-ink")}>
              <FolderOpen size={13} aria-hidden="true" /> {t("room.chooseEllipsis")}
            </button>
            {group.cwd && (
              <button type="button" onClick={() => void save(null)} disabled={saving} className={ROW_BUTTON}>
                {t("room.clear")}
              </button>
            )}
          </div>
        )}
      </div>
      {locked || canPick ? (
        <div className="mt-1 truncate text-[13px] text-ink" title={folder}>
          {folder ? shortPath(folder, home) : <span className="text-ink-secondary">{t("room.eachBotFolder")}</span>}
        </div>
      ) : (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save((draft ?? group.cwd ?? "").trim() || null);
          }}
        >
          <input
            aria-label={t("room.folder")}
            className={cn(DETAILS_INPUT, "min-w-0")}
            placeholder={t("room.eachBotFolder")}
            value={draft ?? group.cwd ?? ""}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={saving || draft === null} className={ROW_BUTTON}>
            {t("room.save")}
          </button>
        </form>
      )}
      {locked && folder && <div className="mt-1 text-[12px] text-ink-secondary">{t("room.fixedFolder")}</div>}
      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}
    </div>
  );
}

const responderValue = (responder: GroupDefaultResponder) => (responder.kind === "member" ? `member:${responder.botId}` : responder.kind);

export function WhoAnswersRow({ group, bots }: { group: Group; bots: Bot[] }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const pick = (value: string): GroupDefaultResponder =>
    value === "everyone" || value === "mentions" ? { kind: value } : { kind: "member", botId: value.slice("member:".length) };
  return (
    <div className={DETAILS_ROW}>
      <div className="flex items-center justify-between gap-3">
        <DetailsLabel label={t("room.whoAnswersTitle")} />
        <select
          data-who-answers
          aria-label={t("room.whoAnswersTitle")}
          value={responderValue(effectiveDefaultResponder(group, bots))}
          onChange={(event) => dispatch({ type: "patchGroup", groupId: group.id, patch: { defaultResponder: pick(event.target.value) } })}
          className="min-w-0 max-w-[60%] truncate rounded-lg bg-control px-2 py-1.5 text-[13px] text-ink"
        >
          <option value="everyone">{t("room.everyoneResponds")}</option>
          {bots.map((bot) => <option key={bot.id} value={`member:${bot.id}`}>{bot.name}</option>)}
          <option value="mentions">{t("room.onlyMentionedMembers")}</option>
        </select>
      </div>
      <p className="mt-1 break-keep text-[12px] leading-relaxed text-ink-secondary">{groupResponseHint(group, bots, t)}</p>
    </div>
  );
}

export function SearchChatRow() {
  const { t } = useI18n();
  const { dispatch } = useStore();
  return (
    <button
      type="button"
      onClick={() => {
        dispatch({ type: "toggleSettings", open: false });
        requestFind();
      }}
      className={cn(DETAILS_ROW, "flex w-full items-center gap-2 text-left text-[14px] text-ink hover:bg-raised/50")}
    >
      <Search size={16} aria-hidden="true" className="text-ink-secondary" />
      {t("room.searchChat")}
    </button>
  );
}
