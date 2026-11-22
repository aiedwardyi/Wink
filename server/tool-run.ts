// What the Forum loop reads from a shell call, whether or not toolDetailCapture is on: a digest of the whole command,
// and when it failed, the line that names the error (not "Exit code 1" or a runner banner) and its signature.
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import type { ToolRun } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";

const BOILERPLATE = [
  /^exit (?:code|status):? -?\d+$/i,
  /^traceback \(most recent call last\):?$/i,
  /^file "[^"]*", line \d+/i,
  /^at\s/,
  /^[\^~|\s]+$/,
  /^>\s/,
  /^(?:RUN|FAIL|PASS|SKIP|✓|×|❯)\s/,
  /^(?:test files|tests|test suites|duration|start at|ran \d+ tests?)\b/i,
  /command failed with exit code|exited with (?:code|status)|process didn't exit successfully|could not compile|ELIFECYCLE|ERR_PNPM_RECURSIVE_|^error: aborting due to/i,
  /^npm (?:error|ERR!) (?:code|errno|path|command|signal|syscall|a complete log|lifecycle)\b/i,
  /^found \d+ errors?\b|^\d+ (?:errors?|failed|failing)\b/i,
  /^make(?:\[\d+\])?: \*\*\*/,
];
const STRONG = /^(?:[\w.$]*(?:Error|Exception)\b.*:|(?:error|fatal|panic)\b|npm (?:error|ERR!)|E {2,}\S)|\berror(?:\[\w+\]| [A-Z]+\d+)?:/i;
const WEAK = /\b(?:error|failed|failure|cannot|can't|could not|unable|not found|no such|denied|refused|hang up|timed? ?out|undefined|invalid|unexpected|missing)\b/i;
const SOURCE = /\b[\w.-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|c|cc|cpp|h|hpp|rb|php|swift|vue|svelte|json|toml|ya?ml|lock)\b\S*/g;
const LINE_CHARS = 240;
const SHOWN_CHARS = 120;

const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The line a person would quote: a Python traceback's last exception, else the first error-shaped line. */
export function errorLine(output: string): string {
  const lines = stripVTControlCharacters(output).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !BOILERPLATE.some((rule) => rule.test(line)));
  const traceback = /traceback \(most recent call last\)/i.test(output);
  const strong = lines.filter((line) => STRONG.test(line));
  return (traceback ? strong.at(-1) : strong[0]) ?? lines.find((line) => WEAK.test(line)) ?? "";
}

/** Paths, line numbers and ids drop out; error codes stay, so TS2304 and TS2322 sign apart. Its own hash, so no post's text-made error_sig can match it. */
export function runSig(line: string): string {
  const stem = line.toLowerCase()
    .replace(/^e\s+/, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\S*[\\/]\S*/g, " ")
    .replace(SOURCE, " ")
    .replace(/\b([a-z]{1,4})(\d{3,5})\b/g, (_match, code: string, digits: string) => code + [...digits].map((digit) => "abcdefghij"[Number(digit)]).join(""))
    .replace(/\b[0-9a-f]{6,}\b/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^\p{L}\s]+/gu, " ")
    .split(/\s+/).filter(Boolean).slice(0, 24).join(" ");
  return stem ? digest(`forum-loop\n${stem}`) : "";
}

export function toolRun(command: string, output: string | undefined, failed: boolean): ToolRun {
  if (!failed) return { cmd: digest(command) };
  const line = redactSecretsInText(errorLine(output ?? ""));
  const run: ToolRun = { cmd: digest(command), shown: cut(redactSecretsInText(command.replace(/\s+/g, " ").trim()), SHOWN_CHARS) };
  const sig = line ? runSig(line) : "";
  if (sig) {
    run.sig = sig;
    run.error = cut(line, LINE_CHARS);
  }
  return run;
}
