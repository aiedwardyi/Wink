// Small square previews for the Media grid, made in a worker once a session,
// so a long grid never holds full-size decodes and a scroll never waits on one.
import { useEffect, useState } from "react";

// cells top out near 160px, so this stays sharp at 2x
const SIZE = 320;
// about 8 MB of previews; the least recently drawn go first
const KEEP = 400;
const AT_ONCE = 3;

let worker: Worker | undefined;
let broken = false;
let asked = 0;
const made = new Map<string, string>();
const failed = new Set<string>();
const busy = new Set<string>();
// newest wish last, so the cells a fast scroll just reached go first
const queue: string[] = [];
const waiting = new Map<string, Set<(url: string) => void>>();
const replies = new Map<number, (blob: Blob | null) => void>();

const makes = () => !broken && "Worker" in globalThis && "OffscreenCanvas" in globalThis;

function shrinker(): Worker {
  if (worker) return worker;
  const started = new Worker(new URL("./media-thumbs.worker.ts", import.meta.url), { type: "module" });
  started.onmessage = ({ data }: MessageEvent<{ id: number; blob: Blob | null }>) => {
    replies.get(data.id)?.(data.blob);
    replies.delete(data.id);
  };
  started.onerror = () => {
    broken = true;
    started.terminate();
    worker = undefined;
    for (const reply of replies.values()) reply(null);
    replies.clear();
  };
  return (worker = started);
}

function shrink(src: string): Promise<Blob | null> {
  return new Promise((reply) => {
    const id = ++asked;
    replies.set(id, reply);
    try {
      shrinker().postMessage({ id, src, size: SIZE });
    } catch {
      broken = true;
      replies.delete(id);
      reply(null);
    }
  });
}

function pump() {
  while (busy.size < AT_ONCE && queue.length) {
    const src = queue.pop()!;
    if (!waiting.has(src) || busy.has(src) || made.has(src)) continue;
    busy.add(src);
    void shrink(src).then((blob) => {
      busy.delete(src);
      let url = src;
      if (blob) {
        url = URL.createObjectURL(blob);
        made.set(src, url);
        if (made.size > KEEP) {
          const [old, oldUrl] = made.entries().next().value!;
          made.delete(old);
          URL.revokeObjectURL(oldUrl);
        }
      } else failed.add(src);
      const done = waiting.get(src);
      waiting.delete(src);
      done?.forEach((each) => each(url));
      pump();
    });
  }
}

/** The preview if one is made, the picture itself where none can be. */
function ready(src: string): string | undefined {
  if (!makes() || failed.has(src)) return src;
  const url = made.get(src);
  if (url) {
    made.delete(src);
    made.set(src, url);
  }
  return url;
}

function want(src: string, done: (url: string) => void): () => void {
  let set = waiting.get(src);
  if (!set) waiting.set(src, set = new Set());
  set.add(done);
  queue.push(src);
  pump();
  return () => {
    set.delete(done);
    if (!set.size && waiting.get(src) === set) waiting.delete(src);
  };
}

/** Undefined while the preview is being made. */
export function useThumb(src: string): string | undefined {
  const [url, setUrl] = useState(() => ready(src));
  useEffect(() => url === undefined ? want(src, setUrl) : undefined, [src, url]);
  return url;
}
