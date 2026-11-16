import { useEffect, useState } from "react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { useIsPhone } from "@/lib/use-phone-swipe";
import { api } from "@/state/store";

import { Card, ROW_BUTTON } from "./SettingsPrimitives";

type Folder = { path: string; error: string | null };

export function RoomFilesFolderRow() {
  const { t } = useI18n();
  const phone = useIsPhone();
  const visible = !phone && Boolean(window.ogb?.pickFolder);
  const [folder, setFolder] = useState<Folder | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void api("/api/room-files-folder").then((next: Folder) => {
      if (alive) setFolder(next);
    }, () => { if (alive) setProblem("teamRoom.folderError"); });
    return () => { alive = false; };
  }, [visible]);
  const change = async () => {
    if (busy || !folder) return;
    setBusy(true);
    setProblem(null);
    try {
      const path = await window.ogb?.pickFolder?.(folder.path);
      if (path) setFolder(await api("/api/room-files-folder", { method: "PUT", body: JSON.stringify({ path }) }));
    } catch { setProblem("teamRoom.moveFailed"); }
    finally { setBusy(false); }
  };
  if (!visible) return null;
  return (
    <Card>
      <div data-room-files-folder className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-ink">{t("teamRoom.filesFolder")}</div>
          <div className="mt-1 break-all text-[12px] text-ink-secondary">{folder?.path ?? t("teamRoom.loadingFiles")}</div>
        </div>
        <button type="button" disabled={busy || !folder} onClick={() => void change()} className={ROW_BUTTON}>
          {t(busy ? "teamRoom.movingFiles" : "teamRoom.changeFolder")}
        </button>
      </div>
      {(problem || folder?.error) && <p role="alert" className="mt-2 text-[12px] text-danger">{t(problem ?? "teamRoom.folderError")}</p>}
    </Card>
  );
}
