import { opendir, realpath, stat } from "node:fs/promises";
import { freemem } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { VERIFY_LIMITS } from "../shared/live-verify.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { resolveVerifySite } from "./verify-site.ts";

const WEB = new Set([".html", ".htm", ".css", ".js", ".mjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"]);
const SKIP = new Set(["node_modules", "coverage"]);
const OPT_OUT = /(?:^|[.!?,;:\n])\s*(?:please\s+)?(?:don['’]?t|do\s+not|never)\s+(?:(?:check|verify|test)(?:\s*[/,]\s*(?:check|verify|test))*|run\s+(?:checks?|verification|tests?))\b|\bskip\s+(?:checks?|verification|tests?|testing)\b|(?:확인|검사|검증|테스트)\s*(?:하지\s*마|하지\s*말|빼고|없이)/i;
const SHELL = /^(?:bash|shell|exec(?:_command)?|execute(?:_command)?|powershell|terminal|run_(?:shell_)?command)$/i;

export interface VerifyAutoTurn {
  botId: string;
  threadId: string;
  turnId?: string;
  startedAt: number;
  roots: string[];
  depth: number;
  ok: boolean;
  routine?: boolean;
  interrupted?: boolean;
  superseded?: boolean;
  humanId: string;
  humanText: string;
  reply: string;
}

interface AutoStart { botId: string; threadId: string; entry: string; episode: string }
interface VerifyAutoDeps {
  enabled(): boolean;
  startAuto(input: AutoStart): Promise<boolean | void>;
  cancelQueued?(threadId: string): void;
  log(line: string): void;
  freeMemory?(): number;
  scan?: typeof scanVerifyWrites;
}
interface ToolTurn { tools: number; opaque: boolean; writes: Set<string>; sequence: number; checked?: number; names: Map<string, { title: string; shell: boolean }> }

export async function scanVerifyWrites(root: string, since: number): Promise<string[]> {
  const paths: string[] = [];
  const ends = performance.now() + VERIFY_LIMITS.scanMs;
  let entries = 0;
  let stopped = false;
  const walk = async (folder: string): Promise<void> => {
    if (stopped || performance.now() >= ends || entries >= VERIFY_LIMITS.scanEntries) return;
    try {
      for await (const entry of await opendir(folder)) {
        if (stopped || performance.now() >= ends || entries++ >= VERIFY_LIMITS.scanEntries) break;
        if (entry.name.startsWith(".") || SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile() && WEB.has(extname(path).toLowerCase()) && (await stat(path)).mtimeMs >= since - 2_000 && !stopped) paths.push(path);
      }
    } catch {}
  };
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([walk(root), new Promise<void>(done => { timer = setTimeout(() => { stopped = true; done(); }, VERIFY_LIMITS.scanMs); })]);
  } finally { stopped = true; clearTimeout(timer!); }
  return paths;
}

async function entryFor(paths: string[], turn: VerifyAutoTurn): Promise<string | undefined> {
  const roots = (await Promise.all(turn.roots.map(root => realpath(root).catch(() => null)))).filter(root => root !== null);
  const owned = (path: string) => roots.some(root => {
    const rel = relative(root, path);
    return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  });
  const candidates = (await Promise.all(paths.filter(path => WEB.has(extname(path).toLowerCase())).map(async path => {
    const full = await realpath(resolve(turn.roots[0]!, path)).catch(() => null);
    if (!full || !owned(full)) return null;
    const info = await stat(full).catch(() => null);
    return info?.isFile() ? { path: full, mtime: info.mtimeMs } : null;
  }))).filter(row => row !== null).sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) return;
  const urls = `${turn.reply}\n${turn.humanText}`.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  for (const candidate of candidates) {
    for (let folder = dirname(candidate.path); owned(folder);) {
      if ((await stat(join(folder, "package.json")).catch(() => null))?.isFile()) {
        for (const url of urls) {
          try {
            const site = await resolveVerifySite(url.replace(/[),.;]+$/, ""), turn.roots);
            if (typeof site !== "string" && /^https?:/.test(site.root)) return site.root;
          } catch {}
        }
        break;
      }
      const parent = dirname(folder);
      if (parent === folder) break;
      folder = parent;
    }
  }
  const newest = candidates[0]!;
  if (/\.html?$/i.test(newest.path) && !/^index\.html?$/i.test(newest.path.split(/[\\/]/).at(-1)!)) {
    if (typeof await resolveVerifySite(newest.path, turn.roots) !== "string") return newest.path;
  }
  for (let folder = dirname(newest.path); owned(folder);) {
    if ((await stat(join(folder, "index.html")).catch(() => null))?.isFile() && typeof await resolveVerifySite(folder, turn.roots) !== "string") return join(folder, "index.html");
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
}

export function createVerifyAuto(deps: VerifyAutoDeps) {
  const turns = new Map<string, ToolTurn>();
  const latest = new Map<string, object>();
  const key = (threadId: string, turnId?: string) => JSON.stringify([threadId, turnId]);
  const event = (event: RuntimeEvent) => {
    if (event.type !== "item.started" && event.type !== "item.completed" || event.itemType !== "tool" || !deps.enabled()) return;
    const id = key(event.threadId, event.turnId);
    let turn = turns.get(id);
    if (!turn) { turn = { tools: 0, opaque: false, writes: new Set(), sequence: 0, names: new Map() }; turns.set(id, turn); }
    if (event.type === "item.started") {
      turn.tools++;
      if (event.itemId) turn.names.set(event.itemId, { title: event.title ?? "", shell: SHELL.test(event.verb ?? event.title ?? "") });
      return;
    }
    const name = event.itemId ? turn.names.get(event.itemId) : undefined;
    if (event.itemId) turn.names.delete(event.itemId);
    if (name === undefined) turn.tools++;
    if (!event.ok || name?.title.includes("verify_site")) return;
    turn.sequence++;
    if (!event.writes?.length && (name?.shell || event.provider === "antigravityAgent" || event.provider === "museAgent")) turn.opaque = true;
    for (const path of event.writes?.slice(0, 32) ?? []) turn.writes.add(path);
  };
  const checkStarted = (threadId: string, turnId: string) => {
    const id = key(threadId, turnId), turn = turns.get(id), sequence = turn?.sequence;
    return () => { if (turn && turns.get(id) === turn) turn.checked = sequence; };
  };
  const settled = async (input: VerifyAutoTurn) => {
    const id = key(input.threadId, input.turnId), turn = turns.get(id);
    turns.delete(id);
    if (!turn?.tools || !turn.writes.size && !turn.opaque || !deps.enabled() || !input.ok || input.depth !== 0 || input.routine || input.interrupted || input.superseded || !input.roots[0] || OPT_OUT.test(input.humanText) || turn.checked !== undefined && turn.checked >= turn.sequence) return;
    const free = (deps.freeMemory ?? freemem)();
    if (free < VERIFY_LIMITS.autoFreeBytes) { deps.log(`Live Verify: skipped, low memory ${Math.floor(free / 1024 ** 2)} MiB`); return; }
    const token = {};
    latest.set(input.threadId, token);
    deps.cancelQueued?.(input.threadId);
    try {
      const paths = [...turn.writes];
      if (turn.opaque) paths.push(...await (deps.scan ?? scanVerifyWrites)(input.roots[0], input.startedAt));
      const entry = await entryFor([...new Set(paths)], input);
      if (latest.get(input.threadId) !== token) return;
      if (!entry) { deps.log(`Live Verify: no entry for ${input.threadId}`); return; }
      if (await deps.startAuto({ botId: input.botId, threadId: input.threadId, entry, episode: JSON.stringify([input.botId, input.threadId, input.humanId, entry]) }) === false) deps.log(`Live Verify: skipped ${input.threadId}`);
    } catch { deps.log(`Live Verify: skipped ${input.threadId}`); }
    finally { if (latest.get(input.threadId) === token) latest.delete(input.threadId); }
  };
  return { event, checkStarted, settled };
}
