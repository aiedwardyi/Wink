import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";

import { RoutineManager, routineRunCard, type RoutineRun } from "./routines.ts";
import type { Message } from "./store.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
const fn = (name: string) => parsed.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name)!.getText(parsed);

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function readMidRoutine() {
  let now = Date.UTC(2026, 10, 17, 14, 30, 0);
  const messages: Message[] = [];
  const bot = { id: "pokkey", threadId: "pokkey-thread", name: "Pokkey", color: "white", unread: false as boolean, readAt: undefined as number | undefined };
  const store = {
    bot: (id: string) => (id === bot.id ? bot : undefined),
    taskByThread: (botId: string, threadId: string) => (botId === bot.id && threadId === bot.threadId ? { threadId } : undefined),
    groupByThread: () => undefined,
    messagesFor: () => messages,
    appendMessage: (_t: string, m: Omit<Message, "id" | "at">) => { const full = { id: `m${messages.length}`, at: now, ...m } as Message; messages.push(full); return full; },
    patchMessage: (_t: string, id: string, patch: Partial<Message>) => Object.assign(messages.find((m) => m.id === id)!, patch),
    // server/store.ts patchBot: unread false stamps readAt
    patchBot: (_id: string, patch: { unread?: boolean }) => { if (patch.unread === false) bot.readAt = now; Object.assign(bot, patch); return bot; },
  };
  const js = ts.transpileModule(
    [fn("routineSourceOwner"), fn("routineRunFallbackText"), fn("syncRoutineRunToSource"), "return syncRoutineRunToSource;"].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ESNext } },
  ).outputText;
  const syncRoutineRunToSource = new Function("store", "routineRunCard", "profileSyncSettings", js)(
    store, routineRunCard, { deviceId: "maus" },
  ) as (run: RoutineRun) => { threadId: string; messageId: string } | null;

  const dir = mkdtempSync(join(tmpdir(), "unread-ghost-"));
  dirs.push(dir);
  const routines = new RoutineManager({
    file: join(dir, "routines.json"),
    now: () => now,
    botState: () => "ready",
    createTask: () => ({ threadId: bot.threadId }),
    startTurn: async () => {},
    startChatTurn: async () => {},
    onRunChanged: syncRoutineRunToSource,
  });
  routines.create({ name: "Bedtime questions", prompt: "Ask what waits on me", botId: bot.id, sourceThreadId: bot.threadId, schedule: { type: "once", at: now + 60_000 } } as never);
  now += 60_000;
  await routines.tick();
  expect(routines.listRuns()[0]!.status).toBe("running");

  // the user opens the chat mid-turn: read, nothing unread
  now += 5 * 60_000;
  store.patchBot(bot.id, { unread: false });
  expect(bot.unread).toBe(false);

  const base = { eventId: "e1", provider: "claudeAgent", threadId: bot.threadId, turnId: "turn-1", createdAt: new Date(now).toISOString() };
  const opened = { ...base, type: "request.opened", requestId: "r1", requestType: "permission", tool: "Read", summary: "Read sheet.png" } as never;
  now += 14_000;
  return { routines, bot, messages, opened, base, advance: (ms: number) => { now += ms; } };
}

it("an auto-approved tool request mid-routine leaves a read chat read", async () => {
  const { routines, bot, messages, opened, base, advance } = await readMidRoutine();
  // index.ts never calls requestWaiting for a request Auto mode answers
  routines.handleRuntimeEvent(opened, bot.id);
  advance(25);
  routines.handleRuntimeEvent({ ...base, type: "request.resolved", requestId: "r1", behavior: "allow", source: "auto" } as never, bot.id);

  const shownSinceRead = messages.filter((m) => m.at > bot.readAt!).map((m) => `${m.kind}: ${m.text}`);
  expect(shownSinceRead).toEqual([]);
  expect(bot.unread).toBe(false);
  expect(routines.listRuns()[0]!.status).toBe("running");
});

it("a request that really waits on the user still marks the chat unread", async () => {
  const { routines, bot, opened } = await readMidRoutine();
  routines.handleRuntimeEvent(opened, bot.id);
  routines.requestWaiting(opened, bot.id);

  expect(routines.listRuns()[0]).toMatchObject({ status: "waiting", attention: "Read sheet.png" });
  expect(bot.unread).toBe(true);
});
