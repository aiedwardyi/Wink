// Rooms this PC joined elsewhere. Each "joined" frame names the room that changed.
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { fetchResponse, responseBody } from "./api-request";
import { openLiveEvents } from "./live-events";
import type { JoinedEntry, JoinedView } from "./team-rooms";

export type JoinedRoomDetail = JoinedView & { entries: JoinedEntry[]; hasMore?: boolean; noticeEntry?: JoinedEntry };

type Listener = (roomId: string | null) => void;

const listeners = new Set<Listener>();
let stopLive: (() => void) | null = null;

function follow(listener: Listener): () => void {
  listeners.add(listener);
  stopLive ??= openLiveEvents({
    screens: false,
    onFrame: (frame) => {
      if (frame.kind !== "joined") return;
      const roomId = (frame as { roomId?: unknown }).roomId;
      for (const each of [...listeners]) each(typeof roomId === "string" ? roomId : null);
    },
    onSnapshotRequired: async () => {
      for (const each of [...listeners]) each(null);
      return true;
    },
  });
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    stopLive?.();
    stopLive = null;
  };
}

async function read(path: string): Promise<{ status: number; body: any }> {
  const res = await fetchResponse(path);
  return { status: res.status, body: await responseBody(res) };
}

const NONE: JoinedView[] = [];
let rooms: JoinedView[] = NONE;
const watchers = new Set<() => void>();
let loads = 0;

function publish(next: JoinedView[]) {
  rooms = next;
  for (const watcher of [...watchers]) watcher();
}

async function loadRooms() {
  const load = ++loads;
  try {
    const { status, body } = await read("/api/joined/rooms");
    if (load === loads && status === 200 && Array.isArray(body?.rooms)) publish(body.rooms);
  } catch {
    // the next frame or reconnect reloads
  }
}

/** The room a join just returned, ahead of its first frame. */
export function noteJoinedRoom(room: JoinedView) {
  publish([...rooms.filter((each) => each.roomId !== room.roomId), room]);
}

export function forgetJoinedRoom(roomId: string) {
  ++loads;
  publish(rooms.filter((each) => each.roomId !== roomId));
}

const watch = (watcher: () => void) => {
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
};

export function useJoinedRooms(): JoinedView[] {
  useEffect(() => {
    void loadRooms();
    return follow(() => void loadRooms());
  }, []);
  return useLoadedJoinedRooms();
}

/** The list as last loaded; never starts a load. */
export function useLoadedJoinedRooms(): JoinedView[] {
  return useSyncExternalStore(watch, () => rooms);
}

/** undefined while loading, null once this PC no longer holds the room. `beforeOlder` runs just before a page of older rows lands. */
export function useJoinedRoom(roomId: string, limit = 200, beforeOlder?: RefObject<(() => void) | null>): JoinedRoomDetail | null | undefined {
  const [room, setRoom] = useState<{ roomId: string; detail: JoinedRoomDetail | null }>();
  const oldest = useRef<{ roomId: string; seq?: number }>(undefined);
  useEffect(() => {
    let alive = true;
    let loadsHere = 0;
    const load = async () => {
      const load = ++loadsHere;
      try {
        const { status, body } = await read(`/api/joined/rooms/${roomId}?limit=${limit}`);
        if (!alive || load !== loadsHere) return;
        if (status === 200 && body?.room) {
          const seq: number | undefined = body.room.entries?.[0]?.seq;
          if (oldest.current?.roomId === roomId && seq !== undefined && seq < (oldest.current.seq ?? 0)) beforeOlder?.current?.();
          oldest.current = { roomId, seq };
          setRoom({ roomId, detail: body.room });
        } else if (status === 404) setRoom({ roomId, detail: null });
      } catch {
        // keep what is on screen; the next frame reloads
      }
    };
    void load();
    const stop = follow((changed) => {
      if (changed === null || changed === roomId) void load();
    });
    return () => {
      alive = false;
      stop();
    };
  }, [roomId, limit, beforeOlder]);
  return room?.roomId === roomId ? room.detail : undefined;
}
