// Building asks whose ref names a GitHub PR close as done once it merges. take() never waits on gh: it uses what the last check found.
import { z } from "zod";

import { ghRun, type MapGh } from "./map-pr.ts";
import type { TaskAsk } from "./task-asks.ts";
import { UNLANDED_REFRESH_MS } from "./unlanded.ts";

const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i;
const PR_REF = /\bPR\s*#?(\d{1,6})\b/i;
const viewSchema = z.object({ state: z.enum(["OPEN", "MERGED", "CLOSED"]) });

/** The PR an ask's ref names, by URL or "PR n"; null for any other ref. */
export function askPr(ref: string | undefined): { repo?: string; number: number } | null {
  const url = ref ? PR_URL.exec(ref) : null;
  if (url) return { repo: url[1]!.toLowerCase(), number: Number(url[2]) };
  const named = ref ? PR_REF.exec(ref) : null;
  return named ? { number: Number(named[1]) } : null;
}

export interface AskPrsDeps {
  /** where gh resolves "PR n" with no repo: the folder this task pinned */
  repoDir: (botId: string, threadId: string) => string | undefined;
  gh?: MapGh;
  now?: () => number;
}

export function createAskPrs(deps: AskPrsDeps) {
  const gh = deps.gh ?? ghRun;
  const now = deps.now ?? Date.now;
  const checked = new Map<string, { at: number; merged: boolean }>();
  const running = new Map<string, Promise<void>>();

  async function check(key: string, pr: { repo?: string; number: number }, dir: string | undefined) {
    let merged = false;
    try {
      const raw: unknown = JSON.parse(await gh(dir ?? process.cwd(), ["pr", "view", String(pr.number), ...pr.repo ? ["--repo", pr.repo] : [], "--json", "state"]));
      merged = viewSchema.parse(raw).state === "MERGED";
    } catch { /* no gh, signed out or offline: the ask stays as it is */ }
    checked.set(key, { at: now(), merged });
  }

  return {
    /** Ids of building asks whose PR the last check found merged; starts a check for the rest. */
    take(botId: string, threadId: string, asks: readonly TaskAsk[] | undefined): string[] {
      const dir = deps.repoDir(botId, threadId);
      const merged: string[] = [];
      for (const ask of asks ?? []) {
        const pr = ask.status === "building" ? askPr(ask.ref) : null;
        if (!pr || (!pr.repo && !dir)) continue;
        const key = `${pr.repo ?? dir}|${pr.number}`;
        const last = checked.get(key);
        if (last?.merged) merged.push(ask.id);
        else if (!running.has(key) && (!last || now() - last.at >= UNLANDED_REFRESH_MS)) {
          running.set(key, check(key, pr, dir).finally(() => running.delete(key)));
        }
      }
      return merged;
    },
    /** Resolves once every check started so far has finished. */
    settled: () => Promise.all([...running.values()]).then(() => {}),
  };
}
