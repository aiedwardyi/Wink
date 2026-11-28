import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aboutYouRoutes, aboutYouSources, ABOUT_YOU_MAX_PASTE, declineImport, importDeclined } from "./about-you.ts";
import { DATA_DIR } from "./config.ts";
import { importMemoryPins } from "./import-memory-pin.ts";
import { importMemoryRoute, importMemoryTool, importTurnGate, noteSendLocale, type ImportMemoryDeps } from "./memory-import-offer.ts";
import type { Message } from "./store.ts";
import { TurnRegistry } from "./turn-registry.ts";
import { en } from "../src/lib/i18n-catalog.ts";
import { removeTestData } from "./testing/test-home.ts";

const dir = join(DATA_DIR, "about-you");
const typed = (text: string) => ({ role: "user", kind: "text", text }) as Message;
const reply = (text: string) => ({ role: "bot", kind: "text", text }) as Message;
const paste = ["- The user is Dana Park; call her Dana.", "- Speaks Korean and English.", "Source: ChatGPT"].join("\n");

async function call(body: object, chat: Message[], ownerChat = true, open: ImportMemoryDeps["open"] = () => () => true) {
  let status = 0;
  let raw = "";
  const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (text: string) => { raw = text; } } as unknown as ServerResponse;
  const deps: ImportMemoryDeps = {
    caller: () => ({ botId: "b1", threadId: "t1" }),
    ownerChat: () => ownerChat,
    messages: () => chat,
    open,
    now: () => new Date(2026, 10, 19).getTime(),
  };
  await importMemoryRoute(Object.assign(Readable.from([JSON.stringify(body)]), { headers: {} }) as unknown as IncomingMessage, res, deps);
  return { status, text: String(JSON.parse(raw).text ?? JSON.parse(raw).error) };
}

beforeEach(() => {
  removeTestData(dir);
  noteSendLocale("en");
});
afterEach(() => removeTestData(dir));

describe("import_memory tool for a new chat", () => {
  it("is on for a new chat's first typed message while Import Memory is empty", () => {
    expect(importMemoryTool([typed("hi")])).toBe(true);
    expect(importMemoryTool([], 1)).toBe(true);
    expect(importMemoryTool([])).toBe(false);
  });

  it("is off once anything is imported, including facts synced from another PC", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "- Lives in Seoul. (from ChatGPT, 2026-11-18)\n");
    expect(importMemoryTool([typed("hi")])).toBe(false);
  });

  it("is off after the user says no", async () => {
    expect(await call({ decline: true }, [typed("no thanks")])).toEqual({ status: 200, text: expect.stringContaining("no bot offers this again") });
    expect(importMemoryTool([typed("hi")])).toBe(false);
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
  });

  it("stays on for the first 3 typed messages only", () => {
    expect(importMemoryTool([typed("hi"), reply("hello"), typed(paste)])).toBe(true);
    expect(importMemoryTool([typed("a"), reply("b"), typed("c"), reply("d"), typed("e"), reply("f"), typed("g")])).toBe(false);
  });

  it("stays listed for the session that started with it, but saves only in the first 3 typed messages", async () => {
    const pins = importMemoryPins();
    const chat = [typed("hi")];
    expect(pins.forTurn("t1", "claude", undefined, importMemoryTool(chat))).toBe(true);
    chat.push(reply("hello"), typed("b"), reply("c"), typed("d"), reply("e"), typed(paste));
    const open = importMemoryTool(chat);
    expect(pins.forTurn("t1", "claude", "s1", open)).toBe(true);
    expect((await call({}, chat, true, () => (open ? () => true : null))).text).toContain("Settings > Import Memory still works");
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
    expect(pins.forTurn("t1", "claude", undefined, importMemoryTool(chat))).toBe(false);
  });

  it("reads only the start of a heavy chat", () => {
    let read = 0;
    const heavy = { *[Symbol.iterator]() { for (let i = 0; i < 1e9; i++) { read++; yield i % 2 ? reply("r") : typed("q"); } } } as unknown as Message[];
    expect(importMemoryTool(heavy)).toBe(false);
    expect(read).toBeLessThan(10);
  });

  it.each(["saved", "declined"])("a turn it opened saves nothing once Settings has %s", async (state) => {
    const res = { writeHead: () => {}, setHeader: () => {}, end: () => {} } as unknown as ServerResponse;
    if (state === "saved") await aboutYouRoutes.add(Readable.from([JSON.stringify({ text: "- I play cello.\nSource: ChatGPT" })]) as IncomingMessage, res);
    else await call({ decline: true }, [typed("no thanks")]);
    expect((await call({}, [typed(paste)])).text).toContain("Settings > Import Memory still works");
    expect(aboutYouSources().flatMap((entry) => entry.facts)).not.toContain("Speaks Korean and English.");
  });

  it("ends once Settings saves a fact", async () => {
    expect(importMemoryTool([typed("hi")])).toBe(true);
    const res = { writeHead: () => {}, setHeader: () => {}, end: () => {} } as unknown as ServerResponse;
    await aboutYouRoutes.add(Readable.from([JSON.stringify({ text: "- I play cello.\nSource: ChatGPT" })]) as IncomingMessage, res);
    expect(importMemoryTool([typed("hi")])).toBe(false);
  });
});

describe("import_memory saves through the Settings path", () => {
  it("closes once its own save lands, so a second call adds nothing", async () => {
    const chat = [typed("hi"), reply("hello"), typed("- Call me Dana.\n- I grow tomatoes.\nSource: ChatGPT")];
    expect((await call({}, chat)).text).toContain("Saved facts:\n- Call me Dana.\n- I grow tomatoes.");
    expect((await call({}, chat)).text).toContain("Settings > Import Memory still works");
  });

  it("writes nothing when the offer closes while the request body is still arriving", async () => {
    const chat = [typed(paste)];
    let open = true;
    for (const close of [() => declineImport(), () => { open = false; }]) {
      removeTestData(dir);
      open = true;
      const body = new Readable({ read() {} });
      let raw = "";
      const res = { writeHead: () => {}, setHeader: () => {}, end: (text: string) => { raw = text; } } as unknown as ServerResponse;
      const done = importMemoryRoute(Object.assign(body, { headers: {} }) as unknown as IncomingMessage, res, {
        caller: () => ({ botId: "b1", threadId: "t1" }), ownerChat: () => true, messages: () => chat, open: () => () => open,
      });
      await new Promise((r) => setImmediate(r));
      close();
      body.push("{}");
      body.push(null);
      await done;
      expect(JSON.parse(raw).text).toContain("Settings > Import Memory still works");
      expect(aboutYouSources()).toEqual([]);
    }
  });

  it("a pending save dies with its own turn, even when the next turn may save", async () => {
    for (const originMay of [true, false]) {
      removeTestData(dir);
      const turns = new TurnRegistry();
      const turn = (turnId: string, importMemory: boolean) => turns.start(turnId, { botId: "b1", threadId: "t1", owner: "user", depth: 0, importMemory });
      turn("u1", originMay);
      const chat = [typed(paste)];
      const body = new Readable({ read() {} });
      let raw = "";
      const res = { writeHead: () => {}, setHeader: () => {}, end: (text: string) => { raw = text; } } as unknown as ServerResponse;
      const done = importMemoryRoute(Object.assign(body, { headers: {} }) as unknown as IncomingMessage, res, {
        caller: () => ({ botId: "b1", threadId: "t1" }), ownerChat: () => true, messages: () => chat, open: importTurnGate(turns),
      });
      await new Promise((r) => setImmediate(r));
      turns.settle("u1");
      turn("u2", true);
      chat.push(typed("- The user prefers new hiking trails.\nSource: ChatGPT"));
      body.push("{}");
      body.push(null);
      await done;
      expect(JSON.parse(raw).text).toContain("Settings > Import Memory still works");
      expect(aboutYouSources()).toEqual([]);
    }
  });

  it("a stopped or stalled turn's engine saves nothing, even under a newer turn that may save", async () => {
    const turns = new TurnRegistry();
    const gate = importTurnGate(turns);
    turns.start("u1", { botId: "b1", threadId: "t1", owner: "user", depth: 0, importMemory: true });
    gate.stop("t1");
    turns.start("u2", { botId: "b1", threadId: "t1", owner: "user", depth: 0, importMemory: true });
    expect((await call({}, [typed(paste)], true, gate)).text).toContain("Settings > Import Memory still works");
    expect(aboutYouSources()).toEqual([]);
  });

  it("Stop closes the save before the engine exits, also mid-request", async () => {
    const turns = new TurnRegistry();
    const gate = importTurnGate(turns);
    turns.start("u1", { botId: "b1", threadId: "t1", owner: "user", depth: 0, importMemory: true });
    const body = new Readable({ read() {} });
    let raw = "";
    const res = { writeHead: () => {}, setHeader: () => {}, end: (text: string) => { raw = text; } } as unknown as ServerResponse;
    const done = importMemoryRoute(Object.assign(body, { headers: {} }) as unknown as IncomingMessage, res, {
      caller: () => ({ botId: "b1", threadId: "t1" }), ownerChat: () => true, messages: () => [typed(paste)], open: gate,
    });
    await new Promise((r) => setImmediate(r));
    gate.stop("t1");
    body.push("{}");
    body.push(null);
    await done;
    expect(JSON.parse(raw).text).toContain("Settings > Import Memory still works");
    expect((await call({}, [typed(paste)], true, gate)).text).toContain("Settings > Import Memory still works");
    expect((await call({ decline: true }, [typed(paste)], true, gate)).text).toContain("Settings > Import Memory still works");
    expect(aboutYouSources()).toEqual([]);
    expect(importDeclined()).toBe(false);
  });

  it("a live turn still saves", async () => {
    const turns = new TurnRegistry();
    turns.start("u1", { botId: "b1", threadId: "t1", owner: "user", depth: 0, importMemory: true });
    expect((await call({}, [typed(paste)], true, importTurnGate(turns))).text).toContain("Import Memory says: Added 2 new.");
  });

  it("reopens once the stopped engine reports turn.completed", async () => {
    const turns = new TurnRegistry();
    const gate = importTurnGate(turns);
    turns.start("u1", { botId: "b1", threadId: "t1", owner: "user", depth: 0, importMemory: true });
    gate.stop("t1");
    turns.start("u2", { botId: "b1", threadId: "t1", owner: "user", depth: 0, importMemory: true });
    gate.settled("t1", "u2");
    expect((await call({}, [typed(paste)], true, gate)).text).toContain("Settings > Import Memory still works");
    gate.settled("t1", "u1");
    expect((await call({}, [typed(paste)], true, gate)).text).toContain("Import Memory says: Added 2 new.");
  });

  it("reopens once the registry settles a stopped turn whose turn.completed was lost, ID-less or for another turn", async () => {
    for (const fault of ["dropped", "no id", "wrong id"]) {
      removeTestData(dir);
      const turns = new TurnRegistry();
      const gate = importTurnGate(turns);
      turns.start("u1", { botId: "b1", threadId: "t1", owner: "user", depth: 0, importMemory: true });
      gate.stop("t1");
      if (fault === "wrong id") {
        turns.settle("x9");
        gate.settled("t1", "x9");
      }
      expect((await call({}, [typed(paste)], true, gate)).text).toContain("Settings > Import Memory still works");
      turns.settle("u1");
      turns.start("u2", { botId: "b1", threadId: "t1", owner: "user", depth: 0, importMemory: true });
      expect((await call({}, [typed(paste)], true, gate)).text).toContain("Import Memory says: Added 2 new.");
    }
  });

  it("a room Stop or a deleted thread holds nothing", async () => {
    for (const end of ["room", "deleted"]) {
      removeTestData(dir);
      const turns = new TurnRegistry();
      const gate = importTurnGate(turns);
      turns.start("r1", { botId: "b1", threadId: "t1", owner: end === "room" ? "room" : "user", depth: 0 });
      gate.stop("t1");
      if (end === "deleted") gate.forget("t1");
      turns.start("u2", { botId: "b1", threadId: "t1", owner: "user", depth: 0, importMemory: true });
      expect((await call({}, [typed(paste)], true, gate)).text).toContain("Import Memory says: Added 2 new.");
    }
  });

  it("lists only the saved facts, never a flagged line", async () => {
    const text = (await call({}, [typed("- My password is hunter2-very-secret\n- Likes tea.\n- Plays tennis.\nSource: ChatGPT")])).text;
    expect(text).toContain("Saved facts:\n- Likes tea.\n- Plays tennis.");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("only from the saved facts list");
  });

  it("reports when the saved facts list is capped", async () => {
    const text = (await call({}, [typed(`${Array.from({ length: 10 }, (_, i) => `- New fact ${i}.`).join("\n")}\nSource: ChatGPT`)])).text;
    expect(text).toContain("- New fact 7.\n+2 more");
    expect(text).not.toContain("New fact 8.");
  });
  it("saves the user's pasted message and reports what Settings reports", async () => {
    const result = await call({}, [typed("hi"), reply("offer"), typed(paste)]);
    expect(result).toEqual({ status: 200, text: expect.stringMatching(/^Import Memory says: Added 2 new\.\nTell the user this result\.\n/) });
    expect(aboutYouSources()).toEqual([{ source: "ChatGPT", facts: ["The user is Dana Park; call her Dana.", "Speaks Korean and English."] }]);
    expect((await call({}, [typed(paste)])).text).toContain("Settings > Import Memory still works");
  });

  it("after a save that added facts, tells the bot to say what it now knows, from saved facts only", async () => {
    const text = (await call({}, [typed("hi"), reply("offer"), typed(paste)])).text;
    expect(text).toContain("Added 2 new.");
    expect(text).toContain("tell them what you now know");
    expect(text).toContain("up to 5 short bullets");
    expect(text).toContain("Use only from the saved facts list");
    expect(text).toContain("The user is Dana Park; call her Dana.");
    expect(text).not.toMatch(/wrong or missing/i);
    removeTestData(dir);
    noteSendLocale("ko");
    const ko = (await call({}, [typed(paste.replace("Dana", "Dan"))])).text;
    expect(ko).toContain("글머리표");
    expect(ko).toContain("한국어로");
  });

  it("gives no recap for an error, and leaves errors unchanged", async () => {
    expect((await call({}, [typed("   ")])).text).toBe(`Import Memory says: ${en["aboutYou.noFacts"]}\nTell the user this result.`);
    expect((await call({}, [typed("x".repeat(ABOUT_YOU_MAX_PASTE + 1))])).text).toBe(`Import Memory says: ${en["aboutYou.tooLarge"]}\nTell the user this result.`);
  });

  it("imports the paste the bot saw, not a later steered line or a side quick question", async () => {
    const steered = { ...typed("thanks, take your time"), steered: true } as Message;
    const quickAsk = { ...typed("what time is it?"), quick: { state: "asked" } } as Message;
    expect((await call({}, [typed("hi"), reply("offer"), typed(paste), steered, quickAsk])).text).toContain("Added 2 new.");
    expect(aboutYouSources()).toEqual([{ source: "ChatGPT", facts: ["The user is Dana Park; call her Dana.", "Speaks Korean and English."] }]);
  });

  it("refuses a paste over 4 MB with the Settings message", async () => {
    const result = await call({}, [typed("x".repeat(ABOUT_YOU_MAX_PASTE + 1))]);
    expect(result.text).toContain(en["aboutYou.tooLarge"]);
    expect(existsSync(join(dir, "MEMORY.md"))).toBe(false);
  });

  it("saves every fact past the prompt's 200-line cut", async () => {
    const facts = Array.from({ length: 201 }, (_, i) => `Fact ${i}.`);
    const text = (await call({}, [typed(`${facts.map((fact) => `- ${fact}`).join("\n")}\nSource: ChatGPT`)])).text;
    expect(text).toContain("Added 201 new.");
    expect(text).not.toContain("not added");
    expect(aboutYouSources().find((entry) => entry.source === "ChatGPT")?.facts).toEqual(facts);
  });

  it("answers a Korean user in Korean", async () => {
    noteSendLocale("ko");
    expect((await call({}, [typed(paste)])).text).toContain("새로 2개 추가했어요.");
  });

  it("never writes from a room: other people's text stays out of the owner's memory", async () => {
    expect((await call({}, [typed(paste)], false)).status).toBe(403);
    expect((await call({ decline: true }, [typed("no")], false)).status).toBe(403);
    expect(existsSync(dir)).toBe(false);
  });

  it("is offered and mounted only in the owner's own 1:1 turns", () => {
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toContain("!commsDepth && opts?.readOnly !== true && instance.adapter.capabilities.agentsMcp === true && !notOwnerChats().has(threadId)");
    expect(index).toContain("importEligible && turnStartedByUser(opts) && importMemoryTool(activeMessages)");
    const mounts = index.split("\n").filter((line) => line.includes("agentsIntegration(bot.id"));
    expect(mounts.filter((line) => line.includes("importMemory")).map((line) => line.trim())).toEqual([
      "const agents = instance.adapter.capabilities.agentsMcp === true ? agentsIntegration(bot.id, bot.threadId, 0, false, false, false, importMemoryTool(store.activePathBack(bot.threadId), 1)) : undefined;",
      "integrations.agents = agentsIntegration(bot.id, threadId, commsDepth, false, readOnly, false, importMemory);",
    ]);
    expect(mounts.find((line) => line.includes("hop"))).not.toContain("importMemory");
  });
});
