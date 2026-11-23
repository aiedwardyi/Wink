// Dream check: one idle-tidy pass (server/memory-sleep.ts) over copies of each bot's notes, then proof no fact was lost.
// Reads a copy of ~/.orbit, never the live folder; writes only under a throwaway data dir and Claude config dir.
// node --experimental-strip-types scripts/dream-check.ts <orbit copy> [--bots id,id] [--no-model] [--max-tokens 2000000] [--json out.json]
// The model pass needs CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY, so no engine profile is touched.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import type { NoteGenerator } from "../server/memory-pass.ts";

// the note helper's model (server/drivers/claude.ts runHelper)
const MODEL = "claude-haiku-5-5";
const MOVED = /^- ("(?:[^"\\\n]|\\.)*") replaced by /gm;
const botsSchema = z.array(z.object({ id: z.string(), name: z.string().optional() }));
const count = z.number().default(0);
const replySchema = z.object({
  result: z.string().default(""),
  usage: z.object({ input_tokens: count, cache_read_input_tokens: count, cache_creation_input_tokens: count, output_tokens: count }).default({ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }),
});
const sleepLogSchema = z.object({ result: z.string(), moved: z.number().optional(), ms: z.number() });

export type After = { memory: string; history: string[]; side: string[] };

const factKey = (line: string) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim();

function keys(text: string): Set<string> {
  return new Set(text.split("\n").map(factKey).filter(Boolean));
}

/** Every non-blank line of `before` that is in none of MEMORY.md, a line the history records as moved, or a side file. */
export function lostFacts(before: string, after: After): string[] {
  const found = new Set([...keys(after.memory), ...after.side.flatMap((text) => [...keys(text)])]);
  for (const text of after.history) {
    for (const [, json] of text.matchAll(MOVED)) {
      try {
        found.add(factKey(z.string().parse(JSON.parse(json!))));
      } catch {
        // an entry edited by hand finds nothing
      }
    }
  }
  return [...keys(before)].filter((key) => !found.has(key));
}

/** Lines of MEMORY.md after the tidy that were not in it before: the tidy only removes, so this must stay empty. */
export function madeUp(before: string, after: string): string[] {
  const had = keys(before);
  return [...keys(after)].filter((key) => !had.has(key));
}

// the server's textTokens estimate (context-compaction.ts)
const tokens = (text: string) => Math.ceil(Buffer.byteLength(text, "utf8") / 3);
const lineCount = (text: string) => (text ? text.replace(/\n$/, "").split("\n").length : 0);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((name) => join(dir, name)).filter((path) => statSync(path).isFile());
}

type Spent = { input: number; output: number };

function claudeGenerator(configDir: string, cwd: string, spent: Spent, cap: number): NoteGenerator {
  return (prompt, signal, onUsage) =>
    new Promise<string>((resolve, reject) => {
      if (spent.input + spent.output >= cap) return reject(new Error("model token cap reached"));
      const child = spawn(
        process.env.CLAUDE_CLI ?? "claude",
        ["-p", "--model", MODEL, "--output-format", "json", "--safe-mode", "--tools", "", "--strict-mcp-config", "--no-session-persistence"],
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
  result: string;
  linesBefore: number;
  linesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  moved: number;
  proposed: number;
  lost: string[];
  madeUp: string[];
  conflicts: number;
  ms: number;
  modelTokens: number;
  reply: string;
};

async function main(): Promise<number> {
  const [dir, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const at = rest.indexOf(`--${name}`);
    return at >= 0 ? rest[at + 1] : undefined;
  };
  if (!dir) throw new Error("usage: node --experimental-strip-types scripts/dream-check.ts <orbit copy> [--bots id,id] [--no-model] [--max-tokens 2000000] [--json out.json]");
  const live = join(homedir(), ".orbit");
  if (existsSync(live) && realpathSync(dir).toLowerCase() === realpathSync(live).toLowerCase()) throw new Error(`${dir} is the live ~/.orbit; copy it first`);
  const model = !rest.includes("--no-model");
  if (model && !process.env.CLAUDE_CODE_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) throw new Error("set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, or pass --no-model");
  const cap = Number(flag("max-tokens") ?? 2_000_000);

  const names = new Map<string, string>();
  try {
    for (const bot of botsSchema.parse(JSON.parse(readFileSync(join(dir, "bots.json"), "utf8")))) names.set(bot.id, bot.name ?? bot.id);
  } catch {
    // a copy of workspaces alone: ids stand in for names
  }
  const source = join(dir, "workspaces");
  const picked = flag("bots")?.split(",");
  const ids = readdirSync(source).filter((id) => existsSync(join(source, id, "MEMORY.md")) && (picked ? picked.includes(id) : names.size === 0 || names.has(id)));

  const root = mkdtempSync(join(tmpdir(), "wink-dream-"));
  // read by server/config.ts at import, so it is set before the engine loads
  process.env.OMB_DATA_DIR = join(root, "data");
  const configDir = join(root, "claude");
  const helperDir = join(root, "helper");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(helperDir, { recursive: true });
  for (const id of ids) {
    for (const name of ["MEMORY.md", "memory", "memory-history", "imported.md"]) {
      if (existsSync(join(source, id, name))) cpSync(join(source, id, name), join(root, "data", "workspaces", id, name), { recursive: true });
    }
  }
  const { createMemorySleep, parseTidy, SLEEP_IDLE_MS } = await import("../server/memory-sleep.ts");
  const { workspaceDir, PARKED_COPY } = await import("../server/workspace.ts");

  const spent: Spent = { input: 0, output: 0 };
  const generator = model ? claudeGenerator(configDir, helperDir, spent, cap) : null;
  const results: BotResult[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realInfo = console.info;
  try {
    // a copy has no turns to wait out: the quiet spell and the boot spread fire at once, the model timeout stays
    Object.assign(globalThis, { setTimeout: (fn: () => void, ms?: number) => realSetTimeout(fn, (ms ?? 0) >= SLEEP_IDLE_MS ? 0 : ms) });
    for (const id of ids) {
      const ws = workspaceDir(id);
      const before = readFileSync(join(ws, "MEMORY.md"), "utf8");
      const parked = filesUnder(ws).filter((path) => PARKED_COPY.test(path)).length;
      const used = spent.input + spent.output;
      let reply = "";
      let log: z.infer<typeof sleepLogSchema> | undefined;
      console.info = (...args: unknown[]) => {
        const text = String(args[0]);
        if (text.startsWith("[memory-sleep] ")) log = sleepLogSchema.parse(JSON.parse(text.slice("[memory-sleep] ".length)));
        else realInfo(...args);
      };
      const generate: NoteGenerator | null = generator && Object.assign(async (...args: Parameters<NoteGenerator>) => (reply = await generator(...args)), { engine: "claude" });
      const started = Date.now();
      const sleep = createMemorySleep({
        dataDir: process.env.OMB_DATA_DIR,
        bots: () => [id],
        generate: () => generate,
        enabled: () => true,
        busy: () => false,
        changed: () => {},
      });
      await new Promise((resolve) => realSetTimeout(resolve, 10));
      await sleep.idle();
      sleep.dispose();
      const after = readFileSync(join(ws, "MEMORY.md"), "utf8");
      const historyDir = join(ws, "memory-history");
      const side = filesUnder(ws).filter((path) => !path.startsWith(historyDir) && relative(ws, path) !== "MEMORY.md");
      const { duplicates, disagree } = parseTidy(reply);
      results.push({
        id,
        name: names.get(id) ?? id,
        result: log?.result ?? "no log",
        linesBefore: lineCount(before),
        linesAfter: lineCount(after),
        tokensBefore: tokens(before),
        tokensAfter: tokens(after),
        moved: log?.moved ?? 0,
        proposed: (duplicates ?? []).reduce((sum, { drop }) => sum + drop.length, 0) + (disagree ?? []).length,
        lost: lostFacts(before, { memory: after, history: filesUnder(historyDir).map((path) => readFileSync(path, "utf8")), side: side.map((path) => readFileSync(path, "utf8")) }),
        madeUp: madeUp(before, after),
        conflicts: (log?.result === "conflict" ? 1 : 0) + side.filter((path) => PARKED_COPY.test(path)).length - parked,
        ms: log?.ms ?? Date.now() - started,
        modelTokens: spent.input + spent.output - used,
        reply,
      });
    }
  } finally {
    globalThis.setTimeout = realSetTimeout;
    console.info = realInfo;
  }

  const sum = (pick: (row: BotResult) => number) => results.reduce((total, row) => total + pick(row), 0);
  const rows = results.map((row) =>
    `| ${row.name} | ${row.result} | ${row.linesBefore} -> ${row.linesAfter} | ${row.tokensBefore} -> ${row.tokensAfter} | ${row.proposed}/${row.moved} | ${row.lost.length} | ${row.madeUp.length} | ${row.conflicts} | ${row.ms} | ${row.modelTokens} |`);
  console.log(
    [
      `Dream check: ${results.length} bots, ${model ? MODEL : "no model"}`,
      "",
      "| bot | result | lines | tokens | proposed/moved | lost | made up | conflicts | ms | model tok |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...rows,
      `| total | | ${sum((r) => r.linesBefore)} -> ${sum((r) => r.linesAfter)} | ${sum((r) => r.tokensBefore)} -> ${sum((r) => r.tokensAfter)} | ${sum((r) => r.proposed)}/${sum((r) => r.moved)} | ${sum((r) => r.lost.length)} | ${sum((r) => r.madeUp.length)} | ${sum((r) => r.conflicts)} | ${sum((r) => r.ms)} | ${spent.input + spent.output} |`,
    ].join("\n"),
  );
  const json = flag("json");
  if (json) writeFileSync(json, `${JSON.stringify({ model: model ? MODEL : null, spent, results }, null, 2)}\n`);
  rmSync(root, { recursive: true, force: true });
  return sum((r) => r.lost.length + r.madeUp.length) ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
