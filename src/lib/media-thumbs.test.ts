// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const asked: string[] = [];
// a worker whose preview fetch never answers
class StalledWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(data: { src: string }) { asked.push(data.src); }
  terminate() {}
}

it("a preview that never answers frees its slot and the cell draws the picture itself", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("Worker", StalledWorker);
  vi.stubGlobal("OffscreenCanvas", class {});
  const { useThumb } = await import("./media-thumbs");
  const shown: Record<string, string | undefined> = {};
  const Cell = ({ src }: { src: string }) => { shown[src] = useThumb(src); return null; };
  const root = createRoot(document.createElement("div"));
  const srcs = ["/p/1.png", "/p/2.png", "/p/3.png", "/p/4.png", "/p/5.png"];
  await act(async () => root.render(srcs.map((src) => createElement(Cell, { key: src, src }))));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(asked).toHaveLength(5);
  expect(shown).toEqual(Object.fromEntries(srcs.map((src) => [src, src])));
  root.unmount();
  vi.useRealTimers();
});
