import { basename, join } from "node:path";

import type { Picture } from "./picks.ts";
import type { Message } from "./store.ts";

const PICTURE_SCAN = 200;
const PICTURES_MAX = 8;
const CAPTION_MAX = 80;
const SHOW_IMAGE = /(?:^|[_.])show_image$/;

export type ShownPicture = Picture & { original?: string };
type PictureTurn = { questionId: string; context?: string; options?: string[]; pictures: ShownPicture[] };
type ReplyPictures = PictureTurn & { prior?: PictureTurn };

const sentByPerson = (message: Message) => message.role === "user" && message.kind === "text" && !message.from;

function botTurn(messages: readonly Message[], end: number) {
  const turn: Message[] = [];
  const limit = Math.max(0, end - PICTURE_SCAN);
  for (let i = end - 1; i >= limit; i -= 1) {
    const row = messages[i]!;
    if (sentByPerson(row)) return { turn: turn.reverse(), previous: i };
    if (row.role === "bot" && !row.comm) turn.push(row);
  }
  return { turn: turn.reverse(), previous: -1 };
}

const isQuestionCard = (row: Message) => row.kind === "options" && row.role === "bot" && row.card?.askUser && !row.card.requestId;

function picturesIn(turn: Message[], attachments: string, answered?: Message): PictureTurn | undefined {
  const tools = new Map(turn.filter((row) => row.kind === "activity" && row.tool?.ok !== false && SHOW_IMAGE.test(row.tool?.name ?? "")).map((row) => [row.id, row.tool?.summary]));
  const pictures = new Map<string, ShownPicture>();
  let lastScreen: string | undefined;
  for (const row of turn) {
    if (row.kind !== "screen" || !row.image || basename(row.image) !== row.image) continue;
    const path = join(attachments, row.image);
    const caption = row.text?.replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX);
    const original = row.parentId ? tools.get(row.parentId) : undefined;
    pictures.set(path, { path, caption, original });
    lastScreen = row.id;
  }
  const reply = turn.findLast((row) => row.kind === "text" && row.text?.trim());
  const question = answered ?? turn.findLast((row) => row === reply || isQuestionCard(row));
  const questionId = question?.id ?? lastScreen;
  if (!questionId) return undefined;
  const card = question?.card;
  const context = [answered ? card?.subtitle : reply?.text ?? card?.subtitle, ...(card?.options ?? [])].filter(Boolean).join("\n");
  return { questionId, context, options: card?.options, pictures: [...pictures.values()].slice(-PICTURES_MAX) };
}

export function replyTurns(messages: readonly Message[], ids: string[], attachments: string): Map<string, ReplyPictures> {
  const wanted = new Set(ids);
  const found = new Map<string, ReplyPictures>();
  for (let i = messages.length - 1; i >= 0 && wanted.size; i -= 1) {
    const answer = messages[i]!;
    if (!wanted.delete(answer.id)) continue;
    let end = i;
    let answered: Message | undefined;
    if (answer.answersCard) {
      const card = messages.findIndex((row) => row.id === answer.answersCard && isQuestionCard(row));
      if (card >= 0 && card < i) {
        answered = messages[card];
        // The tapped card may precede a newer turn.
        end = card + 1;
        while (end < i && !sentByPerson(messages[end]!)) end += 1;
      }
    }
    const { turn, previous } = botTurn(messages, end);
    const current = picturesIn(turn, attachments, answered);
    const prior = previous >= 0 && !answered ? picturesIn(botTurn(messages, previous).turn, attachments) : undefined;
    if (current || prior) found.set(answer.id, { ...(current ?? { questionId: answer.id, pictures: [] }), prior });
  }
  return found;
}

export function shownPicture(value: string | null | undefined, shown: ShownPicture[]): Picture | undefined {
  const asked = value?.trim().toLowerCase();
  if (!asked) return undefined;
  const is = (path: string, caption?: string) => asked === path.toLowerCase() || (caption !== undefined && asked === `${path} (${caption})`.toLowerCase());
  const exact = shown.find(({ path, caption }) => is(path, caption));
  const aliases = exact ? [] : shown.filter(({ original, caption }) => original && is(original, caption));
  return exact ?? (aliases.length === 1 ? aliases[0] : undefined);
}
