// Boot reads of threads the store has not loaded, from their newest rows, so opening the app parses no whole transcript.
import { offscreenLimit } from "./chat-tail.ts";
import { readThreadTail } from "./message-db.ts";
import { endsNoteWindow, hasLocalUndeliveredPaneNote } from "./pane-wake.ts";
import type { Message, Store } from "./store.ts";

const PANE_TAIL = 1000;

/** The newest `count` rows, chained as Store.thread() chains legacy rows; the oldest stays unchained unless all rows came back. */
function chainedTail(threadId: string, count: number) {
  const tail = readThreadTail(threadId, count);
  let previous: string | null | undefined = tail.messages.length < count ? null : undefined;
  for (const message of tail.messages) {
    if (message.parentId === undefined && previous !== undefined) message.parentId = previous;
    previous = message.id;
  }
  return tail;
}

/** The rows messagePage would send, or null when the store must answer (loaded, or no rows here so a legacy file imports). */
export function chatListPage(
  store: Pick<Store, "loaded">,
  threadId: string,
  limit: number,
  offscreen?: { unread?: boolean; readAt?: number },
): { messages: Message[]; hasMore: boolean } | null {
  if (store.loaded(threadId)) return null;
  // one row past the page: offscreenLimit compares the first page row's parent with it
  const { messages, options, activeLeafId } = chainedTail(threadId, limit + 1);
  if (!messages.length) return null;
  const rows = offscreen ? offscreenLimit(messages, limit, offscreen, activeLeafId || messages.at(-1)!.id, options) : limit;
  const start = Math.max(0, messages.length - rows);
  return { messages: messages.slice(start), hasMore: start > 0 };
}

/** hasLocalUndeliveredPaneNote on the stored active path, loading the thread only when its newest rows cannot decide. */
export function paneNoteWaitingAtBoot(
  store: Pick<Store, "loaded" | "activePath">,
  threadId: string,
  deliveredId: string | undefined,
  deviceId: string,
  skippedId?: string,
): boolean {
  const scan = (messages: Message[]) => hasLocalUndeliveredPaneNote(messages, deliveredId, deviceId, skippedId);
  if (store.loaded(threadId)) return scan(store.activePath(threadId));
  const { messages, activeLeafId } = chainedTail(threadId, PANE_TAIL);
  // the newest rows are the path's end only when the head is the last row and they chain unbroken
  const straight = messages.length > 0 && (!activeLeafId || activeLeafId === messages.at(-1)!.id) && messages.every((row, i) => !i || row.parentId === messages[i - 1]!.id);
  if (straight) {
    const found = scan(messages);
    if (found || messages.length < PANE_TAIL || messages.some((row) => row.id === deliveredId || row.id === skippedId || endsNoteWindow(row))) return found;
  }
  return scan(store.activePath(threadId));
}

/** Loads the chats' transcripts after the first paint, one per task and the open chat first, so a switch or send rarely waits on a load. */
export function warmChats(
  store: Pick<Store, "loaded" | "messagesFor">,
  chats: () => ReadonlyArray<{ id: string; threadId: string }>,
  afterPaint: (start: () => Promise<void>) => void,
): (open: string) => void {
  let first: string | undefined;
  const failed = new Set<string>();
  const next = () => {
    const cold = chats().filter((chat) => !store.loaded(chat.threadId) && !failed.has(chat.threadId));
    return cold.find((chat) => chat.id === first) ?? cold[0];
  };
  const warm = async () => {
    for (let chat = next(); chat; chat = next()) {
      await new Promise((resolve) => setImmediate(resolve));
      try {
        if (!store.loaded(chat.threadId)) store.messagesFor(chat.threadId);
      } catch (error) {
        // a failed thread stays cold, and loads (or fails) on its own request
        failed.add(chat.threadId);
        console.error("warm chats failed", chat.threadId, error);
      }
    }
  };
  // not awaited: the warm stays out of the startup line's checks time
  afterPaint(async () => void warm());
  return (open) => { first ??= open; };
}
