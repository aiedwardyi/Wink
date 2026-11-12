import type { ArchiveEntry, ChangeList } from "./memory-clean-types.ts";
import { protectedLines } from "./memory-clean-validate.ts";

export function recallScope(text: string, list: ChangeList, typed: ReadonlySet<string>, inserted: number[] = []): number[] {
  const lines = text.split("\n");
  const filled = (id: number) => !!lines[id - 1]?.trim();
  const core = new Set([...inserted.filter(filled), ...list.changes.flatMap((change) => {
    if (change.op === "merge" || change.op === "file") return change.ids;
    if (change.op === "learn" || change.op === "own") return [];
    if (change.op === "replace") return [change.id, change.newer];
    const twin = change.op === "retire" ? lines.findIndex((line, i) => i + 1 !== change.id && line === lines[change.id - 1]) + 1 : 0;
    return twin ? [change.id, twin] : [change.id];
  })]);
  const scope = new Set(core);
  for (const id of core) {
    for (const step of [-1, 1]) {
      let at = id + step;
      while (at >= 1 && at <= lines.length && !filled(at)) at += step;
      if (filled(at)) scope.add(at);
    }
    for (let at = id - 1; at >= 1; at--) if (/^#{1,6}\s/.test(lines[at - 1]!)) { scope.add(at); break; }
  }
  const distance = (id: number) => Math.min(...[...core].map((n) => Math.abs(n - id)));
  const guarded = [...protectedLines(text, typed)].filter(filled)
    .sort((a, b) => Number(scope.has(b)) - Number(scope.has(a)) || distance(a) - distance(b) || a - b);
  for (const id of guarded.slice(0, 4)) scope.add(id);
  return [...scope].filter(filled).sort((a, b) => a - b);
}

function render(lines: string[], picked: Array<[number, string[]]>): string {
  const out: string[] = [];
  let last = 0;
  for (const [id, text] of [...picked, [lines.length + 1, []] as [number, string[]]]) {
    if (lines.slice(last, id - 1).some((line) => line.trim())) out.push("…");
    out.push(...text);
    last = id;
  }
  return out.join("\n");
}

export function excerpt(text: string, ids: number[]): string {
  const lines = text.split("\n");
  return render(lines, ids.map((id) => [id, [lines[id - 1]!]]));
}

export function afterExcerpt(text: string, ids: number[], entries: ArchiveEntry[]): string {
  const lines = text.split("\n");
  const leading = entries.flatMap((entry) => entry.header.after === 0 ? entry.header.wrote : []);
  return [...leading, render(lines, ids.map((id) => {
    const entry = entries.find((item) => item.header.at.includes(id));
    const added = entries.flatMap((item) => item.header.after === id ? item.header.wrote : []);
    return [id, [...(!entry ? [lines[id - 1]!] : entry.header.at[0] === id ? entry.header.wrote : []), ...added]];
  }))].join("\n");
}

const normalize = (text: string) => text.toLowerCase().replace(/["'`“”‘’()[\]{}]/g, "").replace(/\s+/g, " ").replace(/[\s.,;:!?。]+$/, "").trim();

const words = (text: string) => normalize(text).split(" ").map(normalize).filter(Boolean);

const within = (text: string, part: string) => !!part && ` ${words(text).join(" ")} `.includes(` ${part} `);

const NEGATION = new Set(["no", "not", "never"]);

const OFTEN = new Set(["once", "twice", "always"]);

const CAP = ["cap", "caps", "capped", "max", "maximum", "most", "limit"];

const FLOOR = ["min", "minimum", "least", "floor"];

// the part of a key its question asks for: not the noun "which" or "what" names, one bound of a range, or the place without how often
function core(key: string, question: string, bare: string, asked: Set<string>): string {
  const noun = /\b(?:which|what) (\S+)/.exec(normalize(question))?.[1];
  const full = normalize(key);
  if (noun && full.endsWith(` ${noun}`)) return full.slice(0, -noun.length - 1);
  if (noun && full.startsWith(`${noun} `)) return full.slice(noun.length + 1);
  const range = /^(\d+(?:\.\d+)?) ?(?:-|–|to) ?(\d+(?:\.\d+)?)$/.exec(bare);
  const cap = CAP.some((word) => asked.has(word)), floor = FLOOR.some((word) => asked.has(word));
  if (range && cap !== floor) return cap ? range[2]! : range[1]!;
  const rest = bare.split(" ");
  return !asked.has("how") && rest.some((word) => OFTEN.has(word)) ? rest.filter((word) => !OFTEN.has(word)).join(" ") : "";
}

// A quote of one original line cannot carry a merge's swapped value, and a key from a merged line never passes on null.
export function gradeByCode(key: string | null, answer: string | null, question = "", original: string[] = [], merged: string[] = []): boolean | undefined {
  if (key === null) return answer === null;
  const asked = new Set(words(question));
  // "delete" is named by a question that says "deleted" and "queues" by one that says "queue"; "it" is the asked subject
  const unasked = (text: string) => words(text).filter((word) => word !== "it" && !["", "s", "es", "d", "ed", "ing"].some((suffix) => asked.has(word + suffix)
    || !!suffix && word.length > suffix.length + 2 && word.endsWith(suffix) && asked.has(word.slice(0, -suffix.length)))).join(" ");
  const bare = unasked(key);
  if (answer === null) return original.some((line) => within(line, bare)) && !merged.some((line) => within(line, bare));
  const said = words(answer).join(" ");
  // a key that adds only a negation to the question is its "no"
  if (bare && bare.split(" ").every((word) => NEGATION.has(word)) && ![...NEGATION].some((word) => asked.has(word)) && ["yes", "no"].includes(said)) return said === "no";
  const center = core(key, question, bare, asked);
  if (center && (center === said || center === unasked(answer))) return true;
  return normalize(key) === normalize(answer) || (!!bare && (bare === said || bare === unasked(answer))) || (within(answer, bare) && original.some((line) => within(line, said))) || undefined;
}
