// What changed between two system texts, as the lines a resumed session needs.
// Each sentence is keyed by the headings and tags it sits under, so a part that
// only moves is free, while a value that lands under another heading, or lines
// of one paragraph that change order, still count as changed.

/** Past this, a line is Wink's guidance: independent rules whose order and line breaks carry nothing. */
export const SYSTEM_LINE_SPLIT_CHARS = 2_000;
const SENTENCE_END = /(?<=[.!?])\s+/;
const HEADING = /^(#{1,6})\s/;
const OPEN_TAG = /^<([\w-]+)(?:\s[^>]*)?>$/;
const CLOSE_TAG = /^<\/([\w-]+)>$/;

type Unit = { text: string; path: string[]; key: string; line: number; long: boolean; heading: boolean };
type Parsed = { units: Unit[]; lines: string[]; runs: number[][] };

function parse(text: string): Parsed {
  const units: Unit[] = [];
  const lines = text.split("\n").map((line) => line.trimEnd());
  const runs: number[][] = [];
  const open: Array<{ tag: string; tags: string[]; headings: Array<{ level: number; text: string }> }> = [];
  let tags: string[] = [];
  let headings: Array<{ level: number; text: string }> = [];
  let run: number[] = [];
  const end = () => {
    if (run.length) runs.push(run);
    run = [];
  };
  const add = (text: string, path: string[], line: number, kind: "tag" | "heading" | "line" | "long") => {
    if (kind === "heading" || kind === "line") run.push(units.length);
    units.push({ text, path, key: `${path.join("\n")}\n\n${text}`, line, long: kind === "long", heading: kind === "heading" });
  };
  lines.forEach((line, at) => {
    const bare = line.trim();
    if (!bare) return end();
    const opened = OPEN_TAG.exec(bare);
    const closed = CLOSE_TAG.exec(bare);
    if (opened || closed) {
      end();
      // a tag's body never inherits the headings around it, so the tag moves freely
      const index = closed ? open.findLastIndex((entry) => entry.tag === closed[1]) : -1;
      if (index >= 0) ({ tags, headings } = open.splice(index)[0]!);
      add(bare, [], at, "tag");
      if (opened) {
        open.push({ tag: opened[1]!, tags, headings });
        tags = [...tags, bare];
        headings = [];
      }
      return;
    }
    const heading = HEADING.exec(bare);
    if (heading) {
      end();
      const level = heading[1]!.length;
      headings = headings.filter((entry) => entry.level < level);
      add(bare, [...tags, ...headings.map((entry) => entry.text)], at, "heading");
      headings = [...headings, { level, text: bare }];
      return;
    }
    const long = line.length > SYSTEM_LINE_SPLIT_CHARS;
    if (long) end();
    const path = [...tags, ...headings.map((entry) => entry.text)];
    for (const sentence of bare.split(SENTENCE_END)) if (sentence) add(sentence, path, at, long ? "long" : "line");
    if (long) end();
  });
  end();
  return { units, lines, runs };
}

/** A run's surviving units still sit together in `other`, in order, with only new text between them. */
function runIntact(keys: string[], other: string[], at: Map<string, number[]>, own: Set<string>): boolean {
  if (keys.length <= 1) return true;
  return (at.get(keys[0]!) ?? []).some((start) => {
    let index = start;
    for (const key of keys.slice(1)) {
      index++;
      while (index < other.length && other[index] !== key && !own.has(other[index]!)) index++;
      if (other[index] !== key) return false;
    }
    return true;
  });
}

function positions(keys: string[]): Map<string, number[]> {
  const at = new Map<string, number[]>();
  keys.forEach((key, index) => {
    const list = at.get(key);
    if (list) list.push(index);
    else at.set(key, [index]);
  });
  return at;
}

const scope = (unit: Unit) => (unit.heading ? [...unit.path, unit.text] : unit.path);
const within = (path: string[], prefix: string[]) => prefix.every((part, index) => path[index] === part);

function lines(parsed: Parsed, changed: Set<number>): string[] {
  const out: string[] = [];
  let shown: string[] = [];
  let lastLine = -1;
  for (const index of [...changed].sort((a, b) => a - b)) {
    const unit = parsed.units[index]!;
    if (!unit.long && unit.line === lastLine) continue;
    // the headings above a changed line ride with it, or the line loses its section
    let same = 0;
    while (same < shown.length && shown[same] === unit.path[same]) same++;
    out.push(...unit.path.slice(same).filter((part) => !OPEN_TAG.test(part)));
    out.push(unit.long ? unit.text : parsed.lines[unit.line]!);
    shown = scope(unit);
    lastLine = unit.line;
  }
  return out;
}

export function systemDelta(delivered: string, system: string) {
  const before = parse(delivered);
  const after = parse(system);
  const keysBefore = before.units.map((unit) => unit.key);
  const keysAfter = after.units.map((unit) => unit.key);
  const inBefore = new Set(keysBefore);
  const inAfter = new Set(keysAfter);
  const broken = (from: Parsed, own: Set<string>, other: string[], otherHas: Set<string>) => {
    const at = positions(other);
    const out = new Set<number>();
    for (const run of from.runs) {
      const kept = run.map((index) => from.units[index]!.key).filter((key) => otherHas.has(key));
      if (!runIntact(kept, other, at, own)) run.forEach((index) => out.add(index));
    }
    return out;
  };
  const removed = broken(before, inBefore, keysAfter, inAfter);
  const added = broken(after, inAfter, keysBefore, inBefore);
  const unmatched = (from: Parsed, skip: Set<number>, other: Parsed, otherSkip: Set<number>, out: Set<number>) => {
    const left = new Map<string, number>();
    other.units.forEach((unit, index) => otherSkip.has(index) || left.set(unit.key, (left.get(unit.key) ?? 0) + 1));
    from.units.forEach((unit, index) => {
      if (skip.has(index)) return;
      const count = left.get(unit.key) ?? 0;
      left.set(unit.key, count - 1);
      if (count <= 0) out.add(index);
    });
  };
  const removedFlagged = new Set(removed);
  const addedFlagged = new Set(added);
  unmatched(before, removedFlagged, after, addedFlagged, removed);
  unmatched(after, addedFlagged, before, removedFlagged, added);
  // a value that moved to another heading: the smallest section holding both places resends whole
  const sections: string[][] = [];
  const addedByText = new Map<string, Unit[]>();
  for (const index of added) {
    const unit = after.units[index]!;
    const list = addedByText.get(unit.text);
    if (list) list.push(unit);
    else addedByText.set(unit.text, [unit]);
  }
  for (const index of removed) {
    const unit = before.units[index]!;
    for (const other of addedByText.get(unit.text) ?? []) {
      if (other.key === unit.key) continue;
      let shared = 0;
      while (shared < unit.path.length && unit.path[shared] === other.path[shared]) shared++;
      if (shared) sections.push(unit.path.slice(0, shared));
      else for (const path of [unit.path, other.path]) if (path.length) sections.push(path.slice(0, 1));
    }
  }
  for (const prefix of sections) {
    before.units.forEach((unit, index) => within(scope(unit), prefix) && removed.add(index));
    after.units.forEach((unit, index) => within(scope(unit), prefix) && added.add(index));
  }
  return { removed: lines(before, removed), added: lines(after, added) };
}
