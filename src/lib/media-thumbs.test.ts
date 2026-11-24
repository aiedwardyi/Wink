// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

type Asked = { src: string; signal?: AbortSignal };
const asked: Asked[] = [];
// an img request: open until it loads, fails or its src is cleared
const pics: Array<{ src: string; open: boolean }> = [];
const decoded: number[] = [];
let page: { onmessage: ((event: MessageEvent) => void) | null } | undefined;
// vite resolves the worker's URL against self.location
const scope: { location: Location; onmessage?: (event: MessageEvent) => void; postMessage: (data: unknown) => void } = {
  location,
  postMessage: (data) => page?.onmessage?.({ data } as MessageEvent),
};
// the page's worker runs the real worker script in this scope
class InlineWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { page = this; }
  postMessage(data: unknown) { scope.onmessage!({ data } as MessageEvent); }
  terminate() {}
}
const aborted = (signal: AbortSignal | undefined) => new Promise<never>((_, fail) => signal?.addEventListener("abort", () => fail(signal.reason)));
let cutAt = 0;
let freeAt = 0;
// when a request settles, in ms from now, and whether it answers; undefined never settles
// "/dead/*" never answers, "/cut/*" hangs until cutAt and then fails, "/busy/*" waits for a free connection until freeAt
// "/slowpic/*" sends its first bytes after 1 s and ends at 70 s, "/half/*" sends its first bytes and then nothing
function line(src: string): [number, boolean] | undefined {
  const now = Date.now();
  if (src.startsWith("/dead/") || src.startsWith("/half/")) return;
  if (src.startsWith("/slowpic/")) return [70_000, true];
  if (src.startsWith("/cut/")) return now < cutAt ? [cutAt - now, false] : [0, true];
  if (src.startsWith("/busy/")) return [Math.max(0, freeAt - now), true];
  return [0, true];
}
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  #pic?: { src: string; open: boolean };
  #sized = false;
  get naturalWidth() { return this.#sized ? 640 : 0; }
  set src(src: string) {
    const pic = { src, open: true };
    pics.push((this.#pic = pic));
    const at = line(src);
    const first = /^\/(slowpic|half)\//.test(src) ? 1_000 : at?.[1] ? at[0] : undefined;
    if (first !== undefined) setTimeout(() => void (this.#sized = pic.open), first);
    if (at) setTimeout(() => {
      if (!pic.open) return;
      pic.open = false;
      (at[1] ? this.onload : this.onerror)?.();
    }, at[0]);
  }
  removeAttribute(name: string) {
    if (name === "src" && this.#pic) this.#pic.open = false;
  }
}
const open = () => asked.filter((each) => !each.signal?.aborted).length + pics.filter((each) => each.open).length;
// "/stall/*" never answers the preview's fetch, like a stalled remote socket, but its img loads; "/slow/*" sends 6 bytes, one every 4 s
function serve(src: string, init?: RequestInit) {
  const signal = init?.signal ?? undefined;
  asked.push({ src, signal });
  if (/^\/(stall|dead|slowpic|half)\//.test(src)) return aborted(signal);
  if (src.startsWith("/404/")) return Promise.resolve(new Response(new ReadableStream({ start: (control) => void aborted(signal).catch((error) => control.error(error)) }), { status: 404 }));
  if (/^\/(cut|busy)\//.test(src)) {
    const at = line(src)!;
    return Promise.race([aborted(signal), new Promise<Response>((done, fail) => setTimeout(() => at[1] ? done(new Response(new Uint8Array(4), { headers: { "content-type": "image/png" } })) : fail(new TypeError("Failed to fetch")), at[0]))]);
  }
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    start: (control) => void aborted(init?.signal ?? undefined).catch((error) => control.error(error)),
    pull: (control) => new Promise<void>((done) => setTimeout(() => {
      if (sent++ < 6) control.enqueue(new Uint8Array([sent]));
      else control.close();
      done();
    }, 4_000)),
  });
  return Promise.resolve(new Response(body, { headers: { "content-type": "image/png" } }));
}

let useThumb: typeof import("./media-thumbs").useThumb;
beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("self", scope);
  vi.stubGlobal("fetch", serve);
  vi.stubGlobal("Worker", InlineWorker);
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("createImageBitmap", async (source: Blob | object) => {
    if (source instanceof Blob) decoded.push(source.size);
    return { width: 640, height: 480, close() {} };
  });
  vi.stubGlobal("OffscreenCanvas", class {
    getContext() { return { drawImage() {} }; }
    convertToBlob() { return Promise.resolve(new Blob(["thumb"])); }
  });
  await vi.importActual("./media-thumbs.worker");
  ({ useThumb } = await import("./media-thumbs"));
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function grid(srcs: string[]) {
  const shown: Record<string, string | undefined> = {};
  const drawn: Record<string, string> = {};
  // same shape as ShowMedia's MediaCell: its img asks for an address on its own and nothing ends it
  const Cell = ({ src }: { src: string }) => {
    const url = (shown[src] = useThumb(src));
    useEffect(() => {
      if (!url) return;
      if (url.startsWith("blob:")) return void (drawn[src] = "thumb");
      const img = new FakeImage();
      img.onload = () => void (drawn[src] = "full");
      img.onerror = () => void (drawn[src] = "broken");
      img.src = url;
    }, [src, url]);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(srcs.map((src) => createElement(Cell, { key: src, src }))));
  return { shown, drawn, unmount: () => act(() => root.unmount()) };
}
// a second at a time, so each cell's effect and img run as they would between frames
async function pass(ms: number) {
  for (let left = ms; left > 0; left -= 1_000) await act(() => vi.advanceTimersByTimeAsync(Math.min(1_000, left)));
}
const start = () => { asked.length = 0; pics.length = 0; };
const names = (dir: string, n: number) => Array.from({ length: n }, (_, i) => `/${dir}/${i + 1}.png`);

it("a preview fetch that goes silent is ended, frees its slot and the cell draws the picture itself", async () => {
  const srcs = ["/stall/1.png", "/stall/2.png", "/stall/3.png", "/stall/4.png", "/stall/5.png"];
  const { shown, unmount } = await grid(srcs);
  expect(asked).toHaveLength(3);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(asked).toHaveLength(5);
  expect(asked.every((each) => each.signal?.aborted)).toBe(true);
  expect(shown).toEqual(Object.fromEntries(srcs.map((src) => [src, src])));
  unmount();
});

it("a slow preview still sending past the bound keeps its thumbnail", async () => {
  asked.length = 0;
  const { shown, unmount } = await grid(["/slow/1.png"]);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(asked).toHaveLength(1);
  expect(decoded).toEqual([6]);
  expect(shown["/slow/1.png"]).toMatch(/^blob:/);
  unmount();
});

it("a picture whose own request stalls too holds at most 3 requests and none once the grid closes", async () => {
  start();
  const { shown, unmount } = await grid(names("dead", 12));
  let most = 0;
  for (let t = 0; t < 120; t++) {
    most = Math.max(most, open());
    await pass(1_000);
  }
  expect(most).toBe(3);
  expect(Object.values(shown).every((url) => url === undefined)).toBe(true);
  await unmount();
  await pass(10_000);
  expect(open()).toBe(0);
});

it("a stall that ends with the connections cut draws every square once the link is back", async () => {
  start();
  cutAt = Date.now() + 30_000;
  const { drawn, unmount } = await grid(names("cut", 12));
  await pass(120_000);
  expect(Object.keys(drawn)).toHaveLength(12);
  expect(Object.values(drawn).every((each) => each === "thumb" || each === "full")).toBe(true);
  await unmount();
});

it("a preview ended only by waiting for a connection makes its thumbnail on the next open", async () => {
  start();
  freeAt = Date.now() + 25_000;
  const srcs = names("busy", 6);
  const first = await grid(srcs);
  await pass(60_000);
  expect(Object.keys(first.drawn)).toHaveLength(6);
  await first.unmount();
  const next = await grid(srcs);
  await pass(1_000);
  expect(srcs.map((src) => next.drawn[src])).toEqual(srcs.map(() => "thumb"));
  await next.unmount();
});

it("a preview answered with an error ends its download and the cell draws the picture", async () => {
  start();
  const { shown, unmount } = await grid(["/404/1.png"]);
  await pass(100);
  expect(shown["/404/1.png"]).toBe("/404/1.png");
  expect(asked[0].signal?.aborted).toBe(true);
  await unmount();
});

it("a fallback picture still without bytes after the bound frees its slot for the rest", async () => {
  start();
  freeAt = 0;
  const fine = names("busy/free", 9);
  const dead = names("dead/first", 3);
  const { drawn, unmount } = await grid([...dead, ...fine]);
  await pass(15_000);
  expect(Object.keys(drawn)).toHaveLength(0);
  await pass(10_000);
  expect(fine.map((src) => drawn[src])).toEqual(fine.map(() => "thumb"));
  await unmount();
});

it("a fallback picture whose first bytes came runs past a minute and draws", async () => {
  start();
  const { shown, unmount } = await grid(["/slowpic/1.png"]);
  await pass(65_000);
  expect(shown["/slowpic/1.png"]).toBeUndefined();
  await pass(20_000);
  expect(shown["/slowpic/1.png"]).toBe("/slowpic/1.png");
  await unmount();
});

it("a fallback picture silent after its first bytes keeps its slot until the grid closes", async () => {
  start();
  const { unmount } = await grid([...names("half", 3), "/dead/behind.png"]);
  await pass(120_000);
  expect(pics.map((each) => [each.src, each.open])).toEqual(names("half", 3).map((src) => [src, true]));
  await unmount();
  expect(open()).toBe(0);
});

it("a dead picture is asked twice and then left alone", async () => {
  start();
  const srcs = names("dead/twice", 3);
  const { unmount } = await grid(srcs);
  await pass(300_000);
  expect(srcs.map((src) => pics.filter((each) => each.src === src).length)).toEqual([2, 2, 2]);
  expect(asked).toHaveLength(3);
  expect(open()).toBe(0);
  await unmount();
});

it("asks used up during an outage start over on the next open", async () => {
  start();
  cutAt = Date.now() + 200_000;
  const srcs = names("cut/again", 3);
  const first = await grid(srcs);
  await pass(60_000);
  expect(Object.keys(first.drawn)).toHaveLength(0);
  await first.unmount();
  await pass(150_000);
  const next = await grid(srcs);
  await pass(2_000);
  expect(srcs.map((src) => next.drawn[src])).toEqual(srcs.map(() => "thumb"));
  await next.unmount();
});
