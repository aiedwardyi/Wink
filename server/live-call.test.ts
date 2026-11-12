import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STATUS_MAX_BYTES } from "../shared/call-status.ts";
import { CALL_ID, LIVE_MODEL, LIVE_TOOLS, LIVE_URL } from "../shared/live-call.ts";
import { callLinesSinceLastUserTurn, capNotes, chatTail, CHAT_TAIL_TOKENS, createLiveCallRoutes, isCallKeyCard, LIVE_CALL_FILE, NOTES_MAX_BYTES, parseCallTag } from "./live-call.ts";
import { estimateContextTokens } from "./context-compaction.ts";
import { queueSteeredMessage, _resetSteerQueue } from "./steer-queue.ts";
import { Store } from "./store.ts";
import { workspaceDir } from "./workspace.ts";

const KEY = "AIzaTEST-not-a-real-key-0123456789";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(opts: { key?: string; reply?: () => Response } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "live-call-")); dirs.push(dir);
  const store = new Store(() => ({ instanceId: "claude", model: "opus", effort: "max" as const }));
  const bot = store.createBot({ name: "Juno" }, { seedMessages: false });
  store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "fix the login page" });
  store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "On it." });
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => opts.reply?.() ?? Response.json({ name: "auth_tokens/abc123" }));
  const routes = createLiveCallRoutes({ cfg: { gemini: { apiKey: "key" in opts ? opts.key : KEY } }, store, dataDir: dir, fetch: fetch as unknown as typeof globalThis.fetch });
  async function post(route: "token" | "lines" | "end", body: object = {}, botId = bot.id) {
    let status = 0;
    let raw = "";
    const res = { writeHead: (code: number) => { status = code; }, setHeader: () => {}, end: (text: string) => { raw = text; } } as unknown as ServerResponse;
    await routes(Readable.from([JSON.stringify(body)]) as IncomingMessage, res, ["", botId, route] as unknown as RegExpMatchArray);
    return { status, raw, data: JSON.parse(raw) as Record<string, any> };
  }
  const sent = (call = 0) => JSON.parse(String(fetch.mock.calls[call]![1].body));
  return { dir, store, bot, fetch, post, sent };
}

describe("call token", () => {
  it.each(["en", "ko", "unknown", undefined])("hints input transcription with the call language: %s", async (locale) => {
    const h = harness();
    await h.post("token", { locale });
    expect(h.sent().bidiGenerateContentSetup.inputAudioTranscription).toEqual({ languageCodes: [locale === "ko" ? "ko" : "en"] });
  });

  it("keeps transcription language with the brief on reconnect", async () => {
    const h = harness();
    const first = await h.post("token", { locale: "ko" });
    await h.post("token", { callId: first.data.callId, locale: "en", resume: true });
    expect(h.sent(1).bidiGenerateContentSetup.inputAudioTranscription).toEqual({ languageCodes: ["ko"] });
    expect(h.sent(1).bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain("Speak Korean");
  });

  it("mints a 1-use token with the setup locked in and never returns the key", async () => {
    const h = harness();
    const { status, raw, data } = await h.post("token");
    expect(status).toBe(200);
    expect(data).toEqual({ callId: expect.stringMatching(CALL_ID), engine: "gemini", model: LIVE_MODEL, url: LIVE_URL, token: "auth_tokens/abc123", expiresAt: expect.any(Number) });
    expect(raw).not.toContain(KEY);
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    const body = h.sent();
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(body.uses).toBe(1);
    expect(body.bidiGenerateContentSetup).toMatchObject({
      model: `models/${LIVE_MODEL}`,
      tools: [{ functionDeclarations: [expect.objectContaining({ name: "propose_work" }), expect.objectContaining({ name: "ask" })] }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 1_200, endOfSpeechSensitivity: "END_SENSITIVITY_LOW", startOfSpeechSensitivity: "START_SENSITIVITY_LOW", prefixPaddingMs: 300 } },
      sessionResumption: {},
    });
    const brief = body.bidiGenerateContentSetup.systemInstruction.parts[0].text as string;
    expect(brief).toContain("You are Juno");
    expect(brief).toContain("fix the login page");
    expect(brief).toContain("STATUS:\nJuno is idle.\nLocal time ");
  });

  it("keeps the brief for a resumed callId", async () => {
    const h = harness();
    const first = await h.post("token");
    h.store.appendMessage(h.bot.threadId, { role: "user", kind: "text", text: "a later line" });
    await h.post("token", { callId: first.data.callId, resume: true });
    expect(h.sent(1).bidiGenerateContentSetup.systemInstruction).toEqual(h.sent(0).bidiGenerateContentSetup.systemInstruction);
    await h.post("token");
    expect(h.sent(2).bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain("a later line");
  });

  it("brief has no details-in-chat tail", async () => {
    const h = harness();
    await h.post("token");
    const brief = h.sent().bidiGenerateContentSetup.systemInstruction.parts[0].text as string;
    expect(brief).toContain("say it in 1-3 sentences.");
    expect(brief).not.toContain("details in chat");
    expect(brief).toContain("never point the person to the chat or tell them to check it for details, in any language.");
    expect(brief).toContain("No code, paths, ids or links aloud: say it's in the chat. Otherwise never point the person to the chat");
    expect(brief).toContain("Busy in STATUS never stops new work: offer it and call propose_work, it queues.");
  });

  it("brief greets in the app language", async () => {
    const h = harness();
    await h.post("token", { locale: "ko" });
    const brief = h.sent().bidiGenerateContentSetup.systemInstruction.parts[0].text as string;
    expect(brief).toContain("Greet in Korean.");
  });

  it("brief speaks as the bot, never mentions sending to a bot", async () => {
    const h = harness();
    await h.post("token");
    const setup = h.sent().bidiGenerateContentSetup;
    const brief = setup.systemInstruction.parts[0].text as string;
    expect(brief).toContain("Never mention a bot, a helper, the chat or sending.");
    expect(brief).toContain("\"Want me to open your Desktop folder?\"");
    expect(brief).toContain("A vague order gets one short question first");
    expect(brief).not.toMatch(/ask whether to send|Juno has/);
    expect(setup.tools[0].functionDeclarations[0].description).not.toMatch(/bot/i);
  });

  it("order is the user's request to the voice, never its offer", () => {
    const order = LIVE_TOOLS[0]!.parameters.properties.order!.description;
    expect(order).toContain("as they would say it to you");
    expect(order).toContain("never your offer or reply");
  });

  it("brief routes PC actions to the bot", async () => {
    const h = harness();
    await h.post("token");
    const setup = h.sent().bidiGenerateContentSetup;
    const brief = setup.systemInstruction.parts[0].text as string;
    expect(brief).toContain("You have full access to the person's PC and projects");
    expect(brief).toContain("never say you can't do it or lack access");
    expect(setup.tools[0].functionDeclarations[0].description).toContain("full access to the user's PC");
  });

  it("brief pins the app language", async () => {
    const h = harness();
    await h.post("token", { locale: "ko" });
    await h.post("token");
    const brief = (call: number) => h.sent(call).bidiGenerateContentSetup.systemInstruction.parts[0].text as string;
    expect(brief(0)).toContain("Speak Korean");
    expect(brief(0)).toContain("ask again in Korean");
    expect(brief(1)).toContain("Speak English");
    expect(brief(0)).not.toContain("the user's language");
  });

  it("brief answers English or Korean in kind, any other language in the app language", async () => {
    const h = harness();
    await h.post("token");
    const brief = h.sent().bidiGenerateContentSetup.systemInstruction.parts[0].text as string;
    expect(brief).toContain("When they speak English or Korean, answer in that language");
    expect(brief).toContain("Any other language, Japanese too, gets English, never a third language.");
    expect(brief).not.toContain("Switch only when the person clearly asks");
  });

  it("brief never names the app Orbit", async () => {
    const h = harness();
    const bot = h.store.createBot({ name: "Teacher", description: "your project teacher for Orbit. Vault: C:\Orbit-extras\notes" }, { seedMessages: false });
    h.store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "is OpenMaus or MausBot in the Orbit build?" });
    await h.post("token", {}, bot.id);
    const brief = h.sent().bidiGenerateContentSetup.systemInstruction.parts[0].text as string;
    expect(brief).toContain("your project teacher for Wink");
    expect(brief).not.toMatch(/Orbit|OpenMaus|MausBot/i);
  });

  it("a bot named Orbit keeps its name", async () => {
    const h = harness();
    const bot = h.store.createBot({ name: "Orbit" }, { seedMessages: false });
    await h.post("token", {}, bot.id);
    expect(h.sent().bidiGenerateContentSetup.systemInstruction.parts[0].text).toContain("You are Orbit.");
  });

  it("409s without a key and puts one Gemini key card in the chat", async () => {
    const h = harness({ key: undefined });
    const first = await h.post("token");
    expect(first.status).toBe(409);
    const again = await h.post("token");
    expect(again.data.cardId).toBe(first.data.cardId);
    const cards = h.store.activePath(h.bot.threadId).filter((row) => row.kind === "secret");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.secret).toMatchObject({ target: "geminiApiKey", helpUrl: "https://aistudio.google.com/apikey" });
    expect(isCallKeyCard(cards[0]!.secret!)).toBe(true);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("502s with Google's message", async () => {
    const h = harness({ reply: () => Response.json({ error: { message: "Model not supported for ephemeral tokens" } }, { status: 400 }) });
    const { status, data } = await h.post("token");
    expect(status).toBe(502);
    expect(data.error).toBe("Model not supported for ephemeral tokens");
  });

  it("404s an unknown bot", async () => {
    expect((await harness().post("token", {}, "nobody")).status).toBe(404);
  });
});

describe("brief caps", () => {
  it("cuts notes to 16 KB on a whole line and never splits Hangul", () => {
    const notes = Array.from({ length: 400 }, (_, i) => `${i} 메모 줄입니다 note line`).join("\n");
    const cut = capNotes(notes);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(NOTES_MAX_BYTES);
    expect(notes.startsWith(cut)).toBe(true);
    expect(cut).not.toContain("�");
    expect(capNotes("short")).toBe("short");
  });

  it("keeps the newest chat lines within ~2k tokens", () => {
    const lines = Array.from({ length: 300 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `line ${i} ${"word ".repeat(20)}` }));
    const tail = chatTail(lines, "Ed");
    expect(estimateContextTokens([{ text: tail }])).toBeLessThanOrEqual(CHAT_TAIL_TOKENS + 10);
    expect(tail.endsWith(`You: line 299 ${"word ".repeat(20)}`)).toBe(true);
    expect(tail).not.toContain("line 0 ");
  });

  it("puts capped MEMORY.md in the brief", async () => {
    const h = harness();
    mkdirSync(workspaceDir(h.bot.id), { recursive: true });
    writeFileSync(join(workspaceDir(h.bot.id), "MEMORY.md"), Array.from({ length: 190 }, (_, i) => `- note ${i} ${"x".repeat(120)}`).join("\n"));
    await h.post("token");
    const brief = h.sent().bidiGenerateContentSetup.systemInstruction.parts[0].text as string;
    const notes = brief.split("YOUR NOTES:\n")[1]!.split("\n\nRECENT CHAT:")[0]!;
    expect(notes).toContain("- note 0 ");
    expect(Buffer.byteLength(notes, "utf8")).toBeLessThanOrEqual(NOTES_MAX_BYTES);
  });
});

describe("brief STATUS", () => {
  afterEach(() => { _resetSteerQueue(); });
  const statusOf = (brief: string) => brief.split("STATUS:\n")[1]!.split("\nLocal time ")[0]!;

  it("replaces NOW with busy state, waiting sends, the open card and worker reports", async () => {
    const h = harness();
    h.store.appendMessage(h.bot.threadId, { role: "user", kind: "note", text: "[pane aaaaaaaa] [BUILD | opus | high] from Juno (b1): FAIL BUILD branch=x sha=1 dirty=0\nstack trace" });
    h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "options", card: { title: "Your bot has a question", subtitle: "Restart at 8:15 PM instead?", options: ["Yes, 8:15 PM", "Still 1 AM"], askUser: true } });
    h.store.setActivity(h.bot.id, "working");
    queueSteeredMessage(h.bot.id, h.bot.threadId, "then deploy", {});
    await h.post("token");
    const brief = h.sent().bidiGenerateContentSetup.systemInstruction.parts[0].text as string;
    expect(brief).not.toContain("NOW:");
    expect(brief).toContain("FACTS: Only from YOUR NOTES, RECENT CHAT, STATUS and [Wink] lines.");
    expect(statusOf(brief)).toBe([
      "Juno is busy, working on: fix the login page.",
      "Sends waiting to run after this.",
      "Open question for the person: Restart at 8:15 PM instead? Options: Yes, 8:15 PM; Still 1 AM.",
      "Workers, newest first: BUILD reported FAILED.",
    ].join("\n"));
    expect(statusOf(brief)).not.toContain("stack trace");
  });

  it("stays under 1.6 KB in Korean", async () => {
    const h = harness();
    h.store.appendMessage(h.bot.threadId, { role: "user", kind: "text", text: "평가 루프를 다시 시작해 주세요. ".repeat(60) });
    h.store.appendMessage(h.bot.threadId, { role: "bot", kind: "options", card: { title: "질문", subtitle: "새벽 1시에 재시작할까요? ".repeat(60), options: Array.from({ length: 40 }, (_, i) => `선택지 ${"가".repeat(60)} ${i}`), askUser: true } });
    h.store.setActivity(h.bot.id, "working");
    await h.post("token", { locale: "ko" });
    const status = statusOf(h.sent().bidiGenerateContentSetup.systemInstruction.parts[0].text as string);
    expect(Buffer.byteLength(status, "utf8")).toBeLessThanOrEqual(STATUS_MAX_BYTES);
    expect(status).not.toContain("�");
  });
});

describe("call context on sends", () => {
  it("a call turn reads the lines said before it, skipping its own row and a line written after it", () => {
    const call = { id: "c-0123456789ab" };
    const at = 1;
    const rows = [
      { id: "t", role: "user", kind: "text", text: "typed before the call", at },
      { id: "l1", role: "user", kind: "text", text: "Can you check the build?", call, at },
      { id: "l2", role: "bot", kind: "text", text: "Want me to check it?", call: { ...call, voice: true }, at },
      { id: "o", role: "user", kind: "text", text: "Check the build.", call: { ...call, order: true }, at },
      { id: "l3", role: "user", kind: "text", text: "Yes.", call, at },
    ] as Parameters<typeof callLinesSinceLastUserTurn>[0];
    const [block] = callLinesSinceLastUserTurn(rows, new Set(["o"]));
    expect(block!.split("\n").slice(1)).toEqual(["Person: Can you check the build?", "You: Want me to check it?", "Person: Yes."]);
    expect(block).not.toContain("typed before the call");
  });
});

describe("call lines and end", () => {
  it("appends user and voice rows tagged with the call", async () => {
    const h = harness();
    const callId = "c-0123456789ab";
    const { status, data } = await h.post("lines", { callId, lines: [{ who: "user", text: " 로그인 페이지 고쳐줘 " }, { who: "voice", text: "로그인 페이지를 고칠까요?" }, { who: "user", text: "  " }] });
    expect(status).toBe(200);
    expect(data.ids).toHaveLength(2);
    const rows = h.store.activePath(h.bot.threadId).slice(-2);
    expect(rows.map(({ role, kind, text, call }) => ({ role, kind, text, call }))).toEqual([
      { role: "user", kind: "text", text: "로그인 페이지 고쳐줘", call: { id: callId } },
      { role: "bot", kind: "text", text: "로그인 페이지를 고칠까요?", call: { id: callId, voice: true } },
    ]);
  });

  it("400s a bad call id", async () => {
    expect((await harness().post("lines", { callId: "nope", lines: [{ who: "user", text: "hi" }] })).status).toBe(400);
  });

  it("appends the stats line to diag/live-call.jsonl", async () => {
    const h = harness();
    const stats = { device: "phone", ms: 61_000, turns: 4, userLines: 4, voiceLines: 4, hangulShare: 0.5, ttfaMs: { p50: 1_100, p90: 1_900 }, interrupted: 1, orders: { proposed: 1, confirmed: 1, declined: 0, expired: 0 }, doneGuard: 0, hidden: { spans: 0, ms: 0 }, reconnects: 0, closeCodes: [1000], usage: { total: 900 } };
    expect((await h.post("end", { callId: "c-0123456789ab", stats })).data).toEqual({ ok: true });
    const full = { ...stats, asks: { sent: 2, retried: 0, answered: 1, ms: { p50: 9_000, p90: 9_000 } }, guard: { nudges: 1, failLines: 0, promise: 1, cant: 0, unsure: 0 }, ackMs: { p50: 1_200, p90: 2_400 } };
    expect((await h.post("end", { callId: "c-0123456789ab", stats: full })).data).toEqual({ ok: true });
    const lines = readFileSync(join(h.dir, LIVE_CALL_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([{ receivedAt: expect.any(String), callId: "c-0123456789ab", botId: h.bot.id, model: LIVE_MODEL, ...stats }, { receivedAt: expect.any(String), callId: "c-0123456789ab", botId: h.bot.id, model: LIVE_MODEL, ...full }]);
  });
});

describe("call recap", () => {
  const callId = "c-0123456789ab";
  const said = [
    { who: "voice", text: "Good evening. What do you need?", at: 1_000 },
    { who: "user", text: "Can you fix the login page bug?", at: 9_000 },
    { who: "voice", text: "Fix the login page bug. Shall I send that?", at: 14_000 },
  ];
  const firstRow = (h: ReturnType<typeof harness>) => h.store.activePath(h.bot.threadId).find((row) => row.call?.id === callId)!;

  it("saves the length and summary on the call's first row and never asks twice", async () => {
    const h = harness({ reply: () => Response.json({ candidates: [{ content: { parts: [{ text: "You asked Juno to fix the login page bug.\n Juno sent the job." }] } }] }) });
    await h.post("lines", { callId, lines: said });
    await h.post("end", { callId, stats: { ms: 151_000 } });
    await vi.waitFor(() => expect(firstRow(h).call).toEqual({ id: callId, voice: true, ms: 151_000, summary: "You asked Juno to fix the login page bug. Juno sent the job." }));
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toContain(":generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(h.sent().contents[0].parts[0].text).toContain("User: Can you fix the login page bug?");
    await h.post("end", { callId, stats: { ms: 151_000 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("saves only the length when Google fails or there is no key", async () => {
    for (const h of [harness({ reply: () => Response.json({ error: { message: "quota" } }, { status: 429 }) }), harness({ key: undefined })]) {
      await h.post("lines", { callId, lines: said });
      await h.post("end", { callId, stats: {} });
      await vi.waitFor(() => expect(firstRow(h).call).toEqual({ id: callId, voice: true, ms: 13_000 }));
    }
  });
});

it("parses only well-formed call tags and drops voice", () => {
  expect(parseCallTag({ id: "c-0123456789ab", order: true, voice: true })).toEqual({ id: "c-0123456789ab", order: true });
  expect(parseCallTag({ id: "c-0123456789ab", ask: true })).toEqual({ id: "c-0123456789ab", ask: true });
  expect(parseCallTag({ id: "x" })).toBeUndefined();
  expect(parseCallTag(undefined)).toBeUndefined();
});
