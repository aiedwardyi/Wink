import { useRef, useState } from "react";
import { Pencil } from "lucide-react";

import { composerEnterIntent } from "@/lib/composer-enter";
import { useI18n } from "@/lib/i18n";
import { typedRoomName } from "@/lib/team-rooms";
import { api, useStore } from "@/state/store";

import { InitialsAvatar, profileInitials } from "./Avatar";
import { DETAILS_ROW } from "./BotDetailsRows";
import { RenameActions } from "./RenameActions";

export function RoomOwnName({ name }: { name: string }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const composing = useRef(false);
  const ended = useRef(0);
  const save = async () => {
    if (saving || composing.current) return;
    setSaving(true);
    setError(false);
    try {
      const name = typedRoomName(value) || "Guest";
      dispatch({ type: "configStatus", config: await api("/api/config", { method: "PUT", body: JSON.stringify({ profile: { name } }) }) });
      setEditing(false);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <li className={`${DETAILS_ROW} py-2`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <InitialsAvatar initials={profileInitials({ name })} size={24} tone="bg-control" />
        {editing ? (
          <>
            <input
              autoFocus
              aria-label={t("settings.profile.nameLabel")}
              value={value}
              disabled={saving}
              onChange={(event) => setValue(event.target.value)}
              onCompositionStart={() => { composing.current = true; ended.current = 0; }}
              onCompositionEnd={() => { composing.current = false; ended.current = Date.now(); }}
              onKeyDown={(event) => {
                if (composerEnterIntent(event, { composing: composing.current, justEnded: Date.now() - ended.current < 50 }) !== "send") return;
                event.preventDefault();
                void save();
              }}
              className="min-w-0 flex-1 rounded-md border border-hairline/40 bg-inset px-2 py-1 text-[14px] text-ink outline-none focus:border-accent"
            />
            <RenameActions disabled={saving} onSave={() => void save()} onCancel={() => { setEditing(false); setError(false); }} />
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{name}</span>
            <span className="shrink-0 text-[12px] text-ink-secondary">{t("chat.you")}</span>
            <button type="button" aria-label={t("teamRoom.renameSelf")} onClick={() => { composing.current = false; setValue(state.config?.profile?.name ?? name); setEditing(true); }} className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"><Pencil size={14} /></button>
          </>
        )}
      </div>
      {editing && <p className="mt-1 text-[12px] text-ink-secondary">{t("teamRoom.nameEverywhere")}</p>}
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{t("settings.profile.saveError")}</p>}
    </li>
  );
}
