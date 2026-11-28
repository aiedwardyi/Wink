import type { Reservation } from "./comms-root.ts";
import type { Message, Store } from "./store.ts";

export const PANE_WAKE_PROMPT = "A pane note arrived. Act on it.";
export const PANE_WAKE_DEBOUNCE_MS = 3_000;

export interface WakeAdmission { rootId: string | null; reservation: Reservation | null }

export interface PaneWakeDeps {
  enabled(botId: string, threadId: string): boolean;
  busy(botId: string, threadId: string): boolean;
  paused?(botId: string): boolean;
  /** A user turn since the note already delivered it. */
  hasNotes(threadId: string): boolean;
  /** Every pane was closed by this bot's own terminal_close. */
  closedByBot?(botId: string, paneIds: string[]): Promise<boolean>;
  /** A burst was dropped because the bot closed all its panes. */
  skipped?(botId: string, threadId: string): void;
  /** Starts with the admission's own root and reservation, never a re-read. */
  wake(botId: string, threadId: string, admission: WakeAdmission): void;
  admit?(botId: string, threadId: string): WakeAdmission | null;
}

const isReportNote = (message: Message) => message.kind === "note" && Boolean(message.reportIds?.length);

/** The user's own message carried the notes before it; a teammate's peer turn held them. */
export const endsNoteWindow = (message: Message) =>
  message.role === "user" && message.kind === "text" && Boolean(message.text?.trim()) && !message.steered && !message.quick && !message.from?.botId;

export function isWakeNote(message: Message): boolean {
  return (!message.quiet || isReportNote(message)) && !message.comm?.read && (message.kind === "note" || (message.kind === "activity" && message.comm?.peer === "reply" && message.comm.wake === true));
}

export function paneNoteWaiting(store: Pick<Store, "bot" | "taskByThread" | "activePath">, botId: string, threadId: string): boolean {
  const sharing = store.bot(botId)?.shareTerminalWithChat !== false;
  const deliveredId = store.taskByThread(botId, threadId)?.paneNotesDeliveredId;
  const messages = store.activePath(threadId);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.id === deliveredId) break;
    if (endsNoteWindow(message)) break;
    if (message.kind === "note" && (sharing || isReportNote(message)) && isWakeNote(message) && message.text?.trim()) return true;
  }
  return false;
}

export function paneWakeEnabled(store: Store, botId: string, threadId: string): boolean {
  const bot = store.bot(botId);
  if (!bot) return false;
  if (bot.shareTerminalWithChat !== false) return true;
  const task = store.taskByThread(botId, threadId);
  const messages = store.activePath(threadId);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.id === task?.paneNotesDeliveredId || message.id === task?.paneNotesSkippedId) break;
    if (endsNoteWindow(message)) break;
    if ((message.kind === "activity" || isReportNote(message)) && isWakeNote(message) && message.text?.trim()) return true;
  }
  return false;
}

export function hasLocalUndeliveredPaneNote(messages: Message[], deliveredId: string | undefined, deviceId: string, skippedId?: string): boolean {
  return localNoteBack(messages.toReversed(), deliveredId, deviceId, skippedId);
}

function localNoteBack(newestFirst: Iterable<Message>, deliveredId: string | undefined, deviceId: string, skippedId?: string): boolean {
  for (const message of newestFirst) {
    if (message.id === deliveredId || message.id === skippedId) break;
    if (endsNoteWindow(message)) break;
    if (!message.quiet && isWakeNote(message) && message.text?.trim() && message.origin === deviceId) return true;
  }
  return false;
}

export interface PaneWakeChat { botId: string; threadId: string; deliveredId: string | null; skippedId?: string }

/** Open chats that track pane note delivery, in bot order. */
export function paneWakeChats(store: Pick<Store, "bots" | "taskByThread">): PaneWakeChat[] {
  return store.bots.flatMap((bot) => {
    const task = store.taskByThread(bot.id, bot.threadId);
    return task?.paneNotesDeliveredId === undefined ? [] : [{ botId: bot.id, threadId: bot.threadId, deliveredId: task.paneNotesDeliveredId, skippedId: task.paneNotesSkippedId }];
  });
}

/** The chats whose stored local pane notes were never delivered; reads only each chat's tail. */
export function bootPaneWakes(chats: PaneWakeChat[], back: (threadId: string) => Iterable<Message>, deviceId: string): Array<{ botId: string; threadId: string }> {
  return chats.flatMap(({ botId, threadId, deliveredId, skippedId }) => (localNoteBack(back(threadId), deliveredId ?? undefined, deviceId, skippedId) ? [{ botId, threadId }] : []));
}

interface Pending {
  botId: string;
  threadId: string;
  timer: ReturnType<typeof setTimeout> | null;
  panes: Set<string>;
  /** A note with no known pane joined: always wake. */
  unknownPane: boolean;
  notes: number;
  checking: boolean;
}

/** One teacher turn per burst of pane notes, only once the bot is idle. */
export class PaneWakeScheduler {
  private readonly pending = new Map<string, Pending>();
  private readonly deps: PaneWakeDeps;

  constructor(deps: PaneWakeDeps) {
    this.deps = deps;
  }

  noteArrived(botId: string, threadId: string, paneId?: string): void {
    if (!this.deps.enabled(botId, threadId) || this.deps.paused?.(botId)) return;
    const key = `${botId}\0${threadId}`;
    const entry = this.pending.get(key) ?? { botId, threadId, timer: null, panes: new Set(), unknownPane: false, notes: 0, checking: false };
    if (paneId) entry.panes.add(paneId);
    else entry.unknownPane = true;
    entry.notes++;
    this.pending.set(key, entry);
    this.arm(key, entry);
  }

  /** Any turn settled: retry every burst that found its bot busy. */
  settled(): void {
    for (const [key, entry] of this.pending) this.arm(key, entry);
  }

  forgetBot(botId: string): void {
    for (const [key, entry] of this.pending) {
      if (entry.botId !== botId) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.pending.delete(key);
    }
  }

  private arm(key: string, entry: Pending): void {
    if (entry.timer) return;
    entry.timer = setTimeout(() => this.fire(key, entry), PANE_WAKE_DEBOUNCE_MS);
    entry.timer.unref?.();
  }

  private fire(key: string, entry: Pending): void {
    entry.timer = null;
    // the check in flight re-arms if it needs to
    if (entry.checking) return;
    const { botId, threadId } = entry;
    if (this.deps.busy(botId, threadId)) return;
    if (!this.deps.enabled(botId, threadId) || this.deps.paused?.(botId) || !this.deps.hasNotes(threadId)) {
      this.pending.delete(key);
      return;
    }
    if (!entry.unknownPane && entry.panes.size > 0 && this.deps.closedByBot) {
      void this.check(key, entry, this.deps.closedByBot);
      return;
    }
    this.pending.delete(key);
    this.wake(entry);
  }

  /** Drops a burst whose panes the bot closed itself; any doubt wakes. */
  private async check(key: string, entry: Pending, closedByBot: NonNullable<PaneWakeDeps["closedByBot"]>): Promise<void> {
    const { botId, threadId } = entry;
    const notes = entry.notes;
    entry.checking = true;
    let closed = false;
    try {
      closed = await closedByBot(botId, [...entry.panes]);
    } catch {}
    entry.checking = false;
    if (this.pending.get(key) !== entry) return;
    if (entry.notes !== notes) return this.arm(key, entry);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (this.deps.busy(botId, threadId)) return;
    this.pending.delete(key);
    if (!this.deps.enabled(botId, threadId) || this.deps.paused?.(botId) || !this.deps.hasNotes(threadId)) return;
    if (closed) return this.deps.skipped?.(botId, threadId);
    this.wake(entry);
  }

  private wake(entry: Pending): void {
    const { botId, threadId } = entry;
    const admission = this.deps.admit ? this.deps.admit(botId, threadId) : { rootId: null, reservation: null };
    if (admission) this.deps.wake(botId, threadId, admission);
  }
}
