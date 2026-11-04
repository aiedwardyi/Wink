import { snapshotCoversHello } from "@/lib/live-events";

/** Peripherals that may ride the first chat snapshot. Engine describe
 * (`instances`) walks PATH and CLI `--version`; keep it off composer paint. */
export const FIRST_CHAT_PERIPHERAL_KEYS = ["config", "routines"] as const;
export const DEFERRED_INSTANCE_IDLE_MS = 800;

export function canPrefetchChat(location: Pick<Location, "protocol" | "hostname">): boolean {
  return location.protocol === "http:" || location.protocol === "https:";
}

export function createChatSnapshotLoad<T extends { cursor?: string }>(fetchSnapshot: () => Promise<T>, alive: () => boolean) {
  let prefetched: Promise<T | null> | null = null;
  return {
    prefetch() {
      prefetched ??= fetchSnapshot().catch(() => null);
    },
    async load(boundary: () => string | undefined): Promise<T | null> {
      let pending = prefetched;
      prefetched = null;
      while (alive()) {
        const before = boundary();
        const fresh = !pending;
        const snapshot = await (pending ?? fetchSnapshot());
        pending = null;
        if (!alive()) return null;
        const current = boundary();
        if (snapshot && (current === undefined || snapshotCoversHello(snapshot.cursor, current)
          || (fresh && before === current && snapshot.cursor === undefined))) return snapshot;
        if (fresh && before === current) throw new Error("Chat snapshot is older than the live stream");
      }
      return null;
    },
  };
}

const SNAPSHOT_FRAME_KINDS = new Set(["bot", "group", "thread", "message", "message.patch", "bot.deleted", "group.deleted", "bots.order", "groups.order", "queue.cancelled", "task.packet", "task.resume"]);

export function chatFrameAfterSnapshot(frame: { kind: string; seq?: number }, cursor?: string): boolean {
  if (!cursor || !Number.isSafeInteger(frame.seq) || !SNAPSHOT_FRAME_KINDS.has(frame.kind)) return true;
  // Pending chat frames share the hello generation and may already be in the snapshot.
  return !snapshotCoversHello(cursor, `${cursor.slice(0, cursor.lastIndexOf(":"))}:${frame.seq}`);
}

export function isFirstChatPeripheral(key: string): boolean {
  return (FIRST_CHAT_PERIPHERAL_KEYS as readonly string[]).includes(key);
}

export function firstChatPeripherals<T extends { key: string }>(parts: readonly T[]): T[] {
  return parts.filter((part) => isFirstChatPeripheral(part.key));
}

export type IdleScheduleHost = {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
};

export function scheduleDeferredInstancesLoad(
  wake: () => void,
  host: IdleScheduleHost = globalThis as unknown as IdleScheduleHost,
): () => void {
  const requestIdle = host.requestIdleCallback;
  if (requestIdle) {
    const id = requestIdle(wake, { timeout: DEFERRED_INSTANCE_IDLE_MS });
    return () => host.cancelIdleCallback?.(id);
  }
  const timer = (host.setTimeout ?? setTimeout)(wake, DEFERRED_INSTANCE_IDLE_MS);
  return () => (host.clearTimeout ?? clearTimeout)(timer as ReturnType<typeof setTimeout>);
}
