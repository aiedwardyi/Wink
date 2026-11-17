import { useEffect, useRef, useSyncExternalStore } from "react";
import { z } from "zod";
import type { Message } from "@/state/store";
import { prefersReducedMotion } from "./arrival-glow";
import { linkedFileSrc, localLinks, showKind, type ShowKind } from "./chat-media";

export { linkedFileSrc, localLinks, showKind, showName, type ShowKind } from "./chat-media";

export type PaneKind = ShowKind | "text" | "folder";

export interface ShowItem {
  threadId: string;
  path: string;
  kind: PaneKind;
  /** a room file's own URL; a bot's file goes through linked-file */
  src?: string;
}

const folderSchema = z.object({
  files: z.array(z.object({ name: z.string().min(1), path: z.string().min(1), size: z.number(), modified: z.number() })),
  more: z.number(),
});

export type FolderListing = z.infer<typeof folderSchema>;

const listed = new Map<string, FolderListing>();
const folderViews = new Map<string, (listing: FolderListing) => void>();

/** A linked folder's files from this PC's server, or null when it won't list them. */
export async function linkedFolder(threadId: string, path: string): Promise<FolderListing | null> {
  const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/linked-folder?path=${encodeURIComponent(path)}`).catch(() => null);
  const body = res?.ok ? folderSchema.safeParse(await res.json().catch(() => null)) : null;
  return body?.success ? body.data : null;
}

/** Shows a folder its link just listed, so the pane draws that listing without asking again. */
export function showFolder(threadId: string, path: string, listing: FolderListing) {
  const key = `${threadId}\n${path}`;
  const view = folderViews.get(key);
  if (view) view(listing);
  else listed.set(key, listing);
  showItem({ threadId, path, kind: "folder" });
}

/** An open folder takes each listing its link hands over, since showItem keeps the same item as it is. */
export function watchFolder(threadId: string, path: string, take: (listing: FolderListing) => void): () => void {
  const key = `${threadId}\n${path}`;
  folderViews.set(key, take);
  return () => {
    if (folderViews.get(key) === take) folderViews.delete(key);
  };
}

export function takeFolder(threadId: string, path: string): FolderListing | null {
  const key = `${threadId}\n${path}`;
  const listing = listed.get(key) ?? null;
  listed.delete(key);
  return listing;
}

let showing: ShowItem | null = null;
let media: string | null = null;
let checking: string | null = null;
let mapping: string | null = null;
const last = new Map<string, ShowItem>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const PANE_TAB_KEY = "omb-pane-tab";
const paneTab = z.union([z.enum(["media", "map"]), z.object({ threadId: z.string(), path: z.string(), kind: z.enum(["image", "pdf", "page", "text", "folder"]), src: z.string().optional() })]);
type PaneTab = z.infer<typeof paneTab>;
const picked = new Map<string, PaneTab>();

function picks(): Record<string, PaneTab> {
  try {
    return z.record(z.string(), paneTab).catch({}).parse(JSON.parse(globalThis.localStorage?.getItem(PANE_TAB_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

function pick(threadId: string, tab: PaneTab) {
  picked.set(threadId, tab);
  try {
    globalThis.localStorage?.setItem(PANE_TAB_KEY, JSON.stringify({ ...picks(), [threadId]: tab }));
  } catch {
    // Storage blocked: the pick lasts until the app closes.
  }
}

let pulses = 0;

/** False when this exact file was already on the Show tab, so nothing changed. */
function openItem(next: ShowItem): boolean {
  last.set(next.threadId, next);
  if (!media && !checking && !mapping && showing?.threadId === next.threadId && showing.path === next.path && showing.src === next.src) return false;
  showing = next;
  media = null;
  checking = null;
  mapping = null;
  emit();
  return true;
}

/** A click on the file already showing pulses the pane, so it reads as "this is it". */
export function showItem(next: ShowItem) {
  pick(next.threadId, next);
  if (openItem(next) || prefersReducedMotion()) return;
  pulses++;
  emit();
}

export function usePanePulse(): number {
  return useSyncExternalStore(subscribe, () => pulses, () => 0);
}

function openMedia(threadId: string) {
  if (media === threadId) return;
  media = threadId;
  checking = null;
  mapping = null;
  emit();
}

export function showMedia(threadId: string) {
  pick(threadId, "media");
  openMedia(threadId);
}

/** Fronts the Check tab; the checker itself lives in verify-watch. */
export function showCheck(threadId: string) {
  if (checking === threadId) return;
  checking = threadId;
  media = null;
  mapping = null;
  emit();
}

export const checkThread = () => checking;

export function closeShow() {
  if (!showing && !media && !checking && !mapping) return;
  showing = null;
  media = null;
  checking = null;
  mapping = null;
  emit();
}

export const lastShown = (threadId: string) => last.get(threadId);

/** The header button: shuts this chat's pane, or opens the tab last picked in it, else Map while a worker is live, else Media. Only a bot chat has a `map`; a room's runs on each person's own PC. */
export function togglePane(threadId: string, map?: "idle" | "live") {
  if (showing?.threadId === threadId || media === threadId || mapping === threadId) return closeShow();
  const tab = picked.get(threadId) ?? picks()[threadId] ?? (map === "live" ? "map" : "media");
  if (tab === "map" && map) openMap(threadId);
  else if (tab === "map") openMedia(threadId);
  else if (tab === "media") openMedia(threadId);
  else openItem(last.get(threadId) ?? tab);
}

export function useShowItem(): ShowItem | null {
  return useSyncExternalStore(subscribe, () => showing, () => null);
}

/** The thread whose pane is on the Media tab. */
export function useMediaThread(): string | null {
  return useSyncExternalStore(subscribe, () => media, () => null);
}

/** The thread whose pane is on the Check tab. */
export function useCheckThread(): string | null {
  return useSyncExternalStore(subscribe, () => checking, () => null);
}

function openMap(threadId: string) {
  if (mapping === threadId) return;
  mapping = threadId;
  checking = null;
  media = null;
  emit();
}

export function showMap(threadId: string) {
  pick(threadId, "map");
  openMap(threadId);
}

export function useMapThread(): string | null {
  return useSyncExternalStore(subscribe, () => mapping, () => null);
}

export const showableLinks = (text: string) => localLinks(text).filter((path) => showKind(path));

/** Replies in a turn whose bot already put a picture in the chat, so their file links don't draw it again. */
export function picturedReplies(messages: readonly Message[]): Set<string> {
  const pictured = new Set<string>();
  let shown = new Set<string>();
  let replies: Message[] = [];
  const close = () => {
    for (const reply of replies) if (shown.has(reply.from?.botId ?? "")) pictured.add(reply.id);
    shown = new Set();
    replies = [];
  };
  for (const message of messages) {
    if (message.role === "user") close();
    else if (message.kind === "screen" && message.image) shown.add(message.from?.botId ?? "");
    else if (message.kind === "text") replies.push(message);
  }
  close();
  return pictured;
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

/** Which file opens on its own: the newest page or PDF a bot hands over in this chat while it is open, unless closed this turn. Pictures open on a click. */
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
    if (!path && message.role === "bot" && message.kind === "text" && message.text) path = showableLinks(message.text).findLast((link) => showKind(link) !== "image");
  }
  const next = { ...state, seen };
  return { state: next, item: path && state.closedTurn !== turnOf(messages) ? { threadId, path, kind: showKind(path)! } : null };
}

/** `free`: nothing else holds the right slot, so opening on its own never closes what the user is looking at. */
export function useAutoShow(threadId: string | undefined, messages: readonly Message[], free: boolean) {
  const shown = useShowItem();
  const onMedia = useMediaThread() !== null;
  const onMap = useMapThread() !== null;
  const state = useRef<AutoShow>({ seen: null });
  const was = useRef(shown);
  const probe = useRef<AbortController>(undefined);
  // A probe still out when the user picks another tab or file, or a newer file arrives, is stale.
  useEffect(() => () => probe.current?.abort(), [threadId, shown, free, onMedia, onMap]);
  useEffect(() => {
    const closed = Boolean(was.current && !shown && was.current.threadId === threadId);
    was.current = shown;
    if (!threadId) return;
    const step = autoShowStep(state.current, threadId, messages, closed);
    state.current = step.state;
    const item = step.item;
    // A file this PC can't serve would open a dead pane; its link still opens it in the browser.
    if (item && free && !onMedia && !onMap) {
      probe.current?.abort();
      const { signal } = probe.current = new AbortController();
      fetch(linkedFileSrc(item.threadId, item.path), { headers: { Range: "bytes=0-0" }, signal })
        .then((res) => { if (!signal.aborted && (res.ok || res.status === 416)) openItem(item); }, () => {});
    }
  }, [threadId, messages, shown, free, onMedia, onMap]);
}
