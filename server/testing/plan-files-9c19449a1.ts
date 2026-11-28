import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

import type { TaskRecordContext } from "../turn-context.ts";
import { testHome } from "./test-home.ts";

// only an ASCII word char extends the extension: Korean and Japanese particles attach to the filename
const DOC_PATH = /(?:[A-Za-z]:)?[\p{L}\p{M}\p{N}\p{Pc}.~\\/-]*\.(?:md|txt|docx?|pdf)(?!\w)/giu;
// a quoted path may hold spaces, so it is read whole before DOC_PATH
const QUOTED_DOC_PATH = /(["'`])([^"'`\n]+\.(?:md|txt|docx?|pdf))\1/gi;
// CJK prose runs into names with no space, so every name the text or the files on disk support is pinned; DOC_PATH guesses the rest
const NAME_RUN = /[\p{L}\p{M}\p{N}\p{Pc}\p{S}.:\\/-]+/gu;
const DOC_EXT = /\.(?:md|txt|docx?|pdf)(?!\w)/gi;
// Windows finds review.txt for "review.txt.", so a name ends only after an extension
const NAME_END = /\.[A-Za-z\d]+(?!\.*[\w~\\/-])/g;
// in CJK prose a name may start where Latin letters follow another script
const LATIN_START = /(?<=^|(?!\p{Script=Latin})\p{L})\p{Script=Latin}/gu;

function localPath(ref: string, cwd: string | undefined): string | null {
  const path = ref.trim();
  if (!path || /^\w{2,}:\/\//.test(path)) return null;
  if (/^~[\\/]/.test(path)) return join(testHome(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return cwd ? resolve(cwd, path) : null;
}

function runFiles(run: string, cwd: string | undefined, listed: (dir: string) => Set<string>): string[] {
  const ends = [...run.matchAll(NAME_END)].map((match) => match.index + match[0].length).reverse();
  const refs: [number, string][] = [];
  let rest = run;
  let from = 0;
  const starts = [0];
  const latin = [...run.matchAll(LATIN_START)].map((match) => match.index);
  const named = [...latin, ...[...run.matchAll(/[\\/]/g)].map((match) => match.index)];
  for (const hit of run.matchAll(DOC_EXT)) {
    if (hit.index < from) continue;
    const after = hit.index + hit[0].length;
    const tails = ends.filter((end) => end >= after && !/[\\/]/.test(run.slice(after, end)));
    let best: [number, number] | undefined;
    for (let start = from; start <= hit.index && tails.length > 0 && (!best || tails[0]! - start > best[1] - best[0]); start++) {
      // a name starts after a character no ASCII name holds, so release-plan.md never pins plan.md
      if (start && start !== starts.at(-1) && /[\w.~:\\/-]/.test(run[start - 1]!) || /[\uDC00-\uDFFF]/.test(run[start]!)) continue;
      const head = localPath(run.slice(start, after), cwd);
      if (!head || !listed(dirname(head)).has(fileKey(basename(head)))) continue;
      for (const end of tails) {
        if (best && end - start <= best[1] - best[0]) break;
        const path = localPath(run.slice(start, end), cwd)!;
        if (listed(dirname(path)).has(fileKey(basename(path))) && existsSync(path)) {
          best = [start, end];
          break;
        }
      }
    }
    const spans = best ? [best] : [];
    if (ends.includes(after)) {
      // 请先读plan.md is prose then a name, 新draft.md and 計画.md改訂.md one name each, and no rule tells them apart, so the token and each start since the name before this one are pinned up to this end, but never past a name end into a later name's start (a Latin start, a folder, a file on disk)
      const token = [...run.slice(0, after).matchAll(DOC_PATH)].at(-1)!;
      const next = Math.max(best?.[0] ?? 0, ...named.filter((at) => at < hit.index));
      const lead = Math.max(token.index, ends.find((end) => end <= next) ?? 0);
      const near = Math.max(lead, starts.at(-2) ?? 0);
      for (const start of new Set([lead, ...[...starts, ...latin].filter((start) => start >= near)])) {
        if (start < hit.index) spans.push([start, after]);
      }
    }
    if (!spans.length) {
      // a folder like notes.md/ ends no name, so the next name may still start before it
      if (tails.length) from = after;
      continue;
    }
    from = Math.max(...spans.map(([, end]) => end));
    starts.push(from);
    for (const [start, end] of spans) refs.push([start, run.slice(start, end)]);
    const blank = Math.min(...spans.map(([start]) => start));
    rest = rest.slice(0, blank) + " ".repeat(from - blank) + rest.slice(from);
  }
  for (const match of rest.matchAll(DOC_PATH)) refs.push([match.index, match[0]]);
  return refs.sort(([a], [b]) => a - b).map(([, ref]) => ref);
}

function fileKey(name: string): string {
  return name.normalize("NFC").toUpperCase();
}

// a CJK plan tries a name start per character, so folders are listed once and walked down from cwd or the drive root, never a stat per guess
function listedFiles(cwd: string | undefined): (dir: string) => Set<string> {
  const base = cwd ? resolve(cwd) : undefined;
  const listed = new Map<string, Set<string>>();
  const none = new Set<string>();
  const read = (dir: string) => {
    let names = listed.get(dir);
    if (!names) {
      names = new Set();
      listed.set(dir, names);
      try {
        for (const name of readdirSync(dir)) {
          const key = fileKey(name);
          names.add(key);
          // a name start goes on only when a file name begins with it up to its extension
          for (const match of key.matchAll(DOC_EXT)) names.add(key.slice(0, match.index + match[0].length));
        }
      } catch {}
    }
    return names;
  };
  return (dir) => {
    let at = base && (dir === base || dir.startsWith(base + sep)) ? base : parse(dir).root;
    for (const part of dir.slice(at.length).split(sep)) {
      if (!part) continue;
      if (!read(at).has(fileKey(part))) return none;
      at = join(at, part);
    }
    return read(at);
  };
}

/** Files the record names as its plan: artifacts labeled or named plan, and any document path the goal or plan steps cite. */
export function planFiles(record: Pick<TaskRecordContext, "goal" | "plan" | "artifacts">, cwd?: string): string[] {
  const refs = (record.artifacts ?? []).filter((item) => /plan/i.test(item.label) || /plan/i.test(basename(item.ref))).map((item) => item.ref);
  const cited = [record.goal, ...record.plan.map((item) => item.step)].join("\n").replace(/\w{2,}:\/\/\S+/g, "");
  for (const match of cited.matchAll(QUOTED_DOC_PATH)) refs.push(match[2]!);
  const listed = listedFiles(cwd);
  for (const run of cited.replace(QUOTED_DOC_PATH, " ").match(NAME_RUN) ?? []) refs.push(...runFiles(run, cwd, listed));
  return [...new Set(refs.map((ref) => localPath(ref, cwd)).filter((path): path is string => path !== null))];
}
