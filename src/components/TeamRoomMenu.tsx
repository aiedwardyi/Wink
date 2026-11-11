// The sidebar's way in: New team room (a name, nothing else) and Join team room (one code box).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { KeyRound, UsersRound } from "lucide-react";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { noteJoinedRoom } from "@/lib/joined-rooms";
import { createTeamRoom, joinErrorKey, joinedSelection, joinRoom, looksLikeRoomCode } from "@/lib/team-rooms";
import { Presence } from "@/lib/use-presence";
import { useStore } from "@/state/store";

type Sheet = "create" | "join" | null;

let sheet: Sheet = null;
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
function JoinSheet({ closing, onClose }: { closing: boolean; onClose: () => void }) {
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
    const result = await joinRoom(value);
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

  return (
    <Shell label={t("teamRoom.joinMenu")} closing={closing} onClose={onClose}>
      <div className="mb-3 text-[15px] font-semibold text-ink">{t("teamRoom.joinMenu")}</div>
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
  const open = useSyncExternalStore(watch, () => sheet);
  const close = () => openSheet(null);
  useEffect(() => close, []);
  return (
    <>
      <Presence open={open === "create"}>{(closing) => <CreateSheet closing={closing} onClose={close} />}</Presence>
      <Presence open={open === "join"}>{(closing) => <JoinSheet closing={closing} onClose={close} />}</Presence>
    </>
  );
}
