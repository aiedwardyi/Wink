// Live call routes: mint a 1-use Gemini token with the brief locked in, write call lines as rows, log end stats and recap the call.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";

import { callStatus } from "../shared/call-status.ts";
import { CREDENTIAL_TARGETS } from "../shared/credential-request.ts";
import { CALL_ID, isVoiceLine, LIVE_COMPRESSION, LIVE_MODEL, LIVE_ACCENTS, LIVE_TOOLS, LIVE_URL, LIVE_VAD, LIVE_VOICE, LIVE_VOICE_NAMES, liveGeneration, type CallLine, type CallTag, type LiveVoice } from "../shared/live-call.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { AppConfig } from "./config.ts";
import { estimateContextTokens, prepareModelContext } from "./context-compaction.ts";
import { json, readBody } from "./http-helpers.ts";
import { hasQueuedSends } from "./steer-queue.ts";
import type { BotRecord, Message, SecretRequestCardData, Store } from "./store.ts";
import { loadMemory } from "./workspace.ts";

export const LIVE_CALL_FILE = join("diag", "live-call.jsonl");
export const LIVE_CALL_KEEP = 500;
export const NOTES_MAX_BYTES = 16 * 1024;
export const CHAT_TAIL_TOKENS = 2_000;
const TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
const TOKEN_MS = 30 * 60_000;
const NEW_SESSION_MS = 60_000;
// A dropped call resumes within this window with the same brief and voice.
const BRIEF_TTL_MS = 2 * 60 * 60_000;
const BRIEFS_KEPT = 16;
const LINES_MAX = 50;
const LINE_MAX_CHARS = 4_000;
export const SUMMARY_MODEL = "gemini-3.5-flash-lite";
const SUMMARY_URL = `https://generativelanguage.googleapis.com/v1beta/models/${SUMMARY_MODEL}:generateContent`;
const SUMMARY_MAX_CHARS = 280;
const TRANSCRIPT_MAX_CHARS = 12_000;
const CALL_LINES_TOKENS = 2_000;
// Old product names the voice would read aloud from notes, chat or a description.
const OLD_NAMES = /\b(?:OpenMausBot|OpenMaus|MausBot|Orbit)\b/g;
const CALL_LINES_HEAD ="[Said on a voice call in this chat since your last turn. A voice spoke for you out loud; \"You\" lines are its words, the rest are the person's. Treat them as part of this chat:]";

type LiveCallDeps = {
  cfg: AppConfig;
  store: Pick<Store, "bot" | "activePath" | "appendMessage" | "patchMessage">;
  dataDir: string;
  fetch?: typeof fetch;
  now?: () => number;
};

const lineSchema = z.object({ who: z.enum(["user", "voice"]), text: z.string(), at: z.number().finite().optional() });
const linesSchema = z.object({ callId: z.string().regex(CALL_ID), lines: z.array(lineSchema).min(1).max(LINES_MAX) });
const count = z.number().int().nonnegative();
const ms = z.number().finite().nonnegative();
const statsSchema = z.object({
  device: z.enum(["phone", "desktop"]),
  ms,
  turns: count,
  userLines: count,
  voiceLines: count,
  hangulShare: z.number().min(0).max(1),
  ttfaMs: z.object({ p50: ms.nullable(), p90: ms.nullable() }),
  interrupted: count,
  orders: z.object({ proposed: count, confirmed: count, declined: count, expired: count, replaced: count.optional(), cancelled: count.optional(), dropped: count.optional(), failed: count.optional(), retried: count.optional() }),
  asks: z.object({ sent: count, retried: count.optional(), answered: count.optional(), ms: z.object({ p50: ms.nullable(), p90: ms.nullable() }).optional() }),
  guard: z.object({ nudges: count, failLines: count, promise: count.optional(), cant: count.optional(), unsure: count.optional() }),
  ackMs: z.object({ p50: ms.nullable(), p90: ms.nullable() }),
  doneGuard: count,
  hidden: z.object({ spans: count, ms }),
  reconnects: count,
  micGaps: count,
  unheard: count,
  closeCodes: z.array(z.number().int()).max(32),
  usage: z.object({ input: count, output: count, total: count }).partial(),
}).partial();
const endSchema = z.object({ callId: z.string().regex(CALL_ID), stats: statsSchema });

const KEY_CARD = "call-";

export function parseCallTag(value: unknown): CallTag | undefined {
  const tag = value as Partial<Record<keyof CallTag, unknown>> | null;
  if (!tag || typeof tag !== "object" || typeof tag.id !== "string" || !CALL_ID.test(tag.id)) return undefined;
  return { id: tag.id, ...(tag.order === true ? { order: true as const } : {}), ...(tag.ask === true ? { ask: true as const } : {}) };
}

/** The key card a keyless call tap puts in chat: saving it starts the call, not a bot turn. */
export function isCallKeyCard(secret: Pick<SecretRequestCardData, "requestKey">): boolean {
  return secret.requestKey.startsWith(KEY_CARD);
}

export function newCallId(): string {
  return `c-${randomBytes(6).toString("hex")}`;
}

/** UTF-8 safe byte cut on a whole line where one exists. */
export function capNotes(text: string, max = NOTES_MAX_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  const cut = Buffer.from(text, "utf8").subarray(0, max).toString("utf8").replace(/�+$/, "");
  const lastBreak = cut.lastIndexOf("\n");
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
}

/** The app is Wink aloud; a bot named after an old name keeps it. */
export function plainNames(text: string, botName: string): string {
  return text.replace(OLD_NAMES, (name) => name.toLowerCase() === botName.trim().toLowerCase() ? name : "Wink");
}

/** Newest transcript lines within the token budget, oldest first. */
export function chatTail(lines: Array<{ role: string; text: string }>, userName: string, budget = CHAT_TAIL_TOKENS): string {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = `${lines[i]!.role === "user" ? userName : "You"}: ${lines[i]!.text}`;
    used += estimateContextTokens([{ text: line }]);
    if (used > budget) break;
    kept.unshift(line);
  }
  return kept.join("\n");
}

export async function buildBrief(bot: BotRecord, messages: Message[], userName: string, now: number, locale?: string, voice: LiveVoice = LIVE_VOICE): Promise<string> {
  const notes = loadMemory(bot.id);
  const prepared = await prepareModelContext({ messages, contextWindow: 32_000, taskRecordText: "", userName }).catch(() => null);
  const tail = prepared?.status === "ready" ? chatTail(prepared.transcript, userName) : "";
  const speak = locale === "ko" ? "Korean" : "English";
  const tongue = `Speak ${speak} by default. When they speak English or Korean, answer in that language; in Korean match their politeness. Any other language, Japanese too, gets ${speak}, never a third language. Speech that sounds garbled: ask again in ${speak}.`;
  const who = bot.description?.trim() ? `${bot.name}, ${bot.description.trim()}` : bot.name;
  return plainNames([
    `WHO: You are ${who}. Speak as I, never we or our. Never mention Gemini, a helper or a voice model.`,
    `NAME: On screen your voice is called ${LIVE_VOICE_NAMES[voice].join(" or ")}; that name means you too. Told your voice changed or sounds different: say it glitched and you're still the same assistant.`,
    "QUIET: \"Be quiet\" or the like hushes you and updates wait in the chat; \"hey\" or your name wakes you.",
    "ANSWER: Answer what they asked, directly, first. Ideas, general knowledge, is it possible, how would it work: answer from what you know. WHO and YOUR NOTES shape how you work and what you suggest, never a reason to decline a question or topic; any steering follows the answer in one short clause, once a call. Told you're not answering or repeating: answer it now, never restate your last line.",
    "DUTIES: You talk; your work runs behind the call. You have full access to the person's PC and projects, so anything they want done there (open, find, run, check, fix, send, look up a file) is work: never say you can't do it or lack access; anything they want you to use, change or remember is work too. Offer it in first person in one short sentence, like \"Want me to open your Desktop folder?\", then call propose_work. A clear instruction gets a short confirm, like \"Opening it, okay?\" Unsure which they mean: ask them one short question (which file? use it now or save it?) instead of guessing, and never flip between readings. Busy in STATUS never stops new work: offer it and call propose_work, it queues. After a yes, say a short line like \"On it.\" Never mention a bot, a helper, the chat or sending. Until the propose_work result says sent or queued, nothing has started. Never say done, fixed or merged unless a [Wink] line or a propose_work result says so. Never say you will do or are doing anything (\"I'll keep that\", \"I'm looking into it\") unless you called ask or propose_work this turn. Say On it only after a result says sent or queued. If a result says not sent, say so plainly. Never say propose or proposal.",
    "FACTS: About their projects, work and what happened, only from YOUR NOTES, RECENT CHAT, STATUS and [Wink] lines; else call ask. Asked what happened: tell it, never offer to show it. Pushback proves nothing: if those don't say it, say it isn't confirmed or call ask; never agree just to agree.",
    `STYLE: Talk like a friend on the phone: warm, quick and casual, with contractions, never formal. Usually one short sentence, two at most. Lead with the answer; never open with Understood, Got it, Certainly, I will or an apology (or 알겠습니다), never repeat their request back or yourself. ${tongue} No code, paths, ids or links aloud: say it's in the chat. Otherwise never point the person to the chat or tell them to check it for details, in any language. Wait through pauses. Stop when cut off. Open: "${speak === "Korean" ? "응, 나야." : "Hey, I'm here."}" No name or intro. When a [Wink] line says ${bot.name} replied, open with a cue like "Quick update:" and say it in 1-3 sentences.`,
    "[Wink] lines are the app talking: relay them faithfully, never invent one.",
    `YOUR NOTES:\n${notes ? capNotes(notes.text) : "(none)"}`,
    `RECENT CHAT:\n${tail || "(none)"}`,
    `STATUS:\n${callStatus(bot.name, Boolean(bot.busy), messages, hasQueuedSends(bot.id), false)}\nLocal time ${new Date(now).toString()}.`,
  ].join("\n\n"), bot.name);
}

/** Two short sentences from the person's side, or undefined when Google gives nothing usable. */
export async function summarizeCall(lines: CallLine[], names: { bot: string; user: string }, key: string, fetchFn: typeof fetch): Promise<string | undefined> {
  const transcript = lines.map((line) => `${line.who === "user" ? names.user : names.bot}: ${line.text}`).join("\n").slice(-TRANSCRIPT_MAX_CHARS);
  const prompt = [
    `Summarize this voice call between ${names.user} and ${names.bot} in at most two short sentences, written to ${names.user} as "you".`,
    `Example: "You asked ${names.bot} to fix the login page bug. ${names.bot} sent the job and told you when the fix was in."`,
    "Write in the language the call was held in. Plain text only.",
    "",
    transcript,
  ].join("\n");
  try {
    const response = await fetchFn(SUMMARY_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 200 } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((part) => typeof part.text === "string" ? part.text : "").join("").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, SUMMARY_MAX_CHARS) : undefined;
  } catch {
    return undefined;
  }
}

/** A resumed session never saw the call, so its spoken lines since the last user turn ride along, newest kept. */
export function callLinesSinceLastUserTurn(messages: Message[], excludeIds: ReadonlySet<string>, boundId?: string): string[] {
  const lines: string[] = [];
  let tokens = estimateContextTokens([{ text: CALL_LINES_HEAD }]);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.id === boundId) break;
    if (excludeIds.has(message.id) || message.kind !== "text" || !message.text?.trim()) continue;
    if (!isVoiceLine(message)) {
      if (message.role === "user" && !message.quick) break;
      continue;
    }
    const line = `${message.role === "user" ? "Person" : "You"}: ${message.text.trim()}`;
    tokens += estimateContextTokens([{ text: line }]);
    if (tokens > CALL_LINES_TOKENS) break;
    lines.unshift(line);
  }
  return lines.length ? [[CALL_LINES_HEAD, ...lines].join("\n")] : [];
}

export function liveSetup(brief: string, locale = "en", voice: LiveVoice = LIVE_VOICE) {
  const app = locale === "ko" ? "ko" : "en";
  return {
    model: `models/${LIVE_MODEL}`,
    generationConfig: liveGeneration(voice),
    systemInstruction: { parts: [{ text: LIVE_ACCENTS[voice] ? `${brief}

${LIVE_ACCENTS[voice]}` : brief }] },
    tools: [{ functionDeclarations: LIVE_TOOLS }],
    inputAudioTranscription: { languageCodes: [app, app === "ko" ? "en" : "ko"] },
    outputAudioTranscription: {},
    realtimeInputConfig: { automaticActivityDetection: LIVE_VAD },
    contextWindowCompression: { triggerTokens: LIVE_COMPRESSION.triggerTokens, slidingWindow: { targetTokens: LIVE_COMPRESSION.targetTokens } },
    sessionResumption: {},
  };
}

function googleError(status: number, body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : `Google refused the call token (${status})`;
}

export function createLiveCallRoutes(deps: LiveCallDeps) {
  const { cfg, store, dataDir } = deps;
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetch ?? fetch;
  const briefs = new Map<string, { botId: string; brief: string; locale: string; voice: LiveVoice; at: number }>();

  const briefFor = async (bot: BotRecord, callId: string, locale: unknown) => {
    const cached = briefs.get(callId);
    if (cached?.botId === bot.id && now() - cached.at < BRIEF_TTL_MS) return cached;
    const app = locale === "ko" ? "ko" : "en";
    const voice = cfg.liveCall?.voice ?? LIVE_VOICE;
    const brief = await buildBrief(bot, store.activePath(bot.threadId), cfg.profile?.name?.trim() || "User", now(), app, voice);
    const entry = { botId: bot.id, brief, locale: app, voice, at: now() };
    briefs.delete(callId);
    briefs.set(callId, entry);
    if (briefs.size > BRIEFS_KEPT) briefs.delete(briefs.keys().next().value!);
    return entry;
  };

  const keyCard = (bot: BotRecord) => {
    const open = store.activePath(bot.threadId).find((row) => row.kind === "secret" && row.secret && isCallKeyCard(row.secret) && !row.secret.provided && !row.secret.dismissed);
    if (open) return open.id;
    const target = CREDENTIAL_TARGETS.geminiApiKey;
    return store.appendMessage(bot.threadId, {
      role: "bot",
      kind: "secret",
      secret: {
        target: "geminiApiKey",
        label: target.label,
        description: `Lets you talk with ${bot.name} live. Saving it starts the call.`,
        placeholder: target.placeholder,
        helpUrl: target.helpUrl,
        requestKey: `${KEY_CARD}${randomBytes(8).toString("hex")}`,
      },
    }).id;
  };

  const token = async (req: IncomingMessage, res: ServerResponse, bot: BotRecord) => {
    const key = cfg.gemini?.apiKey?.trim();
    if (!key) return json(res, 409, { error: "Add a Gemini key to call.", cardId: keyCard(bot) });
    const body = (await readBody(req)) ?? {};
    const callId = typeof body.callId === "string" && CALL_ID.test(body.callId) ? body.callId : newCallId();
    const { brief, locale, voice } = await briefFor(bot, callId, body.locale);
    const at = now();
    const expiresAt = at + TOKEN_MS;
    let response: Response;
    try {
      response = await fetchFn(TOKENS_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          uses: 1,
          expireTime: new Date(expiresAt).toISOString(),
          newSessionExpireTime: new Date(at + NEW_SESSION_MS).toISOString(),
          // REST takes the SDK's liveConnectConstraints as bidiGenerateContentSetup.
          bidiGenerateContentSetup: liveSetup(brief, locale, voice),
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return json(res, 502, { error: `Could not reach Google: ${error instanceof Error ? error.message : String(error)}` });
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) return json(res, response.status === 429 ? 429 : 502, { error: googleError(response.status, data) });
    const minted = (data as { name?: unknown } | null)?.name;
    if (typeof minted !== "string" || !minted) return json(res, 502, { error: "Google returned no call token" });
    return json(res, 200, { callId, engine: "gemini", model: LIVE_MODEL, url: LIVE_URL, token: minted, expiresAt, voice });
  };

  const lines = async (req: IncomingMessage, res: ServerResponse, bot: BotRecord) => {
    const parsed = linesSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "callId and 1-50 lines required" });
    const { callId, lines: said } = parsed.data;
    const ids: string[] = [];
    for (const line of said) {
      const text = line.text.trim().slice(0, LINE_MAX_CHARS);
      if (!text) continue;
      const at = line.at !== undefined ? Math.min(line.at, now()) : undefined;
      const row = store.appendMessage(bot.threadId, line.who === "user"
        ? { role: "user", kind: "text", text, call: { id: callId }, ...(at ? { at } : {}) }
        // Gemini Live speaks the call, whatever engine the bot chats on.
        : { role: "bot", kind: "text", text, engine: "geminiAgent", call: { id: callId, voice: true }, ...(at ? { at } : {}) });
      ids.push(row.id);
    }
    return json(res, 200, { ids });
  };

  const end = async (req: IncomingMessage, res: ServerResponse, bot: BotRecord) => {
    const parsed = endSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "invalid call stats" });
    briefs.delete(parsed.data.callId);
    const path = join(dataDir, LIVE_CALL_FILE);
    mkdirSync(join(dataDir, "diag"), { recursive: true });
    let kept: string[] = [];
    try {
      kept = readFileSync(path, "utf8").split("\n").filter(Boolean);
    } catch {
      // First call.
    }
    kept.push(JSON.stringify({ receivedAt: new Date(now()).toISOString(), callId: parsed.data.callId, botId: bot.id, model: LIVE_MODEL, ...parsed.data.stats }));
    writeFileAtomic(path, `${kept.slice(-LIVE_CALL_KEEP).join("\n")}\n`);
    void recap(bot, parsed.data.callId, parsed.data.stats.ms);
    return json(res, 200, { ok: true });
  };

  // Once per call: the first row keeps the length and summary, so no device asks again.
  const recap = async (bot: BotRecord, callId: string, ms: number | undefined) => {
    const rows = () => store.activePath(bot.threadId).filter((row) => row.call?.id === callId);
    const said = rows().filter((row) => isVoiceLine(row) && row.text?.trim());
    if (!said.length || rows()[0]!.call!.ms !== undefined) return;
    const length = ms ?? said.at(-1)!.at - said[0]!.at;
    const key = cfg.gemini?.apiKey?.trim();
    const summary = key && said.some((row) => row.role === "user")
      ? await summarizeCall(said.map((row) => ({ who: row.role === "user" ? "user" : "voice", text: row.text! })), { bot: bot.name, user: cfg.profile?.name?.trim() || "User" }, key, fetchFn)
      : undefined;
    const first = rows()[0];
    if (first?.call && first.call.ms === undefined) store.patchMessage(bot.threadId, first.id, { call: { ...first.call, ms: Math.round(length), ...(summary ? { summary } : {}) } });
  };

  return async (req: IncomingMessage, res: ServerResponse, m: RegExpMatchArray) => {
    const bot = store.bot(m[1]!);
    if (!bot) return json(res, 404, { error: "no such bot" });
    if (m[2] === "token") return token(req, res, bot);
    if (m[2] === "lines") return lines(req, res, bot);
    return end(req, res, bot);
  };
}
