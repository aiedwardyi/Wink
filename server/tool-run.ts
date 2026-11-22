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
// Fail closed: a failure is signed only when it says which failure it is, since a missed handoff costs nothing and a wrong one
// teaches a bot the wrong fix. That is a failing test with its file, from a runner read below, or an error naming a path with a
// folder, or the code location it was raised at. Anything else (other runners, a bare file name, a generic line) is not signed.
// The failing test, file and name: vitest, pytest and playwright (each with or without a project) print both on one line;
// jest and cargo print the name alone, under a FAIL header naming the file or above a panic naming it.
const TEST_NAME = [/^FAIL\s+(?:\|[^|]+\|\s+)?(\S+)\s+>\s+(.+)$/, /^FAILED\s+(\S+?)::(\S+)/, /^●\s+(?!Console$)(.+)$/, /^---- (\S+) stdout ----$/, /^\d+\)\s+(?:\[[^\]]+\]\s+›\s+)?(\S+?):\d+:\d+\s+›\s+(.+?)(?:\s+─+)?$/];
const TEST_FILE = [/^FAIL\s+(\S+\.\w+)(?:\s+\(.+\))?$/, /^thread '.*?'(?: \(\d+\))? panicked at (.+?):\d+:\d+:?$/];
// a test runner's summary or failure line, for runners this file reads and ones it does not (go, rspec, JUnit, bun, karma, TAP ...)
const TEST_RUN = [
  /^(?:test files|tests?:?|test suites:?)\s+\d|^\d+ (?:failing|failed|fail)\b|^[ℹ#] fail \d|^test result: failed\b|^=+ .*\bfailed\b|^failed!/i,
  /^(?:FAIL|FAILED|--- FAIL)\b|^not ok \d|^\(fail\) /,
  /\b\d+ (?:tests?|examples?|specs?|runs)\b.*\b\d+ fail|\btests run: \d+, failures: \d+|\(\d+ failed\)/i,
];
// where an error was raised, for one whose line names no path: a Python frame (the last), a Rust panic or compile error, a Node file:line header
const FRAME = [/^File "([^"]+)", line (\d+)/, /\bpanicked at (.+?):(\d+):\d+:?$/, /^--> (.+?):(\d+):\d+$/, /^(\S*[\\/][^\s:]+\.\w+):(\d+)$/];
// a location in a test file: a test failed there, and only a runner read above says which test
const TEST_SOURCE = /^(?:test_[^:]*|[^:]*[._-](?:test|spec)s?\.\w+):\d+$/;
// an error about a file or command needs that path's folder to say which one
const PATH_ERROR = /no such file|enoent|filenotfound|not found|does not exist|cannot (?:open|create|access|stat)|can't open|(?:could not|unable to) (?:open|read)|permission denied|eacces|eperm|eisdir|enotdir|is a directory|not a directory/i;
// a file named with no folder: which one is meant depends on where the bot stood, unless a code location next to it says
const BARE_FILE = /(?<![\w.-])\.[a-z][\w.-]*|(?<![\w.-])[\w-][\w.-]*\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|c|cc|cpp|h|hpp|rb|php|swift|vue|svelte|json|toml|ya?ml|lock|txt|md|csv|tsv|xml|html?|css|scss|sh|ps1|bat|cmd|sql|db|sqlite|ini|cfg|conf|env|properties|gradle|log|bin|pem|key|crt|zip|gz|tar|png|jpe?g|svg|wasm|jar|dll|exe|so|proto|mod|sum)(?![\w-])/i;
// a file name with the line it points at ("app.rb:3", "cart_test.go:12:", "app.ts(3,1)"): a code location, folder or not
const BARE_SPOT = /(?<![\w.\\/-])([\w-][\w.-]*\.[a-z]\w*)(?::(\d+)(?::\d+)?|\((\d+),\d+\))/gi;
// a quoted path, a URL, or an unquoted one (curly quotes are not part of it)
const QUOTED_PATH = /(['"`])([^'"`\r\n]*[\\/][^'"`\r\n]*)\1/g;
const URL_TEXT = /https?:\/\/[^\s'"`<>()]+/g;
const BARE_PATH = /[^\s'"`‘’“”]*[\\/][^\s'"`‘’“”]*/g;
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

/** The first failing test a runner names, with its file without folders, which differ per checkout; "" when no file is named. */
export function failingTest(output: string): string {
  const lines = stripVTControlCharacters(output).split(/\r?\n/).map((line) => line.trim());
  for (const [at, line] of lines.entries()) {
    const [, first, name] = TEST_NAME.map((rule) => rule.exec(line)).find(Boolean) ?? [];
    if (!first) continue;
    const named = (rule: RegExp) => (text: string) => rule.exec(text)?.[1];
    const file = name === undefined ? lines.slice(0, at).reverse().map(named(TEST_FILE[0])).find(Boolean) ?? lines.slice(at).map(named(TEST_FILE[1])).find(Boolean) : first;
    return file ? `${file.replace(/^.*[\\/]/, "")} > ${name ?? first}`.toLowerCase().replace(/\s+/g, " ") : "";
  }
  return "";
}

/** Where the error was raised, as file:line, when the output shows it; the last Python frame, else the first. */
export function errorFrame(output: string): string {
  const lines = stripVTControlCharacters(output).split(/\r?\n/).map((line) => line.trim());
  const found = lines.flatMap((line) => {
    const [, path, row] = FRAME.map((rule) => rule.exec(line)).find(Boolean) ?? [];
    return path ? [`${path.replace(/^.*[\\/]/, "")}:${row}`.toLowerCase()] : [];
  });
  return (/traceback \(most recent call last\)/i.test(output) ? found.at(-1) : found[0]) ?? "";
}

const testRun = (output: string) => stripVTControlCharacters(output).split(/\r?\n/).some((line) => TEST_RUN.some((rule) => rule.test(line.trim())));
const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
const words = (text: string) => text
  .replace(/\b([a-z]{1,4})(\d{3,5})\b/g, (_match, code: string, digits: string) => code + [...digits].map((digit) => "abcdefghij"[Number(digit)]).join(""))
  .replace(/\b[0-9a-f]{6,}\b/g, " ")
  .replace(/\d+/g, " ")
  .replace(/[^\p{L}\s]+/gu, " ")
  .split(/\s+/).filter(Boolean);

/**
 * A failure's signature: what failed (the test, else the paths the line names, else the frame it was raised at) and the
 * line's words. A path keeps its last part, so one file in two checkouts signs alike, with its line when it is a code
 * location; ids and other numbers drop out, error codes stay, so TS2304 and TS2322 sign apart. "" when nothing says
 * which failure this is. Its own hash, so no post's text-made error_sig can match it.
 */
export function runSig(line: string, test = "", frame = ""): string {
  const paths: string[] = [];
  const spots: string[] = [];
  const loose: string[] = [];
  const name = (path: string, url = false) => {
    const trimmed = path.replace(/^[‘“(]+/, "").replace(/[’”,;:.]+$/, "").replace(/(?<!\(\d+,\d+)\)$/, "").replace(/[’”,;:.]+$/, "");
    const [, body = "", paren = "", colon = ""] = /^(.*?)(?:\((\d+),\d+\)|:(\d+)(?::\d+)?)?$/.exec(trimmed) ?? [];
    // a path starts at a root, a drive, ~ or ./, or ends in a file type, or has 2 folders: "Failure/Error" and "and/or" are words
    if (!url && !/^(?:[a-z]:|~|\.{1,2})?[\\/]|\.\w+$|[\\/].*[\\/]/i.test(body)) return ` ${path} `;
    const parts = body.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..");
    // a scoped package keeps its scope
    const last = parts.at(-2)?.startsWith("@") ? parts.slice(-2).join("/") : parts.at(-1) ?? "";
    // a date or a ratio is not a path
    if (!/\p{L}/u.test(last)) return " ";
    if (parts.length < 2) loose.push(last);
    else paths.push(paren || colon ? `${last}:${paren || colon}` : last);
    return " ";
  };
  const rest = line.toLowerCase()
    .replace(/^e\s+/, "")
    .replace(URL_TEXT, (url) => name(decoded(url.replace(/^https?:\/\//, "").replace(/[?#].*$/, "")), true))
    .replace(QUOTED_PATH, (_match, _quote: string, path: string) => name(path))
    .replace(BARE_PATH, (path) => name(path))
    .replace(BARE_SPOT, (_match, file: string, colon?: string, paren?: string) => {
      spots.push(`${file}:${colon ?? paren}`);
      return " ";
    });
  const stem = words(rest).slice(0, 24).join(" ");
  if (!test) {
    const pathError = PATH_ERROR.test(line);
    const located = spots.length > 0 || paths.some((path) => /:\d+$/.test(path));
    if ([...paths, ...spots, frame].some((place) => TEST_SOURCE.test(place))) return "";
    if ((loose.length || BARE_FILE.test(rest)) && (pathError || !located)) return "";
    if ((pathError && !paths.length) || (!paths.length && !spots.length && !frame)) return "";
  }
  const what = test || [...paths, ...spots, ...loose].join(" ") || frame;
  return digest(`forum-loop\n${what}\n${stem}`);
}

export function toolRun(command: string, output: string | undefined, failed: boolean): ToolRun {
  // a secret command's output is never quoted, so nothing it printed reaches a log, a steer or a post
  if (!failed || secretCommand(command)) return { cmd: digest(command) };
  const line = redactSecretsInText(errorLine(output ?? ""));
  const run: ToolRun = { cmd: digest(command), shown: cut(redactSecretsInText(command.replace(/\s+/g, " ").trim()), SHOWN_CHARS) };
  const test = failingTest(output ?? "");
  const sig = line && (test || !testRun(output ?? "")) ? runSig(line, test, test ? "" : errorFrame(output ?? "")) : "";
  if (sig) {
    run.sig = sig;
    run.error = cut(line, LINE_CHARS);
  }
  return run;
}
