import type { Translate } from "./i18n";
import { parseWorkerLabel, UNKNOWN_PANE_STATE, workerRuns, type WorkerShownState } from "./worker-runs";

/** Every open worker, whatever its state; the sidebar line and the side pane badge both say this number. */
export const openWorkerCount = (runs: readonly unknown[]): number => runs.length;

export function workerStatusText(runs: readonly { state: WorkerShownState }[], t: Translate): string {
  if (!runs.some(({ state }) => state === "working" || state === "waiting")) return "";
  const count = openWorkerCount(runs);
  return t(count === 1 ? "workers.countOne" : "workers.countMany", { count });
}

export function sidebarWorkerStatus(messages: Parameters<typeof workerRuns>[0], labels: readonly string[], t: Translate): string {
  if (!labels.length) return "";
  const runs = workerRuns(messages).sort((a, b) => b.latest.at - a.latest.at || b.latest.index - a.latest.index);
  const states = labels.map((label) => {
    const nick = parseWorkerLabel(label).nick;
    const matched = nick === null ? undefined : runs.find((run) => run.nick === nick || run.notes.some(({ note }) => parseWorkerLabel(note.label).nick === nick));
    const run = matched?.pane8 ? runs.find((run) => run.pane8 === matched.pane8) : matched;
    return { state: run?.state ?? UNKNOWN_PANE_STATE };
  });
  return workerStatusText(states, t);
}
