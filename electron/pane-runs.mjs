import fs from "node:fs";
import path from "node:path";
import { capturedSession, resumeSessionReason } from "./worker-session.mjs";

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
  // `kept` marks a pane the last quit left in the worker host, whatever its state.
  const runs = new Map(readRuns(file).filter((run) => (run?.state === "running" || run?.kept) && !run.recovery?.replacement).map((run) => [run.id, run]));
  const prior = new Set(runs.keys());
  const waiting = new Set();
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
    started({ id, botId, teacher, label, cwd, baseHead, spawnedAt, session, worker }) {
      const run = { id, botId, teacher, label: label ?? null, cwd, spawnedAt, state: "running", ...(session ? { session: { ...session } } : {}) };
      if (baseHead) run.baseHead = baseHead;
      // What a kept pane's session is rebuilt from; each value keeps its identity between calls.
      for (const [key, value] of Object.entries(worker ?? {})) if (value !== null && value !== undefined) run[key] = value;
      const stored = runs.get(id);
      if (stored?.session && session?.launchGeneration === stored.session.launchGeneration) run.session = { ...stored.session, lifecycle: "running" };
      if (stored && Object.keys(run).every((key) => stored[key] === run[key])) return;
      runs.set(id, run);
      const original = runs.get(session?.recoveredFrom);
      if (original?.recovery && prior.has(original.id)) original.recovery.replacement = id;
      save();
    },
    capture(input) {
      const run = runs.get(input?.pane);
      if (prior.has(input?.pane)) return false;
      const session = capturedSession(run, input);
      if (!session) return false;
      const previous = run.session;
      run.session = session;
      if (save()) return true;
      run.session = previous;
      return false;
    },
    reported: (id) => mark(id, "reported"),
    ended: (id) => mark(id, "ended"),
    closed(id) {
      if (runs.delete(id)) save();
    },
    /** A pane left running in the worker host at quit. */
    kept(id) {
      const run = runs.get(id);
      if (!run || run.kept) return;
      run.kept = true;
      save();
    },
    /** Every record a previous run left, whether its pane still runs in a worker host or not. */
    left: () => [...prior].map((id) => runs.get(id)).filter(Boolean),
    /** A kept pane is live again: its record follows the pane from here on. */
    adopted(id) {
      const run = runs.get(id);
      if (!run || !(prior.delete(id) || waiting.delete(id))) return;
      delete run.kept;
      save();
    },
    /** A worker host this start cannot reach may still run the pane: nothing resumes or drops it meanwhile. */
    held(id) {
      if (prior.delete(id)) waiting.add(id);
    },
    /** That host is gone after all, so the pane takes the restart path. */
    released(id) {
      if (waiting.delete(id)) prior.add(id);
    },
    /** Panes a previous run left mid-run, by the bot that spawned them. */
    restarted() {
      const bots = new Map();
      for (const id of prior) {
        const run = runs.get(id);
        if (run?.state === "running") bots.set(run.botId, [...(bots.get(run.botId) ?? []), run]);
      }
      return bots;
    },
    forget(botId) {
      for (const id of prior) {
        if (runs.get(id)?.botId !== botId) continue;
        runs.delete(id);
        prior.delete(id);
      }
      save();
    },
    /** Counts a launch whose note never landed; returns how many records that dropped. */
    missed(botId) {
      let dropped = 0;
      for (const id of prior) {
        const run = runs.get(id);
        if (run?.botId !== botId) continue;
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

/** One note per bot, through the pane mailbox so it wakes the bot once. `kept` adds each bot's lines about panes the worker host held on to. */
export async function notifyRestartedPanes({ runs, mailbox, notePane, retryMs = RETRY_MS, tries = TRIES, warn = () => {}, noteText = restartNoteText, kept = new Map() }) {
  const bots = runs.restarted();
  for (const botId of kept.keys()) if (!bots.has(botId)) bots.set(botId, []);
  if (!bots.size) return;
  const mail = await Promise.resolve().then(mailbox).catch(() => null);
  await Promise.all([...bots].map(async ([botId, panes]) => {
    const held = kept.get(botId);
    const first = panes[0] ?? held.pane;
    const scope = { pane: first.id, bot: botId, teacher: first.teacher ?? botId };
    let reason = "no mailbox";
    for (let attempt = 1; mail && attempt <= tries; attempt++) {
      try {
        await notePane(mail, scope, [held?.text, panes.length ? noteText(panes) : ""].filter(Boolean).join("\n"));
        held?.delivered?.();
        return panes.length ? runs.forget(botId) : undefined;
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
