// Auto mode: when a bot may answer its own permission requests.
//
// Auto mode answers every permission request, destructive-looking ones
// included, in a turn a person started. When nobody started the turn it
// still answers ordinary work, but skips destructive commands, deletes
// outside the turn's folder, and local-computer requests.
//
// The guard is deliberately tiny and literal. It is NOT a security
// boundary (an agent set on damage has a thousand spellings for `rm`);
// it is a "you probably didn't mean to hand THIS one over unattended"
// backstop for the obvious catastrophes. Real containment is the
// sandbox and the bot's own computer, not a regex.

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf]/i, // rm -rf, rm -fr, rm -r -f
  /\bRemove-Item\b[^\r\n|;&]*-(?:Recurse|Force)\b/i,
  /\bmkfs\b|\bdiskutil\s+erase|\bdd\s+[^|]*\bof=\/dev\//i,
  /:\(\)\s*\{.*\}\s*;?\s*:/, // fork bomb
  /\bgit\s+push\s+[^|]*--force(-with-lease)?\b|\bgit\s+reset\s+--hard\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\s+TABLE\b/i,
  /\bsudo\s+rm\b|\bchmod\s+-R\s+777\s+\//i,
];
// shutdown/reboot/halt: hyphen is a word boundary, so feat/graceful-shutdown
// matched the old /\bshutdown\b/ scan. Match command position instead (below).
const POWER_OFF_RULE = String.raw`\bshutdown\b|\breboot\b|\bhalt\b`;
const POWER_OFF = new Set(["shutdown", "reboot", "halt"]);

// Not destructive, but exactly what you don't hand over unattended: a
// bot reading your keys is quiet, permanent, and unrecoverable.
// [\\/] throughout: the same file is spelled C:\Users\you\.env on Windows and
// ~/.env everywhere else, and a guard that only knows one of them is no guard.
const SENSITIVE = [
  /(^|[\s\\/"'])\.env(\.|$|["'\s])/i,
  /\.ssh[\\/]|id_rsa|id_ed25519|authorized_keys/i,
  /\.aws[\\/]credentials|\.netrc|\.npmrc|\.pypirc|\.docker[\\/]config\.json/i,
  /security\s+find-(generic|internet)-password|\bkeychain\b/i,
  /\bcredentials?\.json\b|\bserviceaccount\b/i,
];

/** First matching pattern's source, so a verdict can NAME the rule that
 * made it — the decision log's whole value is "which rule", and deriving
 * the match a second time at the call site is how the log and the verdict
 * drift apart. */
function matchFirst(rules: RegExp[], text: string): string | null {
  for (const re of rules) if (re.test(text)) return re.source;
  return null;
}

export function looksSensitive(text: string): boolean {
  return matchFirst(SENSITIVE, text) !== null;
}

export function looksDestructive(text: string): boolean {
  return matchDestructive(text) !== null;
}

/** The key an "Always allow" remembers.
 *
 * A bare tool name is far too coarse for a command runner: remembering
 * "Bash" would hand the bot a permanent unattended shell, which is the
 * opposite of what someone pressing "always allow" on `git status`
 * intends. Command tools are therefore keyed by their program —
 * `Bash:git`, `Bash:npm` — so the grant is as narrow as the thing you
 * actually looked at. Computed once, server-side, and echoed back by the
 * client so the two sides can never disagree about what was granted. Null
 * when no key can be that narrow, and the card then offers no grant. */
const COMMAND_TOOLS = new Set(["bash", "shell", "execute", "run_command", "computer_exec", "terminal", "powershell"]);
// A file tool's key carries no path, so one grant would cover every file.
// delete and move are ACP kinds; Claude deletes and moves through Bash.
const FILE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "delete", "move"]);
// A placeholder stands in for a tool nobody could name: acp/core.ts sends
// "tool" for a toolCall with no kind, codex.ts "mcp" when the elicitation text
// hides the tool name. Keying a grant
// on one covers every tool that lands on the same placeholder, including a
// file write, which is the grant FILE_TOOLS above refuses.
const ANONYMOUS_TOOLS = new Set(["tool", "mcp"]);
// Chaining, substitution or redirection runs a second program, or writes a
// second path, under the first program's grant.
const CHAINED = /[;&|`<>\n\r]|\$\(/;
// claude.ts askSummary and acp/core.ts cut command summaries at 200 chars, and
// a cut command can hide its tail. Lower either cut and this must follow.
const SUMMARY_CUT = 200;
// A launcher runs whatever program follows it, so its name grants nothing.
const LAUNCHERS = new Set(["env", "nohup", "nice", "timeout", "xargs", "exec", "command", "time", "watch", "bash", "sh", "zsh", "cmd", "pwsh", "powershell"]);
const ELEVATORS = new Set(["sudo", "doas", "run0"]);
// Windows matches a program by basename in any case, with or without .exe.
const programName = (word: string) => (word.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");

function isPowerOffProgram(word: string): boolean {
  return POWER_OFF.has(programName(word.replace(/^["'({!]+|["')}]+$/g, "")));
}

/** shutdown/reboot/halt as the program that runs, not a branch/path/message token. */
function matchPowerOffCommand(text: string): string | null {
  const segments: string[] = [];
  const add = (chunk: string) => {
    for (const part of chunk.split(/[;&|\n\r]+|\$\(|`/)) {
      const trimmed = part.trim();
      if (trimmed) segments.push(trimmed);
    }
  };
  add(text);
  // Nested shells: bash -c '...', cmd /c ..., pwsh -Command "..."
  for (const m of text.matchAll(/(?:^|[\s"'"])(?:-[cC]|-Command|\/[cC])\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g)) {
    add(m[1] ?? m[2] ?? m[3] ?? "");
  }
  for (const segment of segments) {
    if (segmentHasPowerOffCommand(segment)) return POWER_OFF_RULE;
  }
  return null;
}

function segmentHasPowerOffCommand(segment: string): boolean {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Z_][A-Z0-9_]*=/.test(w)) {
      i += 1;
      continue;
    }
    if (ELEVATORS.has(programName(w))) {
      i += 1;
      continue;
    }
    const name = programName(w.replace(/^["'({!]+|["')}]+$/g, ""));
    if (!name || name.startsWith("-")) {
      i += 1;
      continue;
    }
    if (LAUNCHERS.has(name)) {
      i += 1;
      while (i < words.length && /^[-/]/.test(words[i])) {
        const flag = words[i].toLowerCase();
        i += 1;
        if ((flag === "-c" || flag === "-command" || flag === "/c") && i < words.length) i += 1;
      }
      // timeout 5 shutdown / nice 10 reboot
      if (i < words.length && /^\d+(?:\.\d+)?[smhd]?$/i.test(words[i])) i += 1;
      continue;
    }
    return isPowerOffProgram(w);
  }
  return false;
}

function matchDestructive(text: string): string | null {
  return matchFirst(DESTRUCTIVE, text) ?? matchPowerOffCommand(text);
}

const DELETE_PROGRAMS = new Set(["rm", "rmdir", "unlink", "del", "erase", "rd", "remove-item", "ri"]);
// ACP kinds; Claude deletes and moves through Bash
const DELETE_TOOLS = new Set(["delete", "move"]);
// a quoted path keeps its spaces; a cmd switch (/q, /s) is not a path
const argWords = (text: string) => [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]).filter(Boolean);
const CMD_SWITCH = /^\/[A-Za-z](?::\S*)?$/;
const looksLikePath = (word: string) => /^(?:[A-Za-z]:[\\/]|[\\/]|~(?:[\\/]|$))/.test(word) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(word);

const CD_PROGRAMS = new Set(["cd", "chdir", "pushd", "push-location", "set-location", "sl", "popd", "pop-location"]);
const PUSH_PROGRAMS = new Set(["pushd", "push-location"]);
const POP_PROGRAMS = new Set(["popd", "pop-location"]);
// switches that keep a move where the path says: cmd /d, cd -L, PowerShell -Path
const CD_SWITCHES = new Set(["/d", "-l", "-path", "-literalpath", "-passthru"]);
const movesDir = (word: string) => CD_PROGRAMS.has(programName(word)) || /^(?:cd|chdir)[.\\/]/i.test(word);
const expandHome = (path: string) => path.replace(/^~(?=[\\/]|$)/, homedir());
const isRooted = (path: string) => isAbsolute(path) || /^~(?:[\\/]|$)/.test(path);

/** Where worker panes keep their worktrees. */
export const worktreeRoot = () => process.env.ORBIT_WORKTREE_ROOT || join(homedir(), "orbit-wt");

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** The real path, through links, of a path that may not exist yet. */
function realPath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return null;
    const real = realPath(parent);
    return real && join(real, basename(path));
  }
}

function holdsLink(dir: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || (entry.isDirectory() && holdsLink(join(dir, entry.name)))) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** True when `path` sits in a linked worktree registered to a repo inside `workspace`. */
function inOwnedWorktree(path: string, workspace: string): boolean {
  for (let dir = path; ; dir = dirname(dir)) {
    const dotGit = lstatSync(join(dir, ".git"), { throwIfNoEntry: false });
    if (dotGit?.isDirectory()) return false;
    if (dotGit?.isFile()) {
      try {
        const gitdir = resolve(dir, readFileSync(join(dir, ".git"), "utf8").replace(/^gitdir:\s*/, "").trim());
        const back = realPath(resolve(gitdir, readFileSync(join(gitdir, "gitdir"), "utf8").trim()));
        const repo = realPath(dirname(dirname(dirname(gitdir))));
        return basename(dirname(gitdir)) === "worktrees" && back === join(dir, ".git") && !!repo && within(workspace, repo);
      } catch {
        return false;
      }
    }
    if (dirname(dir) === dir) return false;
  }
}

/** A stale worktree a routine may clear: never a link, never one holding a link, never the live checkout. */
function cleanable(path: string, workspace: string): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() || (stat?.isDirectory() && holdsLink(path))) return false;
  const real = realPath(path);
  const live = realPath(workspace);
  if (!real || !live || within(real, live)) return false;
  const root = realPath(worktreeRoot());
  return (!!root && real !== root && within(root, real)) || inOwnedWorktree(stat?.isDirectory() ? real : dirname(real), live);
}

/**
 * Checks an unattended request's deletes against `workspace`, following cd
 * across the command. `outside` is the first path removed outside it that
 * is not a cleanable worktree; `rest` is the request without the deletes
 * that only clear worktrees, for the destructive rule.
 */
function checkDeletes(tool: string, summary: string, workspace: string): { outside: string | null; rest: string } {
  const root = resolve(workspace);
  const real = (path: string | null) => {
    try {
      return path === null ? null : realpathSync.native(path);
    } catch {
      return null;
    }
  };
  const live = real(root);
  // a relative path under a folder we lost track of could be anywhere
  const place = (path: string, dir: string | null) => (dir === null && !isRooted(path) ? null : resolve(dir ?? root, expandHome(path)));
  const bare = tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
  const segments: { text: string; paths: { word: string; at: string | null }[] }[] = [];
  if (DELETE_TOOLS.has(bare)) {
    // an ACP title, not a command line; only a word that is plainly a path counts
    segments.push({ text: summary, paths: argWords(summary).filter(looksLikePath).map((word) => ({ word, at: place(word, root) })) });
  } else if (COMMAND_TOOLS.has(bare)) {
    let dir: string | null = root;
    const stack: (string | null)[] = [];
    for (const text of summary.split(/[;&|\n\r]+/)) {
      const words = argWords(text);
      let i = 0;
      while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]) || ELEVATORS.has(programName(words[i])))) i += 1;
      const program = programName(words[i] ?? "");
      const args = words.slice(i + 1).filter((word) => !word.startsWith("-") && !CMD_SWITCH.test(word));
      const switches = words.slice(i + 1).filter((word) => word.startsWith("-") || CMD_SWITCH.test(word));
      if (CD_PROGRAMS.has(program)) {
        const target = args[0];
        if (switches.some((word) => !CD_SWITCHES.has(word.toLowerCase())) || /[$%]/.test(target ?? "")) dir = null;
        else if (POP_PROGRAMS.has(program)) dir = target === undefined && stack.length ? (stack.pop() ?? null) : null;
        else if (PUSH_PROGRAMS.has(program) && target === undefined) dir = null;
        else {
          if (PUSH_PROGRAMS.has(program)) stack.push(dir);
          dir = target === undefined ? homedir() : isRooted(target) ? resolve(expandHome(target)) : dir && resolve(dir, target);
        }
      } else if (
        // a move in a group, subshell or nested shell, or glued as cd.., is one we can't follow
        words.some((word, j) => {
          const bare = word.replace(/^[$`"'({]+/, "");
          return movesDir(bare) && (bare !== word || j === i || /^(?:[({]|-c|-command|\/c)$/i.test(words[j - 1] ?? ""));
        })
      ) {
        dir = null;
      }
      segments.push({ text, paths: DELETE_PROGRAMS.has(program) ? args.map((word) => ({ word, at: place(word, dir) })) : [] });
    }
  } else {
    return { outside: null, rest: summary };
  }
  let outside: string | null = null;
  const rest: string[] = [];
  for (const { text, paths: lexical } of segments) {
    const paths = lexical.map(({ word, at }) => ({ word, at: real(at) }));
    const clears = live !== null && paths.length > 0 && paths.every(({ at }, i) => at !== null && cleanable(lexical[i].at!, live));
    if (!clears) rest.push(text);
    outside ??= clears ? null : (paths.find(({ at }) => live === null || at === null || !within(live, at))?.word ?? null);
  }
  return { outside, rest: rest.length === segments.length ? summary : rest.join(" ; ") };
}

export function approvalKey(tool: string, summary: string, scope?: "local-computer"): string | null {
  const bare = tool.replace(/^mcp__[^_]+__/, "").toLowerCase();
  if (FILE_TOOLS.has(bare) || ANONYMOUS_TOOLS.has(bare)) return null;
  if (!COMMAND_TOOLS.has(bare)) return scope ? `${scope}:${tool}` : tool;
  if (CHAINED.test(summary) || summary.length >= SUMMARY_CUT) return null;
  // first bare word of the command, skipping env assignments and sudo-likes
  const words = summary.trim().split(/\s+/);
  let i = 0;
  while (i < words.length && (/^[A-Z_][A-Z0-9_]*=/.test(words[i]) || ELEVATORS.has(programName(words[i])))) i += 1;
  // a quoted path splits on its spaces and a shell unescapes a backslash, so
  // neither word names the program that runs
  if (/["'\\]/.test(words[i] ?? "")) return null;
  const program = (words[i] ?? "").split(/[\\/]/).pop()?.replace(/[^\w.-]/g, "") ?? "";
  if (!program || program.startsWith("-") || LAUNCHERS.has(programName(program))) return null;
  const key = `${tool}:${program}`;
  return scope ? `${scope}:${key}` : key;
}

// A longer or deeper input is skipped, never cut.
const GUARD_INPUT_MAX = 65_536;
const GUARD_INPUT_DEPTH = 64;

/** Every key and string a tool call carries, whole, for the guard to judge. */
export function guardInput(input: unknown): { action: string } | { actionRefused: "too-large" | "unreadable" } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { actionRefused: "unreadable" };
  let size: number;
  try {
    size = JSON.stringify(input).length;
  } catch {
    return { actionRefused: "unreadable" };
  }
  if (size > GUARD_INPUT_MAX) return { actionRefused: "too-large" };
  const parts: string[] = [];
  const walk = (value: unknown, depth: number): boolean => {
    if (depth > GUARD_INPUT_DEPTH) return false;
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) return value.every((inner) => walk(inner, depth + 1));
    else if (value && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        parts.push(key);
        if (!walk(inner, depth + 1)) return false;
      }
    }
    return true;
  };
  return walk(input, 0) ? { action: parts.join("\n") } : { actionRefused: "unreadable" };
}

/** The deny for an Auto bot's desktop ask the guard could not read whole. */
export const UNCHECKED_DESKTOP_DENY_NOTE = {
  "too-large": "Wink: this desktop action is too large for Auto mode to check, so it was skipped. Split it into smaller steps.",
  unreadable: "Wink: this desktop action's input can't be read, so Auto mode skipped it.",
} as const;

/** The deny for an Auto bot's desktop ask in a turn nobody started. */
export const AWAY_DESKTOP_DENY_NOTE =
  "Wink: desktop control needs the user present. Skip this step and continue with the rest.";

/** The deny for an Auto bot's destructive step or out-of-folder delete in a turn nobody started. */
export const UNATTENDED_DENY_NOTE =
  "Wink: nobody started this turn, so destructive commands and deletes outside the project folder are off. Skip this step and say so in your report.";

/** The deny for a helper's ask that only a person could approve, once its turn has ended. */
export const BACKGROUND_DENY_NOTE =
  "Wink: this needs the user's approval, and the turn that started you has ended. Skip it and say so in your report.";

export interface AutoApprover {
  autoApprove?: boolean;
  alwaysAllow?: string[];
}

/** Why a verdict landed the way it did. `unattended-block` exists only in
 * contrast: a grant WOULD have fired, and the only thing that stopped it
 * was that nobody started this turn — the most audit-worthy card of all. */
export type AutoVerdictSource =
  | "always-allow"
  | "auto-mode"
  | "unattended-block"
  | "away-desktop-deny"
  | "unattended-deny"
  | "unchecked-desktop-deny"
  | "local-computer-block"
  | "destructive-guard"
  | "sensitive-guard"
  | "no-grant";

export interface AutoVerdict {
  /** Chip text when the bot may answer itself, null when a human decides.
   * The string becomes the chip in the transcript, so an auto-approved
   * action is never invisible. */
  approve: string | null;
  source: AutoVerdictSource;
  /** What identifies the rule that decided: the matched regex (guards) or
   * the granted key (always-allow, and unattended-block over one). Auto
   * mode has no narrower identity than the mode itself, so it carries none. */
  rule?: string;
}

/** The verdict AND its provenance. The decision itself is unchanged from
 * autoDecision below — this exists so the decision log can record which
 * rule decided without the call site re-deriving (and eventually
 * mis-deriving) the match. */
export function autoVerdict(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
    /** the folder the turn runs in; unattended deletes stay inside it */
    workspace?: string;
    /** why a tool call reached the guard without its whole input */
    refused?: "too-large" | "unreadable";
  },
): AutoVerdict {
  // the guards outrank the grants, so an "always allow" can never widen
  // into them
  const destructive = matchDestructive(summary) ?? matchDestructive(tool);
  const sensitive = destructive ? null : matchFirst(SENSITIVE, summary);
  // The grant is computed even when a hard block will refuse it: the row
  // worth auditing is "this WOULD have auto-approved, and only the block
  // stood in the way", which cannot be told apart from an ordinary
  // "nobody granted this" card without knowing both halves.
  const key = approvalKey(tool, summary, context?.scope);
  const grant =
    destructive || sensitive
      ? null
      : key && bot.alwaysAllow?.includes(key)
        ? { approve: `auto-approved ${key} (always allowed)`, source: "always-allow" as const, rule: key }
        : null;
  if (context?.unattended && bot.autoApprove && context.scope === "local-computer") {
    // nobody can answer a desktop card, so skip the step instead of stalling the turn
    return { approve: null, source: "away-desktop-deny" };
  }
  if (context?.unattended && bot.autoApprove) {
    if (context.refused) return { approve: null, source: "unattended-deny", rule: context.refused };
    // a file tool's summary carries the file's text, which runs nothing
    const runs = !FILE_TOOLS.has(tool.replace(/^mcp__[^_]+__/, "").toLowerCase());
    // no folder (an API engine, a cloud run): only the destructive rule applies
    const { outside, rest } = context.workspace ? checkDeletes(tool, summary, context.workspace) : { outside: null, rest: summary };
    const rule = (runs ? (rest === summary ? destructive : (matchDestructive(rest) ?? matchDestructive(tool))) : null) ?? outside;
    if (rule) return { approve: null, source: "unattended-deny", rule };
  }
  if (context?.unattended && !bot.autoApprove) {
    // Auto mode covers a turn nobody started, but an Ask bot's grants wait
    // for a human: the guard above is "not a security boundary" and must not
    // stand in for one at 3am.
    if (grant) return { approve: null, source: "unattended-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (context?.scope === "local-computer" && !bot.autoApprove) {
    // Host control is not covered by a remembered always-allow grant.
    // After the Auto-on-this-computer warning, unclassified GUI actions
    // (click/type) may auto-approve; destructive/sensitive still card.
    if (grant) return { approve: null, source: "local-computer-block", rule: grant.rule };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: null, source: "no-grant" };
  }
  if (context?.scope === "local-computer") {
    // Auto mode past the warning still stops for a destructive-looking
    // host-control action.
    if (context.refused) return { approve: null, source: "unchecked-desktop-deny", rule: context.refused };
    if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
    if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
    return { approve: `auto-approved ${tool}`, source: "auto-mode" };
  }
  // In a turn a person started, Auto mode answers even a destructive-looking
  // request instead of carding it. Ask mode keeps the guard.
  if (bot.autoApprove) return { approve: `auto-approved ${tool}`, source: "auto-mode" };
  if (destructive) return { approve: null, source: "destructive-guard", rule: destructive };
  if (sensitive) return { approve: null, source: "sensitive-guard", rule: sensitive };
  if (grant) return { approve: grant.approve, source: grant.source, rule: grant.rule };
  return { approve: null, source: "no-grant" };
}

/** Why this request may be answered without the human, or null to ask. */
export function autoDecision(
  bot: AutoApprover,
  tool: string,
  summary: string,
  context?: {
    /** the turn was started by an outside event, with nobody at the keyboard */
    unattended?: boolean;
    /** the request controls the user's active desktop */
    scope?: "local-computer";
    workspace?: string;
  },
): string | null {
  return autoVerdict(bot, tool, summary, context).approve;
}
