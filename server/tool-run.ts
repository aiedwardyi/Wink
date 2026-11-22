// What the Forum loop reads from a shell call, whether or not toolDetailCapture is on: a digest of the whole command,
// and when it failed, the line that names the error (not "Exit code 1" or a runner banner) and its signature.
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

import type { ToolRun } from "./contracts.ts";
import { redactSecretsInText } from "./redact.ts";
import { secretCommand } from "./tool-detail.ts";

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
// the failing test, so two tests printing one assertion line sign apart: vitest, pytest, jest, cargo, go, playwright (each with or without a project)
const TEST_NAME = [/^FAIL\s+(?:\|[^|]+\|\s+)?(\S+)\s+>\s+(.+)$/, /^FAILED\s+(\S+?)::(\S+)/, /^●\s+(.+)$/, /^---- (\S+) stdout ----$/, /^--- FAIL: (\S+)/, /^\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?(\S+?):\d+:\d+\s+›\s+(.+?)(?:\s+─+)?$/];
// a test runner's summary or failure line: a run that prints one but names no failing test is not signed, since any
// two of its tests would sign alike (mocha, node:test and runners this file does not know stay silent, like jest)
const TEST_RUN = [/^(?:test files|tests?:?|test suites:?)\s+\d|^\d+ (?:failing|failed)\b|^ℹ fail \d|^test result: failed\b|^=+ .*\bfailed\b/i, /^(?:FAIL|FAILED|--- FAIL)\b/];
// a quoted path or a URL is what a path-only error is about (ENOENT, Cannot find module, npm 404): its last part stays in the signature
const QUOTED_PATH = /(['"`])([^'"`\r\n]*[\\/][^'"`\r\n]*)\1/g;
const URL_TEXT = /https?:\/\/[^\s'"`<>()]+/g;
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

/** The first failing test a runner names, its file without folders, which differ per checkout. */
export function failingTest(output: string): string {
  for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
    const [, first, name] = TEST_NAME.map((rule) => rule.exec(line.trim())).find(Boolean) ?? [];
    if (first) return (name === undefined ? first : `${first.replace(/^.*[\\/]/, "")} > ${name}`).toLowerCase().replace(/\s+/g, " ");
  }
  return "";
}

const testRun = (output: string) => stripVTControlCharacters(output).split(/\r?\n/).some((line) => TEST_RUN.some((rule) => rule.test(line.trim())));
const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
// a scoped package keeps its scope; any other path keeps its last part, so one file in two checkouts signs alike
const lastPart = (path: string) => (/^@[^\\/]+\/[^\\/]+$/.test(path) ? path : path.split(/[\\/]+/).filter(Boolean).at(-1) ?? "");
const words = (text: string) => text
  .replace(/\b([a-z]{1,4})(\d{3,5})\b/g, (_match, code: string, digits: string) => code + [...digits].map((digit) => "abcdefghij"[Number(digit)]).join(""))
  .replace(/\b[0-9a-f]{6,}\b/g, " ")
  .replace(/\d+/g, " ")
  .replace(/[^\p{L}\s]+/gu, " ")
  .split(/\s+/).filter(Boolean);

/** Paths, line numbers and ids drop out, but a quoted path or URL keeps its last part; error codes stay, so TS2304 and TS2322 sign apart. Its own hash, so no post's text-made error_sig can match it. */
export function runSig(line: string, test = ""): string {
  const named: string[] = [];
  const name = (text: string) => {
    named.push(text);
    return " ";
  };
  const rest = line.toLowerCase()
    .replace(/^e\s+/, "")
    .replace(URL_TEXT, (url) => name(lastPart(decoded(url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "")))))
    .replace(QUOTED_PATH, (_match, _quote: string, path: string) => name(lastPart(path)))
    .replace(/\S*[\\/]\S*/g, " ")
    .replace(SOURCE, " ");
  const stem = [...words(rest), ...words(named.join(" "))].slice(0, 24).join(" ");
  return stem ? digest(test ? `forum-loop\n${test}\n${stem}` : `forum-loop\n${stem}`) : "";
}

export function toolRun(command: string, output: string | undefined, failed: boolean): ToolRun {
  // a secret command's output is never quoted, so nothing it printed reaches a log, a steer or a post
  if (!failed || secretCommand(command)) return { cmd: digest(command) };
  const line = redactSecretsInText(errorLine(output ?? ""));
  const run: ToolRun = { cmd: digest(command), shown: cut(redactSecretsInText(command.replace(/\s+/g, " ").trim()), SHOWN_CHARS) };
  const test = failingTest(output ?? "");
  const sig = line && (test || !testRun(output ?? "")) ? runSig(line, test) : "";
  if (sig) {
    run.sig = sig;
    run.error = cut(line, LINE_CHARS);
  }
  return run;
}
