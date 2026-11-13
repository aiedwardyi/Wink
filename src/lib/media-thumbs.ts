// Small square previews for the Media grid, made in a worker once a session,
// so a long grid never holds full-size decodes and a scroll never waits on one.
import { useEffect, useState } from "react";

// cells top out near 160px, so this stays sharp at 2x
const SIZE = 320;
// about 8 MB of previews; the least recently drawn go first
const KEEP = 400;
const AT_ONCE = 3;
// a little past the start, where many clips are still black
const FRAME_AT = 0.5;
const FRAME_MS = 10_000;
const STILL_MS = 200;

let worker: Worker | undefined;
let broken = false;
let watching = false;
let moving: ReturnType<typeof setTimeout> | undefined;
let asked = 0;
const made = new Map<string, string>();
const failed = new Set<string>();
const clips = new Set<string>();
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

/** The frame a little past the start, read from metadata and a single seek, never the whole clip. */
function firstFrame(src: string): Promise<VideoFrame | ImageBitmap | null> {
  return new Promise((done) => {
    const video = document.createElement("video");
    const end = (frame: VideoFrame | ImageBitmap | null) => {
      clearTimeout(timer);
      video.onloadedmetadata = video.onseeked = video.onerror = null;
      video.removeAttribute("src");
      video.load();
      done(frame);
    };
    const timer = setTimeout(() => end(null), FRAME_MS);
    video.muted = true;
    video.preload = "metadata";
    video.onloadedmetadata = () => { video.currentTime = Math.min(FRAME_AT, video.duration / 2) || 0; };
    video.onseeked = () => {
      if (!video.videoWidth) return end(null);
      // a VideoFrame reaches the worker uncopied; copying the picture here drops a scroll frame on a slow machine
      if (!("VideoFrame" in globalThis)) return void createImageBitmap(video).then(end, () => end(null));
      try {
        end(new VideoFrame(video));
      } catch {
        end(null);
      }
    };
    video.onerror = () => end(null);
    video.src = src;
  });
}

async function shrink(src: string): Promise<Blob | null> {
  const frame = clips.has(src) ? await firstFrame(src) : undefined;
  if (frame === null) return null;
  return new Promise((reply) => {
    const id = ++asked;
    replies.set(id, reply);
    try {
      shrinker().postMessage({ id, src, size: SIZE, frame }, frame ? [frame] : []);
    } catch {
      broken = true;
      frame?.close();
      replies.delete(id);
      reply(null);
    }
  });
}

// a frame grab mid-scroll drops scroll frames on a slow machine, so clips wait for the scroll to rest
function watchScroll() {
  if (watching) return;
  watching = true;
  addEventListener("scroll", () => {
    clearTimeout(moving);
    moving = setTimeout(() => {
      moving = undefined;
      pump();
    }, STILL_MS);
  }, { capture: true, passive: true });
}

function pump() {
  for (let i = queue.length - 1; i >= 0 && busy.size < AT_ONCE; i--) {
    const src = queue[i];
    if (moving && clips.has(src)) continue;
    queue.splice(i, 1);
    if (!waiting.has(src) || busy.has(src) || made.has(src)) continue;
    busy.add(src);
    void shrink(src).then((blob) => {
      busy.delete(src);
      clips.delete(src);
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

/** The preview if one is made, the picture or clip itself where none can be. */
function ready(src: string): string | undefined {
  if (!makes() || failed.has(src)) return src;
  const url = made.get(src);
  if (url) {
    made.delete(src);
    made.set(src, url);
  }
  return url;
}

function want(src: string, clip: boolean, done: (url: string) => void): () => void {
  if (clip) {
    clips.add(src);
    watchScroll();
  }
  let set = waiting.get(src);
  if (!set) waiting.set(src, set = new Set());
  set.add(done);
  queue.push(src);
  pump();
  return () => {
    set.delete(done);
    if (!set.size && waiting.get(src) === set) {
      waiting.delete(src);
      clips.delete(src);
    }
  };
}

/** Undefined while the preview is being made; a clip's preview is its first frame. */
export function useThumb(src: string, clip = false): string | undefined {
  const [url, setUrl] = useState(() => ready(src));
  useEffect(() => url === undefined ? want(src, clip, setUrl) : undefined, [src, clip, url]);
  return url;
}
