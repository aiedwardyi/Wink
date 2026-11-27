// A collector waiting on one turn's reply. Bus subscribers each see every
// event, so the persistence guard dropping a stopped turn's late text does
// not stop it reaching a collector; each collector applies the same rule.
import type { RuntimeEvent } from "./contracts.ts";
import { ENGINE_SUMMARY_PREFIX } from "./replies.ts";
import type { Message, RowMark } from "./store.ts";

export type TurnReplyStep = { text: string; replace?: boolean } | "completed" | null;
type Phase = Extract<RuntimeEvent, { itemType: "assistant_text" }>["phase"];

export function ownTurnReply(stale: (threadId: string, turnId: string | undefined) => boolean) {
  let own: string | undefined;
  let final = false;
  const retained: string[] = [];
  // a failed start completes before dispatch returns the id to claim
  const ended = new Set<string>();
  return {
    claim(turnId: string | undefined) {
      own ??= turnId;
      return Boolean(turnId && turnId === own && ended.has(turnId));
    },
    fold(e: RuntimeEvent): TurnReplyStep {
      // the fold settles its own turn before collectors run, so completion
      // is matched by id, never by the stale rule
      if (e.type === "turn.completed") {
        if (!e.turnId || e.turnId === own) return "completed";
        ended.add(e.turnId);
        return null;
      }
      if (stale(e.threadId, e.turnId)) return null;
      if (e.type === "turn.started") own ??= e.turnId;
      if (e.type !== "item.completed" || e.itemType !== "assistant_text") return null;
      own ??= e.turnId;
      if (e.turnId && e.turnId !== own) return null;
      if (e.phase === "commentary" && final) return null;
      const text = e.summarized ? `${ENGINE_SUMMARY_PREFIX}${e.text}` : e.text;
      if (e.phase !== "commentary") retained.push(text);
      if (e.phase !== "final_answer" || final) return { text };
      final = true;
      return { text: retained.join("\n"), replace: true };
    },
  };
}

// the 50 most common English words, those of 3+ letters
const COMMON = new Set("the and that have for not with you this but his from they say her she will one all would there their what out about who get which".split(" "));
const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => /^\p{N}+$/u.test(word) || (word.length >= 3 && !COMMON.has(word)));
const numbers = (text: string) => new Set(text.match(/\p{N}+(?:[.,:]\p{N}+)*/gu) ?? []);
// links, link or image targets, code, paths and file names
const KEPT = /https?:\/\/[^\s<>()\]]*[^\s<>()\].,;:!?'"]|\]\([^)\s]+\)|```[\s\S]*?```|`[^`\n]+`|(?:[A-Za-z]:)?[\w.~-]*(?:[\\/][\w.~-]+)+|\b[\w-]+\.[A-Za-z]\w{1,4}\b/g;

type Said = { id: string; text: string; words: string[]; numbers: Set<string> };

/** Most of an answer's content words come back together in a later text of
 * the same turn, and every link, path, code and number it had. */
function restates(later: Said, earlier: Said): boolean {
  const own = new Set(earlier.words);
  if (own.size < 8) return false;
  // close together: a long answer holds most words of any short line somewhere
  const span = Math.ceil(1.5 * earlier.words.length);
  let kept = 0;
  for (let i = 0; i === 0 || i + span <= later.words.length; i++) kept = Math.max(kept, new Set(later.words.slice(i, i + span).filter((word) => own.has(word))).size);
  if (kept / own.size < 0.7) return false;
  for (const number of earlier.numbers) if (!later.numbers.has(number)) return false;
  return (earlier.text.match(KEPT) ?? []).every((part) => later.text.includes(part));
}

const said = (text: string, id = ""): Said => ({ id, text, words: words(text), numbers: numbers(text) });

/** The texts no later one restates. */
export function unrestated(texts: string[]): string[] {
  const rows = texts.map((text) => said(text));
  return texts.filter((_, i) => !rows.slice(i + 1).some((later) => restates(later, rows[i]!)));
}

/** Per thread, the turn's engine summaries. A turn that wrote no other text
 * shows them at its end, or it would look empty; one with a final answer
 * hides its commentary, and a text a later one restates. */
export function turnSummaries(hide?: (threadId: string, ids: string[], restated?: true) => void) {
  const turns = new Map<string, { turnId?: string; ids: string[]; replied: boolean; commentary: string[]; final: boolean; said: Said[] }>();
  return {
    /** `text` only for a row a later restatement may hide. */
    note(threadId: string, turnId: string | undefined, messageId: string, summarized: boolean, phase?: Phase, text?: string) {
      let turn = turns.get(threadId);
      if (!turn || (turn.turnId && turnId && turn.turnId !== turnId)) turns.set(threadId, (turn = { turnId, ids: [], replied: false, commentary: [], final: false, said: [] }));
      turn.turnId ??= turnId;
      if (summarized) turn.ids.push(messageId);
      else turn.replied = true;
      if (phase === "commentary") turn.commentary.push(messageId);
      else if (phase === "final_answer") turn.final = true;
      if (!summarized && text) turn.said.push(said(text, messageId));
    },
    settle(threadId: string, turnId: string | undefined, quiet = false): string[] {
      const turn = turns.get(threadId);
      if (!turn || (turn.turnId && turnId && turn.turnId !== turnId)) return [];
      turns.delete(threadId);
      // commentary a final hides cannot stand in for an earlier row
      const hidden = new Set(turn.final ? turn.commentary : []);
      const restated = new Set(turn.said.filter((row, i) => turn.said.slice(i + 1).some((later) => !hidden.has(later.id) && restates(later, row))).map((row) => row.id));
      const commentary = [...hidden].filter((id) => !restated.has(id));
      if (commentary.length) hide?.(threadId, commentary);
      if (restated.size) hide?.(threadId, [...restated], true);
      return turn.replied || quiet ? [] : turn.ids;
    },
  };
}

export function turnAddedMessage(messages: readonly Message[], start: number): boolean {
  return messages.slice(start).some((message) => {
    if (message.role !== "bot" || message.summarized || message.kind === "compaction" || message.quick) return false;
    if (message.kind === "activity") {
      return Boolean(message.comm || message.tool?.ok === false || message.tool?.name.startsWith("error:") || message.tool?.name === "memory.save");
    }
    if (message.kind === "text") return Boolean(message.text?.trim());
    if (message.kind === "options") return Boolean(message.card);
    if (message.kind === "connector") return Boolean(message.connector);
    if (message.kind === "secret") return Boolean(message.secret);
    if (message.kind === "screen") return Boolean(message.image || message.png || message.hasImage || message.roomFiles?.some((file) => !file.deleted && file.type.startsWith("image/")));
    return true;
  });
}

export function turnUnread() {
  const turns = new Map<string, { turnId?: string; start: RowMark }>();
  return {
    start(threadId: string, turnId: string | undefined, start: RowMark) {
      const turn = turns.get(threadId);
      if (turn && turn.turnId === turnId) return;
      turns.set(threadId, { turnId, start });
    },
    settle(threadId: string, turnId: string | undefined, since: (start: RowMark) => readonly Message[]): boolean {
      const turn = turns.get(threadId);
      if (!turn || (turn.turnId && turnId && turn.turnId !== turnId)) return false;
      turns.delete(threadId);
      return turnAddedMessage(since(turn.start), 0);
    },
    forget(threadId: string) {
      turns.delete(threadId);
    },
  };
}
