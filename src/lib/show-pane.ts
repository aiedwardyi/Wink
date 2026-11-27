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
let working: string | null = null;
let timeline: string | null = null;
let tools: string | null = null;
const last = new Map<string, ShowItem>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const PANE_TAB_KEY = "omb-pane-tab";
const fileTab = z.object({ threadId: z.string(), path: z.string(), kind: z.enum(["image", "pdf", "page", "text", "folder"]), src: z.string().optional() });
const paneTab = z.union([z.enum(["media", "map", "workers", "timeline"]), fileTab]);
type PaneTab = z.infer<typeof paneTab>;
const openedTab = z.union([z.enum(["workers", "media", "check", "map", "timeline"]), fileTab]);
export type PaneEntry = z.infer<typeof openedTab>;
export type PaneTool = Exclude<PaneEntry, ShowItem>;
export const PANE_TOOLS: readonly PaneTool[] = ["workers", "media", "check", "map", "timeline"];
// Alt plus the letter opens the tool. Alt+M, R, T, I and U are taken app-wide.
export const PANE_KEY: Record<PaneTool, string> = { workers: "W", media: "P", check: "C", map: "G", timeline: "L" };
export const PANE_TABS_KEY = "omb-pane-tabs";
export const tabKey = (tab: PaneEntry) => typeof tab === "string" ? tab : `file:${tab.src ?? tab.path}`;
const opened = new Map<string, PaneEntry[]>();
const NO_TABS: PaneEntry[] = [];

function storedTabs(): Record<string, PaneEntry[]> {
  try {
    return z.record(z.string(), z.array(openedTab)).catch({}).parse(JSON.parse(globalThis.localStorage?.getItem(PANE_TABS_KEY) ?? "{}"));
  } catch {
    return {};
  }
}

/** A chat's open tabs in the order the user left them. */
export function paneTabs(threadId: string): PaneEntry[] {
  let tabs = opened.get(threadId);
  if (!tabs) opened.set(threadId, tabs = storedTabs()[threadId] ?? seedTabs(threadId));
  return tabs;
}

// A chat last seen before tabs keeps the one tab it was on.
function seedTabs(threadId: string): PaneEntry[] {
  const tab = picked.get(threadId) ?? picks()[threadId];
  return tab ? [tab] : NO_TABS;
}

function keepTabs(threadId: string, tabs: PaneEntry[]) {
  opened.set(threadId, tabs);
  try {
    globalThis.localStorage?.setItem(PANE_TABS_KEY, JSON.stringify({ ...storedTabs(), [threadId]: tabs }));
  } catch {
    // Storage blocked: the tabs last until the app closes.
  }
}

function addTab(threadId: string, tab: PaneEntry): boolean {
  const tabs = paneTabs(threadId);
  if (tabs.some((entry) => tabKey(entry) === tabKey(tab))) return false;
  keepTabs(threadId, [...tabs, typeof tab === "string" ? tab : { threadId: tab.threadId, path: tab.path, kind: tab.kind, src: tab.src }]);
  return true;
}

export function usePaneTabs(threadId?: string): readonly PaneEntry[] {
  return useSyncExternalStore(subscribe, () => threadId ? paneTabs(threadId) : NO_TABS, () => NO_TABS);
}

/** Moves a tab in front of `before`, or to the end. */
export function moveTab(threadId: string, key: string, before: string | null) {
  const tabs = paneTabs(threadId);
  const moving = tabs.find((entry) => tabKey(entry) === key);
  if (!moving || key === before) return;
  const rest = tabs.filter((entry) => entry !== moving);
  const at = before === null ? -1 : rest.findIndex((entry) => tabKey(entry) === before);
  keepTabs(threadId, at < 0 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)]);
  emit();
}

const onTab = (threadId: string): string | null =>
  working === threadId ? "workers" : mapping === threadId ? "map" : timeline === threadId ? "timeline" : media === threadId ? "media" : checking === threadId ? "check" : tools === threadId ? null : showing?.threadId === threadId ? tabKey(showing) : null;

/** Closes one tab; the open one hands over to `next`, else to the tool list, in one update so the pane never shuts between them. */
export function closeTab(threadId: string, key: string, next: PaneEntry | null) {
  const tabs = paneTabs(threadId);
  if (!tabs.some((entry) => tabKey(entry) === key)) return;
  const was = onTab(threadId);
  keepTabs(threadId, tabs.filter((entry) => tabKey(entry) !== key));
  if (showing?.threadId === threadId && tabKey(showing) === key) showing = null;
  if (checking === threadId && key === "check") checking = null;
  if (was === key && next && next !== "check") {
    pick(threadId, next);
    openEntry(threadId, next);
  } else if (was === key) openEntry(threadId, "tools");
  emit();
}
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

// The pane is in one chat: a tab fronted in another chat lets go of the file this one showed.
function leaveFile(threadId: string) {
  if (showing?.threadId !== threadId) showing = null;
}

let pulses = 0;

/** False when this exact file was already on the Show tab, so nothing changed. */
function openItem(next: ShowItem): boolean {
  last.set(next.threadId, next);
  const added = addTab(next.threadId, next);
  if (!media && !checking && !mapping && !working && !timeline && !tools && showing?.threadId === next.threadId && showing.path === next.path && showing.src === next.src) {
    if (added) emit();
    return false;
  }
  showing = next;
  media = null;
  checking = null;
  mapping = null;
  working = null;
  timeline = null;
  tools = null;
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
  addTab(threadId, "media");
  if (media === threadId) return;
  media = threadId;
  leaveFile(threadId);
  checking = null;
  mapping = null;
  working = null;
  timeline = null;
  tools = null;
  emit();
}

export function showMedia(threadId: string) {
  pick(threadId, "media");
  openMedia(threadId);
}

/** Fronts the Check tab; the checker itself lives in verify-watch. */
export function showCheck(threadId: string) {
  addTab(threadId, "check");
  if (checking === threadId) return;
  checking = threadId;
  leaveFile(threadId);
  media = null;
  mapping = null;
  working = null;
  timeline = null;
  tools = null;
  emit();
}

export const checkThread = () => checking;

export function closeShow() {
  if (!showing && !media && !checking && !mapping && !working && !timeline && !tools) return;
  showing = null;
  media = null;
  checking = null;
  mapping = null;
  working = null;
  timeline = null;
  tools = null;
  emit();
}

export const lastShown = (threadId: string) => last.get(threadId);

const paneOpen = (threadId: string) => showing?.threadId === threadId || media === threadId || mapping === threadId || working === threadId || timeline === threadId || tools === threadId;

/** The header button: shuts this chat's pane, or opens Workers while the chat lists any, else the tab last open in it, else the tool list. Only a bot chat has a `map` and a Workers tab; a room's runs on each person's own PC. */
export function togglePane(threadId: string, map?: "idle" | "live", workers?: "listed" | "tab") {
  if (paneOpen(threadId)) return closeShow();
  openEntry(threadId, nextTab(threadId, map, workers));
}

/** Opens this chat's pane where the header button would, and leaves an open one as it is. */
export function showPane(threadId: string) {
  if (!paneOpen(threadId)) openEntry(threadId, nextTab(threadId));
}

/** Where an open pane lands when it follows a chat switch: the new chat's own tab, else its tool list. `check`: the chat has a check its Check tab can open. */
const followTab = (threadId: string, map: boolean, check: boolean) => nextTab(threadId, map ? "idle" : undefined, "tab", check);

/** On desktop an open pane goes along to a chat it does not show yet: the tab it lands on there, so that chat draws it in the same render and it never shuts in between. */
export function hopTab(threadId: string, open: readonly (string | null | undefined)[], checking: string | null, map: boolean, check: boolean) {
  return open.some(Boolean) && ![...open, checking].includes(threadId) ? followTab(threadId, map, check) : undefined;
}

export function followPane(threadId: string, map: boolean, check: boolean) {
  const tab = followTab(threadId, map, check);
  openEntry(threadId, tab);
  return tab;
}

function openEntry(threadId: string, tab: PaneEntry | "tools") {
  if (tab === "tools") openTools(threadId);
  else if (tab === "workers") openWorkers(threadId);
  else if (tab === "map") openMap(threadId);
  else if (tab === "timeline") openTimeline(threadId);
  else if (tab === "media") openMedia(threadId);
  else if (tab === "check") showCheck(threadId);
  else openItem(tab);
}

/** Whether the header button would open this chat's pane on Media, or on the tool list a click from it. */
export function paneLeadsToMedia(threadId: string, map?: "idle" | "live", workers?: "listed" | "tab") {
  const tab = nextTab(threadId, map, workers);
  return tab === "media" || tab === "tools";
}

function nextTab(threadId: string, map?: "idle" | "live", workers?: "listed" | "tab", check = false): PaneEntry | "tools" {
  if (workers === "listed") return "workers";
  const usable = (entry: PaneEntry) => typeof entry !== "string" || entry === "media" || (entry === "workers" ? Boolean(workers) : entry === "check" ? check : Boolean(map));
  const tabs = paneTabs(threadId);
  const tab: PaneTab | undefined = picked.get(threadId) ?? picks()[threadId];
  return (tab && tabs.find((entry) => tabKey(entry) === tabKey(tab) && usable(entry))) ?? tabs.find(usable) ?? "tools";
}

function openTools(threadId: string) {
  if (tools === threadId) return;
  tools = threadId;
  leaveFile(threadId);
  media = null;
  checking = null;
  mapping = null;
  working = null;
  timeline = null;
  emit();
}

/** The thread whose pane has no tab open and shows the tool list. */
export function useToolsThread(): string | null {
  return useSyncExternalStore(subscribe, () => tools, () => null);
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
  addTab(threadId, "map");
  if (mapping === threadId) return;
  mapping = threadId;
  leaveFile(threadId);
  checking = null;
  media = null;
  working = null;
  timeline = null;
  tools = null;
  emit();
}

export function showMap(threadId: string) {
  pick(threadId, "map");
  openMap(threadId);
}

export function useMapThread(): string | null {
  return useSyncExternalStore(subscribe, () => mapping, () => null);
}

function openWorkers(threadId: string) {
  addTab(threadId, "workers");
  if (working === threadId) return;
  working = threadId;
  leaveFile(threadId);
  checking = null;
  media = null;
  mapping = null;
  timeline = null;
  tools = null;
  emit();
}

export function showWorkers(threadId: string) {
  pick(threadId, "workers");
  openWorkers(threadId);
}

/** The thread whose pane is on the Workers tab. */
export function useWorkersThread(): string | null {
  return useSyncExternalStore(subscribe, () => working, () => null);
}

function openTimeline(threadId: string) {
  addTab(threadId, "timeline");
  if (timeline === threadId) return;
  timeline = threadId;
  leaveFile(threadId);
  checking = null;
  media = null;
  mapping = null;
  working = null;
  tools = null;
  emit();
}

export function showTimeline(threadId: string) {
  pick(threadId, "timeline");
  openTimeline(threadId);
}

/** The thread whose pane is on the Timeline tab. */
export function useTimelineThread(): string | null {
  return useSyncExternalStore(subscribe, () => timeline, () => null);
}

export const showableLinks = (text: string) => localLinks(text).filter((path) => showKind(path));

/** Replies and current speakers whose pictures are already in the chat. */
export function picturedReplies(messages: readonly Message[]) {
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
    else if (message.kind === "screen" && (message.image || message.roomFiles?.length)) shown.add(message.from?.botId ?? "");
    else if (message.kind === "text") replies.push(message);
  }
  const tailPictures = shown;
  close();
  return { pictured, tailPictures };
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
  const onWorkers = useWorkersThread() !== null;
  const onTimeline = useTimelineThread() !== null;
  const state = useRef<AutoShow>({ seen: null });
  const was = useRef(shown);
  const probe = useRef<AbortController>(undefined);
  // A probe still out when the user picks another tab or file, or a newer file arrives, is stale.
  useEffect(() => () => probe.current?.abort(), [threadId, shown, free, onMedia, onMap, onWorkers, onTimeline]);
  useEffect(() => {
    const closed = Boolean(was.current && !shown && was.current.threadId === threadId);
    was.current = shown;
    if (!threadId) return;
    const step = autoShowStep(state.current, threadId, messages, closed);
    state.current = step.state;
    const item = step.item;
    // A file this PC can't serve would open a dead pane; its link still opens it in the browser.
    if (item && free && !onMedia && !onMap && !onWorkers && !onTimeline) {
      probe.current?.abort();
      const { signal } = probe.current = new AbortController();
      fetch(linkedFileSrc(item.threadId, item.path), { headers: { Range: "bytes=0-0" }, signal })
        .then((res) => { if (!signal.aborted && (res.ok || res.status === 416)) openItem(item); }, () => {});
    }
  }, [threadId, messages, shown, free, onMedia, onMap, onWorkers, onTimeline]);
}
