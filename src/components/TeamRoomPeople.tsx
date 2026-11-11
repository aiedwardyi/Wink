// The host's People sheet: invite by name (one code to copy), the list, Remove.
import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, Copy, X } from "lucide-react";

import { request } from "@/lib/api-request";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { inviteErrorKey, inviteToRoom, removeFromRoom, roomPeople, type TeamRoom } from "@/lib/team-rooms";
import { useStore } from "@/state/store";
import type { Group } from "@/state/store-types";

// Joins and removals at the door send no group frame, so the open sheet asks.
const POLL_MS = 3_000;

type Invited = { id: string; name: string; code: string };

function CodeBox({ invited }: { invited: Invited }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invited.code);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1_200);
    } catch {
      // the code stays on screen to select by hand
    }
  };
  return (
    <div data-team-room-code className="rounded-lg bg-inset px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{invited.name}</span>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t("teamRoom.copyCode", { name: invited.name })}
          className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-accent-text hover:bg-control"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          {copied ? t("teamRoom.copied") : t("teamRoom.copy")}
        </button>
      </div>
      <div className="mt-1 select-all break-all font-mono text-[11.5px] text-ink-secondary">{invited.code}</div>
    </div>
  );
}

export function TeamRoomPeople({ group, closing = false, onClose, triggerRef }: {
  group: TeamRoom;
  closing?: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const { dispatch } = useStore();
  const [name, setName] = useState("");
  const [inviting, setInviting] = useState(false);
  const [problem, setProblem] = useState<MessageKey | null>(null);
  const [invited, setInvited] = useState<Invited[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const roomId = group.hosted.roomId;
  const people = roomPeople(group);
  const waiting = invited.filter((each) => !people.some((person) => person.name === each.name));

  useEffect(() => {
    if (closing) return;
    let alive = true;
    const poll = async () => {
      try {
        const body: { groups?: Group[] } = await request("/api/bots?messages=0");
        const fresh = body.groups?.find((each) => each.id === group.id);
        if (alive && fresh?.room) dispatch({ type: "groupPatched", group: { id: group.id, room: fresh.room } });
      } catch {
        // the next tick asks again
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [closing, dispatch, group.id]);

  useEffect(() => {
    if (closing) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () => [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")];
    dialog.querySelector<HTMLInputElement>("input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (!controls.length) return event.preventDefault();
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => {
      dialog.removeEventListener("keydown", onKey);
      triggerRef.current?.focus();
    };
  }, [closing, onClose, triggerRef]);

  const invite = async () => {
    const wanted = name.trim();
    if (!wanted || inviting) return;
    setInviting(true);
    const result = await inviteToRoom(roomId, wanted);
    setInviting(false);
    if ("code" in result) {
      setInvited((list) => [{ id: result.invite.id, name: result.invite.name, code: result.code }, ...list]);
      setName("");
      setProblem(null);
    } else setProblem(inviteErrorKey(result.status, result.error));
  };

  const remove = async (personId: string) => {
    const room = group.room && "people" in group.room ? group.room : null;
    if (!room) return;
    try {
      await removeFromRoom(roomId, personId);
      dispatch({ type: "groupPatched", group: { id: group.id, room: { ...room, people: room.people.filter((person) => person.id !== personId) } } });
    } catch {
      setProblem("errors.request");
    }
  };

  return (
    <div
      data-closing={closing || undefined}
      inert={closing}
      className="animate-fade-in fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role={closing ? undefined : "dialog"}
        aria-modal={!closing || undefined}
        aria-label={t("teamRoom.people")}
        className="animate-pop-in w-[340px] max-w-[calc(100vw-2rem)] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl"
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="text-[15px] font-semibold text-ink">{t("teamRoom.people")}</div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("chat.dismiss")}
            title={t("chat.dismiss")}
            className="flex size-7 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
        <div className="mb-3 truncate text-[13px] text-ink-secondary">{group.name}</div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void invite();
          }}
        >
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setProblem(null);
            }}
            maxLength={40}
            placeholder={t("teamRoom.personName")}
            aria-label={t("teamRoom.personName")}
            className="min-w-0 flex-1 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-[14px] text-ink placeholder:text-ink-secondary focus:border-accent/60 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!name.trim() || inviting}
            className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-ink hover:brightness-110 disabled:opacity-40"
          >
            {t("teamRoom.invite")}
          </button>
        </form>
        {problem && <p role="alert" className="mt-2 text-[12.5px] text-danger">{t(problem)}</p>}
        {waiting.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {waiting.map((each) => <CodeBox key={each.id} invited={each} />)}
            <p className="text-[12px] text-ink-secondary">{t("teamRoom.codeHint")}</p>
          </div>
        )}
        <ul className="mt-3 flex flex-col gap-0.5" aria-label={t("teamRoom.people")}>
          {people.map((person) => (
            <li key={person.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-raised/50">
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{person.name}</span>
              <button
                type="button"
                onClick={() => void remove(person.id)}
                aria-label={t("teamRoom.removeNamed", { name: person.name })}
                className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-secondary hover:bg-danger/10 hover:text-danger"
              >
                {t("teamRoom.remove")}
              </button>
            </li>
          ))}
          {people.length === 0 && waiting.length === 0 && <li className="px-2 py-1.5 text-[13px] text-ink-secondary">{t("teamRoom.nobody")}</li>}
        </ul>
      </div>
    </div>
  );
}
