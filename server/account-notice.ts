import type { MainChange } from "./account-lifecycle.ts";
import type { AccountNames } from "./account-names.ts";
import type { WorkerRun, WorkerRuns } from "./worker-panes.ts";

type Engine = MainChange["engine"];
type Main = { id: string; generation: number; name: string; seq: number };
type Run = WorkerRun & { name: string; number: number };

const ENGINES: Engine[] = ["claude", "codex"];
const LABELS: Record<Engine, string> = { claude: "Claude", codex: "Codex" };
const MAX_LABELS = 3;
const REFRESH_MS = 300;
const byText = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function stillOn(runs: Run[]) {
  const groups = new Map<string, { engine: Engine; name: string; number: number; labels: string[]; count: number }>();
  for (const run of runs) {
    const key = `${run.engine}:${run.accountId}`;
    const group = groups.get(key) ?? { engine: run.engine, name: run.name, number: run.number, labels: [], count: 0 };
    if (run.label) group.labels.push(run.label);
    group.count++;
    groups.set(key, group);
  }
  const ordered = [...groups.values()].sort((a, b) => ENGINES.indexOf(a.engine) - ENGINES.indexOf(b.engine) || a.number - b.number || byText(a.name, b.name));
  const parts: string[] = [];
  let left = MAX_LABELS;
  let more = 0;
  for (const group of ordered) {
    const shown = group.labels.sort(byText).slice(0, left);
    left -= shown.length;
    more += group.count - shown.length;
    if (shown.length) parts.push(`${group.name}: ${shown.join(", ")}`);
  }
  if (!parts.length) parts.push(`${ordered[0].name}: +${more}`);
  else if (more) parts[parts.length - 1] += `, +${more}`;
  return ` Still on ${parts.join("; ")}.`;
}

export function createAccountNotices(deps: {
  names: Pick<AccountNames, "get" | "nameOf">;
  sync(): void;
  runs(timeoutMs: number): Promise<WorkerRuns>;
  schedule?(run: () => void): void;
}) {
  const schedule = deps.schedule ?? ((run: () => void) => { setImmediate(run); });
  const boot = new Map<Engine, Main>();
  const committed = new Map<Engine, Main>();
  const seen = new Map<string, Main>();
  let snapshot: { seq: number; runs: Run[] } | null = null;
  let wanted = 0;
  let busy = false;

  const syncNames = () => {
    try { deps.sync(); } catch { /* a stale name beats no notice */ }
  };
  const refresh = () => {
    const seq = wanted;
    void deps.runs(REFRESH_MS).then((result) => {
      if (!result.known) return;
      syncNames();
      snapshot = { seq, runs: result.runs.map((run) => ({ ...run, name: deps.names.nameOf(run.accountId, run.engine), number: deps.names.get(run.accountId)?.number ?? Infinity })) };
    }).catch(() => {}).finally(() => {
      busy = false;
      if (wanted !== seq) queue();
    });
  };
  const queue = () => {
    if (busy) return;
    busy = true;
    schedule(refresh);
  };

  return {
    mainChanged(change: MainChange) {
      // The old Main may be removed before the bot's next turn.
      const was = deps.names.nameOf(change.from.id, change.engine);
      syncNames();
      if (!boot.has(change.engine)) boot.set(change.engine, { ...change.from, name: was, seq: 0 });
      committed.set(change.engine, { ...change.to, name: deps.names.nameOf(change.to.id, change.engine), seq: change.seq });
      wanted = Math.max(wanted, change.seq);
      queue();
    },
    forTurn(botId: string) {
      const sentences: string[] = [];
      const still: Run[] = [];
      const delivered = new Map<string, Main>();
      for (const engine of ENGINES) {
        const main = committed.get(engine);
        if (!main) continue;
        const key = `${botId}:${engine}`;
        const was = seen.get(key) ?? boot.get(engine)!;
        if (was.seq >= main.seq) continue;
        if (was.id === main.id && was.generation === main.generation) {
          seen.set(key, main);
          continue;
        }
        if (!snapshot || snapshot.seq < main.seq) continue;
        const runs = snapshot.runs.filter((run) => run.botId === botId && run.engine === engine);
        if (!runs.length) {
          seen.set(key, main);
          continue;
        }
        sentences.push(`${LABELS[engine]} Main is now ${main.name} (was ${was.name}).`);
        still.push(...runs.filter((run) => run.accountId !== main.id || run.accountGeneration !== main.generation));
        delivered.set(key, main);
      }
      const text = sentences.length
        ? `Account note: ${sentences.join(" ")} Replies already resolved keep their account.${still.length ? stillOn(still) : ""}`
        : null;
      return {
        text,
        commit() {
          for (const [key, main] of delivered) if ((seen.get(key)?.seq ?? 0) < main.seq) seen.set(key, main);
        },
      };
    },
    forget(botId: string) {
      for (const engine of ENGINES) seen.delete(`${botId}:${engine}`);
    },
  };
}
