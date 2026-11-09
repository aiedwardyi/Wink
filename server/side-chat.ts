// Quick helper engine: while a bot is busy, a read-only copy of it answers one
// short ask in seconds, or says HANDOFF. It never writes chat rows, never marks
// the bot busy and never touches the main session; the router owns all that.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { prepareModelContext } from "./context-compaction.ts";
import type { ProviderInstance, SideEvent, SideHandle } from "./contracts.ts";
import { liveBlock, quotesUnread } from "./side-live-state.ts";
import type { Message } from "./store.ts";

const PREAMBLE =
  "[Quick helper. The person sent the message below while you are busy on the main task. You are a read-only copy of yourself answering beside that work: the main task keeps running, and it only learns this exchange later as a short note. If the message is a question you can fully answer from this conversation, or with at most 3 Read, Glob or Grep lookups in this project folder, answer it in 1 to 4 short lines under 400 characters (a longer answer is dropped), stating only what this conversation or your lookups show, naming only the files the question needs, never what a file you have not seen does or does not contain, with no extra tips, guesses, or commands and code you composed yourself. Otherwise reply with exactly HANDOFF and nothing else. HANDOFF whenever answering needs editing or creating files, running commands, the web, other computers, workers or other bots, or whenever the message asks for, approves, corrects, pauses or changes work, even when it is phrased as a question. Your latest step may show here as interrupted or without a result; the main task is still running it, so call it in progress. A file being written now: don't state what it says, answer the rest. For anything a file says now, read it; the chat may be behind.]";
const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const CAP_MS = 12_000;
const MAX_CHARS = 450;
// An answered fork exits on its own once stdin ends; this only bounds a stuck one.
const CLOSE_GRACE_MS = 5_000;
// Half of it is the budget: 16k tokens of summary plus newest tail.
const FALLBACK_WINDOW = 32_000;
const LEDGER = join(DATA_DIR, "side-chat", "live.json");

type Live = SideHandle["live"];
type Usage = Extract<SideEvent, { type: "done" }>["usage"];

export interface QuickBot {
  instance: ProviderInstance;
  /** the thread's active path, read only by engines without a fork */
  messages: Message[];
  userName?: string;
}

export interface QuickResult {
  route: "answer" | "handoff";
  text?: string;
  usage?: Usage;
  ms: number;
}

const closing = new Set<Promise<void>>();

function readLedger(): Live[] {
  try {
    const entries = JSON.parse(readFileSync(LEDGER, "utf8"));
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeLedger(entries: Live[]): void {
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileAtomic(LEDGER, JSON.stringify(entries));
}

const record = (live: Live) => writeLedger([...readLedger().filter((entry) => entry.tempDir !== live.tempDir), live]);
const forget = (live: Live) => writeLedger(readLedger().filter((entry) => entry.tempDir !== live.tempDir));

const list = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Everything a fork process can leave behind once it is gone. */
function clean(live: Live): void {
  rmSync(live.tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  if (live.configDir && live.pid > 0) {
    const sessions = join(live.configDir, "sessions");
    try {
      // A hard kill leaves the CLI's registry entry; the pid may be someone else's by now.
      const own = JSON.parse(readFileSync(join(sessions, `${live.pid}.json`), "utf8"));
      if (own?.pid === live.pid && (own.sessionId === undefined || own.sessionId === live.forkSessionId)) {
        for (const name of list(sessions)) {
          if (name === `${live.pid}.json` || (name.startsWith(`${live.pid}.`) && name.endsWith(".key"))) rmSync(join(sessions, name), { force: true });
        }
      }
    } catch {}
  }
  if (live.mcpLogDir && live.forkSessionId) {
    for (const server of list(live.mcpLogDir).filter((name) => name.startsWith("mcp-logs-"))) {
      for (const name of list(join(live.mcpLogDir, server))) {
        const path = join(live.mcpLogDir, server, name);
        try {
          if (statSync(path).mtimeMs >= live.procStart - 1_000 && readFileSync(path, "utf8").includes(live.forkSessionId)) rmSync(path, { force: true });
        } catch {}
      }
    }
  }
}

function alive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Boot: clean what forks of a previous run left; a still-running pid stays for the next sweep. */
export function sweepSide(): void {
  const keep: Live[] = [];
  for (const live of readLedger()) {
    if (alive(live.pid)) keep.push(live);
    else clean(live);
  }
  writeLedger(keep);
}

/** Resolves once every fork closed by quickAsk is gone. */
export async function sideIdle(): Promise<void> {
  while (closing.size) await Promise.all([...closing]);
}

const handoff = (started: number, usage?: Usage): QuickResult => ({ route: "handoff", ...(usage ? { usage } : {}), ms: Date.now() - started });

function viaFork(handle: SideHandle, threadId: string, started: number, attached: string[]): Promise<QuickResult> {
  const live: Live = { ...handle.live };
  record(live);
  return new Promise((resolve) => {
    let text = "";
    const reads = [...attached];
    let ended = false;
    const end = (result: Omit<QuickResult, "ms">, graceMs: number) => {
      if (ended) return;
      ended = true;
      clearTimeout(cap);
      off();
      const done = handle
        .close(graceMs)
        .catch(() => {})
        .then(() => {
          clean(live);
          forget(live);
        });
      closing.add(done);
      void done.finally(() => closing.delete(done));
      resolve({ ...result, ms: Date.now() - started });
    };
    const cap = setTimeout(() => end({ route: "handoff" }, 0), CAP_MS);
    const off = handle.onEvent((event) => {
      if (event.type === "session") {
        live.forkSessionId = event.id;
        record(live);
      } else if (event.type === "text") {
        text += event.delta;
        if (/^\s*HANDOFF/.test(text)) end({ route: "handoff" }, 0);
      } else if (event.type === "tool") {
        if (!READ_TOOLS.has(event.name)) end({ route: "handoff" }, 0);
        else if (event.name === "Read" && event.path) reads.push(event.path);
      } else if (event.type === "found") reads.push(...event.paths);
      else {
        const answer = event.text.trim();
        const usage = event.usage ? { usage: event.usage } : {};
        if (!event.ok || !answer || answer.startsWith("HANDOFF") || answer.length > MAX_CHARS || quotesUnread(threadId, answer, reads)) end({ route: "handoff", ...usage }, CLOSE_GRACE_MS);
        else end({ route: "answer", text: answer, ...usage }, CLOSE_GRACE_MS);
      }
    });
  });
}

async function viaText(bot: QuickBot, ask: string, started: number): Promise<QuickResult> {
  if (!bot.instance.generateText) return handoff(started);
  let usage: Usage;
  try {
    const prepared = await prepareModelContext({ messages: bot.messages, contextWindow: FALLBACK_WINDOW, taskRecordText: "", userName: bot.userName });
    const transcript = prepared.status === "ready" ? prepared.transcript.map((line) => `${line.role === "user" ? "User" : "You"}: ${line.text}`).join("\n\n") : "";
    const prompt = [transcript && `[Conversation so far]\n${transcript}`, ask].filter(Boolean).join("\n\n");
    const answer = (
      await bot.instance.generateText(prompt, {
        ephemeral: true,
        lean: true,
        signal: AbortSignal.timeout(CAP_MS),
        timeoutMs: CAP_MS,
        onUsage: (used) => {
          if (used) usage = { input: used.input, output: used.output, ...(used.cachedInput === undefined ? {} : { cachedInput: used.cachedInput }) };
        },
      })
    ).trim();
    if (!answer || answer.startsWith("HANDOFF")) return handoff(started, usage);
    return { route: "answer", text: answer, ...(usage ? { usage } : {}), ms: Date.now() - started };
  } catch {
    return handoff(started, usage);
  }
}

/** One ask: the engine's fork when it has one, else a chat-only one-shot. */
export function quickAsk(bot: QuickBot, threadId: string, ask: { text: string; notes?: string }): Promise<QuickResult> {
  const started = Date.now();
  const text = [PREAMBLE, ask.notes?.trim(), ask.text].filter(Boolean).join("\n\n");
  const live = liveBlock(threadId);
  let handle: SideHandle | null = null;
  try {
    handle = bot.instance.fork?.({ threadId, text, ...(live.text ? { live: live.text } : {}) }) ?? null;
  } catch {
    return Promise.resolve(handoff(started));
  }
  return handle ? viaFork(handle, threadId, started, live.attached) : viaText(bot, [live.text, text].filter(Boolean).join("\n\n"), started);
}
