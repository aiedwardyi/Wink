import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { cleanFiles } from "./memory-clean-engine.ts";
import { appendBlock, cleanFileSchema, hashText, HISTORY_FILE, isHistory, lineHash, parseHistory, undoBlock } from "./memory-clean-format.ts";
import { memoryCleanHome, type HomeInput } from "./memory-clean-home.ts";
import type { BotCleanState, CleanFile, HistoryRun, MemoryCleanState, MemoryCleanSummary, MemoryCleanUndoResult, TextCall } from "./memory-clean-types.ts";
import { undoText } from "./memory-clean-undo.ts";
import { MEMORY_SAVE_TOOL } from "./memory-save.ts";
import type { Store } from "./store.ts";
import { isMemoryTopicName, readMemoryFile, saveMemoryFile, workspaceDir } from "./workspace.ts";

export type * from "./memory-clean-types.ts";
export { cleanFiles } from "./memory-clean-engine.ts";
export { HISTORY_FILE, POINTER_LINE, lineHash, mergeParkedCopy, parseHistory } from "./memory-clean-format.ts";
export { factTokens, validateChangeList } from "./memory-clean-validate.ts";

const DAY = 86_400_000;
const QUIET_MS = 10 * 60_000;
const RUN_INTERVAL_MS = 6 * 60 * 60_000;
const STATE_FILE = "memory-clean.json";
const time = z.number().finite().nonnegative();
const stateSchema = z.object({
  version: z.literal(1), bots: z.record(z.string(), z.object({
    checkedAt: time.optional(), queued: z.object({ at: time, reason: z.enum(["size", "dropped"]) }).optional(),
    lastRun: z.object({ runId: z.string(), at: time, files: z.array(cleanFileSchema) }).optional(),
    cooldownUntil: time.optional(), backoff: z.record(cleanFileSchema, time).optional(),
    attemptedAt: time.optional(), unchangedHash: z.string().optional(),
    sideHashes: z.record(cleanFileSchema, z.string()).optional(), typed: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(2000).optional(),
  })),
});

function readState(dataDir: string): MemoryCleanState {
  try { return stateSchema.parse(JSON.parse(readFileSync(join(dataDir, STATE_FILE), "utf8"))) as MemoryCleanState; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[memory-clean] invalid local state");
    return { version: 1, bots: {} };
  }
}

function saveState(dataDir: string, state: MemoryCleanState): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, STATE_FILE), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

export function recordTypedLines(botId: string, before: string, after: string, dataDir = DATA_DIR): void {
  try {
    const state = readState(dataDir);
    const bot = state.bots[botId] ??= {};
    const previous = new Set(before.split("\n").map((line) => line.trim()));
    const hashes = new Set(bot.typed ?? []);
    after.split("\n").forEach((line) => { if (line.trim() && !previous.has(line.trim())) hashes.add(lineHash(line)); });
    bot.typed = [...hashes].slice(-2000);
    saveState(dataDir, state);
  } catch { console.warn("[memory-clean] typed lines could not be saved"); }
}

export function typedHashes(botId: string, dataDir = DATA_DIR): string[] {
  return [...(readState(dataDir).bots[botId]?.typed ?? [])];
}

type CleanStore = Pick<Store, "bots" | "bot" | "onChange" | "messagesFor" | "appendMessage" | "patchMessage">;
export type MemoryCleanDeps = {
  store: CleanStore;
  dataDir: string;
  engine(botId: string): Promise<{ propose: TextCall; recall: TextCall; key?: string } | null>;
  busy(): boolean;
  pending(botId: string): boolean;
  dropped(botId: string): boolean;
  home(botId: string): HomeInput;
  now?(): number;
};

function readFile(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function histories(botId: string): Array<{ file: CleanFile; text: string; run: HistoryRun }> {
  let names: string[];
  try { names = readdirSync(join(workspaceDir(botId), "memory")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.filter((name) => isHistory(`memory/${name}`)).flatMap((name) => {
    const file = `memory/${name}` as CleanFile;
    const text = readFileSync(join(workspaceDir(botId), file), "utf8");
    return parseHistory(text).map((run) => ({ file, text, run }));
  }).sort((a, b) => a.run.header.at - b.run.header.at || a.run.header.runId.localeCompare(b.run.header.runId));
}

export function createMemoryClean(deps: MemoryCleanDeps) {
  const now = deps.now ?? Date.now;
  let started = false;
  let disposed = false;
  let lastUserAt = now();
  let epoch = 0;
  const touched = new Map<string, number>();
  let active: { botId: string; controller: AbortController; done: Promise<void> } | null = null;
  let undoing = false;
  let cursor = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stateFor = (botId: string) => readState(deps.dataDir).bots[botId] ?? {};
  const update = (botId: string, apply: (state: BotCleanState) => void) => {
    const state = readState(deps.dataDir);
    apply(state.bots[botId] ??= {});
    saveState(deps.dataDir, state);
  };
  const quiet = (botId: string) => !deps.busy() && !deps.pending(botId) && now() - lastUserAt >= QUIET_MS && now() - (touched.get(botId) ?? 0) >= QUIET_MS;
  const turnStarted = () => { epoch++; active?.controller.abort(); };
  const touch = (botId: string) => { touched.set(botId, now()); if (active?.botId === botId) turnStarted(); };
  const check = (botId: string) => {
    if (disposed) return;
    try {
      const memory = readFile(join(workspaceDir(botId), "MEMORY.md"));
      if (memory === null) return;
      update(botId, (state) => {
        state.checkedAt = now();
        const dropped = deps.dropped(botId);
        if (dropped || Buffer.byteLength(memory) >= 19200 || memory.split("\n").length >= 160) {
          state.queued = { at: state.queued?.at ?? now(), reason: dropped || state.queued?.reason === "dropped" ? "dropped" : "size" };
        } else delete state.queued;
      });
    } catch { console.warn("[memory-clean] size check failed"); }
  };
  const unsubscribe = deps.store.onChange((change) => {
    if (change.type === "bot" && deps.busy()) turnStarted();
    if (change.type !== "message" || change.imported) return;
    if (change.message.role === "user" && !change.message.from && !change.message.origin) { lastUserAt = now(); turnStarted(); }
    const bot = deps.store.bots.find((row) => row.threadId === change.threadId);
    if (bot && change.message.tool?.name === MEMORY_SAVE_TOOL && !change.message.tool.tidy) check(bot.id);
  });

  const run = async (botId: string, controller: AbortController) => {
    const runEpoch = epoch;
    const state = stateFor(botId);
    const home = memoryCleanHome(deps.home(botId));
    if (!home.home || !quiet(botId)) return;
    const newest = histories(botId).at(-1)?.run.header;
    if (state.queued?.reason !== "dropped" && Math.max(state.cooldownUntil ?? 0, newest ? newest.at + 7 * DAY : 0) > now()) return;
    const attemptedAt = Math.max(state.attemptedAt ?? -Infinity, newest?.at ?? -Infinity);
    if (now() - attemptedAt < RUN_INTERVAL_MS) return;
    const base = readMemoryFile(botId);
    const memory = readFile(join(workspaceDir(botId), "MEMORY.md"));
    if (memory === null || (state.backoff?.["MEMORY.md"] ?? 0) > now()) return;
    const historyFile = (/memory\/memory-history(?:-\d+)?\.md/.exec(memory)?.[0] ?? HISTORY_FILE) as CleanFile;
    const history = readFile(join(workspaceDir(botId), historyFile));
    const side = [...new Set(memory.match(/memory\/[\w][\w .-]*?\.md\b/g) ?? [])].flatMap((file) => {
      if (!isMemoryTopicName(file.slice(7)) || isHistory(file) || /\.conflict-/.test(file) || (state.backoff?.[file as CleanFile] ?? 0) > now()) return [];
      const text = readFile(join(workspaceDir(botId), file));
      return text !== null && Buffer.byteLength(text) >= 48000 && state.sideHashes?.[file as CleanFile] !== hashText(text) ? [{ file: file as CleanFile, text }] : [];
    }).sort((a, b) => Buffer.byteLength(b.text) - Buffer.byteLength(a.text))[0];
    const sourceHash = hashText(JSON.stringify([memory, side?.file, side?.text]));
    if (state.unchangedHash === sourceHash) return;
    const engine = await deps.engine(botId);
    if (!engine || controller.signal.aborted || epoch !== runEpoch || !quiet(botId)) return;
    const localTyped = typedHashes(botId, deps.dataDir);
    update(botId, (state) => { state.attemptedAt = now(); });
    const result = await cleanFiles({ memory, side, history, typed: new Set([...localTyped, ...home.typed]), ...engine, now: now(), signal: controller.signal });
    if (!result.ok) {
      if (result.stage === "nothing" || result.stage === "validate") update(botId, (state) => { state.unchangedHash = sourceHash; });
      if (result.stage === "recall") update(botId, (state) => {
        (state.backoff ??= {})["MEMORY.md"] = now() + 14 * DAY;
        if (side) state.backoff[side.file] = now() + 14 * DAY;
      });
      return;
    }
    if (controller.signal.aborted || runEpoch !== epoch || !quiet(botId)) return;
    const currentEngine = await deps.engine(botId);
    if (!currentEngine || currentEngine.key !== engine.key) return;
    const currentHome = memoryCleanHome(deps.home(botId));
    if (controller.signal.aborted || runEpoch !== epoch || !quiet(botId) || !currentHome.home || currentHome.fence !== home.fence ||
      readMemoryFile(botId).revision !== base.revision || readFile(join(workspaceDir(botId), "MEMORY.md")) !== memory ||
      readFile(join(workspaceDir(botId), historyFile)) !== history || (side && readFile(join(workspaceDir(botId), side.file)) !== side.text) ||
      typedHashes(botId, deps.dataDir).some((hash) => !localTyped.includes(hash))) return;
    const target = /memory\/memory-history(?:-\d+)?\.md/.exec(result.memory)?.[0] as CleanFile;
    const targetPath = join(workspaceDir(botId), target);
    let targetText = history ?? "";
    if (target !== historyFile) {
      const existing = readFile(targetPath);
      if (existing !== null) return;
      targetText = `Previous history: ${historyFile}\n\n`;
    }
    if (parseHistory(targetText).some((item) => item.header.runId === result.runId)) return;
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    const archived = appendBlock(targetText, result.block);
    writeFileAtomic(targetPath, archived, { mode: 0o600 });
    if (readMemoryFile(botId).revision !== base.revision || readFile(targetPath) !== archived || (side && readFile(join(workspaceDir(botId), side.file)) !== side.text)) return;
    if (result.side) writeFileAtomic(join(workspaceDir(botId), result.side.file), result.side.text, { mode: 0o600 });
    if (readFile(targetPath) !== archived || (result.side && readFile(join(workspaceDir(botId), result.side.file)) !== result.side.text)) return;
    if (saveMemoryFile(botId, result.memory, base.revision, true).conflict) return;
    const bot = deps.store.bot(botId);
    if (bot) deps.store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: MEMORY_SAVE_TOOL, ok: true, spoken: "Tidied memory, nothing lost", tidy: { runId: result.runId } } });
    update(botId, (state) => {
      delete state.queued;
      delete state.unchangedHash;
      state.lastRun = { runId: result.runId, at: result.header.at, files: Object.keys(result.header.files) as CleanFile[] };
      state.cooldownUntil = result.header.at + 7 * DAY;
      if (result.side) (state.sideHashes ??= {})[result.side.file] = hashText(result.side.text);
    });
  };

  const tick = () => {
    if (!started || disposed || active || undoing) return;
    const bots = deps.store.bots;
    for (let offset = 0; offset < bots.length; offset++) {
      const index = (cursor + offset) % bots.length;
      const bot = bots[index]!;
      if (now() - (stateFor(bot.id).checkedAt ?? 0) >= DAY) check(bot.id);
      const state = stateFor(bot.id);
      if (!state.queued || !quiet(bot.id) || (state.cooldownUntil ?? 0) > now() && state.queued.reason !== "dropped") continue;
      const controller = new AbortController();
      const task = { botId: bot.id, controller, done: Promise.resolve() };
      active = task;
      cursor = (index + 1) % bots.length;
      task.done = run(bot.id, controller).catch(() => console.warn("[memory-clean] run failed")).finally(() => { if (active === task) active = null; });
      break;
    }
  };

  const summary = (botId: string): MemoryCleanSummary => {
    const newest = histories(botId).at(-1)?.run;
    const info = newest?.header.files["MEMORY.md"];
    if (!newest || !info) return { run: null };
    return { run: { runId: newest.header.runId, at: newest.header.at, files: Object.keys(newest.header.files) as CleanFile[], beforeBytes: info.beforeBytes, afterBytes: info.afterBytes,
      merged: newest.header.merged, replaced: newest.header.replaced, moved: newest.header.moved, undoneAt: newest.undo?.at ?? null, undoable: !newest.undo && !active && !undoing } };
  };

  const undo = async (botId: string, runId: string): Promise<MemoryCleanUndoResult> => {
    if (active || undoing || deps.busy()) return { ok: false, error: "busy" };
    const all = histories(botId);
    const found = all.find((item) => item.run.header.runId === runId);
    if (!found) return { ok: false, error: "no-run" };
    if (all.at(-1)?.run.header.runId !== runId) return { ok: false, error: "not-newest" };
    if (found.run.undo) return { ok: false, error: "undone" };
    undoing = true;
    try {
      const baseRevision = readMemoryFile(botId).revision;
      const changes = Object.keys(found.run.header.files).map((file) => {
        const path = join(workspaceDir(botId), file);
        const before = readFile(path);
        if (before === null) throw new Error("Missing cleanup file");
        return { file, path, before, ...undoText(file as CleanFile, before, found.run) };
      });
      const restored = changes.reduce((n, file) => n + file.restored, 0);
      const skipped = changes.reduce((n, file) => n + file.skipped, 0);
      if (deps.busy() || readMemoryFile(botId).revision !== baseRevision || readFile(join(workspaceDir(botId), found.file)) !== found.text || changes.some((file) => readFile(file.path) !== file.before)) return { ok: false, error: "busy" };
      const at = now();
      const archived = appendBlock(found.text, undoBlock({ v: 1, runId, at, restored, skipped }));
      writeFileAtomic(join(workspaceDir(botId), found.file), archived, { mode: 0o600 });
      for (const file of changes) {
        if (readFile(file.path) !== file.before || readFile(join(workspaceDir(botId), found.file)) !== archived) return { ok: false, error: "busy" };
        if (file.file === "MEMORY.md") {
          if (saveMemoryFile(botId, file.text, baseRevision, true).conflict) return { ok: false, error: "busy" };
        } else writeFileAtomic(file.path, file.text, { mode: 0o600 });
      }
      const bot = deps.store.bot(botId);
      const row = bot && deps.store.messagesFor(bot.threadId).find((message) => message.tool?.tidy?.runId === runId);
      if (bot && row?.tool) deps.store.patchMessage(bot.threadId, row.id, { tool: { ...row.tool, spoken: "Memory cleanup undone", tidy: { runId, undoneAt: at } } });
      return { ok: true, revision: readMemoryFile(botId).revision, restored, skipped };
    } finally { undoing = false; }
  };

  return {
    check, touch, turnStarted, tick, summary, undo,
    start() { if (!started && !disposed) { started = true; timer = setInterval(tick, 60_000); timer.unref?.(); } },
    async idle() { if (active) await active.done; },
    dispose() { disposed = true; clearInterval(timer); unsubscribe(); active?.controller.abort(); },
  };
}
