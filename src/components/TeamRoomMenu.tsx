// The sidebar's way in: Join with code (one code box), plus each room's own menu items.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Copy, KeyRound, LogIn, LogOut, Trash2, UsersRound } from "lucide-react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { request } from "@/lib/api-request";
import { forgetJoinedRoom, noteJoinedRoom, useJoinedRooms } from "@/lib/joined-rooms";
import { openRoomDetails } from "@/lib/room-details";
import { inviteErrorKey, inviteToRoom, isTeamRoom, joinedRoomIdOf, joinedRoomBase, joinErrorKey, joinedSelection, joinRoom, looksLikeRoomCode, rejoinRoom, typedRoomName } from "@/lib/team-rooms";
import { CodeBoxes } from "./CodeBoxes";
import { useBackLayer } from "@/lib/use-back-layer";
import { MENU_ITEM_HOVER } from "@/lib/menu-style";
import { Presence } from "@/lib/use-presence";
import { api, useStore, type Group } from "@/state/store";

import { ConfirmDialog } from "./ConfirmDialog";
import { trackFeature } from "@/lib/usage-stats";

type Sheet = "join" | "rejoin" | "leave" | "remove" | "delete" | null;

let sheet: Sheet = null;
let roomTarget: { id: string; name: string; hosted?: boolean } | null = null;
const watchers = new Set<() => void>();

function openSheet(next: Sheet) {
  sheet = next;
  for (const watcher of [...watchers]) watcher();
}

export function confirmRoomDelete(group: Group) {
  roomTarget = { id: group.id, name: group.name, hosted: Boolean(group.hosted) };
  openSheet("delete");
}

const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};

const ITEM = `flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink ${MENU_ITEM_HOVER}`;

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
      await navigator.clipboard.writeText(result.short ?? result.code);
      onClose();
    } catch {
      setProblem("errors.request");
    }
  };
  return (
    <>
      <button type="button" onClick={() => { dispatch({ type: "select", id: group.id }); openRoomDetails(dispatch); onClose(); }} className={ITEM}>
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
    <button onClick={() => pick("join")} className={ITEM}>
      <KeyRound size={16} className="text-ink-secondary" />
      {t("teamRoom.joinMenu")}
    </button>
  );
}

function Shell({ label, closing, onClose, children }: { label: string; closing: boolean; onClose: () => void; children: React.ReactNode }) {
  useBackLayer(!closing, onClose);
  return createPortal(
    <div
      data-closing={closing || undefined}
      inert={closing}
      className="animate-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]"
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
        className="animate-pop-in w-full max-w-[380px] rounded-[24px] border border-hairline/50 bg-panel p-4 shadow-2xl shadow-black/50"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

const INPUT = "w-full rounded-lg border border-hairline/60 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-accent/60 focus:outline-none";

/** A valid code joins the moment it lands: no Enter, no button. */
function JoinSheet({ closing, onClose, rejoin }: { closing: boolean; onClose: () => void; rejoin?: { roomId: string; name: string } }) {
  const { t } = useI18n();
  const { state, dispatch } = useStore();
  const [askName] = useState(() => !rejoin && !state.config?.profile?.name?.trim());
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [hosting, setHosting] = useState(false);
  const busy = useRef(false);
  const waiting = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const join = async (value: string) => {
    if (busy.current) return;
    waiting.current = value;
    const typed = askName ? typedRoomName(name) : "";
    if (askName && !typed) return setProblem("teamRoom.nameRequired");
    waiting.current = null;
    busy.current = true;
    setJoining(true);
    setProblem(null);
    setHosting(false);
    if (typed) {
      try {
        dispatch({ type: "configStatus", config: await api("/api/config", { method: "PUT", body: JSON.stringify({ profile: { name: typed } }) }) });
      } catch {
        busy.current = false;
        setJoining(false);
        setProblem("settings.profile.saveError");
        return;
      }
    }
    const result = rejoin ? await rejoinRoom(rejoin.roomId, value) : await joinRoom(value);
    if ("room" in result) {
      noteJoinedRoom(result.room);
      trackFeature("room.join");
      dispatch({ type: "select", id: joinedSelection(result.room.roomId) });
      onClose();
      return;
    }
    busy.current = false;
    setJoining(false);
    if (result.groupId) {
      dispatch({ type: "select", id: result.groupId });
      setHosting(true);
      return;
    }
    const short = !rejoin && !looksLikeRoomCode(value);
    setProblem(joinErrorKey(result.status, result.error, short));
    input.current?.select();
  };

  const land = (value: string, pasted: boolean) => {
    setCode(value);
    if (looksLikeRoomCode(value)) void join(value.trim());
    else setProblem(pasted && value.trim() ? "teamRoom.badCode" : null);
  };

  useEffect(() => (rejoin ? input.current : document.querySelector<HTMLInputElement>(askName ? "[data-join-name]" : "[data-join-boxes] input"))?.focus(), []);

  const title = t(rejoin ? "teamRoom.rejoin" : "teamRoom.joinMenu");
  return (
    <Shell label={title} closing={closing} onClose={onClose}>
      <div className="mb-3 text-[15px] font-semibold text-ink">{title}</div>
      {rejoin && <>
        <div title={rejoin.name} className="mb-2 truncate text-[13px] text-ink-secondary">{rejoin.name}</div>
        <p className="mb-3 text-[12.5px] text-ink-secondary">{t("teamRoom.rejoinCodeHint")}</p>
      </>}
      {askName && <>
        <input
          data-join-name
          value={name}
          readOnly={joining}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && waiting.current) void join(waiting.current);
          }}
          aria-label={t("teamRoom.joinName")}
          placeholder={t("teamRoom.joinName")}
          className={INPUT}
        />
        <p className="mb-3 mt-1 text-[12px] text-ink-secondary">{t("teamRoom.nameEverywhere")}</p>
      </>}
      {rejoin ? <input
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
      /> : <div data-join-boxes>
        <p className="mb-3 text-[12.5px] text-ink-secondary">{t("teamRoom.shortCodePrompt")}</p>
        <CodeBoxes
          value={code}
          disabled={joining}
          label={t("teamRoom.shortCodeLabel")}
          onChange={(value) => {
            setCode(value);
            setProblem(null);
          }}
          onDone={(value) => void join(value)}
          onOther={(value) => (looksLikeRoomCode(value) ? void join(value) : setProblem("teamRoom.badCode"))}
        />
      </div>}
      <p role={problem ? "alert" : "status"} className={problem ? "mt-2 text-[12.5px] text-danger" : "mt-2 min-h-[1.25rem] text-[12.5px] text-ink-secondary"}>
        {problem ? t(problem) : joining ? t("teamRoom.joining") : hosting ? t("teamRoom.youHost") : ""}
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
  const open = useSyncExternalStore(watch, () => sheet);
  const close = () => openSheet(null);
  const [everyPc, setEveryPc] = useState(false);
  useEffect(() => {
    setEveryPc(false);
    const target = roomTarget;
    if (open !== "delete" || !target || target.hosted) return;
    let live = true;
    // only chat sync carries a delete to other PCs; a local delete still needs no confirm
    void api("/api/profile-sync")
      .then((body) => body?.configured === true && body?.syncChats === true, () => false)
      .then((reach) => {
        if (!live) return;
        if (reach) return setEveryPc(true);
        dispatch({ type: "deleteGroup", groupId: target.id });
        openSheet(null);
      });
    return () => {
      live = false;
    };
  }, [open, dispatch]);
  const joinedId = roomTarget && joinedRoomIdOf(roomTarget.id);
  const leave = async () => {
    if (!joinedId || leaving) return;
    trackFeature("room.leave");
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
      <Presence open={open === "join"}>{(closing) => <JoinSheet closing={closing} onClose={close} />}</Presence>
      <Presence open={open === "rejoin" && Boolean(joinedId)}>
        {(closing) => <JoinSheet closing={closing} onClose={close} rejoin={{ roomId: joinedId!, name: roomTarget?.name ?? "" }} />}
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
      <Presence open={open === "delete" && (roomTarget?.hosted === true || everyPc)}>
        {(closing) => <ConfirmDialog
          closing={closing}
          title={t("teamRoom.deleteTitle", { name: roomTarget?.name ?? "" })}
          body={roomTarget?.hosted ? t("teamRoom.deleteBody") : t("chrome.deleteGroupBodyAllPcs", { name: roomTarget?.name ?? "" })}
          confirmLabel={t("chrome.delete")}
          onCancel={close}
          onConfirm={() => {
            if (roomTarget) dispatch({ type: "deleteGroup", groupId: roomTarget.id });
            close();
          }}
        />}
      </Presence>
    </>
  );
}
