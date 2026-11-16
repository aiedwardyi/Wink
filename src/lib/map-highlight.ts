import { useCallback, useEffect, useMemo, useState } from "react";
import type { MapDiff, MapDiffLine } from "../../shared/map-pane";
import { LIGHT_SKIN_IDS, useSkin } from "./skins";

export type MapToken = { content: string; color?: string };
type Lines = Map<MapDiffLine, MapToken[]>;
type Reply = { id: number; from?: number; tokens?: MapToken[][]; done?: boolean };

const MAX_LINES = 10_000;
const MAX_CHARS = 1_000_000;
const CACHE_MAX = 40;
const done = new Map<string, MapToken[][]>();
const replies = new Map<number, (reply: Reply) => void>();
let worker: Worker | undefined;
let broken = false;
let asked = 0;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
};

const rows = (diff: MapDiff) => diff.lines.filter(line => line.kind !== "fold");
const keyOf = (file: string, lines: MapDiffLine[]) => `${file}\0${hash(lines.map(line => (line.kind === "remove" ? "-" : " ") + line.text).join("\n"))}`;
const tooBig = (diff: MapDiff) => diff.lines.length > MAX_LINES || diff.lines.reduce((sum, line) => sum + line.text.length, 0) > MAX_CHARS;

function highlighter(): Worker | undefined {
  if (broken || !("Worker" in globalThis)) return;
  if (worker) return worker;
  const started = new Worker(new URL("./map-highlight.worker.ts", import.meta.url), { type: "module" });
  started.onmessage = ({ data }: MessageEvent<Reply>) => replies.get(data.id)?.(data);
  started.onerror = () => {
    broken = true;
    started.terminate();
    worker = undefined;
    for (const [id, reply] of replies) reply({ id, done: false });
  };
  return (worker = started);
}

function cachedLines(file: string, diff: MapDiff | undefined) {
  const lines: Lines = new Map();
  if (!diff || diff.binary || tooBig(diff)) return lines;
  const order = rows(diff);
  done.get(keyOf(file, order))?.forEach((tokens, i) => lines.set(order[i], tokens));
  return lines;
}

export function useMapTokens(path: string | null | undefined, diff: MapDiff | undefined) {
  const theme = LIGHT_SKIN_IDS.has(useSkin()) ? "light-plus" : "dark-plus";
  const file = path ? `${path}\0${theme}` : "";
  const cached = useMemo(() => cachedLines(file, diff), [file, diff]);
  const [live, setLive] = useState<{ file: string; diff?: MapDiff; lines: Lines; text: Map<string, MapToken[]> }>({ file: "", lines: new Map(), text: new Map() });

  useEffect(() => {
    if (!path || !diff || diff.binary || tooBig(diff)) return;
    const order = rows(diff);
    const key = keyOf(file, order);
    const thread = order.length && !done.has(key) ? highlighter() : undefined;
    if (!thread) return;
    // Only this revision's texts carry over, so the fallback never outgrows the file on screen.
    setLive(last => {
      const seen = last.file === file ? new Map([...last.text, ...[...last.lines].map(([line, tokens]) => [line.text, tokens] as const)]) : new Map<string, MapToken[]>();
      const text = new Map<string, MapToken[]>();
      for (const line of order) { const tokens = seen.get(line.text); if (tokens) text.set(line.text, tokens); }
      return { file, diff, lines: new Map(), text };
    });
    const id = ++asked;
    const got: MapToken[][] = [];
    replies.set(id, ({ from = 0, tokens, done: whole }) => {
      if (!tokens) {
        replies.delete(id);
        if (!whole) return;
        if (done.size >= CACHE_MAX) done.delete(done.keys().next().value!);
        return void done.set(key, got);
      }
      got.push(...tokens);
      setLive(last => {
        if (last.diff !== diff) return last;
        const lines = new Map(last.lines);
        tokens.forEach((line, i) => lines.set(order[from + i], line));
        return { ...last, lines };
      });
    });
    thread.postMessage({ id, path, theme, code: order.map(line => line.text), removed: order.map(line => line.kind === "remove") });
    return () => { if (replies.delete(id)) worker?.postMessage({ id, stop: true }); };
  }, [path, diff, file, theme]);

  // Until a line's own tokens land, the same text keeps its last colors, so a live edit doesn't flash plain.
  return useCallback((line: MapDiffLine) => cached.get(line) ?? (live.file === file ? (live.diff === diff ? live.lines.get(line) : undefined) ?? live.text.get(line.text) : undefined), [cached, live, file, diff]);
}
