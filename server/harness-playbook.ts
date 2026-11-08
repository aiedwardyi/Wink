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

const AUTO_MATCH_START = "- Match the model to the job:";
const AUTO_MATCH_END = "writing, X news.";
const AUTO_LINE = "- Pass a task to terminal_spawn; Auto picks the worker's model, effort and engine. Tell the user each pick in one sentence.";

function autoPlaybook(playbook: string): string {
  const start = playbook.indexOf(AUTO_MATCH_START);
  const end = playbook.indexOf(AUTO_MATCH_END, start);
  return start < 0 || end < 0 ? playbook : playbook.slice(0, start) + AUTO_LINE + playbook.slice(end + AUTO_MATCH_END.length);
}

/** Only a bot with the shared terminal mounted gets the worker playbook. */
export function harnessPlaybookPrompt(terminalShared: boolean, playbook = HARNESS_PLAYBOOK, auto = false): string {
  return terminalShared ? (auto ? autoPlaybook(playbook) : playbook) : "";
}
