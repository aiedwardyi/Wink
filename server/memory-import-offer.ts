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
export function importMemoryTurn(messages: readonly Pick<Message, "role" | "kind">[], unsent = 0): { offer: boolean; tool: boolean } {
  let typed = unsent;
  // stops past the first few typed lines, so a long chat costs nothing
  for (const message of messages) if (message.role === "user" && message.kind === "text" && ++typed > TOOL_TURNS) return NONE;
  if (!typed || existsSync(declinedFile()) || aboutYouFacts()) return NONE;
  return { offer: typed === 1, tool: true };
}

export function importOfferNote(): string {
  return [
    `[Wink] The user has not imported memory from another AI yet. After your answer, end this reply with one short line in the user's language offering to bring in what their other AI (like ChatGPT, Claude or Gemini) knows about them: they paste the prompt below into it, then paste its answer here. Then give the prompt exactly as written, in a text code block. When they paste that answer, call ${IMPORT_MEMORY_TOOL} and tell them its result. If they say no, call ${IMPORT_MEMORY_TOOL} with decline: true. Offer only in this reply.`,
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
  const paste = deps.messages(source.threadId).findLast((message) => message.role === "user" && message.kind === "text")?.text ?? "";
  const result = addToAboutYou(paste, day((deps.now ?? Date.now)()));
  const note = !("error" in result) ? aboutYouNote(result, t)
    : result.error === "too-large" ? t("aboutYou.tooLarge")
    : result.error === "empty" ? t("aboutYou.noFacts")
    : t("aboutYou.failed");
  return json(res, 200, { text: `Import Memory says: ${note}\nTell the user this result.` });
}
