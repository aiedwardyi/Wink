import type { MessageKey, Translate } from "@/lib/i18n";
import type { PaneNote, PaneNoteStatus } from "../../shared/pane-note";
import { en } from "./i18n-catalog";

export const NOTE_STATUS_KEY = { done: "chat.noteDone", failed: "chat.noteFailed", blocked: "chat.noteBlocked" } as const satisfies Record<PaneNoteStatus, MessageKey>;

const SNAG_KEY = { stalled: "chat.teamSnagStalled", "note-lost": "chat.teamSnagNoteLost", "wake-failed": "chat.teamSnagWakeFailed", "reply-unwoken": "chat.teamSnagReplyUnwoken" } as const;

export function noteTitle(note: PaneNote, t: Translate, type?: "team-report"): string {
  if (type === "team-report") return t("chat.bugReport");
  if (note.snag) {
    const snag = note.snag;
    const pc = t(snag.person ? "chat.teamSnagPersonPc" : "chat.teamSnagPc", { person: snag.person, pc: snag.pc });
    const summary = t(SNAG_KEY[snag.event], { pc, worker: snag.worker || t("chat.teamSnagWorker"), minutes: snag.minutes });
    return snag.count > 1 ? t("chat.teamSnagMore", { summary, count: snag.count - 1 }) : summary;
  }
  return note.label ? t("chat.noteFrom", { label: note.label }) : t(note.pane8 ? "chat.noteFromWorker" : "chat.note");
}

/** The worker's words, or a plain sentence for Wink's own watcher notes. */
export function noteText(note: PaneNote, t: Translate): string {
  if (note.body === en["errors.codexPromo"]) return t("errors.codexPromo");
  if (note.snag) return `${noteTitle(note, t)}\n\n${note.body}`;
  if (note.alert?.kind === "stalled") return note.alert.minutes === 1 ? t("chat.noteStalledOne") : t("chat.noteStalled", { count: note.alert.minutes });
  if (note.alert?.kind === "waiting") return t("chat.noteWaiting");
  if (note.alert?.kind === "finished") return t("chat.noteFinished");
  if (note.alert?.kind === "restarted") return t("chat.noteRestarted", { panes: note.alert.panes.join(", ") });
  if (note.alert?.kind === "limit") return t("chat.noteLimit", { engine: note.alert.engine, reset: note.alert.reset });
  return note.body;
}

export function notePreview(note: PaneNote, t: Translate): string {
  const text = noteText(note, t).replace(/\s+/g, " ").trim();
  if (!note.status) return text;
  const status = t(NOTE_STATUS_KEY[note.status]);
  return text ? t("chat.noteStatusLine", { status, text }) : status;
}
