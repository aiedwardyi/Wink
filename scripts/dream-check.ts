// Dream check: one idle-tidy pass (server/memory-sleep.ts) over copies of each bot's notes, then proof no fact was lost.
// Reads a copy of ~/.orbit, never the live folder; writes only under a throwaway data dir and Claude config dir.
// node --experimental-strip-types scripts/dream-check.ts <orbit copy> [--bots id,id] [--nights 1] [--no-model] [--max-tokens 2000000] [--json out.json]
// The model pass needs CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY on a throwaway profile, or CLAUDE_CONFIG_DIR set to an account profile.
// With the model, a bot near its load budget also gets budget filing (server/memory-file.ts), shadow only: it runs nowhere else.
// A line counts as kept only where the bot still sees it: MEMORY.md, or a synced side file a loaded line says when to read.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import type { NoteGenerator } from "../server/memory-pass.ts";

// the note helper's model (server/drivers/claude.ts runHelper)
const MODEL = "claude-haiku-5-5";
// grouping notes across many overlapping side files needs more than Haiku; the quiz stays on Haiku
const FILER_MODEL = "claude-sonnet-5-5";
// both true, so a tidy must move neither: rule and exception, two people, two things, a passing state
const TRAP_PAIRS = [
  ["Prefers short replies at work (noted 2026-11-01)", "Wants detailed answers when learning something new (noted 2026-11-12)"],
  ["Allergic to peanuts (noted 2026-11-01)", "Allergic to shellfish (noted 2026-11-12)"],
  ["Alice's phone is 555-1111 (noted 2026-11-01)", "Bob's phone is 555-1111 (noted 2026-11-12)"],
  ["Uses pnpm for Wink (noted 2026-11-01)", "Uses npm for the old Orbit repo (noted 2026-11-12)"],
  ["Never posts on weekends (noted 2026-11-01)", "Posts on Saturday during launch week only (noted 2026-11-12)"],
  ["Usually answers within an hour (noted 2026-11-01)", "Is on vacation until 2026-12-01, so answers slowly (noted 2026-11-12)"],
  ["Lives in Seoul (noted 2026-11-01)", "Works from Busan on Fridays (noted 2026-11-12)"],
  ["Dana owns the Alpha launch (noted 2026-11-01)", "Lee owns the Beta launch (noted 2026-11-12)"],
  ["Likes the word harness (noted 2026-11-01)", "Dislikes the word framework (noted 2026-11-12)"],
  ["Drinks coffee in the morning (noted 2026-11-01)", "Drinks tea after lunch (noted 2026-11-12)"],
] as const;
export const TRAP_ID = "dream-trap";
export const TRAP_MEMORY = `# Memory\n\n## Notes\n${TRAP_PAIRS.flat().map((note) => `- ${note}`).join("\n")}\n`;
// the worst a model could propose: every pair a duplicate both ways and a disagreement
export const TRAP_REPLY = JSON.stringify({
  duplicates: TRAP_PAIRS.flatMap((_, pair) => [{ keep: `L${5 + 2 * pair}`, drop: [`L${4 + 2 * pair}`] }, { keep: `L${4 + 2 * pair}`, drop: [`L${5 + 2 * pair}`] }]),
  disagree: TRAP_PAIRS.map((_, pair) => [`L${4 + 2 * pair}`, `L${5 + 2 * pair}`]),
});
const QUESTIONS = 3;
// memory-health's untriggered-pointer rule (#2136): a sentence, or the one after it, says when
const TRIGGER = /\b(?:when|whenever|before|after|if|while|during|first|start|never|quotes?)\b|때|전에|먼저/i;
const NAME_CHAR = /[A-Za-z0-9_-]/;
const botsSchema = z.array(z.object({ id: z.string(), name: z.string().optional() }));
const count = z.number().default(0);
const replySchema = z.object({
  result: z.string().default(""),
  usage: z.object({ input_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count, output_tokens: count }).default({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }),
});
const sleepLogSchema = z.object({ result: z.string(), moved: z.number().optional(), ms: z.number() });

/** A bot's notes: MEMORY.md, and every other file beside it but the history by its path from the workspace, with / between folders. */
export type Notes = { memory: string; side: Record<string, string> };
/** The server's own rules, passed in: importing workspace.ts here would read the data dir before main points it at the copy. */
export type Rules = { loaded(raw: string): string; synced(name: string): boolean };
export type Block = { path: string; lines: string[] };
export type Quiz = { asked: number; right: number; misses: Array<{ path: string; question: string; answer: string }> };

// the same text but for the list mark, spacing, an Auto Notes stamp and a closing full stop, so a twin merge keeps its line
const factKey = (line: string) =>
  line.replace(/\(noted \d{4}-\d{2}-\d{2}\)/g, " ").replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim().replace(/[.。]+$/u, "");

function keys(text: string): Set<string> {
  return new Set(text.split("\n").map(factKey).filter(Boolean));
}

/** The names of `names` (side files in memory/) that a sentence of `text` points to and says when to read. */
export function pointedTopics(text: string, names: readonly string[]): string[] {
  const saysWhen = text
    .split("\n")
    .flatMap((line) => {
      const sentences = line.split(/(?<=[.!?]) /);
      return sentences.filter((sentence, index) => TRIGGER.test(sentence) || TRIGGER.test(sentences[index + 1] ?? ""));
    })
    .join("\n")
    .replaceAll("\\", "/")
    .toLowerCase();
  return names.filter((name) => {
    const path = `memory/${name.toLowerCase()}`;
    for (let at = saysWhen.indexOf(path); at !== -1; at = saysWhen.indexOf(path, at + 1)) if (!NAME_CHAR.test(saysWhen[at + path.length] ?? "")) return true;
    return false;
  });
}

/** Side files the bot reaches: synced memory/<topic>.md that a loaded line of MEMORY.md says when to read. */
function reached(notes: Notes, rules: Rules): string[] {
  const topics = Object.keys(notes.side).filter((path) => path.startsWith("memory/") && rules.synced(path.slice("memory/".length)));
  const pointed = new Set(pointedTopics(rules.loaded(notes.memory), topics.map((path) => path.slice("memory/".length))));
  return topics.filter((path) => pointed.has(path.slice("memory/".length)));
}

/** Every non-blank line of MEMORY.md before that the bot no longer reaches after: a line only in the history is lost. */
export function lostFacts(before: Notes, after: Notes, rules: Rules): string[] {
  const found = new Set([...keys(after.memory), ...reached(after, rules).flatMap((path) => [...keys(after.side[path]!)])]);
  return [...keys(before.memory)].filter((key) => !found.has(key));
}

/** Lines MEMORY.md gave up that a side file in memory/ took, by side file. */
export function movedBlocks(before: Notes, after: Notes): Block[] {
  const [had, has] = [keys(before.memory), keys(after.memory)];
  return Object.entries(after.side).flatMap(([path, text]) => {
    if (!path.startsWith("memory/")) return [];
    const was = keys(before.side[path] ?? "");
    const lines = text.split("\n").filter((line) => {
      const key = factKey(line);
      return key && had.has(key) && !has.has(key) && !was.has(key);
    });
    return lines.length ? [{ path, lines }] : [];
  });
}

/** Lines the tidy wrote that no note held before. Only a pointer line may be new, one that says when to read a side file that took lines from MEMORY.md. */
export function madeUp(before: Notes, after: Notes): string[] {
  const had = keys(before.memory);
  const took = movedBlocks(before, after).map(({ path }) => path.slice("memory/".length));
  const memory = [...keys(after.memory)].filter((key) => !had.has(key) && !pointedTopics(key, took).length);
  const side = Object.entries(after.side).flatMap(([path, text]) => {
    const was = keys(before.side[path] ?? "");
    return [...keys(text)].filter((key) => !had.has(key) && !was.has(key));
  });
  return [...memory, ...side];
}

function jsonIn<T extends z.ZodType>(output: string, schema: T): z.infer<T> | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(output.slice(start, end + 1)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function quizPrompt(blocks: readonly Block[]): string {
  return [
    `A bot moved each block of notes below out of its always-loaded memory into a side file. For each block, write ${QUESTIONS} questions that only that block's notes answer.`,
    "One of them describes a situation where the bot would need these notes without naming their subject. Each question stands alone; never mention blocks, notes or files.",
    `Reply with JSON only, one key for each of the ${blocks.length} block(s): {"B1": ["question", "question", "question"]${blocks.length > 1 ? ', "B2": ["question", "question", "question"]' : ""}}`,
    "",
    ...blocks.flatMap(({ lines }, index) => [`<block id="B${index + 1}">`, ...lines, "</block>"]),
  ].join("\n");
}

export function answerPrompt(memory: string, questions: readonly string[]): string {
  return [
    "You are a bot. MEMORY.md below loads into every session. Side files in memory/ do not; you read one only when a line in MEMORY.md says when to read it.",
    "For each question, name the one file you would read to answer it: a memory/<name>.md path, MEMORY.md when MEMORY.md itself answers it, or none.",
    `Reply with JSON only: {"Q1": "memory/example.md"}`,
    "",
    "<memory>",
    memory,
    "</memory>",
    "",
    ...questions.map((question, index) => `Q${index + 1}: ${question}`),
  ].join("\n");
}

/** The questions the writer gave each block, `QUESTIONS` at most; a block it skipped gets none, and each missing one counts as a miss. */
export function parseQuestions(output: string, blocks: readonly Block[]): string[][] {
  const parsed = jsonIn(output, z.record(z.string(), z.array(z.string())));
  return blocks.map((_, index) => (parsed?.[`B${index + 1}`] ?? []).slice(0, QUESTIONS));
}

/** A question is right only when the answerer names the side file its block went to. */
export function scoreQuiz(blocks: readonly Block[], questions: readonly string[][], output: string): Quiz {
  const answers = jsonIn(output, z.record(z.string(), z.string())) ?? {};
  const quiz: Quiz = { asked: blocks.length * QUESTIONS, right: 0, misses: [] };
  let at = 0;
  blocks.forEach(({ path }, index) => {
    const asked = questions[index] ?? [];
    for (const question of asked) {
      const answer = answers[`Q${++at}`] ?? "";
      if (answer.trim().replace(/^[`"']+|[`"']+$/g, "").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase() === path.toLowerCase()) quiz.right += 1;
      else quiz.misses.push({ path, question, answer });
    }
    for (let missing = asked.length; missing < QUESTIONS; missing += 1) quiz.misses.push({ path, question: "", answer: "" });
  });
  return quiz;
}

// the server's textTokens estimate (context-compaction.ts)
const tokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3);
const lineCount = (text: string) => (text ? text.replace(/\n$/, "").split("\n").length : 0);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((name) => join(dir, name)).filter((path) => statSync(path).isFile());
}

type Spent = { input: number; output: number };

function claudeGenerator(configDir: string, cwd: string, spent: Spent, cap: number, model = MODEL): NoteGenerator {
  return (prompt, signal, onUsage) =>
    new Promise<string>((resolve, reject) => {
      if (spent.input + spent.output >= cap) return reject(new Error("model token cap reached"));
      const child = spawn(
        process.env.CLAUDE_CLI ?? "claude",
        ["-p", "--model", model, "--output-format", "json", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
        { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4096)));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(stderr.trim() || `claude exited ${code}`));
        try {
          const { result, usage } = replySchema.parse(JSON.parse(stdout));
          const used = { input: usage.input_tokens, cachedInput: usage.cache_read_input_tokens, cacheCreation: usage.cache_creation_input_tokens, output: usage.output_tokens };
          spent.input += used.input + used.cachedInput + used.cacheCreation;
          spent.output += used.output;
          onUsage?.(used);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(prompt);
    });
}

export type BotResult = {
  id: string;
  name: string;
  night: number;
  trap: boolean;
  result: string;
  linesBefore: number;
  linesAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  /** loaded into every turn: MEMORY.md as the load budget cuts it */
  tokensBefore: number;
  tokensAfter: number;
  moved: number;
  filed: number;
  proposed: number;
  lost: string[];
  madeUp: string[];
  /** kept blocks only; a block with any miss is undone and scored in `undone` */
  quiz: Quiz;
  undone: Quiz;
  conflicts: number;
  ms: number;
  modelTokens: number;
  filingTokens: number;
  reply: string;
};

const failures = (row: BotResult) => row.lost.length + row.madeUp.length + row.quiz.misses.length + (row.trap ? row.moved : 0);

async function main(): Promise<number> {
  const [dir, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  if (!dir) throw new Error("usage: node --experimental-strip-types scripts/dream-check.ts <orbit copy> [--bots id,id] [--nights 1] [--no-model] [--max-tokens 2000000] [--json out.json]");
  const live = join(homedir(), ".orbit");
  if (existsSync(live) && realpathSync(dir).toLowerCase() === realpathSync(live).toLowerCase()) throw new Error(`${dir} is the live ~/.orbit; copy it first`);
  const model = !rest.includes("--no-model");
  const token = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY);
  if (model && !token && !process.env.CLAUDE_CONFIG_DIR) throw new Error("set CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or CLAUDE_CONFIG_DIR, or pass --no-model");
  const cap = Number(flag("max-tokens") ?? 2_000_000);
  const nights = Math.max(1, Number(flag("nights") ?? 1));

  const names = new Map<string, string>();
  try {
    for (const bot of botsSchema.parse(JSON.parse(readFileSync(join(dir, "bots.json"), "utf8")))) names.set(bot.id, bot.name ?? bot.id);
  } catch {
    // a copy of workspaces alone: ids stand in for names
  }
  const source = join(dir, "workspaces");
  const picked = flag("bots")?.split(",");
  const ids = readdirSync(source).filter((id) => id !== TRAP_ID && existsSync(join(source, id, "MEMORY.md")) && (picked ? picked.includes(id) : names.size === 0 || names.has(id)));

  const root = mkdtempSync(join(tmpdir(), "wink-dream-"));
  // read by server/config.ts at import, so it is set before the engine loads
  process.env.OMB_DATA_DIR = join(root, "data");
  const configDir = token || !process.env.CLAUDE_CONFIG_DIR ? join(root, "claude") : process.env.CLAUDE_CONFIG_DIR;
  const helperDir = join(root, "helper");
  mkdirSync(join(root, "claude"), { recursive: true });
  mkdirSync(helperDir, { recursive: true });
  for (const id of ids) {
    for (const name of ["MEMORY.md", "memory", "memory-history", "imported.md"]) {
      if (existsSync(join(source, id, name))) cpSync(join(source, id, name), join(root, "data", "workspaces", id, name), { recursive: true });
    }
  }
  mkdirSync(join(root, "data", "workspaces", TRAP_ID), { recursive: true });
  writeFileSync(join(root, "data", "workspaces", TRAP_ID, "MEMORY.md"), TRAP_MEMORY);
  const { createMemorySleep, parseTidy, SLEEP_IDLE_MS, SLEEP_TIMEOUT_MS } = await import("../server/memory-sleep.ts");
  const { isMemoryTopicName, loadedMemory, workspaceDir, PARKED_COPY } = await import("../server/workspace.ts");
  const { filingBytes, filingDue, filingPrompt, fileableNotes, misrouted, planFiling, routePrompt } = await import("../server/memory-file.ts");
  const rules: Rules = { loaded: (raw) => loadedMemory(raw).text, synced: isMemoryTopicName };

  const spent: Spent = { input: 0, output: 0 };
  const generator = model ? claudeGenerator(configDir, helperDir, spent, cap) : null;
  const ask = (prompt: string) => generator!(prompt, AbortSignal.timeout(SLEEP_TIMEOUT_MS));
  const filer = model ? claudeGenerator(configDir, helperDir, spent, cap, FILER_MODEL) : null;
  const askFiler = (prompt: string) => filer!(prompt, AbortSignal.timeout(SLEEP_TIMEOUT_MS));
  const notesOf = (ws: string): Notes => {
    const historyDir = join(ws, "memory-history");
    const side = filesUnder(ws).filter((path) => !path.startsWith(historyDir) && relative(ws, path) !== "MEMORY.md");
    return { memory: readFileSync(join(ws, "MEMORY.md"), "utf8"), side: Object.fromEntries(side.map((path) => [relative(ws, path).replaceAll("\\", "/"), readFileSync(path, "utf8")])) };
  };
  const results: BotResult[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realInfo = console.info;
  try {
    // a copy has no turns to wait out: the quiet spell and the boot spread fire at once, the model timeout stays
    Object.assign(globalThis, { setTimeout: (fn: () => void, ms?: number) => realSetTimeout(fn, (ms ?? 0) >= SLEEP_IDLE_MS ? 0 : ms) });
    const filing = new Set<string>();
    for (let night = 1; night <= nights; night += 1) for (const id of [...ids, TRAP_ID]) {
      const trap = id === TRAP_ID;
      if (trap && night > 1) continue;
      const ws = workspaceDir(id);
      const before = notesOf(ws);
      const parked = Object.keys(before.side).filter((path) => PARKED_COPY.test(path)).length;
      const used = spent.input + spent.output;
      let reply = "";
      let log: z.infer<typeof sleepLogSchema> | undefined;
      console.info = (...args: unknown[]) => {
        const text = String(args[0]);
        if (text.startsWith("[memory-sleep] ")) log = sleepLogSchema.parse(JSON.parse(text.slice("[memory-sleep] ".length)));
        else realInfo(...args);
      };
      // the trap bot gets the worst reply a model could give, for free
      const tidier: NoteGenerator | null = trap ? async () => TRAP_REPLY : generator;
      const generate: NoteGenerator | null = tidier && Object.assign(async (...args: Parameters<NoteGenerator>) => (reply = await tidier(...args)), { engine: "claude" });
      const started = Date.now();
      const sleep = createMemorySleep({
        dataDir: process.env.OMB_DATA_DIR,
        bots: () => [id],
        generate: () => generate,
        enabled: () => true,
        busy: () => false,
        changed: () => {},
        now: () => Date.now() + (night - 1) * 24 * 60 * 60_000,
      });
      await new Promise((resolve) => realSetTimeout(resolve, 10));
      await sleep.idle();
      sleep.dispose();
      const ms = log?.ms ?? Date.now() - started;
      const tidied = readFileSync(join(ws, "MEMORY.md"), "utf8");
      const filingFrom = spent.input + spent.output;
      let filed = 0;
      const written = new Map<string, string | null>();
      const restore = () => {
        writeFileSync(join(ws, "MEMORY.md"), tidied);
        for (const [path, was] of written) {
          if (was === null) rmSync(path, { force: true });
          else writeFileSync(path, was);
        }
        written.clear();
        filed = 0;
      };
      const apply = (plan: NonNullable<ReturnType<typeof planFiling>>) => {
        mkdirSync(join(ws, "memory"), { recursive: true });
        for (const [name, text] of Object.entries(plan.topics)) {
          const path = join(ws, "memory", name);
          const was = existsSync(path) ? readFileSync(path, "utf8") : null;
          written.set(path, was);
          writeFileSync(path, was === null ? text : `${was}${was && !was.endsWith("\n") ? "\n" : ""}${text}`);
        }
        writeFileSync(join(ws, "MEMORY.md"), plan.memory);
        filed = plan.bytes;
      };
      let filingReply = "";
      let filingOptions: Parameters<typeof planFiling>[3] = {};
      let existing: string[] = [];
      let plan: ReturnType<typeof planFiling> = null;
      if (filer && !trap && filingDue(tidied, filing.has(id))) {
        existing = existsSync(join(ws, "memory")) ? readdirSync(join(ws, "memory")) : [];
        const loaded = rules.loaded(tidied).split("\n");
        const files = reached(notesOf(ws), rules).map((path) => ({ name: path.slice("memory/".length), line: loaded.find((line) => line.replaceAll("\\", "/").includes(path)) ?? "" })).filter(({ name }) => !PARKED_COPY.test(name));
        filingReply = await askFiler(filingPrompt(fileableNotes(tidied), filingBytes(tidied), files));
        // route every candidate first, so the night still fills once misrouted notes drop out
        const candidates = planFiling(tidied, filingReply, existing, { files, nightBytes: Infinity });
        const skip = candidates ? misrouted(await askFiler(routePrompt(rules.loaded(candidates.memory), candidates.filed)), candidates.filed) : new Set<string>();
        filingOptions = { files, skip };
        plan = planFiling(tidied, filingReply, existing, filingOptions);
        if (plan) {
          apply(plan);
          filing.add(id);
        }
      }
      let after = notesOf(ws);
      const blocks = movedBlocks(before, after);
      let quiz: Quiz = { asked: 0, right: 0, misses: [] };
      let undone: Quiz = { asked: 0, right: 0, misses: [] };
      if (blocks.length) {
        // a fresh answerer that sees only MEMORY.md after the move must name each block's side file
        const questions = generator ? parseQuestions(await ask(quizPrompt(blocks)), blocks) : blocks.map(() => []);
        quiz = scoreQuiz(blocks, questions, generator ? await ask(answerPrompt(rules.loaded(after.memory), questions.flat())) : "");
        const missed = new Set(quiz.misses.map(({ path }) => path));
        if (missed.size && plan) {
          // undo only the blocks with a miss: refile exactly the notes of the blocks that passed
          const kept = plan.filed.filter(({ topic }) => !missed.has(`memory/${topic}`));
          const keep = new Set(kept.flatMap(({ notes }) => notes.map(({ ref }) => ref)));
          const skip = new Set(fileableNotes(tidied).map(({ at }) => `L${at + 1}`).filter((ref) => !keep.has(ref)));
          restore();
          const again = keep.size ? planFiling(tidied, filingReply, existing, { ...filingOptions, skip }) : null;
          const same = again && JSON.stringify(again.filed) === JSON.stringify(kept);
          if (same) apply(again);
          const keptPaths = new Set(same ? kept.map(({ topic }) => `memory/${topic}`) : []);
          const score = (inKept: boolean): Quiz => {
            const asked = blocks.filter(({ path }) => keptPaths.has(path) === inKept).length * QUESTIONS;
            const misses = quiz.misses.filter(({ path }) => keptPaths.has(path) === inKept);
            return { asked, right: asked - misses.length, misses };
          };
          [quiz, undone] = [score(true), score(false)];
          after = notesOf(ws);
        }
      }
      if (!filingDue(readFileSync(join(ws, "MEMORY.md"), "utf8"), true)) filing.delete(id);
      const { duplicates, disagree } = parseTidy(reply);
      results.push({
        id,
        name: trap ? "(trap pairs)" : (names.get(id) ?? id),
        night,
        trap,
        result: log?.result ?? "no log",
        linesBefore: lineCount(before.memory),
        linesAfter: lineCount(after.memory),
        bytesBefore: Buffer.byteLength(before.memory, "utf8"),
        bytesAfter: Buffer.byteLength(after.memory, "utf8"),
        tokensBefore: tokens(rules.loaded(before.memory)),
        tokensAfter: tokens(rules.loaded(after.memory)),
        moved: log?.moved ?? 0,
        filed,
        proposed: (duplicates ?? []).reduce((sum, { drop }) => sum + drop.length, 0) + (disagree ?? []).length,
        lost: lostFacts(before, after, rules),
        madeUp: madeUp(before, after),
        quiz,
        undone,
        conflicts: (log?.result === "conflict" ? 1 : 0) + Object.keys(after.side).filter((path) => PARKED_COPY.test(path)).length - parked,
        ms,
        modelTokens: spent.input + spent.output - used,
        filingTokens: spent.input + spent.output - filingFrom,
        reply,
      });
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    console.info = realInfo;
  }

  const sum = (pick: (row: BotResult) => number) => results.reduce((total, row) => total + pick(row), 0);
  const quizCell = (asked: number, right: number) => (asked ? `${right}/${asked}` : "-");
  const rows = results.map((row) =>
    `| ${row.name} | ${row.night} | ${row.result} | ${row.linesBefore} -> ${row.linesAfter} | ${row.bytesBefore} -> ${row.bytesAfter} | ${row.tokensBefore} -> ${row.tokensAfter} | ${row.proposed}/${row.moved} | ${row.filed} | ${row.lost.length} | ${row.madeUp.length} | ${quizCell(row.quiz.asked, row.quiz.right)} | ${row.undone.asked / QUESTIONS} | ${row.conflicts} | ${row.ms} | ${row.modelTokens} | ${row.filingTokens} |`);
  const bots = results.filter((row) => !row.trap);
  console.log(
    [
      `Dream check: ${new Set(bots.map(({ id }) => id)).size} bots, ${nights} night(s), ${model ? `${MODEL}, filer ${FILER_MODEL}` : "no model"}`,
      "",
      "| bot | night | result | lines | bytes | loaded tok | proposed/moved | filed B | lost | made up | quiz kept | undone blocks | conflicts | ms | model tok | filing tok |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
      ...rows,
      `| total | | | | | | ${sum((r) => r.proposed)}/${sum((r) => r.moved)} | ${sum((r) => r.filed)} | ${sum((r) => r.lost.length)} | ${sum((r) => r.madeUp.length)} | ${quizCell(sum((r) => r.quiz.asked), sum((r) => r.quiz.right))} | ${sum((r) => r.undone.asked) / QUESTIONS} | ${sum((r) => r.conflicts)} | ${sum((r) => r.ms)} | ${spent.input + spent.output} | ${sum((r) => r.filingTokens)} |`,
    ].join("\n"),
  );
  const json = flag("json");
  if (json) writeFileSync(json, `${JSON.stringify({ model: model ? MODEL : null, spent, results }, null, 2)}\n`);
  rmSync(root, { recursive: true, force: true });
  return sum(failures) ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
