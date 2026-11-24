// Practice checks on copies: each item is asked of a bot on its notes before a topic moved and after, inside the night ledger.
// node --experimental-strip-types scripts/dream-practice.ts --practice <dir> --json <summary.json> [--build sha] [--date yyyy-mm-dd]
//   [--check-turns --live <orbit dir> --code <checkout> [--engine wink|cli]]
// Check turns stay off without --check-turns until the 0.35M unit is settled (DESIGN-v4 2.6); the ledger is written either way.
// Note text (items, rubrics, sentinels, rows, server logs) stays in <practice>\<bot-id>\; --json gets counts, codes and sha8s.
// --engine cli asks each item as a one-shot claude -p in the arm folder; the tests' stub engine runs through it.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

import { BOT_ID, cleanerSkip, noteGroups, sha8 } from "../server/memory-clean.ts";
import { sweepStale } from "./dream-check.ts";
import { kindsSchema, Ledger, type Usage } from "./dream-ledger.ts";

export const KIT_PREFIX = "wink-dream-kit-";
const SWEEP_MS = 14 * 86_400_000;
const RETRIES = 2;
const TURN_MODEL = { model: "claude-opus-5-5", effort: "high" };
const GRADER_MODEL = "claude-sonnet-5-5";
const TURN_MS = 240_000;
const PRELOAD = fileURLToPath(new URL("./dream-engine-env.cjs", import.meta.url));

export type ItemKind = "blind" | "cued" | "sentinel";
export type Item = { sha8: string; kind: ItemKind; question: string; rubric: string };
export type Side = "before" | "after";
export type Arm = { kind: "blind" | "cued"; side: Side; data: string; workspace: string };
export type Reply = { text: string; usage: Usage; error?: string; stopped?: boolean; noIndex?: boolean };
export interface Engine {
  turn(bot: string, arm: Arm, question: string): Promise<Reply>;
  ask(prompt: string): Promise<Reply>;
  close(): Promise<void>;
}

/** 3 of 3 passes; 1 or 2 of 3 runs 3 more and passes at 5 of 6; exactly 4 of 6 runs 6 more and passes at 10 of 12; 0 of 3 fails. */
export function afterVerdict(runs: readonly boolean[]): "pass" | "fail" | "more" {
  const passed = runs.filter(Boolean).length;
  if (runs.length === 3) return passed === 3 ? "pass" : passed === 0 ? "fail" : "more";
  if (runs.length === 6) return passed >= 5 ? "pass" : passed === 4 ? "more" : "fail";
  if (runs.length === 12) return passed >= 10 ? "pass" : "fail";
  return "more";
}

export const admitted = (baseline: readonly boolean[]) => baseline.length === 3 && baseline.every(Boolean);

/** Recall reads lookup-bots.json at server start: [] turns the bot's own notes off in the blind folder; the cued folder has no list, so recall is on. */
export function prepareArm(root: string, kind: Arm["kind"], side: Side, bot: string, notes: string): Arm {
  const data = join(root, "arms", `${kind}-${side}`, "data");
  rmSync(join(data, ".."), { recursive: true, force: true });
  const workspace = join(data, "workspaces", bot);
  cpSync(notes, workspace, { recursive: true });
  if (kind === "blind") writeFileSync(join(data, "lookup-bots.json"), "[]\n");
  return { kind, side, data, workspace };
}

const TOPIC_DIR = /^topic-[0-9a-f]{8}$/;
const READ_TOOLS = /^(?:Read|Glob|Grep|LS)$/;
const PATH_KEYS = new Set(["file_path", "path", "notebook_path"]);

/** A permission ask is allowed only for a read tool whose parsed action keeps every path inside the arm; a missing or refused action is denied. */
export function fence(request: { requestType?: string; tool?: string; action?: string; actionRefused?: string }, armRoot: string): boolean {
  if (request.requestType !== "permission" || request.actionRefused || !request.action || !READ_TOOLS.test(request.tool ?? "")) return false;
  const inside = (path: string) => {
    const rel = relative(resolve(armRoot), resolve(armRoot, path));
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  // guardInput's action: every key and string of the call, one per line
  const parts = request.action.split("\n");
  return parts.every((part, at) => (PATH_KEYS.has(parts[at - 1] ?? "") || isAbsolute(part) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(part) ? inside(part) : true));
}

export const BLOCKED = ["no-account", "getwinkdev", "no-credentials", "home-credentials", "token-expiry"] as const;
export class Blocked extends Error {
  readonly code: (typeof BLOCKED)[number];
  constructor(code: (typeof BLOCKED)[number]) {
    super(`blocked: ${code}`);
    this.code = code;
  }
}

const fileWith = <T>(schema: z.ZodType<T>, file: string) => (existsSync(file) ? parseWith(schema, readFileSync(file, "utf8")) : null);
const accountsSchema = z.object({ defaults: z.object({ claude: z.string() }) });
const credentialsSchema = z.object({ claudeAiOauth: z.object({ accessToken: z.string().min(1), expiresAt: z.number() }) });

/** The Main Claude token from the live account folder, as run.ps1 picks it; never ~/.claude/.credentials.json, never refreshed. */
export function kitToken(live: string, now = Date.now(), home = homedir()): string {
  const main = fileWith(accountsSchema, join(live, "accounts.json"))?.defaults.claude ?? "";
  if (!/^acct_[a-z0-9-]+$/.test(main)) throw new Blocked("no-account");
  // the 02:00 eval needs getwinkdev; never borrow it
  if (main.startsWith("acct_dc417022-")) throw new Blocked("getwinkdev");
  const file = resolve(live, "accounts", main, ".credentials.json");
  if (file.toLowerCase() === resolve(home, ".claude", ".credentials.json").toLowerCase()) throw new Blocked("home-credentials");
  const credentials = fileWith(credentialsSchema, file);
  if (!credentials) throw new Blocked("no-credentials");
  // a refresh would rotate the live login under the app; a token near expiry ends the night instead
  if (credentials.claudeAiOauth.expiresAt < now + 25 * 60_000) throw new Blocked("token-expiry");
  return credentials.claudeAiOauth.accessToken;
}

/** Files past 14 days go; sentinels stay while their bot practices. A topic goes whole, 14 days after it is done, so an open topic keeps its copies and items. */
export function sweepPractice(practice: string, now = Date.now()) {
  if (!existsSync(practice)) return;
  const old = (path: string) => now - (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? now) > SWEEP_MS;
  for (const name of readdirSync(practice, { recursive: true, encoding: "utf8" })) {
    const parts = name.split(/[\\/]/);
    if (parts.includes("sentinels")) continue;
    const at = parts.findIndex((part) => TOPIC_DIR.test(part));
    if (at !== -1) {
      const topic = join(practice, ...parts.slice(0, at + 1));
      if (at === parts.length - 1 && existsSync(join(topic, "done")) && old(join(topic, "done"))) rmSync(topic, { recursive: true, force: true });
      continue;
    }
    const path = join(practice, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isFile() && now - stat.mtimeMs > SWEEP_MS) rmSync(path, { force: true });
  }
}

const filesOf = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((name) => statSync(join(dir, name)).isFile()).sort() : []);
/** The copy pair a topic's turns all run on; rows carry it beside the item and the build. */
export const copySha = (topic: string) => sha8(["before", "after"].flatMap((side) => filesOf(join(topic, side)).map((name) => `${side}/${name.replaceAll("\\", "/")}\0${readFileSync(join(topic, side, name), "utf8")}`)).join("\0"));

const notesOf = (file: string) => (existsSync(file) ? noteGroups(readFileSync(file, "utf8").split(/\r?\n/)).map((note) => note.join("\n")).filter((note) => note.startsWith("- ")) : []);

/** The item writer's prompt: notes the topic moved and notes it kept, never a skipped one. */
export function itemPrompt(topic: string, sentinels: boolean): string | null {
  const after = new Set(notesOf(join(topic, "after", "MEMORY.md")));
  const moved = notesOf(join(topic, "before", "MEMORY.md")).filter((note) => !after.has(note) && !cleanerSkip(note));
  if (!moved.length) return null;
  const kept = [...after].filter((note) => !cleanerSkip(note)).slice(0, 40);
  return [
    "Write check items for one bot's notes. Moved notes left its main notes file for a side file; kept notes stay.",
    `Reply with JSON only: {"blind": {"question": "...", "rubric": "..."}, "cued": {"question": "...", "rubric": "..."}${sentinels ? ', "sentinels": [{"question": "...", "rubric": "..."}, {"question": "...", "rubric": "..."}]' : ""}}.`,
    "blind and cued: a question a user would type whose answer needs a moved note, each about a different moved note when there are two. The rubric says what a right answer holds.",
    ...(sentinels ? ["sentinels: two questions answered by kept notes only."] : []),
    "",
    "Moved:",
    ...moved,
    "",
    "Kept:",
    ...kept,
  ].join("\n");
}

const writtenSchema = z.object({
  blind: z.object({ question: z.string().min(1), rubric: z.string().min(1) }),
  cued: z.object({ question: z.string().min(1), rubric: z.string().min(1) }),
  sentinels: z.array(z.object({ question: z.string().min(1), rubric: z.string().min(1) })).optional(),
});
/** The JSON object in a reply, read through its schema; a model may wrap it in words. */
function parseWith<T>(schema: z.ZodType<T>, text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
const itemOf = (kind: ItemKind, { question, rubric }: { question: string; rubric: string }): Item => ({ sha8: sha8(`${kind}\0${question}\0${rubric}`), kind, question, rubric });

export const gradePrompt = (item: Item, answer: string) =>
  ["Grade a bot's answer against a rubric. Reply with JSON only: {\"pass\": true} or {\"pass\": false}.", `Question: ${item.question}`, `Rubric: ${item.rubric}`, "Answer:", answer].join("\n");
const gradeSchema = z.object({ pass: z.boolean() });

const RESULTS = ["waiting", "passed", "failed", "not-admitted", "void", "unfinished", "established", "unchecked"] as const;
type Result = (typeof RESULTS)[number] | "running";
type Pair = { item: string; kind: ItemKind; copy: string; build: string; night: string; baseline: boolean[]; after: boolean[]; errors: number; result: Result };
const FINISHED = new Set<Result>(["passed", "failed", "not-admitted", "void", "established"]);

const count = z.number().int().nonnegative();
const SHA8 = z.string().regex(/^[0-9a-f]{8}$/);
export const kitSummarySchema = z.object({
  build: z.string().regex(/^[0-9a-f]{7,40}$/).nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkTurns: z.boolean(),
  blocked: z.enum(BLOCKED).nullable(),
  spent: z.object({ fresh: count, processed: count }).strict(),
  week: count,
  reserve: count,
  ledger: kindsSchema,
  items: z.array(z.object({
    bot: z.string().regex(BOT_ID),
    topic: SHA8,
    item: SHA8,
    copy: SHA8,
    kind: z.enum(["blind", "cued", "sentinel"]),
    result: z.enum(RESULTS),
    baseline: count,
    baselineRuns: count,
    after: count,
    afterRuns: count,
    errors: count,
  }).strict()),
  topicsUnchecked: count,
  blindBaselineFails: count,
  voided: count,
  unfinished: count,
}).strict();
export type KitSummary = z.infer<typeof kitSummarySchema>;

type Night = { practice: string; root: string; engine: Engine; ledger: Ledger; build: string; date: string };

const topicsOf = (botDir: string) =>
  readdirSync(botDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && TOPIC_DIR.test(entry.name) && !existsSync(join(botDir, entry.name, "done"))).map((entry) => join(botDir, entry.name)).sort((a, b) => statSync(a).birthtimeMs - statSync(b).birthtimeMs || a.localeCompare(b));

/** One night: per bot, fullest first, its oldest open topic; a pair starts only when it can finish tonight, and one left running is voided at the end. */
export async function night({ practice, root, engine, ledger, build, date }: Night) {
  const items: KitSummary["items"] = [];
  const arms = new Map<string, Arm>();
  let topicsUnchecked = 0;
  const bots = (existsSync(practice) ? readdirSync(practice) : []).filter((name) => BOT_ID.test(name) && existsSync(join(practice, name)) && statSync(join(practice, name)).isDirectory() && topicsOf(join(practice, name)).length);
  const size = (bot: string) => statSync(join(topicsOf(join(practice, bot))[0]!, "before", "MEMORY.md"), { throwIfNoEntry: false })?.size ?? 0;
  for (const bot of bots.sort((a, b) => size(b) - size(a))) {
    const botDir = join(practice, bot);
    const checkDir = join(botDir, "check");
    mkdirSync(checkDir, { recursive: true });
    const pairsFile = join(checkDir, "pairs.json");
    const pairs: Record<string, Pair> = existsSync(pairsFile) ? JSON.parse(readFileSync(pairsFile, "utf8")) : {};
    const save = () => writeFileSync(pairsFile, `${JSON.stringify(pairs, null, 1)}\n`);
    const sentinelDir = join(botDir, "sentinels");
    const sentinels = (): Item[] => filesOf(sentinelDir).map((name) => JSON.parse(readFileSync(join(sentinelDir, name), "utf8")));
    try {
      for (const topic of topicsOf(botDir)) {
        const topicSha = topic.slice(-8);
        const copy = copySha(topic);
        const itemsFile = join(topic, "items.json");
        if (!existsSync(itemsFile)) {
          const prompt = itemPrompt(topic, !sentinels().length);
          let written: z.infer<typeof writtenSchema> | null = null;
          if (prompt) {
            if (!ledger.callFits(prompt.length, 4_000)) break;
            const reply = await engine.ask(prompt);
            ledger.add("item", reply.usage);
            written = parseWith(writtenSchema, reply.text);
            appendFileSync(join(checkDir, "rows.jsonl"), `${JSON.stringify({ at: Date.now(), night: date, build, topic: topicSha, call: "item", error: reply.error ?? (written ? null : "parse"), text: reply.text })}\n`);
            if (!written) continue;
          }
          const made = written ? [itemOf("blind", written.blind), itemOf("cued", written.cued)] : [];
          if (written?.sentinels?.length && !sentinels().length) {
            mkdirSync(sentinelDir, { recursive: true });
            for (const sentinel of written.sentinels.slice(0, 2).map((each) => itemOf("sentinel", each))) writeFileSync(join(sentinelDir, `${sentinel.sha8}.json`), JSON.stringify(sentinel));
          }
          writeFileSync(itemsFile, JSON.stringify(made));
        }
        const topicItems: Item[] = JSON.parse(readFileSync(itemsFile, "utf8"));
        // a topic whose two items cannot both run is not checked, so nothing moves
        if (topicItems.length < 2) {
          topicsUnchecked++;
          writeFileSync(join(topic, "done"), "");
          continue;
        }
        const queue = [...sentinels(), ...topicItems];
        for (const item of queue) {
          const pair = await runPair({ practice, root, engine, ledger, build, date, arms }, bot, topic, copy, item, pairs, save, checkDir);
          items.push({ bot, topic: topicSha, item: item.sha8, copy, kind: item.kind, result: pair?.result === "running" ? "unfinished" : (pair?.result ?? "waiting"), baseline: pair?.baseline.filter(Boolean).length ?? 0, baselineRuns: pair?.baseline.length ?? 0, after: pair?.after.filter(Boolean).length ?? 0, afterRuns: pair?.after.length ?? 0, errors: pair?.errors ?? 0 });
        }
        // one open topic a bot a night; dream-check plans the next only once this one is done
        if (queue.some((item) => !Object.values(pairs).some((pair) => sameRun(pair, item, copy) && FINISHED.has(pair.result)))) break;
        writeFileSync(join(topic, "done"), "");
      }
    } finally {
      for (const pair of Object.values(pairs)) if (pair.result === "running") pair.result = "unfinished";
      save();
    }
  }
  return {
    items,
    topicsUnchecked,
    blindBaselineFails: items.filter((item) => item.kind === "blind" && item.result === "not-admitted").length,
    voided: items.filter((item) => item.result === "void").length,
    unfinished: items.filter((item) => item.result === "unfinished").length,
  };
}

// a sentinel is checked once per bot, whatever topic is open; an item belongs to its topic's copy pair
const sameRun = (pair: Pair, item: Item, copy: string) => pair.item === item.sha8 && (item.kind === "sentinel" || pair.copy === copy);

async function runPair(o: Night & { arms: Map<string, Arm> }, bot: string, topic: string, copy: string, item: Item, pairs: Record<string, Pair>, save: () => void, checkDir: string): Promise<Pair | null> {
  const mine = Object.values(pairs).filter((pair) => sameRun(pair, item, copy));
  const finished = mine.find((pair) => FINISHED.has(pair.result));
  if (finished) return finished;
  // an unfinished pair from an earlier night or build is void; tonight starts it over from the baseline
  for (const pair of mine) if (pair.result === "running") pair.result = "unfinished";
  if (!o.ledger.pairFits()) return null;
  const pair: Pair = { item: item.sha8, kind: item.kind, copy, build: o.build, night: o.date, baseline: [], after: [], errors: 0, result: "running" };
  pairs[`${item.sha8}-${copy}-${o.build}-${o.date}`] = pair;
  save();
  const armKind = item.kind === "cued" ? "cued" : "blind";
  // an arm is set up once a night: its kit server keeps running on it between items
  const arm = (side: Side) => {
    const root = join(o.root, bot, copy);
    const key = join(root, armKind, side);
    const made = o.arms.get(key) ?? prepareArm(root, armKind, side, bot, join(topic, side));
    o.arms.set(key, made);
    return made;
  };
  const once = async (side: Side, at: Arm): Promise<boolean | "void" | null> => {
    for (let errors = 0; ; ) {
      if (!o.ledger.turnFits()) return null;
      const reply = await o.engine.turn(bot, at, item.question);
      o.ledger.add("check", reply.usage);
      // an empty reply, a stop, an engine error or a cued turn before its index is an error, never a miss
      const fault = reply.error ? "engine" : reply.stopped ? "stopped" : reply.noIndex ? "no-index" : !reply.text.trim() ? "empty" : null;
      let pass: boolean | null = null;
      let grade: Reply | null = null;
      if (!fault) {
        grade = await o.engine.ask(gradePrompt(item, reply.text));
        o.ledger.add("grade", grade.usage);
        pass = grade.error ? null : (parseWith(gradeSchema, grade.text)?.pass ?? null);
      }
      o.ledger.turn(reply.usage.fresh + (grade?.usage.fresh ?? 0));
      appendFileSync(join(checkDir, "rows.jsonl"), `${JSON.stringify({ at: Date.now(), night: o.date, item: item.sha8, copy, build: o.build, kind: item.kind, side, pass, fault: fault ?? (pass === null ? "grade" : null), answer: reply.text, error: reply.error ?? null, grade: grade?.text ?? null, fresh: reply.usage.fresh, processed: reply.usage.processed })}\n`);
      if (pass !== null) return pass;
      pair.errors++;
      if (++errors > RETRIES) return "void";
    }
  };
  const phase = async (side: Side, runs: boolean[], more: () => boolean) => {
    const at = arm(side);
    while (more()) {
      const outcome = await once(side, at);
      if (outcome === null) return false;
      if (outcome === "void") {
        pair.result = "void";
        save();
        return false;
      }
      runs.push(outcome);
      save();
    }
    return true;
  };
  if (item.kind === "sentinel") {
    if (await phase("before", pair.baseline, () => pair.baseline.length < 6 && pair.baseline.every(Boolean))) pair.result = pair.baseline.length === 6 && pair.baseline.every(Boolean) ? "established" : "failed";
    save();
    return pair;
  }
  if (!(await phase("before", pair.baseline, () => pair.baseline.length < 3))) return pair;
  if (!admitted(pair.baseline)) {
    pair.result = "not-admitted";
    save();
    return pair;
  }
  if (await phase("after", pair.after, () => afterVerdict(pair.after) === "more")) pair.result = afterVerdict(pair.after) === "pass" ? "passed" : "failed";
  save();
  return pair;
}

const replySchema = z.object({ result: z.string(), usage: z.object({ input_tokens: z.number(), output_tokens: z.number(), cache_read_input_tokens: z.number().default(0), cache_creation_input_tokens: z.number().default(0) }) });
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ORBIT_|OMB_|EVAL_)|^CLAUDE_CONFIG_DIR$|^CLAUDE_CODE_OAUTH_TOKEN$|^ANTHROPIC_/i.test(key)));

/** One claude -p call with the night's throwaway config and no session files. */
function claudeOnce(prompt: string, cwd: string, model: string, config: string, token: string | null): Promise<Reply> {
  return new Promise((done) => {
    const cli = process.env.CLAUDE_CLI ?? "claude";
    const [command, lead] = /\.m?js$/i.test(cli) ? [process.execPath, [cli]] : [cli, []];
    const env: NodeJS.ProcessEnv = { ...cleanEnv(), CLAUDE_CONFIG_DIR: config };
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    for (const name of ["CLAUDE_CLI", "DREAM_STUB_MARKER", "DREAM_STUB_FAIL"]) if (process.env[name]) env[name] = process.env[name];
    const child = spawn(command, [...lead, "-p", "--model", model, "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence"], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, timeout: TURN_MS });
    let stdout = "";
    let stderr = "";
    const none = { fresh: 0, processed: 0 };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-4096)));
    child.on("error", (error) => done({ text: "", usage: none, error: String(error) }));
    child.on("close", (code) => {
      const parsed = parseWith(replySchema, stdout);
      const used = parsed?.usage;
      const usage = used ? { fresh: used.input_tokens + used.cache_creation_input_tokens + used.output_tokens, processed: used.input_tokens + used.cache_creation_input_tokens + used.cache_read_input_tokens + used.output_tokens } : none;
      if (code !== 0 || !parsed) return done({ text: "", usage, error: stderr.trim() || `claude exited ${code}` });
      done({ text: parsed.result, usage });
    });
    child.stdin.end(prompt);
  });
}

/** Turns as one-shot claude -p runs in the arm's workspace: for tests on the stub engine only, never a night's measure. */
export function cliEngine(root: string, token: string | null): Engine {
  const config = join(root, "claude");
  mkdirSync(config, { recursive: true });
  return {
    turn: (_bot, arm, question) => claudeOnce(question, arm.workspace, TURN_MODEL.model, config, token),
    ask: (prompt) => claudeOnce(prompt, root, GRADER_MODEL, config, token),
    close: async () => {},
  };
}

const eventSchema = z.object({
  type: z.string(),
  threadId: z.string().optional(),
  requestId: z.string().optional(),
  requestType: z.string().optional(),
  tool: z.string().optional(),
  action: z.string().optional(),
  actionRefused: z.string().optional(),
  ok: z.boolean().optional(),
  usage: z.object({ input: z.number().default(0), cachedInput: z.number().default(0), output: z.number().default(0) }).optional(),
});
type ServerEvent = z.infer<typeof eventSchema>;
const frameSchema = z.object({ kind: z.string().optional(), event: eventSchema.optional() });
const instancesSchema = z.object({ instances: z.array(z.object({ instanceId: z.string(), driverKind: z.string().optional() })) });
const createdSchema = z.object({ bot: z.object({ id: z.string(), threadId: z.string() }) });
const messagesSchema = z.object({ messages: z.array(z.object({ sendId: z.string().nullish(), role: z.string().optional(), kind: z.string().optional(), text: z.string().nullish() })) });
const lookupRowSchema = z.object({ botId: z.string(), at: z.number(), reason: z.string() });
type Body = { [key: string]: string | boolean | string[] | Body | undefined };
type Server = { child: ChildProcess; base: string; auth: string; events: { at: number; ev: ServerEvent }[]; abort: AbortController; instanceId: string; bots: Map<string, { id: string; threadId: string }> };

/** Typed turns on POST /api/bots/:id/messages, a server from the code checkout per arm folder (DESIGN-v4 5.1), as rot-check-2's run.mjs drove them. */
export function winkEngine(o: { root: string; code: string; token: string; logs: (bot: string) => string }): Engine {
  const config = join(o.root, "claude");
  mkdirSync(config, { recursive: true });
  const servers = new Map<string, Server>();
  const call = async (server: Server, path: string, method = "GET", body?: Body) => {
    const response = await fetch(server.base + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${server.auth}` }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    return { status: response.status, text: await response.text() };
  };
  const boot = async (bot: string, arm: Arm): Promise<Server> => {
    const key = arm.data;
    const running = servers.get(key);
    if (running) return running;
    const profile = join(arm.data, "..", "profile");
    for (const dir of [profile, join(profile, "AppData", "Roaming"), join(profile, "AppData", "Local")]) mkdirSync(dir, { recursive: true });
    const port = 47_950 + servers.size;
    const auth = randomBytes(24).toString("hex");
    const env = { ...cleanEnv(), HOME: profile, USERPROFILE: profile, APPDATA: join(profile, "AppData", "Roaming"), LOCALAPPDATA: join(profile, "AppData", "Local"), OMB_DATA_DIR: arm.data, OMB_PORT: String(port), OMB_COMMS_TOKEN: auth, EVAL_CLAUDE_OAUTH: o.token, EVAL_CLAUDE_CONFIG: config };
    const child = spawn(process.execPath, ["--experimental-strip-types", "--require", PRELOAD, join(o.code, "server", "index.ts")], { cwd: o.code, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const log = join(o.logs(bot), `server-${arm.kind}-${arm.side}.log`);
    child.stdout!.on("data", (chunk) => appendFileSync(log, chunk));
    child.stderr!.on("data", (chunk) => appendFileSync(log, chunk));
    const server: Server = { child, base: `http://127.0.0.1:${port}`, auth, events: [], abort: new AbortController(), instanceId: "", bots: new Map() };
    servers.set(key, server);
    for (const started = Date.now(); ; await new Promise((done) => setTimeout(done, 250))) {
      if (child.exitCode !== null) throw new Error("kit server exited before ready");
      if (await call(server, "/api/bots?messages=0").then(({ status }) => status === 200, () => false)) break;
      if (Date.now() - started > 90_000) throw new Error("kit server not ready");
    }
    const stream = await fetch(server.base + "/api/events", { headers: { authorization: `Bearer ${auth}` }, signal: server.abort.signal });
    void (async () => {
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
          for (const line of buffer.slice(0, end).split("\n")) {
            const frame = line.startsWith("data:") ? parseWith(frameSchema, line.slice(5)) : null;
            const event = frame?.event ?? (frame && parseWith(eventSchema, line.slice(5)));
            if (frame?.kind !== "hello" && event) server.events.push({ at: Date.now(), ev: event });
          }
          buffer = buffer.slice(end + 2);
        }
      }
    })();
    const instances = parseWith(instancesSchema, (await call(server, "/api/instances")).text)?.instances ?? [];
    server.instanceId = instances.find((each) => each.driverKind === "claudeAgent")?.instanceId ?? "";
    if (!server.instanceId) throw new Error("kit server has no claudeAgent instance");
    return server;
  };
  const botIn = async (server: Server, bot: string, arm: Arm) => {
    const made = server.bots.get(bot);
    if (made) return made;
    const created = await call(server, "/api/bots", "POST", { cwd: arm.workspace, modelSelection: { instanceId: server.instanceId, model: TURN_MODEL.model, mode: "pinned", effort: TURN_MODEL.effort } });
    const fresh = parseWith(createdSchema, created.text)?.bot;
    if (!fresh) throw new Error(`create bot ${created.status}`);
    const patched = await call(server, `/api/bots/${fresh.id}`, "PATCH", { memoryNotes: false, autoApprove: false, leanStartup: true, alwaysAllow: [], hidden: true });
    if (patched.status !== 200) throw new Error(`patch bot ${patched.status}`);
    cpSync(arm.workspace, join(arm.data, "workspaces", fresh.id), { recursive: true });
    const handle = { id: fresh.id, threadId: fresh.threadId };
    server.bots.set(bot, handle);
    return handle;
  };
  const none = { fresh: 0, processed: 0 };
  return {
    async turn(bot, arm, question) {
      try {
        const server = await boot(bot, arm);
        const handle = await botIn(server, bot, arm);
        const since = server.events.length;
        const started = Date.now();
        const mine = () => server.events.slice(since).filter(({ ev }) => ev.threadId === handle.threadId);
        const answered = new Set<unknown>();
        const answer = setInterval(() => {
          for (const { ev } of mine().filter(({ ev }) => ev.type === "request.opened" && !answered.has(ev.requestId))) {
            answered.add(ev.requestId);
            const allow = fence(ev, join(arm.data, ".."));
            void call(server, `/api/bots/${handle.id}/respond`, "POST", { requestId: ev.requestId, behavior: allow ? "allow" : "deny", message: allow ? undefined : "Not available in this practice copy. Answer from what you have." }).catch(() => {});
          }
        }, 300);
        const sendId = randomBytes(8).toString("hex");
        const sent = await call(server, `/api/bots/${handle.id}/messages`, "POST", { text: question, sendId });
        if (sent.status < 200 || sent.status >= 300) {
          clearInterval(answer);
          return { text: "", usage: none, error: `send ${sent.status}` };
        }
        const until = async (ms: number) => {
          for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 300))) {
            const done = mine().find(({ ev }) => ev.type === "turn.completed");
            if (done) return done.ev;
          }
          return null;
        };
        let done = await until(TURN_MS);
        const stopped = !done;
        if (stopped) {
          await call(server, `/api/bots/${handle.id}/interrupt`, "POST", {}).catch(() => {});
          done = await until(30_000);
        }
        clearInterval(answer);
        const messages = parseWith(messagesSchema, (await call(server, `/api/threads/${handle.threadId}/messages?limit=60`)).text)?.messages ?? [];
        const at = messages.findIndex((message) => message.sendId === sendId);
        const text = (at === -1 ? [] : messages.slice(at + 1)).filter((message) => message.role === "bot" && message.kind === "text" && message.text).map((message) => message.text).join("\n\n");
        const usage = done?.usage ?? { input: 0, cachedInput: 0, output: 0 };
        const lookups = arm.kind === "cued" ? readFileSync(join(arm.data, "lookup-log.jsonl"), { encoding: "utf8", flag: "a+" }).split("\n").map((line) => parseWith(lookupRowSchema, line)) : [];
        // recall's index is built after start: a cued turn that met no index is retried, not graded
        const noIndex = lookups.some((row) => row?.botId === handle.id && row.at >= started && row.reason === "no-index");
        return { text, usage: { fresh: usage.input - usage.cachedInput + usage.output, processed: usage.input + usage.output }, stopped, noIndex, error: done?.ok === false ? "turn failed" : undefined };
      } catch (error) {
        return { text: "", usage: none, error: String(error) };
      }
    },
    ask: (prompt) => claudeOnce(prompt, o.root, GRADER_MODEL, config, o.token),
    async close() {
      for (const server of servers.values()) {
        server.abort.abort();
        if (server.child.exitCode === null) {
          const exited = new Promise((done) => {
            server.child.once("exit", done);
            setTimeout(done, 10_000);
          });
          if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.child.pid), "/T", "/F"], { windowsHide: true });
          else server.child.kill("SIGKILL");
          await exited;
        }
      }
    },
  };
}

const today = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const practice = flag("practice");
  const json = flag("json");
  if (!practice || !json) throw new Error("usage: node --experimental-strip-types scripts/dream-practice.ts --practice <dir> --json <summary.json> [--build sha] [--date yyyy-mm-dd] [--check-turns --live <orbit dir> --code <checkout> [--engine wink|cli]]");
  const date = flag("date") ?? today();
  const build = flag("build") ?? null;
  const checkTurns = args.includes("--check-turns");
  mkdirSync(practice, { recursive: true });
  sweepPractice(practice);
  sweepStale(tmpdir());
  const ledger = new Ledger(join(practice, "ledger"), date);
  let blocked: KitSummary["blocked"] = null;
  let outcome: Awaited<ReturnType<typeof night>> = { items: [], topicsUnchecked: 0, blindBaselineFails: 0, voided: 0, unfinished: 0 };
  if (checkTurns) {
    if (!build) throw new Error("--check-turns needs --build: rows are keyed by item, copy and build");
    const root = mkdtempSync(join(tmpdir(), KIT_PREFIX));
    let engine: Engine | null = null;
    try {
      const live = flag("live");
      const token = live ? kitToken(live) : null;
      if (flag("engine") === "cli") engine = cliEngine(root, token);
      else {
        const code = flag("code");
        if (!token || !code) throw new Error("the wink engine needs --live and --code");
        engine = winkEngine({ root, code, token, logs: (bot) => join(practice, bot, "check") });
      }
      outcome = await night({ practice, root, engine, ledger, build, date });
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      blocked = error.code;
    } finally {
      await engine?.close();
      rmSync(root, { recursive: true, force: true });
      sweepStale(tmpdir());
    }
  }
  const summary: KitSummary = { build, date, checkTurns, blocked, spent: ledger.night, week: ledger.week, reserve: ledger.data.reserve, ledger: { kinds: ledger.data.kinds }, ...outcome };
  writeFileSync(json, `${JSON.stringify(kitSummarySchema.parse(summary), null, 2)}\n`);
  return blocked ? 3 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
