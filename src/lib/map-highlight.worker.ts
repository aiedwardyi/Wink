import type { BundledLanguage, GrammarState } from "shiki";
import type { MapToken } from "./map-highlight";

// enough rows per reply that the page paints a slice in one short task
const SLICE_LINES = 150;
const BATCH = 40;
const stopped = new Set<number>();
const pause = () => new Promise<void>(resolve => setTimeout(resolve));

function extension(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : name;
}

export async function tokenize(path: string, theme: string, code: string[], removed: boolean[], send: (from: number, tokens: MapToken[][]) => void, alive = () => true) {
  const shiki = await import("shiki");
  const ext = extension(path);
  const lang = Object.keys(shiki.bundledLanguages).find((id): id is BundledLanguage => id === ext);
  if (!lang) return false;
  const highlighter = await shiki.getSingletonHighlighter({ themes: [theme], langs: [lang] });
  let state: GrammarState | undefined;
  let old: GrammarState | undefined;
  let tokens: MapToken[][] = [];
  let from = 0;
  for (let at = 0; at < code.length;) {
    if (!alive()) return false;
    const gone = removed[at];
    let end = at;
    while (end < code.length && end - at < BATCH && removed[end] === gone) end++;
    // A removed run starts from the new side's state, so a line inside an unchanged comment stays a comment.
    if (gone && !removed[at - 1]) old = state;
    const result = highlighter.codeToTokens(code.slice(at, end).join("\n"), { lang, theme, grammarState: gone ? old : state, tokenizeMaxLineLength: 2_000 });
    for (const line of result.tokens) tokens.push(line.map(token => token.color === result.fg ? { content: token.content } : { content: token.content, color: token.color }));
    if (gone) old = result.grammarState;
    else state = result.grammarState;
    at = end;
    if (tokens.length >= SLICE_LINES || at === code.length) {
      send(from, tokens);
      from += tokens.length;
      tokens = [];
      await pause();
    }
  }
  return true;
}

if ("WorkerGlobalScope" in globalThis) self.onmessage = ({ data }: MessageEvent<{ id: number; stop?: boolean; path: string; theme: string; code: string[]; removed: boolean[] }>) => {
  if (data.stop) return void stopped.add(data.id);
  const { id } = data;
  tokenize(data.path, data.theme, data.code, data.removed, (from, tokens) => self.postMessage({ id, from, tokens }), () => !stopped.has(id))
    .then(ok => self.postMessage({ id, done: ok }), () => self.postMessage({ id, done: false }))
    .finally(() => stopped.delete(id));
};
