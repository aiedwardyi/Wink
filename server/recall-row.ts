// What a recall row may hold, kept apart from the index so Dreaming checks a note without loading SQLite.
import { secretLike } from "./memory-pass.ts";
import { redactSecretsInText } from "./redact.ts";

const SEPARATOR = /^\|[\s:|-]+\|?$/;
const STRUCK = /^[-*\s|]*(?:\d+\s*\|\s*)?~~/;

export const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

// Rows come from files a bot can be talked into writing, so nothing here may read as markup or as Wink's own framing.
export function clean(line: string): string {
  const text = line
    .replace(/<\/?[a-zA-Z!][^<>]*>/g, " ")
    .replace(/<(?=[a-zA-Z/!])/g, " ")
    .replace(/\[\/?\s*Wink recall[^\]]*\]?/gi, " ")
    .replace(/current message:/gi, "current message -")
    .replace(/\s+/g, " ")
    .replace(/^[\s|]+|[\s|]+$/g, "");
  return redactSecretsInText(text);
}

/** A line recall never returns as a row; Dreaming keeps such a note in MEMORY.md. */
export function hiddenFromRecall(raw: string): boolean {
  const line = raw.trim();
  // a split could part a label from its value, so the whole row is withheld, as Auto Notes does
  return !line || SEPARATOR.test(line) || line.startsWith("#") || STRUCK.test(line) || secretLike(line) || !words(clean(line)).length;
}
