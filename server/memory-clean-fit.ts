import { changeIds, keptList, stagedCandidate, type CleanSource } from "./memory-clean-plan.ts";
import type { Change, CleanFile, CleanInput } from "./memory-clean-types.ts";
import { contentWords, FILE_FLOOR, GROWTH_MAX, openLine, protectedLines, rememberCovered } from "./memory-clean-validate.ts";

export const PLANNED = "Filed by plan";
// over the light limits a night files at least this many lines, so it always makes progress
const STEP_LINES = 3;
const DROPPABLE = ["merge", "replace", "retire"];

type Staged = ReturnType<typeof stagedCandidate>;

/** Code files enough lines to fit every cap with no model op, so a night never waits on the model doing sums; model ops ride on top only while the fit holds. */
export function fitPlan(input: CleanInput, sources: CleanSource[], lists: Map<CleanFile, unknown>, runId: string, at: number) {
  const source = sources.find((item) => item.file === "MEMORY.md")!;
  const validate = (list: unknown) => keptList({ file: source.file, text: source.text, list, typed: input.typed, user: input.user, side: input.side?.file });
  const { result, list } = validate(lists.get(source.file) ?? { version: 1, file: source.file, changes: [] });
  const model: Change[] = result.ok ? list.changes.filter((change) => change.reason !== PLANNED) : [];
  const listOf = (changes: Change[]) => ({ version: 1 as const, file: source.file, changes });
  const lines = source.text.split("\n");
  const over = Buffer.byteLength(source.text) > FILE_FLOOR || lines.length > 140;
  const guarded = protectedLines(source.text, input.typed);
  const used = new Set(model.flatMap(changeIds));
  const asked = (input.user ?? []).filter((line) => line.kind === "remember");
  const heard = new Set((input.user ?? []).flatMap((line) => [...contentWords(line.text)]));
  const month = new Date(at).toISOString().slice(0, 7);
  // lines the user has not talked about this week go first, then the oldest, then the largest; each must pass the pointer check alone
  const pool = lines.flatMap((line, i) => {
    if (!over || !line.trim() || /^#/.test(line) || guarded.has(i + 1) || openLine(line) || used.has(i + 1) || asked.some((item) => rememberCovered(item.text, line))) return [];
    const words = [...contentWords(line)];
    return [{ id: i + 1, hot: words.filter((word) => heard.has(word)).length / Math.max(1, words.length), noted: /\(noted (\d{4}-\d\d-\d\d)\)/.exec(line)?.[1] ?? "", bytes: Buffer.byteLength(line) + 1 }];
  }).sort((a, b) => a.hot - b.hot || a.noted.localeCompare(b.noted) || b.bytes - a.bytes)
    .filter((line) => !validate(listOf([{ op: "file", ids: [line.id], topic: `notes-${month}`, reason: PLANNED }])).dropped.length);
  const ops = [`notes-${month}`, `notes-${month}-b`].map((topic) => ({ topic, ids: [] as number[], bytes: 0 }));
  const planned = () => ops.filter((op) => op.ids.length).map((op) => ({ op: "file" as const, ids: [...op.ids].sort((a, b) => a - b), topic: op.topic, reason: PLANNED }));
  const stage = (items: Change[]) => (items.some((change) => DROPPABLE.includes(change.op)) ? [items, items.filter((change) => !DROPPABLE.includes(change.op))] : [items])
    .map((kept) => stagedCandidate(input, sources, new Map([...lists, [source.file, listOf(kept)]]), runId, at));
  // more filing cures budget and MEMORY.md growth only, so any other error ends the search and a line that adds one is skipped
  const hard = (staged: Staged[]) => new Set(staged.flatMap((item) => item.ok ? [] : item.errors.map((error) => error.reason)).filter((reason) => reason !== "budget" && reason !== "cap-growth"));
  const short = (staged: Staged[]) => staged.flatMap((item) => item.budgets.filter((budget) => budget.file === source.file))
    .reduce((need, budget) => ({ bytes: Math.max(need.bytes, budget.finalBytes - budget.maxBytes), lines: Math.max(need.lines, budget.finalLines - budget.maxLines) }), { bytes: 0, lines: 0 });
  let staged = stage([]);
  const need = short(staged);
  let filed = { bytes: 0, lines: 0 };
  for (const line of pool) {
    if (hard(staged).size || (staged.every((item) => item.ok) && filed.lines >= Math.min(STEP_LINES, pool.length))) break;
    const op = ops.find((item) => item.bytes + line.bytes <= GROWTH_MAX);
    if (!op) break;
    op.ids.push(line.id);
    op.bytes += line.bytes;
    filed = { bytes: filed.bytes + line.bytes, lines: filed.lines + 1 };
    // a pointer row costs a line and a few words per filed line, so measure only once the sums could fit
    if (filed.bytes < need.bytes + 40 + 16 * filed.lines || filed.lines < need.lines + planned().length || filed.lines < STEP_LINES) continue;
    const next = stage(planned());
    if (hard(next).size || next.some((item) => item.dropped.length)) {
      op.ids.pop();
      op.bytes -= line.bytes;
      filed = { bytes: filed.bytes - line.bytes, lines: filed.lines - 1 };
      continue;
    }
    staged = next;
  }
  // each model op must keep the plan passing even with every merge, replace and retire judged away later
  const kept: Change[] = [];
  for (const change of model) if (stage([...kept, change, ...planned()]).every((item) => item.ok && !item.dropped.length)) kept.push(change);
  return { list: listOf([...kept, ...planned()]), ids: new Set(ops.flatMap((op) => op.ids)) };
}
