import ts from "typescript";
import { location, parseSource, readSource, runCheck, testFile, trackedFiles, walk } from "./repo-check.mjs";

const glyphPattern = /[\u2500-\u259f\u25b0\u25b1]/u;
const allowlist = [
  { file: "src/components/UsageChart.tsx", text: "▁▂▃▄▅▆▇█", count: 1, reason: "Existing terminal chart fallback alphabet; app changes are outside this gate." },
  { file: "src/lib/terminal-skin.ts", text: "▰", count: 1, reason: "Existing terminal meter fill; replace in a separate UI fix." },
  { file: "src/lib/terminal-skin.ts", text: "▱", count: 1, reason: "Existing terminal meter remainder; replace in a separate UI fix." },
  { file: "src/components/TermStatusLine.tsx", text: " │ ", count: 2, reason: "Existing terminal status separators; app changes are outside this gate." },
  { file: "electron/terminal-host.mjs", text: "▰", count: 1, reason: "Recognizes an external CLI footer; does not draw a UI shape." },
];

export function glyphHits(file, text) {
  if (!glyphPattern.test(text) && !/\\u|&#/.test(text)) return [];
  if (/\.(?:html|css)$/.test(file)) {
    const source = text.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
    return [...source.matchAll(/[\u2500-\u259f\u25b0\u25b1]|&#(?:x([\da-f]+)|(\d+));/gi)].flatMap((match) => {
      const value = match[1] || match[2] ? String.fromCodePoint(parseInt(match[1] ?? match[2], match[1] ? 16 : 10)) : match[0];
      return glyphPattern.test(value) ? [{ file, line: source.slice(0, match.index).split("\n").length, text: value }] : [];
    });
  }
  const source = parseSource(file, text);
  const hits = [];
  walk(source, (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      const value = node.text.replace(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, decimal) => String.fromCodePoint(parseInt(hex ?? decimal, hex ? 16 : 10)));
      if (glyphPattern.test(value)) hits.push({ file, line: location(source, node), text: value });
    }
  });
  return hits;
}

export function checkGlyphs(files = trackedFiles(/^(?:src|site|electron|server|shared|companion)\/.*\.(?:[cm]?[jt]sx?|html|css)$/), read = readSource) {
  const counts = new Map();
  return files.filter((file) => !testFile.test(file)).flatMap((file) => glyphHits(file, read(file))).filter((hit) => {
    const entry = allowlist.find((entry) => entry.file === hit.file && entry.text === hit.text);
    if (!entry) return true;
    const count = (counts.get(entry) ?? 0) + 1;
    counts.set(entry, count);
    return count > entry.count;
  }).map((hit) => `${hit.file}:${hit.line}: shape glyph in UI string ${JSON.stringify(hit.text)}`);
}

runCheck(import.meta.url, checkGlyphs);
