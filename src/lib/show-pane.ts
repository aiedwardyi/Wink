import { useEffect, useRef, useSyncExternalStore } from "react";
import type { Message } from "@/state/store";

export type ShowKind = "image" | "pdf" | "page";

export interface ShowItem {
  threadId: string;
  path: string;
  kind: ShowKind;
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
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function showItem(next: ShowItem) {
  if (showing?.threadId === next.threadId && showing.path === next.path) return;
  showing = next;
  emit();
}

export function closeShow() {
  if (!showing) return;
  showing = null;
  emit();
}

export function useShowItem(): ShowItem | null {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => showing, () => null);
}

const LINK = /\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g;

/** Absolute local file links a bot reply hands over, in order. */
export function showableLinks(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(LINK)) {
    let path = match[1] ?? match[2]!;
    if (/^file:\/\//i.test(path)) {
      try { path = decodeURIComponent(new URL(path).pathname).replace(/^\/([a-zA-Z]:)/, "$1"); } catch { continue; }
    }
    if ((path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) && showKind(path)) paths.push(path);
  }
  return paths;
}

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
  const state = useRef<AutoShow>({ seen: null });
  const was = useRef(shown);
  useEffect(() => {
    const closed = Boolean(was.current && !shown && was.current.threadId === threadId);
    was.current = shown;
    if (!threadId) return;
    const step = autoShowStep(state.current, threadId, messages, closed);
    state.current = step.state;
    if (step.item && free) showItem(step.item);
  }, [threadId, messages, shown, free]);
}
