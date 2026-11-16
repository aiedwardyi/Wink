import fs from "node:fs";
import path from "node:path";
import { capturedSession, resumeSessionReason, workerSessionAuthorized } from "./worker-session.mjs";

const RETRY_MS = 15_000;
const TRIES = 20;
const MISSES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readRuns(file) {
  try {
    const runs = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(runs) ? runs : [];
  } catch {
    return [];
  }
}

/** Each bot's spawned panes, written on every change so a crash still leaves the record. */
export function createPaneRuns(file) {
  const runs = new Map(readRuns(file).filter((run) => run?.state === "running" && !run.recovery?.replacement).map((run) => [run.id, run]));
  const prior = new Set(runs.keys());
  const save = () => {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify([...runs.values()]));
      fs.renameSync(temporary, file);
      return true;
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
      return false;
    }
  };
  const mark = (id, state) => {
    const run = runs.get(id);
    if (!run || prior.has(id) || run.state === state) return;
    run.state = state;
    if (run.session) run.session.lifecycle = state;
    save();
  };
  save();
  return {
    claim(id) {
      const run = runs.get(id);
      if (!prior.has(id) || resumeSessionReason(run)) return false;
      run.recovery = { claimedAt: Date.now() };
      if (save()) return true;
      delete run.recovery;
      return false;
    },
    releaseClaim(id) {
      const run = runs.get(id);
      if (!prior.has(id) || !run?.recovery || run.recovery.replacement) return false;
      const claim = run.recovery;
      delete run.recovery;
      if (save()) return true;
      run.recovery = claim;
      return false;
    },
    started({ id, botId, teacher, label, cwd, baseHead, spawnedAt, session }) {
      const run = { id, botId, teacher, label: label ?? null, cwd, spawnedAt, state: "running", ...(session ? { session: { ...session } } : {}) };
      if (baseHead) run.baseHead = baseHead;
      const stored = runs.get(id);
      if (stored?.session && session?.launchGeneration === stored.session.launchGeneration) run.session = { ...stored.session, lifecycle: "running" };
      // A send after a BLOCKED report is the answer, so it clears the question.
      if (stored && !stored.blocked && Object.keys(run).every((key) => stored[key] === run[key])) return;
      const original = runs.get(session?.recoveredFrom);
      if (!stored && original?.blocked) run.blocked = original.blocked;
      runs.set(id, run);
      if (original?.recovery && prior.has(original.id)) original.recovery.replacement = id;
      save();
    },
    capture(input, authorization) {
      const run = runs.get(input?.pane);
      if (prior.has(input?.pane) && (run?.recovery || !workerSessionAuthorized(run?.session?.authHash, authorization))) return false;
      const session = capturedSession(run, input);
      if (!session) return false;
      const previous = run.session;
      run.session = session;
      if (save()) return true;
      run.session = previous;
      return false;
    },
    reported: (id) => mark(id, "reported"),
    blocked(id, question) {
      const run = runs.get(id);
      if (!run || prior.has(id) || run.blocked === question) return;
      run.blocked = question;
      save();
    },
    ended: (id) => mark(id, "ended"),
    closed(id) {
      const run = runs.get(id);
      if (!run) return true;
      runs.delete(id);
      if (save()) return true;
      runs.set(id, run);
      return false;
    },
    /** Panes a previous run left mid-run, by the bot that spawned them. */
    restarted(excluded = new Set()) {
      const bots = new Map();
      for (const id of prior) {
        const run = runs.get(id);
        if (run && !excluded.has(id)) bots.set(run.botId, [...(bots.get(run.botId) ?? []), run]);
      }
      return bots;
    },
    forget(botId, excluded = new Set()) {
      for (const id of prior) {
        if (runs.get(id)?.botId !== botId || excluded.has(id)) continue;
        runs.delete(id);
        prior.delete(id);
      }
      save();
    },
    /** Counts a launch whose note never landed; returns how many records that dropped. */
    missed(botId, excluded = new Set()) {
      let dropped = 0;
      for (const id of prior) {
        const run = runs.get(id);
        if (run?.botId !== botId || excluded.has(id)) continue;
        run.missed = (run.missed ?? 0) + 1;
        if (run.missed < MISSES) continue;
        runs.delete(id);
        prior.delete(id);
        dropped++;
      }
      save();
      return dropped;
    },
  };
}

export function restartNoteText(panes) {
  const lines = panes.map((pane) => `- ${pane.label ? `${pane.label} ` : ""}[pane ${pane.id.slice(0, 8)}] in ${pane.cwd}, spawned ${new Date(pane.spawnedAt).toISOString()}`);
  return `RESTARTED: Wink restarted, so these panes you spawned closed mid-run:\n${lines.join("\n")}\nEdits in their folders are still there. Spawn a FRESH worker to continue, or tell the user.`;
}

/** One note per bot, through the pane mailbox so it wakes the bot once. */
export async function notifyRestartedPanes({ runs, mailbox, notePane, retryMs = RETRY_MS, tries = TRIES, warn = () => {}, noteText = restartNoteText }) {
  const bots = runs.restarted();
  if (!bots.size) return;
  const mail = await Promise.resolve().then(mailbox).catch(() => null);
  await Promise.all([...bots].map(async ([botId, panes]) => {
    const scope = { pane: panes[0].id, bot: botId, teacher: panes[0].teacher ?? botId };
    let reason = "no mailbox";
    for (let attempt = 1; mail && attempt <= tries; attempt++) {
      try {
        await notePane(mail, scope, noteText(panes));
        return runs.forget(botId);
      } catch (error) {
        reason = error?.message ?? error;
        if (attempt < tries) await sleep(retryMs);
      }
    }
    const dropped = runs.missed(botId);
    warn(`restart note for ${botId} not delivered: ${reason}`);
    if (dropped) warn(`restart note for ${botId} dropped ${dropped} pane(s) after ${MISSES} launches`);
  }));
}
