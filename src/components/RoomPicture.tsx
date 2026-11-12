import { useEffect, useRef, useState } from "react";
import { ImagePlus, Trash2, Users } from "lucide-react";

import { fetchResponse, request, responseBody } from "@/lib/api-request";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { filesProblem, hostRoomBase, isRoomPicture, roomPictureUrl, type TeamRoom } from "@/lib/team-rooms";
import { useBackLayer } from "@/lib/use-back-layer";
import { useStore } from "@/state/store";

/** `retry`: a change, like the host coming back online, loads a failed picture again. */
export function RoomPicture({ src, size = 32, retry }: { src?: string; size?: number; retry?: unknown }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src, retry]);
  return (
    <span data-room-picture className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      {src && !failed ? (
        <img src={src} alt="" width={size} height={size} draggable={false} onError={() => setFailed(true)} className="block shrink-0 rounded-[22%] bg-raised object-cover" style={{ width: size, height: size }} />
      ) : <Users size={24} className="text-ink-secondary" />}
    </span>
  );
}

export function TeamRoomPicture({ group, size }: { group: TeamRoom; size?: number }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const busy = useRef(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const base = hostRoomBase(group.hosted.roomId);
  useBackLayer(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const save = async (file?: File) => {
    if (busy.current) return;
    setOpen(false);
    setProblem(null);
    if (file) {
      const ahead = filesProblem([file]);
      if (!isRoomPicture(file) || ahead) {
        setProblem(!isRoomPicture(file) ? "teamRoom.fileType" : "teamRoom.pictureTooBig");
        if (input.current) input.current.value = "";
        return;
      }
    }
    busy.current = true;
    setSaving(true);
    try {
      let picture: string | null = null;
      if (file) {
        const query = new URLSearchParams({ name: file.name, uploadId: crypto.randomUUID() });
        const res = await fetchResponse(`${base}/files?${query}`, { method: "POST", body: file, headers: { "content-type": "application/octet-stream" } });
        const body = await responseBody(res);
        if (!res.ok || typeof body?.file?.id !== "string") {
          setProblem(res.status === 415 ? "teamRoom.fileType" : res.status === 413 ? "teamRoom.pictureTooBig" : "teamRoom.pictureError");
          return;
        }
        picture = body.file.id;
      }
      const result = await request(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ picture }) });
      dispatch({ type: "groupPatched", group: { ...result.group, picture: result.group.picture } });
    } catch {
      setProblem("teamRoom.pictureError");
    } finally {
      busy.current = false;
      setSaving(false);
      if (input.current) input.current.value = "";
    }
  };
  const item = "flex w-full items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-left text-[14px] text-ink hover:bg-raised";
  return (
    <div ref={wrapper} className="relative shrink-0">
      <button ref={trigger} data-room-picture-button type="button" aria-label={t("teamRoom.picture")} aria-expanded={open} aria-haspopup="menu" disabled={saving} onClick={() => { setProblem(null); setOpen(!open); }} className="rounded-lg focus-visible:outline-accent disabled:opacity-50">
        <RoomPicture src={roomPictureUrl(base, group.picture)} size={size} />
      </button>
      <input ref={input} data-room-picture-input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => { const file = event.target.files?.[0]; if (file) void save(file); }} />
      {open && (
        <div role="menu" aria-label={t("teamRoom.picture")} className="absolute left-0 top-full z-40 mt-2 min-w-44 rounded-xl border border-hairline/50 bg-card p-1 shadow-xl">
          <button type="button" role="menuitem" autoFocus className={item} onClick={() => { setOpen(false); input.current?.click(); }}>
            <ImagePlus size={16} />{t("teamRoom.changePhoto")}
          </button>
          {group.picture && <button type="button" role="menuitem" className={item} onClick={() => void save()}><Trash2 size={16} />{t("teamRoom.removePhoto")}</button>}
        </div>
      )}
      {problem && <div role="alert" className="absolute left-0 top-full z-40 mt-2 w-60 rounded-lg border border-danger/30 bg-card p-3 text-[13px] text-danger" onClick={() => setProblem(null)}>{t(problem)}</div>}
    </div>
  );
}
