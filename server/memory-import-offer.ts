// A new bot's first reply offers to bring in what another AI knows about the user, while Import Memory is empty.
// The paste is saved by the Settings path from the user's own message; the bot never retypes it.
import { existsSync, mkdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { aboutYouNote } from "../shared/about-you-note.ts";
import { catalogs, type MessageKey } from "../src/lib/i18n-catalog.ts";
import { aboutYouFacts, addToAboutYou, day } from "./about-you.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { json, readBody } from "./http-helpers.ts";
import type { Message } from "./store.ts";

export const IMPORT_MEMORY_TOOL = "import_memory";
// the paste can come a message or two after the offer
const TOOL_TURNS = 3;
const NONE = { offer: false, tool: false } as const;
// beside Import Memory, so the decline travels wherever that folder does
const declinedFile = () => join(DATA_DIR, "about-you", "declined");

let locale: "en" | "ko" = "en";

/** The language of the user's latest send picks the prompt and result wording. */
export function noteSendLocale(value: unknown): void {
  if (value === "en" || value === "ko") locale = value;
}

function t(key: MessageKey, vars?: { count: number }): string {
  const phrase: string = catalogs[locale][key];
  return vars ? phrase.replaceAll("{count}", String(vars.count)) : phrase;
}

/** An owner's 1:1 turn: the offer on a new chat's first typed message, the tool until the paste can have come. Unsent counts a send not in messages yet. */
export function importMemoryTurn(messages: Iterable<Pick<Message, "role" | "kind">>, unsent = 0): { offer: boolean; tool: boolean } {
  let typed = unsent;
  // stops past the first few typed lines, so a long chat costs nothing
  for (const message of messages) if (message.role === "user" && message.kind === "text" && ++typed > TOOL_TURNS) return NONE;
  if (!typed || existsSync(declinedFile()) || aboutYouFacts()) return NONE;
  return { offer: typed === 1, tool: true };
}

const OFFER = {
  en: [
    "Want me to know what ChatGPT, Claude, Gemini, Grok or Muse already knows about you? It takes a minute:",
    "1. Copy the prompt in the box below.",
    "2. Paste it into that AI, on its own app or website (not here in Wink).",
    "3. Copy its answer and paste it back here.",
  ],
  ko: [
    "ChatGPT, Claude, Gemini, Grok, Muse가 이미 알고 있는 내용을 저도 알아 둘까요? 1분이면 돼요:",
    "1. 아래 상자의 프롬프트를 복사하세요.",
    "2. 그 AI의 앱이나 웹사이트에 붙여 넣으세요 (여기 Wink 말고요).",
    "3. 그 AI의 답을 복사해서 여기에 붙여 넣으세요.",
  ],
};

export function importOfferNote(): string {
  return [
    `[Wink] The user has not imported memory from another AI yet. After your answer, end this reply with the offer below word for word, then the prompt below exactly as written in a text code block. Write nothing else about importing. When they paste that answer, call ${IMPORT_MEMORY_TOOL} and tell them its result. If they say no, call ${IMPORT_MEMORY_TOOL} with decline: true. Offer only in this reply.`,
    OFFER[locale].join("\n"),
    `\`\`\`text\n${t("aboutYou.prompt")}\n\`\`\``,
  ].join("\n\n");
}

type Caller = { botId: string; threadId: string };
export type ImportMemoryDeps = {
  caller: (header: string | string[] | undefined) => Caller | undefined;
  ownerChat: (caller: Caller) => boolean;
  messages: (threadId: string) => readonly Message[];
  now?: () => number;
};

// A later steered "thanks" or a side quick ask must not stand in for the paste, so prefer the latest Source:-signed one.
function pastedAnswer(messages: readonly Message[]): string {
  let latest: string | undefined;
  for (let i = messages.length - 1, seen = 0; i >= 0 && seen <= TOOL_TURNS; i--) {
    const message = messages[i];
    if (message.role !== "user" || message.kind !== "text" || (message.quick && !message.steered)) continue;
    seen++;
    const text = message.text ?? "";
    if (/^\s*Source:/m.test(text)) return text;
    latest ??= text;
  }
  return latest ?? "";
}

// Only a save that added something earns the recap; the bullets come from the user's own paste, already in the chat, so no extra model call.
const RECAP = {
  en: "Then tell them what you now know: up to 5 short bullets of the most specific things from their paste, fewer if it has fewer. Use only what the paste says, add nothing, skip anything Import Memory left out.",
  ko: "그다음 지금 알게 된 내용을 말해 주세요: 붙여 넣은 내용에서 가장 구체적인 것 최대 5개를 짧은 글머리표로 (내용이 적으면 더 적게). 붙여 넣은 내용에 있는 것만 쓰고, 덧붙이지 말고, Import Memory가 뺀 것은 빼세요. 한국어로, 자연스러운 존댓말로 쓰세요.",
};

export async function importMemoryRoute(req: IncomingMessage, res: ServerResponse, deps: ImportMemoryDeps): Promise<void> {
  const source = deps.caller(req.headers.authorization);
  if (!source) return json(res, 403, { error: "unknown sender" });
  // a room holds other people's text: only the owner's own chat may write their memory
  if (!deps.ownerChat(source)) return json(res, 403, { error: `${IMPORT_MEMORY_TOOL} works only in the user's own chat with you` });
  const body = await readBody(req);
  if (body?.decline === true) {
    mkdirSync(join(DATA_DIR, "about-you"), { recursive: true, mode: 0o700 });
    writeFileAtomic(declinedFile(), "", { mode: 0o600 });
    return json(res, 200, { text: "Saved: no bot offers this again. Settings > Import Memory still works." });
  }
  const result = addToAboutYou(pastedAnswer(deps.messages(source.threadId)), day((deps.now ?? Date.now)()));
  const note = !("error" in result) ? aboutYouNote(result, t)
    : result.error === "too-large" ? t("aboutYou.tooLarge")
    : result.error === "empty" ? t("aboutYou.noFacts")
    : t("aboutYou.failed");
  const recap = !("error" in result) && result.added ? `\n${RECAP[locale]}` : "";
  return json(res, 200, { text: `Import Memory says: ${note}\nTell the user this result.${recap}` });
}
