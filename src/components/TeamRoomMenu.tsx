// The sidebar's way in: New team room (a name, nothing else) and Join team room (one code box).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Copy, KeyRound, LogIn, LogOut, Trash2, UsersRound } from "lucide-react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { request } from "@/lib/api-request";
import { forgetJoinedRoom, noteJoinedRoom, useJoinedRooms } from "@/lib/joined-rooms";
import { createTeamRoom, inviteErrorKey, inviteToRoom, isTeamRoom, joinedRoomIdOf, joinedRoomBase, joinErrorKey, joinedSelection, joinRoom, looksLikeRoomCode, rejoinRoom } from "@/lib/team-rooms";
import { useBackLayer } from "@/lib/use-back-layer";
import { Presence } from "@/lib/use-presence";
import { useStore, type Group } from "@/state/store";

import { ConfirmDialog } from "./ConfirmDialog";
import { TeamRoomPeople } from "./TeamRoomPeople";

type Sheet = "create" | "join" | "rejoin" | "people" | "leave" | "remove" | null;

let sheet: Sheet = null;
let roomTarget: { id: string; name: string } | null = null;
const watchers = new Set<() => void>();

function openSheet(next: Sheet) {
  sheet = next;
  for (const watcher of [...watchers]) watcher();
}

const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};

const ITEM = "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70";

export function TeamRoomSidebarActions({ group, onClose }: { group: Group; onClose: () => void }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const rooms = useJoinedRooms();
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const joinedId = joinedRoomIdOf(group.id);
  const room = rooms.find((each) => each.roomId === joinedId);
  const pick = (next: Sheet) => {
    roomTarget = { id: group.id, name: group.name };
    openSheet(next);
    onClose();
  };
  const rejoin = async () => {
    if (!joinedId || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await rejoinRoom(joinedId);
      if (!("room" in result)) {
        if ((result.status === 409 && result.error === "no-saved-code") || ["bad-code", "no-invite", "wrong-secret", "too-many-tries"].includes(result.error)) pick("rejoin");
        else setProblem(joinErrorKey(result.status, result.error));
        return;
      }
      noteJoinedRoom(result.room);
      dispatch({ type: "select", id: group.id });
      onClose();
    } catch {
      setProblem("teamRoom.badCode");
    } finally {
      setBusy(false);
    }
  };
  if (room && room.status !== "joined") return (
    <>
      {room.status === "left" && <button type="button" disabled={busy} onClick={() => void rejoin()} className={`${ITEM} disabled:opacity-40`}>
        <LogIn size={16} className="text-ink-secondary" />
        {t("teamRoom.rejoin")}
      </button>}
      <button type="button" disabled={busy} onClick={() => pick("remove")} className={`${ITEM} text-danger disabled:opacity-40`}>
        <Trash2 size={16} />
        {t("teamRoom.removeLocal")}
      </button>
      {problem && <div role="alert" className="px-3.5 py-2 text-[12.5px] text-danger">{t(problem)}</div>}
    </>
  );
  if (joinedId) return (
    <button type="button" onClick={() => pick("leave")} className={`${ITEM} text-danger`}>
      <LogOut size={16} />
      {t("teamRoom.leave")}
    </button>
  );
  if (!isTeamRoom(group)) return null;
  const copy = async () => {
    const result = await inviteToRoom(group.hosted.roomId);
    if (!("code" in result)) return setProblem(inviteErrorKey(result.status));
    try {
      await navigator.clipboard.writeText(result.code);
      onClose();
    } catch {
      setProblem("errors.request");
    }
  };
  return (
    <>
      <button type="button" onClick={() => pick("people")} className={ITEM}>
        <UsersRound size={16} className="text-ink-secondary" />
        {t("teamRoom.people")}
      </button>
      <button type="button" onClick={() => void copy()} className={ITEM}>
        <Copy size={16} className="text-ink-secondary" />
        {t("teamRoom.copy")}
      </button>
      {problem && <div role="alert" className="px-3.5 py-2 text-[12.5px] text-danger">{t(problem)}</div>}
    </>
  );
}

export function TeamRoomMenuItems({ onPick }: { onPick: () => void }) {
  const { t } = useI18n();
  const pick = (next: Sheet) => {
    onPick();
    openSheet(next);
  };
  return (
    <>
      <button onClick={() => pick("create")} className={ITEM}>
        <UsersRound size={16} className="text-ink-secondary" />
        {t("teamRoom.new")}
      </button>
      <button onClick={() => pick("join")} className={ITEM}>
        <KeyRound size={16} className="text-ink-secondary" />
        {t("teamRoom.joinMenu")}
      </button>
    </>
  );
}

function Shell({ label, closing, onClose, children }: { label: string; closing: boolean; onClose: () => void; children: React.ReactNode }) {
  useBackLayer(!closing, onClose);
  return createPortal(
    <div
      data-closing={closing || undefined}
      inert={closing}
      className="animate-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
      }}
    >
      <div
        role={closing ? undefined : "dialog"}
        aria-modal={!closing || undefined}
        aria-label={label}
        className="animate-pop-in w-full max-w-[380px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

const INPUT = "w-full rounded-lg border border-hairline/60 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-accent/60 focus:outline-none";

function CreateSheet({ closing, onClose }: { closing: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [failed, setFailed] = useState(false);
  const create = async () => {
    const wanted = name.trim();
    if (!wanted || creating) return;
    setCreating(true);
    setFailed(false);
    try {
      const { group } = await createTeamRoom(wanted);
      dispatch({ type: "groupPatched", group });
      dispatch({ type: "select", id: group.id });
      onClose();
    } catch {
      setCreating(false);
      setFailed(true);
    }
  };
  return (
    <Shell label={t("teamRoom.new")} closing={closing} onClose={onClose}>
      <div className="mb-3 text-[15px] font-semibold text-ink">{t("teamRoom.new")}</div>
      <input
        autoFocus
        maxLength={100}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) void create();
        }}
        placeholder={t("teamRoom.namePlaceholder")}
        aria-label={t("teamRoom.namePlaceholder")}
        className={INPUT}
      />
      {failed && <div role="alert" className="mt-2 text-[12.5px] text-danger">{t("errors.request")}</div>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[13px] text-ink-secondary hover:bg-raised/70">
          {t("groupWizard.cancel")}
        </button>
        <button
          type="button"
          onClick={() => void create()}
          disabled={!name.trim() || creating}
          className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
        >
          {t("teamRoom.create")}
        </button>
      </div>
    </Shell>
  );
}

/** A valid code joins the moment it lands: no Enter, no button. */
function JoinSheet({ closing, onClose, rejoin }: { closing: boolean; onClose: () => void; rejoin?: { roomId: string; name: string } }) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  const join = async (value: string) => {
    if (busy.current) return;
    busy.current = true;
    setJoining(true);
    setProblem(null);
    const result = rejoin ? await rejoinRoom(rejoin.roomId, value) : await joinRoom(value);
    if ("room" in result) {
      noteJoinedRoom(result.room);
      dispatch({ type: "select", id: joinedSelection(result.room.roomId) });
      onClose();
      return;
    }
    busy.current = false;
    setJoining(false);
    setProblem(joinErrorKey(result.status, result.error));
    input.current?.select();
  };

  const land = (value: string, pasted: boolean) => {
    setCode(value);
    if (looksLikeRoomCode(value)) void join(value.trim());
    else setProblem(pasted && value.trim() ? "teamRoom.badCode" : null);
  };

  useEffect(() => input.current?.focus(), []);

  const title = t(rejoin ? "teamRoom.rejoin" : "teamRoom.joinMenu");
  return (
    <Shell label={title} closing={closing} onClose={onClose}>
      <div className="mb-3 text-[15px] font-semibold text-ink">{title}</div>
      {rejoin && <>
        <div title={rejoin.name} className="mb-2 truncate text-[13px] text-ink-secondary">{rejoin.name}</div>
        <p className="mb-3 text-[12.5px] text-ink-secondary">{t("teamRoom.rejoinCodeHint")}</p>
      </>}
      <input
        ref={input}
        value={code}
        readOnly={joining}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        onPaste={(e) => {
          e.preventDefault();
          land(e.clipboardData.getData("text/plain"), true);
        }}
        onChange={(e) => land(e.target.value, false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && code.trim() && !looksLikeRoomCode(code)) setProblem("teamRoom.badCode");
        }}
        placeholder={t("teamRoom.codePlaceholder")}
        aria-label={t("teamRoom.codePlaceholder")}
        className={`${INPUT} font-mono text-[13px]`}
      />
      <p role={problem ? "alert" : "status"} className={problem ? "mt-2 text-[12.5px] text-danger" : "mt-2 min-h-[1.25rem] text-[12.5px] text-ink-secondary"}>
        {problem ? t(problem) : joining ? t("teamRoom.joining") : ""}
      </p>
    </Shell>
  );
}

export function TeamRoomDialogs() {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const [removing, setRemoving] = useState(false);
  const [removeFailed, setRemoveFailed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveFailed, setLeaveFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const open = useSyncExternalStore(watch, () => sheet);
  const close = () => openSheet(null);
  const group = state.groups.find((each) => each.id === roomTarget?.id);
  const joinedId = roomTarget && joinedRoomIdOf(roomTarget.id);
  const leave = async () => {
    if (!joinedId || leaving) return;
    setLeaving(true);
    setLeaveFailed(false);
    try {
      const { room } = await request(`${joinedRoomBase(joinedId)}/leave`, { method: "POST" });
      noteJoinedRoom(room);
      close();
    } catch {
      setLeaveFailed(true);
    } finally {
      setLeaving(false);
    }
  };
  const remove = async () => {
    if (!joinedId || removing) return;
    setRemoving(true);
    setRemoveFailed(false);
    try {
      await request(joinedRoomBase(joinedId), { method: "DELETE" });
      forgetJoinedRoom(joinedId);
      if (state.selectedId === roomTarget?.id) dispatch({ type: "select", id: state.bots[0]?.id ?? "" });
      close();
    } catch {
      setRemoveFailed(true);
    } finally {
      setRemoving(false);
    }
  };
  useEffect(() => close, []);
  useEffect(() => { if (open === "leave") setLeaveFailed(false); }, [open]);
  return (
    <>
      <Presence open={open === "create"}>{(closing) => <CreateSheet closing={closing} onClose={close} />}</Presence>
      <Presence open={open === "join"}>{(closing) => <JoinSheet closing={closing} onClose={close} />}</Presence>
      <Presence open={open === "rejoin" && Boolean(joinedId)}>
        {(closing) => <JoinSheet closing={closing} onClose={close} rejoin={{ roomId: joinedId!, name: roomTarget?.name ?? "" }} />}
      </Presence>
      <Presence open={open === "people" && isTeamRoom(group)}>
        {(closing) => isTeamRoom(group) && createPortal(<TeamRoomPeople group={group} closing={closing} onClose={close} triggerRef={triggerRef} />, document.body)}
      </Presence>
      <Presence open={open === "leave" && Boolean(joinedId)}>
        {(closing) => <ConfirmDialog
          closing={closing}
          title={t("teamRoom.leaveTitle", { name: roomTarget?.name ?? "" })}
          body={t("teamRoom.leaveBody")}
          confirmLabel={t("teamRoom.leave")}
          confirmDisabled={leaving}
          onCancel={close}
          onConfirm={() => void leave()}
        >
          {leaveFailed && <div role="alert" className="mt-2 text-[12.5px] text-danger">{t("errors.request")}</div>}
        </ConfirmDialog>}
      </Presence>
      <Presence open={open === "remove" && Boolean(joinedId)}>
        {(closing) => <ConfirmDialog
          closing={closing}
          title={t("teamRoom.removeLocalTitle", { name: roomTarget?.name ?? "" })}
          body={t("teamRoom.removeLocalBody")}
          confirmLabel={t("teamRoom.removeLocal")}
          confirmDisabled={removing}
          onCancel={close}
          onConfirm={() => void remove()}
        >
          {removeFailed && <div role="alert" className="mt-2 text-[12.5px] text-danger">{t("errors.request")}</div>}
        </ConfirmDialog>}
      </Presence>
    </>
  );
}
