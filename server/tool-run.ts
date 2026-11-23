// What the Forum loop reads from a shell call, whether or not toolDetailCapture is on: a digest of the whole command,
// and when it failed, the line that names the error (not "Exit code 1" or a runner banner) and its signature.
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { ToolRun } from "./contracts.ts";
import { linkedGitDirs } from "./git-worktree.ts";
import { redactSecretsInText } from "./redact.ts";
import { secretCommand } from "./tool-detail.ts";
import { WORKSPACES_DIR } from "./workspace.ts";

const BOILERPLATE = [
  /^exit (?:code|status):? -?\d+$/i,
  /^traceback \(most recent call last\):?$/i,
  /^file "[^"]*", line \d+/i,
  /^at\s/,
  /^[\^~|\s]+$/,
  /^>\s/,
  /^(?:RUN|FAIL|PASS|SKIP|✓|×|❯)\s/,
  /^(?:test files|tests|test suites|duration|start at|ran \d+ tests?)\b/i,
  /command failed with exit code|exited with (?:code|status)|terminated with exit code|returned non-zero exit status|process didn't exit successfully|could not compile|ELIFECYCLE|ERR_PNPM_RECURSIVE_|^error: aborting due to/i,
  /^npm (?:error|ERR!)(?: (?:code|errno|path|command|signal|syscall|a complete log|lifecycle)\b|$)/i,
  // a Docker build's wrapper: it names the step that failed, not why (BuildKit, its older executor, compose v1)
  /\bdid not complete successfully: exit code\b|\bexecutor failed running \[|^(?:error: )?service '[^']*' failed to build\b/i,
  // a CI runner's or task runner's footer: it names the job, the build step's image or the target that failed, not why
  /^process completed with exit code\b|^(?:error: )?build step \d+ "[^"]*" failed\b|^nx\s+running targets? .*\bfailed\b|^failed tasks:$/i,
  // and its epilogue: GitLab's job result and cleanup, its Kubernetes executor's pod, Jenkins', Travis' and Buildkite's result
  /^error: job failed\b.*\bexit (?:code|status):? \d+$|^cleaning up (?:project directory|file based variables)\b|^(?:using kubernetes|waiting for pod)\b|^(?:error: )?script returned exit code\b|^finished: (?:failure|unstable|aborted)$|^the command ".*" exited with \d+\.?$|^(?:[\w ]+ )?error:? exit (?:code|status):? \d+$/i,
  /^found \d+ errors?\b|^\d+ (?:errors?|failed|failing)\b/i,
  /^make(?:\[\d+\])?: \*\*\*/,
];
const STRONG = /^(?:[\w.$]*(?:Error|Exception)\b.*:|(?:error|fatal|panic)\b|npm (?:error|ERR!)|ERR_PNPM_\w+|E {2,}\S)|\berror(?:\[\w+\]| [A-Z]+\d+)?:/i;
// a header whose detail is on the next line: pydantic names the field under "1 validation error for Settings"
const HEADER = /\b\d+ validation errors? for \S+$/i;
// a timeout says that something did not happen in time, not why: two different failures print the same line
const TIMEOUT = /\btimeout (?:of )?\d+ ?ms exceeded|\bexceeded timeout of \d+ ?ms|\btimed out (?:in|after) \d+ ?m?s\b/i;
// What a test printed while it ran, under its runner's header: jest "● Console", vitest "stdout | <test>" and "stderr | <test>",
// pytest "Captured stdout/stderr/log <phase>" and "live log <phase>". It says what the code logged, not how a test failed, and it
// runs to the runner's next own line: a header, a rule, a test's result or progress mark, the summary.
const CAPTURED = /^(?:● Console|(?:stdout|stderr) \| .+|[-=]+ (?:captured (?:stdout|stderr|log)|live log) .*)$/i;
const RUNNER = /^(?:● |[-=_⎯]{3,}|(?:FAIL|PASS|RUN)\s|[✓√×❯↓]\s|Test (?:Files|Suites:)\s)|\[\s*\d+%\]$/;
// where a runner reports its failures (vitest "⎯ Failed Tests N ⎯", pytest "= FAILURES ="): the error that failed a test is there,
// even when a long output was cut before the header of what a test printed above it
const FAILURES = /^(?:⎯+ (?:failed (?:tests|suites) \d+|unhandled (?:errors?|rejections?)) ⎯+|=+ (?:failures|errors) =+)$/i;
// Python prints a chain's root cause first: what follows was raised while handling it or wraps it, so two causes share it
const CHAINED = /^(?:during handling of the above exception, another exception occurred|the above exception was the direct cause of the following exception):$/i;
// a time a CI runner puts before every line it relays: Azure's and GitHub Actions' raw log, GitLab's with its stream mark, Buildkite's
// and Jenkins' Timestamper ("[2026-11-22T04:12:09Z]"), TeamCity's ("[04:12:09]E: [Step 1/2]") and Buildkite's raw time mark
const LINE_STAMP = /^(?:\d{4}-\d\d-\d\dT[\d:.]+Z(?: \d\d[OE]\+?)?|\[\d{4}-\d\d-\d\dT[\d:.]+Z\]|\[\d\d:\d\d:\d\d\](?: ?[a-z]?:)?(?:\s*\[Step \d+\/\d+\])?|\x1b_bk;t=\d+\x07)/i;
// a clock before every line that LINE_STAMP does not know: where the tool's own text starts is not known, so the log is not read
const CLOCK = /^\W{0,2}(?:\d{2,4}[-/.]\d\d[-/.]\d{2,4}[T ]|[a-z]{3} +\d{1,2} )?\d{1,2}:\d\d:\d\d/i;
// BuildKit's plain progress puts "#<step> <seconds> " before each line a build step printed
const BUILDKIT = /^#\d+ (?:\d+\.\d+ )?/;
// a CI runner's mark before a line it relays: Cloud Build's 'Step #1 - "build": ', Azure's and GitHub Actions' "##[error]" and
// "##[group]", GitHub Actions' workflow commands ("::error::", "::error file=a.ts,line=3::", "::group::"), GitLab's section marks
const CI_PREFIX = /^(?:Step #\d+(?: - "[^"]*")?: ?|##\[[a-z]+\]|::(?:error|warning|notice|debug|group|endgroup)(?: [^\r\n]*?)?::|section_(?:start|end):\d+:[\w.-]+(?:\[[^\]]*\])?)/i;
// a CI runner's error mark: the line it relays is an error, and a workflow command's file= and line= say where
const ERROR_MARK = /^(?:##\[error\]|::error(?: ([^\r\n]*?))?::)/i;
// what a jest assertion expected and received: two failures of one test differ there, and only there
const ASSERTED = /^(?:expected|received)\b[\w ]*:\s*\S/i;
const MATCHER = /\bexpect\(received\)/;
// a Rust assertion says how it compared, and the left and right values under it say what: two failures of one test differ there
const COMPARED = /\bassertion (?:`left [!=]= right` failed|failed: `\(left [!=]= right\)`)/;
const SIDE = /^(?:left|right):\s*\S/;
// a snapshot mismatch says which failure it is only by the lines its diff takes out and puts in, under a legend that is always the same
const SNAPSHOT = /\bsnapshot\b.*\bmismatched\b/i;
const DIFF = /^[-+](?:\s|$)/;
const LEGEND = /^[-+] (?:Expected|Received|Snapshot)(?:\s+[-+] \d+)?$/;
const CODE_FRAME = /^\d+\s*\|/;
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
// Where the error was raised: Python traceback, Rust source location, or path:line in a diagnostic or stack frame.
const FRAME = [/^File "([^"]+)", line (\d+)/, /\bpanicked at (.+?):(\d+):\d+:?$/, /^--> (.+?):(\d+):\d+$/, /(?:^|\((?=(?:[a-z]:)?[\\/]))([^\s()\\/]*[\\/][^():\r\n]+\.\w+):(\d+)(?::\d+)?\)?$/i];
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

// folders of code the bot did not write: a frame there says where a library failed, not which call of the bot's
const VENDOR = /(?:^|\/)(?:node_modules|site-packages|dist-packages)(?:\/|$)/;
// a step that moves the shell, and a cd anywhere else in a step
const CD_STEP = /^(?:cd|pushd|popd|set-location|sl|chdir)(?:\s+(?:\/d\s+|-(?:literal)?path\s+|(?:-[lpe@]+\s+)*(?:--\s+)?)(.+?))?\s*$/i;
const ANY_CD = /(?:^|[\s;&|(`"'])(?:cd|pushd|popd|set-location|chdir)(?:\s|$)/i;

/** Each line as the tool printed it (no color, no time or CI runner's mark before it), and the lines a runner marked as errors. */
function readLines(output: string): { lines: string[]; errors: Set<string> } {
  const errors = new Set<string>();
  let lines = stripVTControlCharacters(output).split(/\r?\n/).map((line) => line.trim());
  const every = (rule: RegExp) => {
    const filled = lines.filter((line) => line && !/^exit code -?\d+$/i.test(line));
    return filled.length > 1 && filled.every((line) => rule.test(line));
  };
  if (every(LINE_STAMP)) lines = lines.map((line) => line.replace(LINE_STAMP, "").trim());
  if (every(CLOCK)) return { lines: [], errors };
  lines = lines.map((line) => {
    const mark = ERROR_MARK.exec(line);
    if (!mark) return line.replace(CI_PREFIX, "").trim();
    const [, file] = /(?:^|,)file=([^,]+)/.exec(mark[1] ?? "") ?? [];
    const [, row] = /(?:^|,)line=(\d+)/.exec(mark[1] ?? "") ?? [];
    const text = line.slice(mark[0].length).trim();
    const shown = file && !text.includes(file.replace(/^.*[\\/]/, "")) ? `${text} (${file}${row ? `:${row}` : ""})` : text;
    if (shown) errors.add(shown);
    return shown;
  });
  return { lines, errors };
}
const printedLines = (output: string) => readLines(output).lines;
// how many brackets a value's line leaves open, outside its strings and chars
const depth = (text: string) => {
  const bare = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'/g, "");
  return bare.split(/[{[(]/).length - bare.split(/[}\])]/).length;
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The line a person would quote: a Python traceback's last exception (of the chain's root cause), else the first error-shaped line,
 * with a header's detail. Not what a test printed while it ran, and not a wrapper saying a child command failed.
 */
export function errorLine(output: string): string {
  let logged = false;
  const { lines: raw, errors } = readLines(output);
  // a Docker build: the error is a line its step printed, and a step whose lines say nothing strong is not signed
  const built = raw.some((line) => BUILDKIT.test(line));
  const printed = built ? raw.map((line) => line.replace(BUILDKIT, "").trim()) : raw;
  const all = printed.slice(Math.max(0, printed.findIndex((line) => FAILURES.test(line))))
    .filter((line) => !(logged = CAPTURED.test(line) || (logged && !RUNNER.test(line))))
    .filter((line) => line && !BOILERPLATE.some((rule) => rule.test(line)));
  const traceback = /traceback \(most recent call last\)/i.test(output);
  const chained = traceback ? all.findIndex((line) => CHAINED.test(line)) : -1;
  const lines = chained < 0 ? all : all.slice(0, chained);
  const strong = lines.flatMap((line, at) => (STRONG.test(line) ? [at] : []));
  const asserted = lines.findIndex((line) => ASSERTED.test(line) || COMPARED.test(line));
  // an assertion and its values say which failure this is ahead of an error line after it, often the runner's own ("error: test failed")
  const first = asserted >= 0 && !(strong[0]! < asserted) ? asserted : strong[0];
  const at = (traceback ? strong.at(-1) : first) ?? (asserted >= 0 ? asserted : built ? -1 : lines.findIndex((line) => WEAK.test(line) || errors.has(line)));
  const line = lines[at] ?? "";
  // a header with no detail under it says nothing about which failure this is
  if (HEADER.test(line)) return lines[at + 1] ? `${line} ${lines[at + 1]}` : "";
  // nor does a snapshot mismatch without its diff
  if (SNAPSHOT.test(line)) {
    const diff: string[] = [];
    for (const text of lines.slice(at + 1)) {
      if (DIFF.test(text)) {
        if (!LEGEND.test(text)) diff.push(text);
      } else if (STRONG.test(text) || CODE_FRAME.test(text)) break;
    }
    return diff.length ? `${line} ${diff.join(" ")}` : "";
  }
  // or an assertion without the values it expected and received, each read to its end: Rust's pretty Debug runs over lines
  const values: string[] = [];
  let open = 0;
  for (let end = at + 1; end < lines.length && (ASSERTED.test(lines[end]!) || SIDE.test(lines[end]!)); ) {
    let value = lines[end++]!;
    for (open = SIDE.test(value) ? depth(value) : 0; open > 0 && end < lines.length; value += ` ${lines[end++]}`) open += depth(lines[end]!);
    values.push(value);
  }
  // a value cut before its end does not say which it was
  if (open > 0) return "";
  if (at === asserted && ASSERTED.test(line)) return [line, ...values].join(" ");
  return MATCHER.test(line) || COMPARED.test(line) ? (values.length ? `${line} ${values.join(" ")}` : "") : line;
}

/** Where a shell call ran: the repo it ran in and the folder inside it. */
export type ShellPlace = { root: string; cwd: string; project?: string };

const roots = new Map<string, string | null>();
/** The folder holding .git above this one, else the starting project folder. */
export function repoRoot(folder: string, fallback = folder): string {
  const held = roots.get(folder);
  if (held !== undefined) return held ?? fallback;
  let root = null;
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  if (roots.size >= 256) roots.delete(roots.keys().next().value!);
  roots.set(folder, root);
  return root ?? fallback;
}

// a command's steps: split at ;, newlines, && and || outside quotes
const steps = (command: string) => {
  const found: string[] = [];
  let quote = "";
  let step = "";
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ";" || char === "\n" || ((char === "&" || char === "|") && command[at + 1] === char)) {
      found.push(step);
      step = "";
      if (char !== ";" && char !== "\n") at++;
      continue;
    }
    step += char;
  }
  return [...found, step].map((text) => text.trim()).filter(Boolean);
};

/**
 * Where a command's work ran and where it left the shell: its cd steps applied in order to the folder the shell stood in.
 * runs is undefined when that is not one known folder: a cd target with a variable, popd, a cd inside a step (a subshell or a
 * wrapped shell), or work done in two folders.
 */
export type ShellFolders = { runs?: string; after?: string };

export function shellFolders(command: string, folder: string | undefined): ShellFolders {
  let at = folder;
  const works: Array<string | undefined> = [];
  for (const step of steps(command)) {
    const cd = CD_STEP.exec(step);
    if (!cd) {
      works.push(ANY_CD.test(step) ? undefined : at);
      continue;
    }
    const raw = (cd[1] ?? "~").replace(/^(["'])(.*)\1$/, "$2");
    const target = process.platform === "win32" ? raw.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/|$)/i, (_, drive: string) => drive.toUpperCase() + ":/") : raw;
    const next = /[$%`]|^-$/.test(target) || /^popd$/i.test(step) ? undefined
      : target === "~" || /^~[\\/]/.test(target) ? join(homedir(), target.slice(1))
      : isAbsolute(target) ? resolve(target) : at === undefined ? undefined : resolve(at, target);
    // a cd to a folder not found here failed or names it in a form this does not read: either way the folder is not known
    at = next !== undefined && existsSync(next) ? next : undefined;
  }
  const runs = works.length ? works.every((work) => work === works[0]) ? works[0] : undefined : at;
  return { runs, after: at };
}

const projects = new Map<string, string>();
function projectAt(root: string): string {
  const held = projects.get(root);
  if (held !== undefined) return held;
  const git = join(root, ".git");
  let path = linkedGitDirs(root)?.common ?? (existsSync(git) ? git : root);
  try { path = realpathSync.native(path); } catch {}
  const project = process.platform === "win32" ? path.toLowerCase() : path;
  if (projects.size >= 256) projects.delete(projects.keys().next().value!);
  projects.set(root, project);
  return project;
}

export function placeAt(folder: string | undefined, projectFolder?: string): ShellPlace | undefined {
  if (folder === undefined) return undefined;
  const start = projectFolder ?? folder;
  const fromStart = relative(start, folder);
  const root = repoRoot(folder, isAbsolute(fromStart) || fromStart.split(sep, 1)[0] === ".." ? folder : start);
  // The app gives every folderless bot its own desk, with no project selected.
  const defaultDesk = !relative(root, folder) && !relative(WORKSPACES_DIR, dirname(root)) && !existsSync(join(root, ".git"));
  return { root, cwd: folder, project: projectAt(defaultDesk ? WORKSPACES_DIR : root) };
}

/** Where a command ran, from the folder the shell stood in. */
export const shellPlace = (command: string, folder: string | undefined, projectFolder = folder) => placeAt(shellFolders(command, folder).runs, projectFolder);

const slashed = (path: string) => path.replace(/\\/g, "/").toLowerCase().replace(/(?<=.)\/+$/, "");
const PROJECT_SIG = "forum-v2:";
export const isProjectRunSig = (sig: string) => sig.startsWith(PROJECT_SIG);
/** A path as this place names it: repo-relative inside the repo, absolute outside it, so one file in two checkouts is one name. */
const placed = (place: ShellPlace) => {
  const root = slashed(place.root);
  const cwd = slashed(place.cwd);
  const inside = (path: string) => path === root || path.startsWith(`${root}/`);
  return (raw: string) => {
    const path = slashed(raw);
    const full = posix.normalize(/^(?:[a-z]:)?\/|^~/.test(path) ? path : posix.join(cwd, path));
    return { name: full === root ? "." : inside(full) ? full.slice(root.length + 1) : full, inside: inside(full) };
  };
};

/** The first failing test a runner names, with its file as the place names it (as printed with no place); "" when no file is named. */
export function failingTest(output: string, place?: ShellPlace): string {
  const lines = printedLines(output);
  for (const [at, line] of lines.entries()) {
    const [, first, name] = TEST_NAME.map((rule) => rule.exec(line)).find(Boolean) ?? [];
    if (!first) continue;
    const named = (rule: RegExp) => (text: string) => rule.exec(text)?.[1];
    const file = name === undefined ? lines.slice(0, at).reverse().map(named(TEST_FILE[0])).find(Boolean) ?? lines.slice(at).map(named(TEST_FILE[1])).find(Boolean) : first;
    // the project or browser a runner names ("FAIL |unit| ...", "1) [webkit] › ..."): one test can fail apart in each
    const [, project = "", browser = ""] = /^(?:FAIL\s+\|([^|]+)\||\d+\)\s+\[([^\]]+)\])/.exec(line) ?? [];
    const scope = project.trim() || browser ? `[${project.trim() || browser}] ` : "";
    return file ? `${scope}${place ? placed(place)(file).name : slashed(file)} > ${name ?? first}`.toLowerCase().replace(/\s+/g, " ") : "";
  }
  return "";
}

/**
 * Where the bot's own code raised the error, as repo path:line: the last Python frame in the repo, else the first. A frame
 * outside the repo (the standard library, the runtime) or under node_modules or site-packages never counts. "" with no place.
 */
export function errorFrame(output: string, place?: ShellPlace): string {
  if (!place) return "";
  const at = placed(place);
  const lines = printedLines(output);
  const traceback = /traceback \(most recent call last\)/i.test(output);
  // a chain's root cause, else where the bot's code was when it was handled or wrapped (a root raised in the standard library)
  const chained = lines.findIndex((line) => CHAINED.test(line));
  for (const part of chained < 0 ? [lines] : [lines.slice(0, chained), lines.slice(chained)]) {
    const found = part.flatMap((line) => {
      const [, path, row] = FRAME.map((rule) => rule.exec(line)).find(Boolean) ?? [];
      if (!path || path.includes("<")) return [];
      const { name, inside } = at(path);
      return inside && !VENDOR.test(name) ? [`${name}:${row}`] : [];
    });
    const frame = traceback ? found.at(-1) : found[0];
    if (frame) return frame;
  }
  return "";
}

const testRun = (output: string) => printedLines(output).some((line) => TEST_RUN.some((rule) => rule.test(line)));
const decoded = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};
// Numbers that tell two runs of one failure apart, not two failures: a uuid, a date or clock time, a duration, a pid, a memory
// address, a hex id or a long number id. Every other number stays: a port, a version, an error code, a count.
const VOLATILE = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b\d{4}-\d\d-\d\d(?:t[\d:.]+z?)?\b|\b\d{1,2}:\d\d:\d\d(?:[.,]\d+)?\b|\b\d+(?:\.\d+)?\s?(?:ms|s|secs?|seconds?|mins?|minutes?|h|hours?|µs|us|ns)\b|\bpid\W{0,2}\d+|\b0x[0-9a-f]{9,}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b|\b\d{9,}\b/g;
const words = (text: string) => text.replace(VOLATILE, " ").replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(Boolean);
const TEMP = slashed(tmpdir());

/**
 * A failure's signature: where it happened (the folder the command ran in, and the command's words) and what failed there (the test,
 * else the paths the line names, else the frame it was raised at) with the line's words. Paths are named from the repo root,
 * so one file in two checkouts signs alike and two files of one name in two folders sign apart; ids and other numbers drop
 * out, error codes stay, so TS2304 and TS2322 sign apart. "" when nothing says which failure this is. Its own hash, so no
 * post's text-made error_sig can match it.
 */
export function runSig(line: string, where: { place: ShellPlace; command: string; test?: string; frame?: string; step?: string }): string {
  const { place, command, test = "", frame = "", step = "" } = where;
  const at = placed(place);
  const paths: string[] = [];
  const spots: string[] = [];
  const loose: string[] = [];
  const name = (path: string, url = false) => {
    const trimmed = path.replace(/^[‘“(]+/, "").replace(/[’”,;:.]+$/, "").replace(/(?<!\(\d+,\d+)\)$/, "").replace(/[’”,;:.]+$/, "");
    const [, body = "", paren = "", colon = ""] = /^(.*?)(?:\((\d+),\d+\)|:(\d+)(?::\d+)?)?$/.exec(trimmed) ?? [];
    // a path starts at a root, a drive, ~ or ./, or ends in a file type, or has 2 folders: "Failure/Error" and "and/or" are words
    if (!url && !/^(?:[a-z]:|~|\.{1,2})?[\\/]|\.\w+$|[\\/].*[\\/]/i.test(body)) return ` ${path} `;
    const parts = body.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..");
    // a date or a ratio is not a path
    if (!/\p{L}/u.test(parts.at(-1) ?? "")) return " ";
    if (parts.length < 2) loose.push(parts.at(-1)!);
    else {
      const named = url ? body : at(body).name;
      // a temp folder is named anew each run: only the file in it says which
      const full = !url && (named.startsWith(`${TEMP}/`) || named.startsWith("/tmp/")) ? `<tmp>/${parts.at(-1)}` : named;
      paths.push(paren || colon ? `${full}:${paren || colon}` : full);
    }
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
  // an assertion's values and a snapshot's diff say which failure this is wherever they start, so they are never cut
  const stem = words(rest).slice(0, COMPARED.test(line) || SNAPSHOT.test(line) ? undefined : 24).join(" ");
  if (!test) {
    const pathError = PATH_ERROR.test(line);
    // a file named in a build step is the one that step sees, so the step says which
    const named = Boolean(step) && BARE_FILE.test(rest);
    const located = named || spots.length > 0 || paths.some((path) => /:\d+$/.test(path));
    if ([...paths, ...spots, frame].some((spot) => TEST_SOURCE.test(spot.replace(/^.*\//, "")))) return "";
    if ((loose.length || BARE_FILE.test(rest)) && (pathError || !located)) return "";
    if ((pathError && !paths.length) || (!paths.length && !spots.length && !frame && !named)) return "";
  }
  const what = test || [step, ...paths, ...spots, ...loose].filter(Boolean).join(" ") || frame;
  const root = place.root.replace(/(?<=.)[\\/]+$/, "").split(/[\\/]/).map((part) => part.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&")).join("[\\\\/]");
  const checkoutPath = new RegExp("(^|[\\s=\"'])" + root + "(?=[\\s\\\\/\"']|$)", /^[a-z]:/i.test(place.root) ? "gi" : "g");
  const ran = command.replace(checkoutPath, "$1<root>");
  const id = digest(JSON.stringify(["forum-loop", place.project, at(place.cwd).name, ran, what, stem]));
  return place.project === undefined ? id : PROJECT_SIG + id;
}

/**
 * The Docker build step that printed this line, as BuildKit heads it ("[builder 4/7] run npm ci"); "" outside a build. In a build
 * the step, not where the bot stood, says which file the line means.
 */
function buildStep(output: string, line: string): string {
  const printed = printedLines(output);
  const step = line ? printed.find((text) => BUILDKIT.test(text) && text.replace(BUILDKIT, "").trim() === line)?.split(" ", 1)[0] : undefined;
  return step ? printed.find((text) => text.startsWith(`${step} [`))?.slice(step.length + 1).toLowerCase() ?? "" : "";
}

/** With no place nothing says where a failure happened, so it is not signed. */
export function toolRun(command: string, output: string | undefined, failed: boolean, place: ShellPlace | undefined): ToolRun {
  // a secret command's output is never quoted, so nothing it printed reaches a log, a steer or a post
  if (!failed || secretCommand(command)) return { cmd: digest(command) };
  const found = errorLine(output ?? "");
  const line = redactSecretsInText(found);
  const run: ToolRun = { cmd: digest(command), shown: cut(redactSecretsInText(command.replace(/\s+/g, " ").trim()), SHOWN_CHARS) };
  const test = place ? failingTest(output ?? "", place) : "";
  const step = buildStep(output ?? "", found);
  const sig = place && line && !TIMEOUT.test(line) && (test || !testRun(output ?? "")) ? runSig(line, { place, command, test, step, frame: test ? "" : errorFrame(output ?? "", place) }) : "";
  if (sig) {
    run.sig = sig;
    run.error = cut(line, LINE_CHARS);
  }
  return run;
}
