import { notifyRestartedPanes, restartNoteText } from "./pane-runs.mjs";
import { resumeSessionReason } from "./worker-session.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function workerResumeStatus(session) {
  if (!session || session.retired || session.exitCode !== null || session.workerFinished) return "resume failed";
  if (session.workerSession?.confirmed === "resume") return "resumed";
  const screen = session.screen.text();
  if (/^\s*(?:(?:Error: )?No conversation found with session ID: [a-f0-9-]+|(?:Error: )?No saved session found with ID [a-f0-9-]+\. Run `codex resume`[^\r\n]*|(?:[■•] )?Failed to resume session from [^\r\n]+: [^\r\n]+)\s*$/im.test(screen)) return "resume failed";
  if (session.worker && session.botPane && session.engine === "claude" && session.claudeStartupScreen === screen) return "pending";
  if (/(?:select a (?:session|conversation)|resume a (?:session|conversation)|choose (?:a |an )?(?:session|conversation|account)|sign in to|log in to|how do you want to log in|do you trust|trust this folder|allow once|allow for this session)/i.test(screen)) return "unexpected menu";
  return "pending";
}

function recoveryNote(panes, results) {
  const resumed = panes.filter((pane) => results.get(pane.id) === "resumed");
  const failed = panes.filter((pane) => !resumed.includes(pane));
  const text = resumed.length ? `RESUMED: ${resumed.map((pane) => `${pane.label || pane.id.slice(0, 8)} (${pane.session.engine})`).join(", ")}.` : "";
  if (!failed.length) return text;
  const note = restartNoteText(failed.map((pane) => results.has(pane.id) ? { ...pane, label: `${pane.label || pane.id.slice(0, 8)} (${results.get(pane.id)})` } : pane));
  return [text, note].filter(Boolean).join("\n");
}

export async function recoverWorkers({ runs, host, mailbox, notePane, warn = () => {}, wait = sleep, staggerMs = 2000, polls = 90, settleMs = 1000, retryMs, tries, kept }) {
  const results = new Map();
  const pending = [];
  let attempted = false;
  const monitor = async (pane) => {
    for (let poll = 0; poll < polls; poll++) {
      const status = host.workerResumeStatus(pane.sessionId);
      if (status === "resumed") {
        await wait(settleMs);
        return host.workerResumeStatus(pane.sessionId);
      }
      if (status !== "pending") return status;
      await wait(500);
    }
    return "resume failed";
  };
  for (const panes of runs.restarted().values()) {
    for (const run of panes) {
      const reason = resumeSessionReason(run);
      if (reason) { if (reason !== "unsupported engine") results.set(run.id, reason); continue; }
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempted) await wait(staggerMs);
        attempted = true;
        try {
          const pane = await host.openForBot(run.botId, { label: run.label ?? undefined, cwd: run.cwd, command: run.session.template.executable }, run);
          if (!pane.sessionId) { results.set(run.id, "resume held by usage policy"); break; }
          pending.push(monitor(pane).then(async (status) => {
            if (status !== "resumed") await host.closeForBot(run.botId, pane.sessionId);
            results.set(run.id, status === "resumed" || status === "unexpected menu" ? status : "resume failed");
          }));
          break;
        } catch (error) {
          const unavailable = /account.*(?:unavailable|signed out|changed)/i.test(error?.message ?? "");
          results.set(run.id, unavailable ? "account signed out or unavailable" : "resume failed");
          if (unavailable || run.recovery || attempt === 2) break;
        }
      }
    }
  }
  await Promise.all(pending);
  await notifyRestartedPanes({ runs, mailbox, notePane, warn, retryMs, tries, kept, noteText: (panes) => recoveryNote(panes, results) });
}
