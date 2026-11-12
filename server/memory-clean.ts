import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { cleanFiles } from "./memory-clean-engine.ts";
import { appendBlock, cleanFileSchema, hashText, HISTORY_FILE, isHistory, legacyCounts, lineHash, parseHistory, undoBlock, voidBlock } from "./memory-clean-format.ts";
import { memoryCleanHome, type HomeInput } from "./memory-clean-home.ts";
import { sleepInput } from "./memory-clean-input.ts";
import type { BotCleanState, CleanFile, HistoryRun, MemoryCleanState, MemoryCleanSummary, MemoryCleanUndoResult, TextCall } from "./memory-clean-types.ts";
import { undoText } from "./memory-clean-undo.ts";
import { MEMORY_SAVE_TOOL } from "./memory-save.ts";
import type { Store } from "./store.ts";
import { isMemoryTopicName, readMemoryFile, saveMemoryFile, workspaceDir } from "./workspace.ts";

export type * from "./memory-clean-types.ts";
export { cleanFiles } from "./memory-clean-engine.ts";
export { HISTORY_FILE, POINTER_LINE, legacyCounts, lineHash, mergeParkedCopy, parseHistory, runItems } from "./memory-clean-format.ts";
export { sleepInput } from "./memory-clean-input.ts";
export { factTokens, validateChangeList } from "./memory-clean-validate.ts";

const DAY = 86_400_000;
const QUIET_MS = 10 * 60_000;
const RETRY_MS = 20 * 3_600_000;
const STATE_FILE = "memory-clean.json";
const time = z.number().finite().nonnegative();
const stateSchema = z.object({
  version: z.literal(1), bots: z.record(z.string(), z.object({
    lastRun: z.object({ runId: z.string(), at: time, files: z.array(cleanFileSchema) }).optional(),
    lastAttempt: z.object({ at: time, tokens: time, hash: z.string() }).optional(),
    sideHashes: z.record(cleanFileSchema, z.string()).optional(), typed: z.array(z.string().regex(/^[0-9a-f]{16}$/)).max(2000).optional(),
  })),
});

function readState(dataDir: string): MemoryCleanState {
  try { return stateSchema.parse(JSON.parse(readFileSync(join(dataDir, STATE_FILE), "utf8"))) as MemoryCleanState; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, bots: {} };
    // saving over an unreadable file would drop its typed protections
    console.warn("[memory-clean] invalid local state");
    throw error;
  }
}

function saveState(dataDir: string, state: MemoryCleanState): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, STATE_FILE), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

// past 2,000, hashes of lines no memory file holds go first; hashes being added stay
function capTyped(botId: string, hashes: string[], added: ReadonlySet<string>): string[] {
  if (hashes.length <= 2000) return hashes;
  try {
    const dir = workspaceDir(botId);
    let names: string[] = [];
    try { names = readdirSync(join(dir, "memory")).filter((name) => name.endsWith(".md") && !isHistory(`memory/${name}`)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const live = new Set([readFile(join(dir, "MEMORY.md")), ...names.map((name) => readFile(join(dir, "memory", name)))].flatMap((text) => text?.split("\n").filter((line) => line.trim()).map(lineHash) ?? []));
    return hashes.filter((hash) => live.has(hash) || added.has(hash)).slice(-2000);
  } catch { return hashes.slice(-2000); }
}

export function recordTypedLines(botId: string, before: string, after: string, dataDir = DATA_DIR): void {
  try {
    const state = readState(dataDir);
    const bot = state.bots[botId] ??= {};
    const previous = new Set(before.split("\n").map((line) => line.trim()));
    const hashes = new Set(bot.typed ?? []);
    const added = new Set(after.split("\n").flatMap((line) => line.trim() && !previous.has(line.trim()) ? [lineHash(line)] : []));
    added.forEach((hash) => hashes.add(hash));
    bot.typed = capTyped(botId, [...hashes], added);
    saveState(dataDir, state);
  } catch { console.warn("[memory-clean] typed lines could not be saved"); }
}

export function typedHashes(botId: string, dataDir = DATA_DIR): string[] {
  try { return [...(readState(dataDir).bots[botId]?.typed ?? [])]; } catch { return []; }
}

export function ownLines(botId: string, add: readonly string[], remove: readonly string[] = [], dataDir = DATA_DIR): void {
  if (!add.length && !remove.length) return;
  const state = readState(dataDir);
  const bot = state.bots[botId] ??= {};
  const drop = new Set(remove);
  bot.typed = capTyped(botId, [...new Set([...(bot.typed ?? []).filter((hash) => !drop.has(hash)), ...add])], new Set(add));
  saveState(dataDir, state);
}

function backup(dataDir: string, botId: string, runId: string, at: number, files: ReadonlyArray<readonly [string, string | null]>): void {
  const root = join(dataDir, "sleep", botId);
  for (const [file, text] of files) {
    if (text === null) continue;
    const path = join(root, runId, file);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, text, { mode: 0o600 });
  }
  for (const name of readdirSync(root)) {
    const day = /^mc-(\d{4})(\d{2})(\d{2})-[0-9a-f]{8}$/.exec(name);
    if (day && at - Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) > 14 * DAY) rmSync(join(root, name), { recursive: true, force: true });
  }
}

type CleanStore = Pick<Store, "bots" | "bot" | "onChange" | "messagesFor" | "appendMessage" | "patchMessage">;
export type MemoryCleanDeps = {
  store: CleanStore;
  dataDir: string;
  engine(botId: string): Promise<{ propose: TextCall; recall: TextCall; key?: string } | null>;
  busy(): boolean;
  pending(botId: string): boolean;
  home(botId: string): HomeInput;
  now?(): number;
};

function readFile(path: string): string | null {
  try {
    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    // a lossy decode would be written back, backup included
    if (!Buffer.from(text).equals(bytes)) throw new Error(`Not UTF-8: ${path}`);
    return text;
  } catch (error) {
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
  let disposed = false;
  let lastUserAt = now();
  let epoch = 0;
  const touched = new Map<string, number>();
  let active: { botId: string; controller: AbortController; done: Promise<void> } | null = null;
  let undoing = false;
  const stateFor = (botId: string): BotCleanState => readState(deps.dataDir).bots[botId] ?? {};
  const update = (botId: string, apply: (state: BotCleanState) => void) => {
    const state = readState(deps.dataDir);
    apply(state.bots[botId] ??= {});
    saveState(deps.dataDir, state);
  };
  const quiet = (botId: string) => !deps.busy() && !deps.pending(botId) && now() - lastUserAt >= QUIET_MS && now() - (touched.get(botId) ?? 0) >= QUIET_MS;
  const turnStarted = () => { epoch++; active?.controller.abort(); };
  const touch = (botId: string) => { touched.set(botId, now()); if (active?.botId === botId) turnStarted(); };
  const unsubscribe = deps.store.onChange((change) => {
    if (change.type === "bot" && deps.busy()) turnStarted();
    if (change.type !== "message" || change.imported) return;
    if (change.message.role === "user" && !change.message.from && !change.message.origin) { lastUserAt = now(); turnStarted(); }
  });

  const run = async (botId: string, controller: AbortController) => {
    const runEpoch = epoch;
    const state = stateFor(botId);
    const home = memoryCleanHome(deps.home(botId));
    if (!home.home || !quiet(botId)) return;
    const base = readMemoryFile(botId);
    const memory = readFile(join(workspaceDir(botId), "MEMORY.md"));
    if (memory === null) return;
    // a paid night that did not land is not paid for again on the same memory within 20 hours
    if (state.lastAttempt?.hash === hashText(memory) && now() - state.lastAttempt.at < RETRY_MS) return;
    const historyFile = (/memory\/memory-history(?:-\d+)?\.md/.exec(memory)?.[0] ?? HISTORY_FILE) as CleanFile;
    const history = readFile(join(workspaceDir(botId), historyFile));
    const named = memory.match(/memory\/[\w][\w .-]*?\.md\b|(?<![\w./\\-])[a-z0-9_][a-z0-9_.-]*\.md\b/g) ?? [];
    const side = [...new Set(named.map((name) => name.startsWith("memory/") ? name : `memory/${name}`))].flatMap((file) => {
      if (!isMemoryTopicName(file.slice(7)) || isHistory(file) || /\.conflict-/.test(file)) return [];
      const text = readFile(join(workspaceDir(botId), file));
      return text !== null && Buffer.byteLength(text) >= 48000 && state.sideHashes?.[file as CleanFile] !== hashText(text) ? [{ file: file as CleanFile, text }] : [];
    }).sort((a, b) => Buffer.byteLength(b.text) - Buffer.byteLength(a.text))[0];
    const engine = await deps.engine(botId);
    if (!engine || controller.signal.aborted || epoch !== runEpoch || !quiet(botId)) return;
    const localTyped = typedHashes(botId, deps.dataDir);
    // an undone night gives back the lines it read
    const newest = histories(botId).filter((item) => !item.run.undo).at(-1)?.run.header;
    const thread = deps.store.bot(botId);
    const input = sleepInput(thread ? deps.store.messagesFor(thread.threadId) : [], newest ? newest.v === 2 ? newest.through : newest.at : null, now(), newest?.v === 2 ? newest.held : undefined);
    const topicText = (file: CleanFile) => readFile(join(workspaceDir(botId), file));
    const result = await cleanFiles({ memory, side, history, typed: new Set([...localTyped, ...home.typed]), user: input.user, through: input.through, topic: topicText, ...engine, now: now(), signal: controller.signal });
    console.info(`[memory-clean] ${botId} ${result.ok ? "slept" : result.stage} tokens ${result.tokens ?? 0}`);
    if (result.tokens) update(botId, (state) => { state.lastAttempt = { at: now(), tokens: result.tokens!, hash: hashText(memory) }; });
    if (!result.ok) return;
    if (controller.signal.aborted || runEpoch !== epoch || !quiet(botId)) return;
    const currentEngine = await deps.engine(botId);
    if (!currentEngine || currentEngine.key !== engine.key) return;
    const currentHome = memoryCleanHome(deps.home(botId));
    if (controller.signal.aborted || runEpoch !== epoch || !quiet(botId) || !currentHome.home || currentHome.fence !== home.fence ||
      readMemoryFile(botId).revision !== base.revision || readFile(join(workspaceDir(botId), "MEMORY.md")) !== memory ||
      readFile(join(workspaceDir(botId), historyFile)) !== history || (side && readFile(join(workspaceDir(botId), side.file)) !== side.text) ||
      result.topics.some((topic) => topicText(topic.file) !== topic.before) || typedHashes(botId, deps.dataDir).some((hash) => !localTyped.includes(hash))) return;
    const target = /memory\/memory-history(?:-\d+)?\.md/.exec(result.memory)?.[0] as CleanFile;
    const targetPath = join(workspaceDir(botId), target);
    let targetText = history ?? "";
    let existing: string | null = null;
    if (target !== historyFile) {
      // an undone night can leave its rotation target behind
      existing = readFile(targetPath);
      targetText = existing ?? `Previous history: ${historyFile}\n\n`;
    }
    if (parseHistory(targetText).some((item) => item.header.runId === result.runId)) return;
    backup(deps.dataDir, botId, result.runId, result.header.at, [["MEMORY.md", memory], [historyFile, history], ...(side ? [[side.file, side.text] as const] : []), ...result.topics.map((topic) => [topic.file, topic.before] as const)]);
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    const archived = appendBlock(targetText, result.block);
    // a night that does not land takes back its archive, side and topic writes, or voids its run when one changed since
    const wrote: Array<{ path: string; before: string | null; text: string }> = [];
    const put = (path: string, before: string | null, text: string) => { writeFileAtomic(path, text, { mode: 0o600 }); wrote.push({ path, before, text }); };
    let landed = false;
    try {
      put(targetPath, target === historyFile ? history : existing, archived);
      if (readMemoryFile(botId).revision !== base.revision || readFile(targetPath) !== archived || (side && readFile(join(workspaceDir(botId), side.file)) !== side.text)) return;
      if (result.side) put(join(workspaceDir(botId), result.side.file), side!.text, result.side.text);
      if (readFile(targetPath) !== archived || (result.side && readFile(join(workspaceDir(botId), result.side.file)) !== result.side.text)) return;
      for (const topic of result.topics) {
        if (topicText(topic.file) !== topic.before) return;
        put(join(workspaceDir(botId), topic.file), topic.before, topic.text);
      }
      landed = !saveMemoryFile(botId, result.memory, base.revision, true).conflict;
    } finally {
      for (const file of landed ? [] : wrote.reverse()) {
        const current = readFile(file.path);
        if (current === file.text) {
          if (file.before === null) rmSync(file.path, { force: true });
          else writeFileAtomic(file.path, file.before, { mode: 0o600 });
        } else if (file.path === targetPath && current !== null) writeFileAtomic(targetPath, appendBlock(current, voidBlock(result.runId, now())), { mode: 0o600 });
      }
    }
    if (!landed) return;
    ownLines(botId, result.owned, [], deps.dataDir);
    const bot = deps.store.bot(botId);
    if (bot) deps.store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: MEMORY_SAVE_TOOL, ok: true, spoken: "Tidied memory, nothing lost", tidy: { runId: result.runId } } });
    update(botId, (state) => {
      state.lastRun = { runId: result.runId, at: result.header.at, files: Object.keys(result.header.files) as CleanFile[] };
      delete state.lastAttempt;
      if (result.side) (state.sideHashes ??= {})[result.side.file] = hashText(result.side.text);
    });
  };

  const runBot = (botId: string) => {
    if (disposed || active || undoing) return Promise.resolve();
    const controller = new AbortController();
    const task = { botId, controller, done: Promise.resolve() };
    active = task;
    task.done = run(botId, controller).catch(() => console.warn("[memory-clean] run failed")).finally(() => { if (active === task) active = null; });
    return task.done;
  };

  const summary = (botId: string): MemoryCleanSummary => {
    const newest = histories(botId).at(-1)?.run;
    const info = newest?.header.files["MEMORY.md"];
    if (!newest || !info) return { run: null };
    return { run: { runId: newest.header.runId, at: newest.header.at, files: Object.keys(newest.header.files) as CleanFile[], beforeBytes: info.beforeBytes, afterBytes: info.afterBytes,
      ...legacyCounts(newest), undoneAt: newest.undo?.at ?? null, undoable: !newest.undo && !active && !undoing } };
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
        // a topic or side file the user deleted reads as empty
        const before = readFile(path) ?? (file === "MEMORY.md" ? null : "");
        if (before === null) throw new Error("Missing cleanup file");
        return { file, path, before, ...undoText(file as CleanFile, before, found.run) };
      }).sort((a, b) => Number(b.file === "MEMORY.md") - Number(a.file === "MEMORY.md"));
      const current = (path: string) => readFile(path) ?? "";
      const restored = changes.reduce((n, file) => n + file.restored, 0);
      const skipped = changes.reduce((n, file) => n + file.skipped, 0);
      if (deps.busy() || readMemoryFile(botId).revision !== baseRevision || readFile(join(workspaceDir(botId), found.file)) !== found.text || changes.some((file) => current(file.path) !== file.before)) return { ok: false, error: "busy" };
      // the undone marker goes last, so a failed write leaves the run undoable
      for (const file of changes) {
        if (current(file.path) !== file.before || readFile(join(workspaceDir(botId), found.file)) !== found.text) return { ok: false, error: "busy" };
        if (file.file === "MEMORY.md") {
          ownLines(botId, found.run.entries.flatMap((entry) => entry.lines.filter((line) => line.trim()).map(lineHash)), found.run.entries.flatMap((entry) => entry.header.owned ?? []), deps.dataDir);
          if (saveMemoryFile(botId, file.text, baseRevision, true).conflict) return { ok: false, error: "busy" };
        } else if (!file.text && (!file.before || found.run.header.files[file.file as CleanFile]?.beforeBytes === 0)) rmSync(file.path, { force: true });
        else writeFileAtomic(file.path, file.text, { mode: 0o600 });
      }
      const at = now();
      writeFileAtomic(join(workspaceDir(botId), found.file), appendBlock(found.text, undoBlock({ v: 1, runId, at, restored, skipped })), { mode: 0o600 });
      const bot = deps.store.bot(botId);
      const row = bot && deps.store.messagesFor(bot.threadId).find((message) => message.tool?.tidy?.runId === runId);
      if (bot && row?.tool) deps.store.patchMessage(bot.threadId, row.id, { tool: { ...row.tool, spoken: "Memory cleanup undone", tidy: { runId, undoneAt: at } } });
      return { ok: true, revision: readMemoryFile(botId).revision, restored, skipped };
    } finally { undoing = false; }
  };

  return {
    touch, turnStarted, run: runBot, summary, undo,
    async idle() { if (active) await active.done; },
    dispose() { disposed = true; unsubscribe(); active?.controller.abort(); },
  };
}
