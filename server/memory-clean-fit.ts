import { changeIds, keptList, stagedCandidate, type CleanSource } from "./memory-clean-plan.ts";
import type { Change, CleanFile, CleanInput, SleepLine } from "./memory-clean-types.ts";
import { contentWords, FILE_FLOOR, filedPointer, GROWTH_MAX, openLine, prepareChangeList, protectedLines, rememberCovered } from "./memory-clean-validate.ts";

export const PLANNED = "Filed by plan";
// over the light limits a night files at least this many lines, so it always makes progress
const STEP_LINES = 3;
// over the load cap a night files up to the caps, at most this many lines
const MAX_LINES = 24;
const DROPPABLE = ["merge", "replace", "retire"];
const CURABLE = ["budget", "cap-growth"];

type Slot = { n: number; topic: string; row: number; ids: number[]; bytes: number; text: string };

const bare = (line: string) => line.replace(/\r$/, "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s*\(noted \d{4}-\d\d-\d\d\)/g, "").trim();
export const subjectOf = (line: string) => bare(line).split(/:\s| - /)[0]!.trim();

/** Floor first: when the floor can't land with tonight's remembers, the oldest one written waits a night with every older one, never the newest. */
export function fitPlan(input: CleanInput, sources: CleanSource[], lists: Map<CleanFile, unknown>, runId: string, at: number) {
  const all = input.user ?? [];
  const source = sources.find((item) => item.file === "MEMORY.md")!;
  const first = floorFit(input, all, sources, lists, runId, at);
  const forced = (user: readonly SleepLine[]) => {
    const result = prepareChangeList({ file: source.file, text: source.text, list: { version: 1, file: source.file, changes: [] }, typed: input.typed, user, side: input.side?.file });
    return result.ok ? result.forced : 0;
  };
  // validate writes remembers newest first, so holding from the oldest end shrinks tonight's room one remember at a time
  const order = all.filter((line) => line.kind === "remember").reverse().sort((a, b) => b.at - a.at);
  let room = forced(all);
  for (let keep = order.length - 1; !first.lands && room && keep > 0; keep--) {
    const held = new Set(order.slice(keep));
    const user = all.filter((line) => !held.has(line));
    const bytes = forced(user);
    if (!bytes) break;
    if (bytes === room) continue;
    room = bytes;
    const fit = floorFit({ ...input, user }, all, sources, lists, runId, at);
    if (fit.lands) return { ...fit, user };
  }
  return { ...first, user: all };
}

/** Code files enough lines to fit every cap with no model op, so a night never waits on the model doing sums; model ops ride on top only while the fit holds. */
function floorFit(input: CleanInput, all: readonly SleepLine[], sources: CleanSource[], lists: Map<CleanFile, unknown>, runId: string, at: number) {
  const source = sources.find((item) => item.file === "MEMORY.md")!;
  const validate = (list: unknown) => keptList({ file: source.file, text: source.text, list, typed: input.typed, user: input.user, side: input.side?.file });
  const { result, list, dropped } = validate(lists.get(source.file) ?? { version: 1, file: source.file, changes: [] });
  const model: Change[] = result.ok ? list.changes.filter((change) => change.reason !== PLANNED) : [];
  const rejected = { errors: result.ok ? [] : result.errors, dropped: dropped.map((item) => ({ ...item, file: source.file })) };
  const listOf = (changes: Change[]) => ({ version: 1 as const, file: source.file, changes });
  const stage = (items: Change[], reserve = false) => (items.some((change) => DROPPABLE.includes(change.op)) ? [items, items.filter((change) => !DROPPABLE.includes(change.op))] : [items])
    .map((kept) => stagedCandidate(input, sources, new Map([...lists, [source.file, listOf(kept)]]), runId, at, reserve));
  const passes = (staged: ReturnType<typeof stage>) => staged.every((item) => item.ok && !item.dropped.some((drop) => drop.file === source.file));
  const lines = source.text.split("\n");
  const before = Buffer.byteLength(source.text);
  const over = before > FILE_FLOOR || lines.length > 140;
  const guarded = protectedLines(source.text, input.typed);
  // held remembers too: a filed line that covers one would be written again the next night
  const asked = all.filter((line) => line.kind === "remember");
  const heard = new Set(all.flatMap((line) => [...contentWords(line.text)]));
  const month = `notes-${new Date(at).toISOString().slice(0, 7)}`;
  const plain = (line: string) => line.replace(/\r$/, "");
  const bytes = (line: string) => Buffer.byteLength(plain(line)) + 1;
  const bullet = (line = "") => /^\s*(?:[-*+]|\d+[.)])\s/.test(line);
  // a stale pair wants a replace, not a topic: one subject, a line with no separator under another line's subject, or two such lines on the same first three content words
  const keyed = lines.flatMap((line, i) => {
    if (!line.trim() || /^#/.test(line)) return [];
    const text = bare(line).toLowerCase();
    const words = text.split(/\s+/).map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter((word) => contentWords(word).size || /\p{N}/u.test(word));
    const split = /:\s| - /.test(text);
    return [{ id: i + 1, text, split, key: subjectOf(line).toLowerCase(), three: split ? "" : words.slice(0, 3).join(" ") }];
  });
  const under = (text: string, key: string) => !!key && (text === key || text.startsWith(`${key} `));
  const paired = new Set(keyed.flatMap((a) => keyed.some((b) => b.id !== a.id && (a.key === b.key || !a.split && under(a.text, b.key) || !b.split && under(b.text, a.key)
    || !!a.three && a.three === b.three)) ? [a.id] : []));
  // lines the user has not talked about this week go first, then the oldest, then the largest
  let pool = lines.flatMap((line, i) => {
    if (!over || !line.trim() || /^#/.test(line) || !bullet(line) && bullet(lines[i + 1]) || paired.has(i + 1) || guarded.has(i + 1) || bytes(line) > GROWTH_MAX || openLine(line)
      || asked.some((item) => rememberCovered(item.text, line))) return [];
    const words = [...contentWords(line)];
    return [{ id: i + 1, hot: words.filter((word) => heard.has(word)).length / Math.max(1, words.length), noted: /\(noted (\d{4}-\d\d-\d\d)\)/.exec(line)?.[1] ?? "", bytes: bytes(line) }];
  }).sort((a, b) => a.hot - b.hot || a.noted.localeCompare(b.noted) || b.bytes - a.bytes);
  // each line must pass the pointer check alone; one list per 4 KB checks them all, since a failing op drops alone
  const failed = new Set<number>();
  for (let start = 0, size = 0, end = 0; start < pool.length; start = end, size = 0) {
    while (end < pool.length && (end === start || size + pool[end]!.bytes <= 4096)) size += pool[end++]!.bytes;
    const chunk = pool.slice(start, end);
    const checked = validate(listOf(chunk.map((line) => ({ op: "file", ids: [line.id], topic: month, reason: PLANNED }))));
    if (!checked.result.ok) chunk.forEach((line) => failed.add(line.id));
    for (const item of checked.dropped) failed.add(chunk[item.change]!.id);
  }
  pool = pool.filter((line) => !failed.has(line.id));
  const base = stage([], true)[0]!;
  const own = base.budgets.find((item) => item.file === source.file);
  const slots: Slot[] = [];
  const hits = (id: number, text: string) => {
    const words = contentWords(text);
    return [...contentWords(lines[id - 1]!)].filter((word) => words.has(word)).length;
  };
  // a line that shares as many words with another row as with its own could route to either file
  const mixed = (ids: number[], own: string, other: string) => ids.some((id) => hits(id, other) >= hits(id, own));
  const pointers = lines.flatMap((line, i) => /^- memory\/(?!memory-history)[\w.-]+\.md: /.test(line) ? [i + 1] : []);
  // rows of the model's file ops kept on top of the floor
  const filings: Array<{ ids: number[]; text: string; topic: string }> = [];
  let grow = (_skip: Set<number>) => false;
  let lands = true;
  if (pool.length && own && (base.ok || base.errors.every((error) => CURABLE.includes(error.reason)))) {
    lands = false;
    const sum = (key: "touchedLines" | "changedChars") => base.budgets.reduce((n, item) => n + item[key], 0);
    const grown = base.budgets.reduce((n, item) => n + item.finalBytes - item.beforeBytes, 0);
    // a topic's last pointer row takes this night's labels while it stays within 300 bytes, as validate extends it
    const open = (from: number): Slot | undefined => {
      for (let n = from; n < 26; n++) {
        const topic = n ? `${month}-${String.fromCharCode(97 + n)}` : month;
        const row = lines.findLastIndex((line) => line.startsWith(`- memory/${topic}.md: `)) + 1;
        const text = row ? plain(lines[row - 1]!) : "";
        if (!row || Buffer.byteLength(text) < 260) return { n, topic, row, ids: [], bytes: 0, text };
      }
      return undefined;
    };
    const rowText = (slot: Slot, ids: number[]) => {
      const path = `memory/${slot.topic}.md`;
      const pointer = filedPointer(source.text, ids, path);
      return slot.row ? `${plain(lines[slot.row - 1]!)}; ${pointer.slice(path.length + 4)}` : pointer;
    };
    const totals = () => {
      const filled = slots.filter((slot) => slot.ids.length);
      const filed = filled.reduce((n, slot) => n + slot.bytes, 0);
      const rows = filled.reduce((n, slot) => n + bytes(slot.text) - (slot.row ? bytes(lines[slot.row - 1]!) : 0), 0);
      const count = filled.reduce((n, slot) => n + slot.ids.length, 0);
      const fits = own.finalBytes - filed + rows <= own.maxBytes && own.finalLines - count + filled.filter((slot) => !slot.row).length <= own.maxLines;
      const capped = sum("touchedLines") + count + filled.length > 40 || sum("changedChars") + filed + rows > 8000 || grown + rows > GROWTH_MAX;
      return { count, fits, capped };
    };
    const added: Array<{ slot: Slot; id: number }> = [];
    const add = (line: { id: number; bytes: number }) => {
      for (let i = 0; i < 2; i++) {
        const slot = slots[i] ?? open(i ? slots[0]!.n + 1 : 0);
        if (!slot) return false;
        slots[i] = slot;
        const ids = [...slot.ids, line.id].sort((a, b) => a - b);
        const text = rowText(slot, ids);
        const other = slots[1 - i];
        const rows = [...pointers.filter((row) => row !== slot.row && row !== other?.row).map((row) => lines[row - 1]!), ...filings.map((filing) => filing.text), ...other?.ids.length ? [other.text] : []];
        if (Buffer.byteLength(text) > 300 || slot.bytes + line.bytes > GROWTH_MAX || rows.some((row) => mixed([line.id], text, row)) || other?.ids.length && mixed(other.ids, other.text, text)
          || filings.some((filing) => mixed(filing.ids, filing.text, text))) continue;
        const kept = { ...slot };
        Object.assign(slot, { ids, bytes: slot.bytes + line.bytes, text });
        if (!totals().capped) { added.push({ slot, id: line.id }); return true; }
        Object.assign(slot, kept);
      }
      return false;
    };
    const queue = [...pool];
    const done = () => {
      const now = totals();
      return now.count >= MAX_LINES || before <= 24000 && now.fits && now.count >= Math.min(STEP_LINES, pool.length);
    };
    while (queue.length && !done()) add(queue.shift()!);
    // the sums are close, not exact; a few real stagings settle the last line
    for (let tries = 0; tries < 6 && added.length; tries++) {
      const staged = stage(planOps(slots));
      if (passes(staged)) { lands = true; break; }
      const reasons = staged.flatMap((item) => item.ok ? [] : item.errors.map((error) => error.reason));
      if (reasons.length && reasons.every((reason) => CURABLE.includes(reason))) {
        let more = false;
        while (queue.length && !more) more = add(queue.shift()!);
        if (more) continue;
        break;
      }
      const { slot, id } = added.pop()!;
      slot.ids = slot.ids.filter((item) => item !== id);
      slot.bytes -= bytes(lines[id - 1]!);
      slot.text = slot.ids.length ? rowText(slot, slot.ids) : slot.row ? plain(lines[slot.row - 1]!) : "";
    }
    grow = (skip) => {
      for (let i = 0; i < queue.length;) {
        if (skip.has(queue[i]!.id)) i++;
        else if (add(queue.splice(i, 1)[0]!)) return true;
      }
      return false;
    };
  }
  // a model file op is proved only when no line has a stale pair and no other row matches a line as well as its own, in both directions
  const proves = (change: Change) => {
    if (change.op !== "file") return true;
    const path = `memory/${change.topic}.md`;
    const text = filedPointer(source.text, change.ids, path);
    const others = [...pointers.flatMap((row) => lines[row - 1]!.startsWith(`- ${path}: `) ? [] : [{ ids: [], text: plain(lines[row - 1]!) }]),
      ...slots.filter((slot) => slot.ids.length && slot.topic !== change.topic), ...filings.filter((filing) => filing.topic !== change.topic)];
    return !change.ids.some((id) => paired.has(id)) && !others.some((row) => mixed(change.ids, text, row.text) || mixed(row.ids, row.text, text));
  };
  // the floor is built first; each model op rides on it only while the plan passes, even with every merge, replace and retire judged away later; one short of room files more lines first
  const kept: Change[] = [];
  for (const change of model) {
    for (let tries = 0; tries < 6; tries++) {
      const taken = new Set([...kept, ...planOps(slots)].flatMap(changeIds));
      if (changeIds(change).some((id) => taken.has(id)) || !proves(change)) break;
      const staged = stage([...kept, change, ...planOps(slots)]);
      if (passes(staged)) {
        kept.push(change);
        if (change.op === "file") filings.push({ ids: change.ids, text: filedPointer(source.text, change.ids, `memory/${change.topic}.md`), topic: change.topic });
        break;
      }
      const reasons = staged.flatMap((item) => item.ok ? [] : item.errors.map((error) => error.reason));
      if (!reasons.length || !reasons.every((reason) => CURABLE.includes(reason)) || !grow(new Set([...taken, ...changeIds(change)]))) break;
    }
  }
  const final = planOps(slots);
  return { list: listOf([...kept, ...final]), ids: new Set(final.flatMap(changeIds)), rejected, lands };
}

const planOps = (slots: Slot[]): Change[] => slots.filter((slot) => slot.ids.length).map((slot) => ({ op: "file", ids: slot.ids, topic: slot.topic, reason: PLANNED }));
