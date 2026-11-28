// While Import Memory is empty, a new chat's first few turns get import_memory, so an answer pasted into the chat
// is saved by the Settings path from the user's own message; the bot never retypes it.
import type { IncomingMessage, ServerResponse } from "node:http";

import { aboutYouNote } from "../shared/about-you-note.ts";
import { catalogs, type MessageKey } from "../src/lib/i18n-catalog.ts";
import { aboutYouFacts, addToAboutYou, day, declineImport, importDeclined } from "./about-you.ts";
import { json, readBody } from "./http-helpers.ts";
import type { Message } from "./store.ts";

export const IMPORT_MEMORY_TOOL = "import_memory";
// the paste can come a message or two into the chat
const TOOL_TURNS = 3;

let locale: "en" | "ko" = "en";

/** The language of the user's latest send picks the result wording. */
export function noteSendLocale(value: unknown): void {
  if (value === "en" || value === "ko") locale = value;
}

function t(key: MessageKey, vars?: { count: number }): string {
  const phrase: string = catalogs[locale][key];
  return vars ? phrase.replaceAll("{count}", String(vars.count)) : phrase;
}

const offerOpen = () => !importDeclined() && !aboutYouFacts();

/** An owner's 1:1 turn gets the tool for a new chat's first few typed messages. Unsent counts a send not in messages yet. */
export function importMemoryTool(messages: Iterable<Pick<Message, "role" | "kind">>, unsent = 0): boolean {
  let typed = unsent;
  // stops past the first few typed lines, so a long chat costs nothing
  for (const message of messages) if (message.role === "user" && message.kind === "text" && ++typed > TOOL_TURNS) return false;
  return Boolean(typed) && offerOpen();
}

type Caller = { botId: string; threadId: string };
export type ImportMemoryDeps = {
  caller: (header: string | string[] | undefined) => Caller | undefined;
  ownerChat: (caller: Caller) => boolean;
  messages: (threadId: string) => readonly Message[];
  /** The calling turn is the owner's typed turn the per-turn rule opened; a session can keep the tool listed past it. */
  open: (caller: Caller) => boolean;
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

const CLOSED = "Import Memory saves from a new chat's first few messages only. Tell the user Settings > Import Memory still works.";

// Only a save that added something earns the recap.
const RECAP = {
  en: "Then tell them what you now know: up to 5 short bullets of the most specific things, fewer if the list has fewer. Use only from the saved facts list, add nothing.",
  ko: "그다음 지금 알게 된 내용을 말해 주세요: 저장된 사실 목록에서 가장 구체적인 것 최대 5개를 짧은 글머리표로 (목록이 적으면 더 적게). 저장된 사실 목록에 있는 것만 쓰고, 덧붙이지 마세요. 한국어로, 자연스러운 존댓말로 쓰세요.",
};

export async function importMemoryRoute(req: IncomingMessage, res: ServerResponse, deps: ImportMemoryDeps): Promise<void> {
  const source = deps.caller(req.headers.authorization);
  if (!source) return json(res, 403, { error: "unknown sender" });
  // a room holds other people's text: only the owner's own chat may write their memory
  if (!deps.ownerChat(source)) return json(res, 403, { error: `${IMPORT_MEMORY_TOOL} works only in the user's own chat with you` });
  // Settings now, not at turn start: a save or decline there mid-turn closes it
  if (!deps.open(source) || !offerOpen()) return json(res, 200, { text: CLOSED });
  const body = await readBody(req);
  if (body?.decline === true) {
    declineImport();
    return json(res, 200, { text: "Saved: no bot offers this again. Settings > Import Memory still works." });
  }
  const accepted: string[] = [];
  const result = addToAboutYou(pastedAnswer(deps.messages(source.threadId)), day((deps.now ?? Date.now)()), accepted);
  // the count only: a line that looked like a password is never echoed into the chat, which is saved and sent on
  const flagged = !("error" in result) && result.flagged.length ? ` ${t(result.flagged.length === 1 ? "aboutYou.flaggedChatOne" : "aboutYou.flaggedChat", { count: result.flagged.length })}` : "";
  const note = !("error" in result) ? (aboutYouNote(result, t) + flagged).trim()
    : result.error === "too-large" ? t("aboutYou.tooLarge")
    : result.error === "empty" ? t("aboutYou.noFacts")
    : t("aboutYou.failed");
  const recap = !("error" in result) && result.added ? `\nSaved facts:\n${accepted.map((fact) => `- ${fact}`).join("\n")}${result.added > accepted.length ? `\n+${result.added - accepted.length} more` : ""}\n${RECAP[locale]}` : "";
  return json(res, 200, { text: `Import Memory says: ${note}\nTell the user this result.${recap}` });
}
