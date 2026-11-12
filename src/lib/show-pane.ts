import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Message } from "@/state/store";

export type ShowKind = "image" | "pdf" | "page";

export interface ShowItem {
  threadId: string;
  path: string;
  kind: ShowKind;
  /** a room file's own URL; a bot's file goes through linked-file */
  src?: string;
}

const KINDS = new Map<string, ShowKind>([["png", "image"], ["jpg", "image"], ["jpeg", "image"], ["gif", "image"], ["webp", "image"], ["pdf", "pdf"], ["html", "page"], ["htm", "page"]]);

export function showKind(path: string): ShowKind | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? KINDS.get(name.slice(dot + 1).toLowerCase()) ?? null : null;
}

export const showName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function linkedFileSrc(threadId: string, filePath: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/linked-file?path=${encodeURIComponent(filePath)}`;
}

let showing: ShowItem | null = null;
let media: string | null = null;
const last = new Map<string, ShowItem>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function showItem(next: ShowItem) {
  last.set(next.threadId, next);
  if (!media && showing?.threadId === next.threadId && showing.path === next.path && showing.src === next.src) return;
  showing = next;
  media = null;
  emit();
}

export function showMedia(threadId: string) {
  if (media === threadId) return;
  media = threadId;
  emit();
}

export function closeShow() {
  if (!showing && !media) return;
  showing = null;
  media = null;
  emit();
}

export const lastShown = (threadId: string) => last.get(threadId);

/** The header button: shuts this chat's pane, or opens what it last showed, else Media. */
export function togglePane(threadId: string) {
  if (showing?.threadId === threadId || media === threadId) return closeShow();
  const was = last.get(threadId);
  if (was) showItem(was);
  else showMedia(threadId);
}

export function useShowItem(): ShowItem | null {
  return useSyncExternalStore(subscribe, () => showing, () => null);
}

/** The thread whose pane is on the Media tab. */
export function useMediaThread(): string | null {
  return useSyncExternalStore(subscribe, () => media, () => null);
}

const LINK = /\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g;

/** Absolute local file links a bot reply hands over, in order. */
export function localLinks(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(LINK)) {
    let path = match[1] ?? match[2]!;
    if (/^file:\/\//i.test(path)) {
      try { path = decodeURIComponent(new URL(path).pathname).replace(/^\/([a-zA-Z]:)/, "$1"); } catch { continue; }
    }
    if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) paths.push(path);
  }
  return paths;
}

export const showableLinks = (text: string) => localLinks(text).filter((path) => showKind(path));

export interface AutoShow {
  threadId?: string;
  /** message ids already weighed; null until the chat's first messages arrive */
  seen: ReadonlySet<string> | null;
  /** the turn the user closed the pane in */
  closedTurn?: string;
}

export interface AutoShowStep {
  state: AutoShow;
  item: ShowItem | null;
}

const turnOf = (messages: readonly Message[]) => messages.findLast(message => message.role === "user")?.id ?? "";

/** Which file opens on its own: the newest one a bot hands over in this chat while it is open, unless closed this turn. */
export function autoShowStep(state: AutoShow, threadId: string, messages: readonly Message[], closed: boolean): AutoShowStep {
  if (state.threadId !== threadId) state = { threadId, seen: null };
  if (closed) state = { ...state, closedTurn: turnOf(messages) };
  if (!state.seen) return { state: messages.length ? { ...state, seen: new Set(messages.map(message => message.id)) } : state, item: null };
  const seen = new Set(state.seen);
  let path: string | undefined;
  // Older pages load above the seen ones, so only the tail past the last seen message is new.
  for (let i = messages.length - 1; i >= 0 && !state.seen.has(messages[i]!.id); i--) {
    const message = messages[i]!;
    seen.add(message.id);
    if (!path && message.role === "bot" && message.kind === "text" && message.text) path = showableLinks(message.text).at(-1);
  }
  const next = { ...state, seen };
  return { state: next, item: path && state.closedTurn !== turnOf(messages) ? { threadId, path, kind: showKind(path)! } : null };
}

/** `free`: nothing else holds the right slot, so opening on its own never closes what the user is looking at. */
export function useAutoShow(threadId: string | undefined, messages: readonly Message[], free: boolean) {
  const shown = useShowItem();
  const onMedia = useMediaThread() !== null;
  const state = useRef<AutoShow>({ seen: null });
  const was = useRef(shown);
  useEffect(() => {
    const closed = Boolean(was.current && !shown && was.current.threadId === threadId);
    was.current = shown;
    if (!threadId) return;
    const step = autoShowStep(state.current, threadId, messages, closed);
    state.current = step.state;
    if (step.item && free && !onMedia) showItem(step.item);
  }, [threadId, messages, shown, free, onMedia]);
}
