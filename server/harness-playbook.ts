import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function harnessPlaybookBody(playbook = HARNESS_PLAYBOOK): string {
  const at = playbook.indexOf(ON_DEMAND);
  return at < 0 ? "" : playbook.slice(at + ON_DEMAND.length, playbook.length - CLOSE.length).trim();
}

// Loose on purpose: a wrongly held shell command costs one read, a missed launch skips the rules.
const WORKER_COMMAND = /(?:^|[\s;&|\\/"'(])(?:claude|codex|grok|muse|agy)(?:\.(?:exe|cmd|ps1))?(?=$|[\s"')])/i;

/** Provider sessions that were handed the on-demand part; a worker launch waits for it. */
export function createPlaybookGate(body = harnessPlaybookBody()) {
  const read = new Set<string>();
  return {
    read(session: string): string {
      read.add(session);
      return body;
    },
    // Never marks the session: spawns sent side by side must all be held.
    hold(session: string, command: string): string | undefined {
      if (!body || read.has(session) || !WORKER_COMMAND.test(command)) return undefined;
      return "Held: this session has not read the worker playbook. Call terminal_playbook, follow it (card, worktree or safety copy, label), then send the spawn again.";
    },
  };
}
