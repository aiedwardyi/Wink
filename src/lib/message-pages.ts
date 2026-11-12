// Hydrate holds only the newest page of each conversation. Older pages come
// from the scrollback endpoint one at a time, when the reader reaches the top.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, MESSAGE_PAGE, type Action, type Message } from "@/state/store";
import { captureTranscriptAnchor, distanceFromTranscriptEdge, restoreTranscriptAnchor, restoreTranscriptScroll, type TranscriptAnchor } from "./bottom-follow";
import { TRANSCRIPT_WINDOW_SIZE, advanceWindow, shouldAdvanceWindow } from "./transcript-window";
import { groupActivityRuns } from "./activity-runs";
import { workerAnchors, type WorkerRun } from "./worker-runs";

// rows a window reading back keeps mounted; the rest below unmount until the reader scrolls down
const EARLIER_CAP = TRANSCRIPT_WINDOW_SIZE * 2;
// rows one earlier load mounts at least, so long bubbles still bring a real page
const EARLIER_ROWS = 40;

export function createEarlierWindow(messages: Message[], {
  terminal, renders, workers,
}: { terminal: boolean; renders: (message: Message) => boolean; workers: readonly { run: WorkerRun }[] }) {
  let built: { first: number; last: number }[] | undefined;
  const rows = () => {
    if (built) return built;
    const anchors = workerAnchors(workers, messages);
    const visible = (message: Message) => anchors.has(message.id)
      ? Boolean(anchors.get(message.id))
      : message.kind !== "launch" && renders(message);
    const indices = new Map(messages.map((message, index) => [message.id, index]));
    return built = groupActivityRuns(messages, terminal, visible).flatMap((item) => {
      const first = item.kind === "message" ? item.message : item.messages[0];
      const last = item.kind === "message" ? first : item.messages.at(-1)!;
      return visible(first) ? [{ first: indices.get(first.id)!, last: indices.get(last.id)! }] : [];
    });
  };
  const start = (before: number, viewport: HTMLElement | null): number => {
    let size = TRANSCRIPT_WINDOW_SIZE;
    if (viewport && viewport.clientHeight > 0) {
      const mounted = [...viewport.querySelectorAll("[data-mid], [data-run]")].filter((row) =>
        !row.parentElement?.closest("[data-mid], [data-run]") && row.lastElementChild && row.lastElementChild.getBoundingClientRect().height > 0);
      if (mounted.length) size = Math.max(EARLIER_ROWS, Math.ceil(2 * viewport.clientHeight * mounted.length / viewport.scrollHeight));
    }
    let counted = 0;
    const all = rows();
    for (let i = all.length - 1; i >= 0; i--) if (all[i].last < before && ++counted >= size) return all[i].first;
    return 0;
  };
  /** Where a window reading back from `from` stops mounting, or null while it holds no more than the cap. */
  const end = (from: number, viewport: HTMLElement | null): number | null => {
    const all = rows();
    const at = all.findIndex((row) => row.first >= from);
    const cut = at < 0 ? undefined : all[at + EARLIER_CAP];
    if (!cut || !viewport) return null;
    // never unmount a row the reader is about to scroll onto
    const id = messages[cut.first]?.id;
    const row = [...viewport.querySelectorAll("[data-mid], [data-run]")].find((el) => el.getAttribute("data-mid") === id || el.getAttribute("data-run")?.endsWith(`:${id}`));
    const box = row?.lastElementChild?.getBoundingClientRect();
    if (box && box.height > 0 && box.top < viewport.getBoundingClientRect().bottom + viewport.clientHeight) return null;
    return cut.first;
  };
  return { start, end };
}

export async function fetchOlderPage(threadId: string, before: string, pages = 1): Promise<{ messages: Message[]; hasMore: boolean }> {
  const page = await api(`/api/threads/${threadId}/messages?limit=${MESSAGE_PAGE}&before=${encodeURIComponent(before)}${pages > 1 ? `&pages=${pages}` : ""}`);
  return { messages: Array.isArray(page?.messages) ? page.messages : [], hasMore: page?.hasMore === true };
}

/** Pixels a paged screen message left out. */
export function screenImageUrl(threadId: string, messageId: string): string {
  return `/api/threads/${threadId}/messages/${messageId}/image`;
}

const lookups = new Map<string, Promise<Message | null>>();

function lookupMessage(threadId: string, messageId: string): Promise<Message | null> {
  const key = `${threadId}:${messageId}`;
  let lookup = lookups.get(key);
  if (!lookup) {
    lookup = api(`/api/threads/${threadId}/messages?around=${encodeURIComponent(messageId)}&limit=1`)
      .then((page) => (page?.messages as Message[] | undefined)?.find((message) => message.id === messageId) ?? null)
      .catch(() => {
        lookups.delete(key);
        return null;
      });
    lookups.set(key, lookup);
  }
  return lookup;
}

/** A pinned or quoted message, fetched alone when it is older than every loaded page. */
export function useThreadMessage(threadId: string, messageId: string | undefined, held: Message | undefined): Message | undefined {
  const [fetched, setFetched] = useState<Message | null>(null);
  const missing = Boolean(messageId && !held);
  useEffect(() => {
    if (!missing || !messageId) return;
    let alive = true;
    void lookupMessage(threadId, messageId).then((message) => {
      if (alive) setFetched(message);
    });
    return () => {
      alive = false;
    };
  }, [threadId, messageId, missing]);
  return held ?? (fetched && fetched.id === messageId ? fetched : undefined);
}

type JumpWindow = { key: string; targetId: string; messages: Message[]; hasMore: boolean; snapshot: number };

async function fetchAround(threadId: string, messageId: string, signal?: AbortSignal): Promise<{ rows: Message[]; hasMore: boolean }> {
  const page = await api(`/api/threads/${threadId}/messages?around=${encodeURIComponent(messageId)}&limit=${MESSAGE_PAGE}`, { signal });
  return { rows: Array.isArray(page?.messages) ? page.messages : [], hasMore: page?.hasMore === true };
}

/** The branch through `targetId` in a fetched window: its ancestors, then the
 * child on `active` at each fork, else the newest. */
function windowBranch(messages: Message[], targetId: string, active: Set<string>): Message[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const children = new Map<string, Message>();
  for (const message of messages) {
    if (message.parentId && !active.has(children.get(message.parentId)?.id ?? "")) children.set(message.parentId, message);
  }
  const seen = new Set<string>();
  const path: Message[] = [];
  for (let cur = byId.get(targetId); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    path.unshift(cur);
  }
  for (let cur = children.get(targetId); cur && !seen.has(cur.id); cur = children.get(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
  }
  return path;
}

export function jumpWindowMessages(rows: Message[], loaded: Message[], targetId: string, leafId: string | null | undefined): Message[] {
  if (!leafId) return rows;
  const byId = new Map([...rows, ...loaded].map((message) => [message.id, message]));
  const active = new Set<string>();
  for (let cur = byId.get(leafId); cur && !active.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) active.add(cur.id);
  return windowBranch(rows, targetId, active);
}

export function mergeForwardPage(messages: Message[], page: Message[], cursor: string): Message[] {
  const at = page.findIndex((message) => message.id === cursor);
  if (at < 0) return messages;
  const ids = new Set(messages.map((message) => message.id));
  const newer = page.slice(at + 1).filter((message) => {
    if (ids.has(message.id)) return false;
    ids.add(message.id);
    return true;
  });
  return newer.length ? [...messages, ...newer] : messages;
}

/** A bounded page around an old message, held apart from the live pages so a
 * jump never downloads the history in between. `key` scopes it to one view. */
export function useJumpWindow(
  dispatch: React.Dispatch<Action>,
  key: string,
  threadId: string,
  loaded: Message[],
  leafId: string | null | undefined,
  patches: Record<string, Message> | undefined,
  snapshot: number,
) {
  const [held, setHeld] = useState<JumpWindow | null>(null);
  // keyed: a lookup still hanging in one chat must not read as pending in the next
  const [pending, setPending] = useState<string | null>(null);
  const inflight = useRef(false);
  const latest = useRef(0);
  // own counter, so a snapshot refetch never strands a jump still in flight
  const refetched = useRef(0);
  const forwardInflight = useRef(new Map<string, number>());
  const [forwardFailed, setForwardFailed] = useState<string | null>(null);
  // leaving the view drops the window; coming back opens at the newest message
  if (held && held.key !== key) setHeld(null);
  const current = held?.key === key ? held : null;
  const committed = useRef({ current, key, loaded, leafId, snapshot });
  useLayoutEffect(() => { committed.current = { current, key, loaded, leafId, snapshot }; });
  const head = loaded[0]?.id;
  const messages = useMemo(() => {
    if (!current) return null;
    const rows = patches ? current.messages.map((message) => patches[message.id] ?? message) : current.messages;
    return jumpWindowMessages(rows, loaded, current.targetId, leafId);
  }, [current, patches, leafId, loaded]);
  const open = useCallback(
    (messageId: string) => {
      const generation = ++latest.current;
      setForwardFailed(null);
      setPending(key);
      fetchAround(threadId, messageId)
        .then(({ rows, hasMore }) => {
          if (generation !== latest.current) return;
          // reaches the loaded pages: join them instead of opening a detached window
          const joins = head ? rows.findIndex((message) => message.id === head) : -1;
          if (joins >= 0) dispatch({ type: "olderMessages", threadId, before: head!, messages: rows.slice(0, joins), hasMore });
          else setHeld({ key, targetId: messageId, messages: rows, hasMore, snapshot });
        })
        .catch(() => {})
        .finally(() => {
          if (generation === latest.current) setPending(null);
        });
    },
    [dispatch, key, threadId, head, snapshot],
  );
  // a snapshot clears the patches the window shows; refetch so the server's copy replaces the stale rows
  useEffect(() => {
    if (!current || current.snapshot === snapshot) return;
    const generation = ++refetched.current;
    fetchAround(threadId, current.targetId)
      .then(({ rows, hasMore }) => {
        if (generation !== refetched.current) return;
        setHeld((w) => (w && w.key === key && w.targetId === current.targetId ? { ...w, messages: rows, hasMore, snapshot } : w));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);
  const older = useCallback(
    (beforeCommit?: () => void, onFail?: () => void, pages = 1) => {
      const before = current?.messages[0]?.id;
      if (!current?.hasMore || !before || inflight.current) return;
      inflight.current = true;
      fetchOlderPage(threadId, before, pages)
        .then((page) => {
          inflight.current = false;
          beforeCommit?.();
          setHeld((w) => {
            if (!w || w.key !== key || w.messages[0]?.id !== before) return w;
            const ids = new Set(w.messages.map((message) => message.id));
            return { ...w, messages: [...page.messages.filter((message) => !ids.has(message.id)), ...w.messages], hasMore: page.hasMore };
          });
        })
        .catch(() => { inflight.current = false; onFail?.(); });
    },
    [current, key, threadId],
  );
  const cursor = messages?.at(-1)?.id;
  const forwardKey = current && cursor ? `${key}:${current.targetId}:${cursor}:${snapshot}` : null;
  const newer = useCallback(
    (beforeCommit: (rows: Message[]) => void) => {
      const generation = latest.current;
      if (!current || !cursor || !forwardKey || forwardInflight.current.get(key) === generation) return;
      forwardInflight.current.set(key, generation);
      setForwardFailed(null);
      const valid = () => {
        const now = committed.current;
        return generation === latest.current && now.key === key && now.current?.targetId === current.targetId && now.current?.snapshot === current.snapshot && now.snapshot === snapshot && now.loaded[0]?.id === head;
      };
      fetchAround(threadId, cursor, AbortSignal.timeout(10_000))
        .then(({ rows }) => {
          if (!valid()) return;
          const held = committed.current.current!;
          const { loaded, leafId } = committed.current;
          const next = mergeForwardPage(held.messages, rows, cursor);
          const joins = head ? next.findIndex((message) => message.id === head) : -1;
          const visible = jumpWindowMessages(next, loaded, held.targetId, leafId);
          if (joins < 0 && visible.at(-1)?.id === cursor) {
            setForwardFailed(forwardKey);
            return;
          }
          const joined = joins >= 0 ? [...next.slice(0, joins), ...loaded] : next;
          beforeCommit(jumpWindowMessages(joined, loaded, held.targetId, leafId));
          if (joins >= 0) {
            dispatch({ type: "olderMessages", threadId, before: head!, messages: next.slice(0, joins), hasMore: held.hasMore });
            setHeld(null);
          } else setHeld({ ...held, messages: next });
        })
        .catch(() => { if (valid()) setForwardFailed(forwardKey); })
        .finally(() => { if (forwardInflight.current.get(key) === generation) forwardInflight.current.delete(key); });
    },
    [current, cursor, dispatch, forwardKey, head, key, snapshot, threadId],
  );
  const close = useCallback(() => {
    latest.current++;
    setPending(null);
    setHeld(null);
    setForwardFailed(null);
  }, []);
  return { messages, hasMore: Boolean(current?.hasMore), pending: pending === key, forwardFailed: forwardFailed === forwardKey && forwardKey !== null, open, older, newer, close };
}

export function useForwardWindow<W extends { key: string; start: number; end: number | null; expanded?: boolean }>({
  key, window, shown, startIndex, endIndex, jump, scrollRef, previousScrollTop, setWindow, pauseFollow, renders,
}: {
  key: string;
  window: W;
  shown: Message[];
  startIndex: number;
  endIndex: number;
  jump: Pick<ReturnType<typeof useJumpWindow>, "messages" | "forwardFailed" | "newer">;
  scrollRef: React.RefObject<HTMLElement | null>;
  previousScrollTop: React.RefObject<number>;
  setWindow: React.Dispatch<React.SetStateAction<W>>;
  pauseFollow: () => void;
  renders: (rows: Message[], index: number) => boolean;
}) {
  const anchor = useRef<{ key: string; row: TranscriptAnchor | null } | null>(null);
  const changing = useRef(false);
  const committed = useRef({ window, endIndex });
  useLayoutEffect(() => { committed.current = { window, endIndex }; });
  useLayoutEffect(() => {
    changing.current = false;
    const el = scrollRef.current;
    if (el && anchor.current?.key === key) {
      if (anchor.current.row) restoreTranscriptAnchor(el, anchor.current.row);
      previousScrollTop.current = el.scrollTop;
    }
    anchor.current = null;
  }, [key, shown, startIndex, endIndex, scrollRef, previousScrollTop]);
  return (movingDown: boolean, retry = false) => {
    const el = scrollRef.current;
    if (!el || (!jump.messages && endIndex >= shown.length) || changing.current) return;
    if (!retry && (jump.forwardFailed || !shouldAdvanceWindow(movingDown, distanceFromTranscriptEdge(el), el.clientHeight))) return;
    const commit = (rows: Message[]) => {
      const now = committed.current;
      if (now.window !== window) {
        // A null end would mount the new page even though this advance was discarded.
        if (now.window.key === key && now.window.end === null) setWindow((current) => current === now.window ? { ...current, end: now.endIndex } : current);
        return;
      }
      changing.current = true;
      pauseFollow();
      anchor.current = { key, row: captureTranscriptAnchor(el) };
      const next = advanceWindow(startIndex, endIndex, rows.length, undefined, (index) => renders(rows, index));
      setWindow((current) => current === window ? { ...current, ...next, expanded: false } : current);
    };
    if (endIndex < shown.length) commit(shown);
    else jump.newer(commit);
  };
}

export function useEarlierPage({
  key, shown, startIndex, hasMore, scrollRef, previousScrollTop, expand, settle,
}: {
  key: string;
  shown: Message[];
  startIndex: number;
  hasMore: boolean;
  scrollRef: React.RefObject<HTMLElement | null>;
  previousScrollTop: React.RefObject<number>;
  expand: (onFail: () => void, beforeCommit: () => boolean, pages: number) => void;
  /** After the last batch of a load lands and the reader's place is restored. */
  settle: () => void;
}) {
  const pending = useRef<{ key: string; landed: boolean; height: number; screen: number; added: number; anchor: TranscriptAnchor | null; top: number } | null>(null);
  const latest = useRef({ expand, settle });
  useLayoutEffect(() => { latest.current = { expand, settle }; });
  const fail = () => { if (pending.current?.key === key) pending.current = null; };
  const measure = () => {
    const page = pending.current;
    const el = scrollRef.current;
    if (!page || !el || page.key !== key) return false;
    // Fresh per batch: the reader may have scrolled since the last one landed.
    page.anchor = captureTranscriptAnchor(el);
    page.height = el.scrollHeight;
    page.top = el.scrollTop;
    page.landed = true;
    return page.anchor !== null;
  };
  useLayoutEffect(() => {
    const page = pending.current;
    const el = scrollRef.current;
    if (!page || !el) return;
    if (page.key !== key) { pending.current = null; return; }
    // A live message changes `shown` too; only the commit measure() armed is the batch.
    if (!page.landed) return;
    page.landed = false;
    // A fold's id comes from its first message, so growing it upward retires the anchor.
    const anchored = page.anchor !== null && restoreTranscriptAnchor(el, page.anchor);
    if (page.anchor && !anchored) restoreTranscriptScroll(el, { scrollHeight: page.height, scrollTop: page.top });
    previousScrollTop.current = el.scrollTop;
    page.added += anchored ? el.scrollTop - page.top : el.scrollHeight - page.height;
    if (!hasMore || page.added >= page.screen) { fail(); latest.current.settle(); return; }
    // Stored pages can fold to nothing; keep going until a screen actually lands.
    latest.current.expand(fail, measure, 5);
  }, [key, shown, startIndex, hasMore, scrollRef, previousScrollTop]);
  const show = () => {
    if (pending.current?.key === key) return;
    const el = scrollRef.current;
    pending.current = el && el.clientHeight > 0
      ? { key, landed: false, height: el.scrollHeight, screen: el.clientHeight, added: 0, anchor: null, top: el.scrollTop }
      : null;
    expand(fail, measure, pending.current ? 5 : 1);
  };
  // Jump to latest or a send returns to the live tail; a page still loading must not reopen scrollback.
  return [show, () => { pending.current = null; }] as const;
}

/** Loads the page before `oldestId`, one request at a time; a call while one loads joins it.
 * `beforeCommit` runs just before the page lands, so a caller can measure the old layout. */
export function useOlderMessages(
  dispatch: React.Dispatch<Action>,
  threadId: string,
  oldestId: string | undefined,
  hasMore: boolean | undefined,
) {
  // A pending page must not block a new thread or cursor.
  const inflight = useRef(new Map<string, { measures: (() => void)[]; fails: (() => void)[] }>());
  const current = useRef({ threadId, oldestId });
  useLayoutEffect(() => {
    current.current = { threadId, oldestId };
  }, [threadId, oldestId]);
  return useCallback(
    (beforeCommit?: () => void, onFail?: () => void, pages = 1) => {
      if (!hasMore || !oldestId) return;
      const key = `${threadId}:${oldestId}`;
      const joined = inflight.current.get(key);
      const waiting = joined ?? { measures: [], fails: [] };
      if (beforeCommit) waiting.measures.push(beforeCommit);
      if (onFail) waiting.fails.push(onFail);
      if (joined) return;
      inflight.current.set(key, waiting);
      fetchOlderPage(threadId, oldestId, pages)
        .then((page) => {
          inflight.current.delete(key);
          const visible = current.current.threadId === threadId;
          if (visible && current.current.oldestId !== oldestId) {
            for (const fail of waiting.fails) fail();
            return;
          }
          if (visible) for (const measure of waiting.measures) measure();
          dispatch({ type: "olderMessages", threadId, before: oldestId, ...page });
        })
        .catch(() => {
          inflight.current.delete(key);
          for (const fail of waiting.fails) fail();
        });
    },
    [dispatch, threadId, oldestId, hasMore],
  );
}
