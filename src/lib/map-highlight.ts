import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { MapDiff, MapDiffLine } from "../../shared/map-pane";
import { LIGHT_SKIN_IDS, useSkin } from "./skins";

export type MapToken = { content: string; color?: string };
type Reply = { id: number; from?: number; tokens?: MapToken[][]; done?: boolean };
export type MapTokens = { file: string; path: string; theme: string; diff?: MapDiff; key: string; order: MapDiffLine[]; lines: Map<MapDiffLine, MapToken[]>; text: Map<string, MapToken[]>; watchers: Map<MapDiffLine, Set<() => void>> };

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

function tokensFor(path: string, theme: string, diff: MapDiff | undefined, last?: MapTokens): MapTokens {
  const file = path && `${path}\0${theme}`;
  const order = file && diff && !diff.binary && !tooBig(diff) ? diff.lines.filter(line => line.kind !== "fold") : [];
  const key = order.length ? keyOf(file, order) : "";
  const lines = new Map<MapDiffLine, MapToken[]>();
  done.get(key)?.forEach((tokens, i) => lines.set(order[i], tokens));
  // Until a line's own tokens land, the same text keeps its last colors, so a live edit doesn't flash plain.
  const text = new Map<string, MapToken[]>();
  if (last?.file === file && !lines.size) {
    const seen = new Map([...last.text, ...[...last.lines].map(([line, tokens]) => [line.text, tokens] as const)]);
    for (const line of order) { const tokens = seen.get(line.text); if (tokens) text.set(line.text, tokens); }
  }
  return { file, path, theme, diff, key, order, lines, text, watchers: new Map() };
}

export function useMapTokens(path: string | null | undefined, diff: MapDiff | undefined): MapTokens {
  const theme = LIGHT_SKIN_IDS.has(useSkin()) ? "light-plus" : "dark-plus";
  const [tokens, setTokens] = useState(() => tokensFor(path ?? "", theme, diff));
  if (tokens.path !== (path ?? "") || tokens.theme !== theme || tokens.diff !== diff) setTokens(tokensFor(path ?? "", theme, diff, tokens));

  useEffect(() => {
    const { key, order } = tokens;
    const thread = key && !done.has(key) ? highlighter() : undefined;
    if (!thread) return;
    const id = ++asked;
    const got: MapToken[][] = [];
    replies.set(id, ({ from = 0, tokens: slice, done: whole }) => {
      if (!slice) {
        replies.delete(id);
        if (!whole) return;
        if (done.size >= CACHE_MAX) done.delete(done.keys().next().value!);
        return void done.set(key, got);
      }
      got.push(...slice);
      slice.forEach((line, i) => {
        tokens.lines.set(order[from + i], line);
        tokens.watchers.get(order[from + i])?.forEach(change => change());
      });
    });
    thread.postMessage({ id, path: tokens.path, theme: tokens.theme, code: order.map(line => line.text), removed: order.map(line => line.kind === "remove") });
    return () => { if (replies.delete(id)) worker?.postMessage({ id, stop: true }); };
  }, [tokens]);
  return tokens;
}

// Each row watches its own line, so a landing slice redraws those rows and never the whole file.
export function useLineTokens(tokens: MapTokens, line: MapDiffLine) {
  const watch = useCallback((change: () => void) => {
    const set = tokens.watchers.get(line) ?? new Set<() => void>();
    tokens.watchers.set(line, set.add(change));
    return () => { set.delete(change); };
  }, [tokens, line]);
  return useSyncExternalStore(watch, () => tokens.lines.get(line) ?? tokens.text.get(line.text));
}
