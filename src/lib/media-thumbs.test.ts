// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

type Asked = { src: string; signal?: AbortSignal };
const asked: Asked[] = [];
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
// "/stall/*" never answers, like a stalled remote socket; "/slow/*" sends 6 bytes, one every 4 s
function serve(src: string, init?: RequestInit) {
  asked.push({ src, signal: init?.signal ?? undefined });
  if (src.startsWith("/stall/")) return aborted(init?.signal ?? undefined);
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
  const Cell = ({ src }: { src: string }) => { shown[src] = useThumb(src); return null; };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(srcs.map((src) => createElement(Cell, { key: src, src }))));
  return { shown, unmount: () => root.unmount() };
}

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
