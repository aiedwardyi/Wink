import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

import { PACKAGED_FILES } from "./proxy-paths.ts";

// orbit-msg is installed on Windows only (electron/terminal-mailbox.mjs).
const REPORTS_WIN32 = `A worker's final message reaches this thread as a pane note. Do not poll the
pane for it; you are woken when it lands.

- Every card, Claude and Codex included, ends with the line the worker must
  run last: \`orbit-msg --report DONE|FAIL|BLOCKED <NICKNAME> "<text>"\`.
  It prefixes branch, sha and dirty state. That line is the guarantee.
- A Claude Stop hook or the Codex \`notify\` setting in its spawn command may
  also fire. They are extras, not the guarantee.`;

const REPORTS_OTHER = `orbit-msg is not installed on this platform, so no report arrives on its own.
Once a worker goes quiet, terminal_read its pane for the final report its card
asked for.`;

export function loadHarnessPlaybook(
  file: string = PACKAGED_FILES.harnessPlaybook,
  worktreeRoot = process.env.ORBIT_WORKTREE_ROOT || join(homedir(), "orbit-wt"),
  platform: NodeJS.Platform = process.platform,
): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8").trim();
  } catch {
    console.warn(`harness playbook: could not read ${file}; the terminal prompt ships without it`);
    return "";
  }
  text = text
    .replaceAll("{{WORKTREE}}", join(worktreeRoot, "<name>"))
    .replaceAll("{{REPORTS}}", platform === "win32" ? REPORTS_WIN32 : REPORTS_OTHER);
  return `\n<harness_playbook>\n${text}\n</harness_playbook>`;
}

const HARNESS_PLAYBOOK = loadHarnessPlaybook();
const ON_DEMAND = "<!-- on demand -->";
const CLOSE = "\n</harness_playbook>";

/** Only a bot with the shared terminal mounted gets the worker playbook, and only the part above the on-demand line. */
export function harnessPlaybookPrompt(terminalShared: boolean, playbook = HARNESS_PLAYBOOK): string {
  if (!terminalShared || !playbook.includes(ON_DEMAND)) return terminalShared ? playbook : "";
  return `${playbook.slice(0, playbook.indexOf(ON_DEMAND)).trimEnd()}${CLOSE}`;
}

const MODEL_PICKS = /^- (Match the model to the job[^\n]*(?:\r?\n {2}[^\n]*)*)/m;

/** The model list every bot gets, cut from the playbook so it lives in one place. */
export function modelPicksPrompt(playbook = HARNESS_PLAYBOOK): string {
  const picks = MODEL_PICKS.exec(playbook)?.[1];
  return picks ? ` ${picks.trim().replace(/\s*\n\s*(?:- )?/g, " ")}` : "";
}

export function harnessPlaybookBody(playbook = HARNESS_PLAYBOOK): string {
  const at = playbook.indexOf(ON_DEMAND);
  return at < 0 ? "" : playbook.slice(at + ON_DEMAND.length, playbook.lastIndexOf(CLOSE)).trim();
}

// Loose on purpose: a wrongly held shell command costs one read, a missed launch skips the rules.
const WORKER_COMMAND = /(?:^|[\s;&|\\/"'(])(?:claude|codex|grok|muse|agy)(?:\.(?:exe|cmd|ps1))?(?=$|[\s"')])/i;

const CARD_LAUNCH = /\bRead (.+?\.md) and do it\./;

function readCardFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The card a standard launch names, when it exists and its `## Already built` section is missing or blank. */
function cardWithoutPriorWork(command: string, cwd: string | undefined, readCard: (path: string) => string | undefined): string | undefined {
  const named = CARD_LAUNCH.exec(command)?.[1]?.replace(/^["'`]+|["'`]+$/g, "");
  const absolute = (path: string) => isAbsolute(path) || win32.isAbsolute(path);
  // A relative card lives in the pane's cwd, never the server's.
  const path = !named || absolute(named) ? named : cwd && absolute(cwd) ? join(cwd, named) : undefined;
  const card = path ? readCard(path) : undefined;
  if (card === undefined) return undefined;
  const lines = card.split(/\r?\n/);
  const at = lines.findIndex((line) => /^##\s+Already built\s*$/i.test(line));
  const end = at < 0 ? -1 : lines.findIndex((line, index) => index > at && /^#{1,2}\s/.test(line));
  const section = at < 0 ? "" : lines.slice(at + 1, end < 0 ? undefined : end).join("").trim();
  return section ? undefined : path;
}

/** Provider sessions that were handed the on-demand part; a worker launch waits for it. */
export function createPlaybookGate(body = harnessPlaybookBody(), readCard = readCardFile) {
  const read = new Set<string>();
  return {
    read(session: string): string {
      read.add(session);
      return body;
    },
    // Never marks the session: spawns sent side by side must all be held.
    hold(session: string, command: string, cwd?: string): string | undefined {
      if (!body || !WORKER_COMMAND.test(command)) return undefined;
      if (!read.has(session)) return "Held: this session has not read the worker playbook. Call terminal_playbook, follow it (card, worktree or safety copy, label), then send the spawn again.";
      const card = cardWithoutPriorWork(command, cwd, readCard);
      if (card) return `Held: ${card} has no prior-work search. Fill ## Already built: search built.md, the status board and earlier cards for this feature; write 'none found (searched: <terms>)' if empty. Then send the spawn again.`;
      return undefined;
    },
  };
}
