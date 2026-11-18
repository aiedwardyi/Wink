import { realpath, stat } from "node:fs/promises";
import { freemem, homedir } from "node:os";
import { basename, dirname, extname, parse, relative, resolve, sep } from "node:path";

import { VERIFY_LIMITS, type VerifyIssue } from "../shared/live-verify.ts";
import { parsePaneNote } from "../shared/pane-note.ts";
import type { BotRecord, Message, Store } from "./store.ts";
import { appEntry, type AppOptions } from "./verify-app.ts";
import { entryFor, OPT_OUT, scanVerifyWrites } from "./verify-auto.ts";
import { VERIFY_REASONS, verifyCardText, verifyNoteText, verifyProblems } from "./verify-message.ts";
import { resolveVerifySite, SITE_TYPES, type WorkerReply, type WorkerStart } from "./verify-site.ts";

/** How long a checked DONE report waits for its result. 15 real worker-built sites (11-18): p50 5.2 s, p90 8.6 s; the margin covers a busy PC. A later result follows as one note. */
export const WORKER_HOLD_MS = 20_000;
const SLOT_MS = 30_000;
const RUN_MS = 88_000;
const ACTIVE = 2;
const PER_HOUR = 12;
const PREVIEW_WAIT_MS = 1_500;
// Holds land within seconds of each other; a boot sweep deeper than this finds none.
const SWEEP_ROWS = 300;
const SOURCE = new Set([".ts", ".tsx", ".jsx", ".js", ".mjs", ".vue", ".svelte", ".astro", ".css", ".html"]);

type Scope = { pane: string; bot: string };
export interface WorkerPlan { botId: string; threadId: string; paneId: string; root: string; target: string; preview: boolean; old?: string }
interface Job { plan: WorkerPlan; notes: string[]; arrival: number; released?: boolean; card?: string; timer?: ReturnType<typeof setTimeout>; abort: AbortController }

export interface VerifyWorkersDeps {
  store: Pick<Store, "activePath" | "activePathBack" | "appendMessage" | "patchMessage" | "messagesFor" | "bots">;
  enabled(): boolean;
  skip?(threadId: string): boolean;
  pane(botId: string, paneId: string): Promise<{ cwd: string; spawnedAt?: number } | null>;
  run(input: WorkerStart): Promise<WorkerReply>;
  arrived(botId: string, threadId: string, paneId: string): void;
  deviceId(): string;
  log(line: string): void;
  freeMemory?(): number;
  scan?: typeof scanVerifyWrites;
  app?: AppOptions;
  holdMs?: number;
}

const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== "" && !rel.startsWith("..") && !parse(rel).root; };
const clock = (ms: number) => { const at = new Date(ms); return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`; };

/** A folder a worker's site can be in: never a drive, the home folder or one of its direct children, nor a path through a link. */
async function workerRoot(cwd: string): Promise<string | null> {
  const real = await realpath(cwd).catch(() => null);
  if (!real || real.toLowerCase() !== resolve(cwd).toLowerCase() || parse(real).root === real) return null;
  const home = resolve(homedir()).toLowerCase();
  return real.toLowerCase() === home || dirname(real).toLowerCase() === home ? null : real;
}

/** Newest DONE report this pane sent before, else when the pane was spawned. */
function since(store: VerifyWorkersDeps["store"], threadId: string, paneId: string, spawnedAt?: number): number | undefined {
  const tag = `[pane ${paneId.slice(0, 8)}]`;
  for (const message of store.activePathBack(threadId)) {
    if (spawnedAt !== undefined && message.at < spawnedAt) break;
    if (message.kind === "note" && !message.heldFrom && message.text?.startsWith(tag) && parsePaneNote(message.text).status === "done") return message.at;
  }
  return spawnedAt;
}

export function createVerifyWorkers(deps: VerifyWorkersDeps) {
  const { store } = deps;
  const jobs = new Map<string, Job>();
  const checked = new Map<string, string>();
  const starts = new Map<string, number[]>();
  const holdMs = Math.min(90_000, deps.holdMs ?? WORKER_HOLD_MS);
  const note = (outcome: string, extra: Partial<Parameters<typeof verifyNoteText>[0]> = {}) => ({ text: verifyNoteText({ outcome, ...extra }) });

  async function planFor(scope: Scope, text: string, source: BotRecord): Promise<WorkerPlan | null> {
    const pane = await deps.pane(scope.bot, scope.pane);
    const root = pane ? await workerRoot(pane.cwd) : null;
    const from = root ? since(store, source.threadId, scope.pane, pane!.spawnedAt) : undefined;
    if (!root || from === undefined) return null;
    const base = { botId: source.id, threadId: source.threadId, paneId: scope.pane, root };
    const joined = jobs.get(root);
    if (joined) return { ...joined.plan, ...base };
    const paths = await (deps.scan ?? scanVerifyWrites)(root, from);
    const site = paths.filter(path => SITE_TYPES.has(extname(path).toLowerCase()));
    const entry = site.length ? await entryFor(site, [root]) : undefined;
    if (!entry) {
      const url = await appEntry(text, { skipPorts: deps.app?.skipPorts, waitMs: PREVIEW_WAIT_MS });
      return url ? { ...base, target: url, preview: true } : null;
    }
    const resolved = await resolveVerifySite(entry, [root]);
    if (typeof resolved === "string" || checked.get(root) === resolved.revision) return null;
    let old: string | undefined;
    for (const path of paths) {
      if (!SOURCE.has(extname(path).toLowerCase()) || !inside(root, path) || inside(resolved.root, path)) continue;
      const mtime = (await stat(path).catch(() => null))?.mtimeMs ?? 0;
      const lag = Math.round((mtime - (resolved.built ?? mtime)) / 60_000);
      if (mtime > (resolved.built ?? mtime) + 2_000) old = `build is older than the source: ${relative(root, path).split(sep).join("/")} changed ${Math.max(1, lag)} min after the build`;
    }
    return { ...base, target: entry, preview: false, ...(old ? { old } : {}) };
  }

  /** No hold: null. Over budget: a line for the bot on the note itself. */
  async function plan(scope: Scope, text: string, kind: string | undefined, source: BotRecord): Promise<{ hold: Message["hold"]; plan: WorkerPlan } | { verifyNote: NonNullable<Message["verifyNote"]> } | null> {
    if (kind !== "report" || parsePaneNote(text).status !== "done" || !deps.enabled() || deps.skip?.(source.threadId)) return null;
    const human = store.activePath(source.threadId).findLast(message => message.role === "user" && message.kind === "text" && !message.from?.botId && message.text?.trim());
    if (human?.text && OPT_OUT.test(human.text)) return null;
    const found = await planFor(scope, text, source).catch((error: Error) => { deps.log(`Live Verify: worker check skipped, ${error.message}`); return null; });
    if (!found) return null;
    if (jobs.has(found.root)) return { hold: { until: jobs.get(found.root)!.arrival + holdMs }, plan: found };
    const now = Date.now(), recent = (starts.get(source.id) ?? []).filter(at => at > now - 3_600_000);
    starts.set(source.id, recent);
    const free = (deps.freeMemory ?? freemem)();
    if (free < VERIFY_LIMITS.autoFreeBytes) return { verifyNote: note(`not checked, low memory (${(free / 1024 ** 3).toFixed(1)} GB free)`) };
    if (jobs.size >= ACTIVE || recent.length >= PER_HOUR) return { verifyNote: note("not checked, the checker is busy") };
    recent.push(now);
    return { hold: { until: now + holdMs }, plan: found };
  }

  const checkedLine = (job: Job, reply?: WorkerReply) => {
    const seconds = `${Math.round((Date.now() - job.arrival) / 1000)} s`;
    if (job.plan.preview) return `preview ${job.plan.target}, named in the report, not tied to files | ${seconds}`;
    const site = reply?.site;
    const shown = site ? `${site.site} in ${basename(job.plan.root)} | site ${site.revision.slice(0, 8)}, ${site.files} files, built ${clock(site.built ?? 0)}` : `${relative(job.plan.root, job.plan.target).split(sep).join("/")} in ${basename(job.plan.root)}`;
    return `${shown} | ${seconds}`;
  };

  function outcome(job: Job, reply: WorkerReply) {
    const checkedText = checkedLine(job, reply);
    const result = reply.result;
    if (reply.status !== "completed" || !result || reply.errorCode) return note(`not checked, ${VERIFY_REASONS[reply.errorCode ?? "internal"]}`, { checked: checkedText });
    const issues: VerifyIssue[] = verifyProblems(result.issues), page = result.page;
    const notChecked = result.notChecked ?? [];
    const why = job.plan.old ?? (issues.length ? undefined
      : page?.blockedErrors ? "blocked code broke the page"
      : page && (page.password || /\/(?:log-?in|sign-?in|auth)(?:\/|$)/i.test(page.path)) ? "sign-in page"
      : page && page.text < 20 && page.images === 0 ? "empty page" : undefined);
    if (why) return note(`inconclusive, ${why}`, { checked: checkedText, notChecked });
    return note(issues.length ? `problems (${issues.length})` : "clean, no problems found", { checked: checkedText, issues, notChecked });
  }

  /** Delivers every held report of the job once, the check on the last copy, then one wake. */
  function release(job: Job, verifyNote: NonNullable<Message["verifyNote"]>) {
    if (job.released) return;
    job.released = true;
    clearTimeout(job.timer);
    const { botId, threadId, paneId } = job.plan;
    const rows = job.notes.map(id => store.messagesFor(threadId).find(message => message.id === id)).filter((row): row is Message => Boolean(row?.hold && !row.hold.to));
    rows.forEach((row, index) => {
      const copy = store.appendMessage(threadId, { role: row.role, kind: "note", text: row.text, origin: deps.deviceId(), heldFrom: row.id, ...(row.from ? { from: row.from } : {}), ...(index === rows.length - 1 ? { verifyNote } : {}) });
      store.patchMessage(threadId, row.id, { hold: { ...row.hold!, to: copy.id } });
    });
    if (rows.length) deps.arrived(botId, threadId, paneId);
  }

  function start(job: Job) {
    const { plan: found } = job;
    job.timer = setTimeout(() => release(job, note("still checking", { checked: checkedLine(job), follows: true })), Math.max(0, job.arrival + holdMs - Date.now()));
    job.timer.unref?.();
    const card = (id: string) => {
      job.card = id;
      for (const noteId of job.notes) {
        const row = store.messagesFor(found.threadId).find(message => message.id === noteId);
        if (row?.hold && !row.hold.to) store.patchMessage(found.threadId, noteId, { hold: { ...row.hold, card: id } });
      }
    };
    void deps.run({ botId: found.botId, threadId: found.threadId, root: found.root, target: found.target, episode: JSON.stringify(["worker", found.botId, found.threadId, found.root, found.target]), slotBy: job.arrival + SLOT_MS, runBy: job.arrival + RUN_MS, signal: job.abort.signal, onCard: card })
      .then(reply => {
        if (reply.status === "completed" && reply.site) checked.set(found.root, reply.site.revision);
        deps.log(`Live Verify: worker check ${reply.status}${reply.errorCode ? ` ${reply.errorCode}` : ""} in ${Date.now() - job.arrival} ms`);
        return outcome(job, reply);
      }, () => note("not checked, an internal error", { checked: checkedLine(job) }))
      .then(verifyNote => {
        if (!job.released) return release(job, verifyNote);
        const last = job.notes.at(-1)!;
        store.appendMessage(found.threadId, { role: "bot", kind: "note", text: verifyNote.text, origin: deps.deviceId(), heldFrom: last, verifyNote: { ...verifyNote, alone: true } });
        deps.arrived(found.botId, found.threadId, found.paneId);
      })
      .finally(() => { if (jobs.get(found.root) === job) jobs.delete(found.root); });
  }

  /** The note is stored with its hold: start its check, or join the one already running on its folder. */
  function held(found: WorkerPlan, message: Message) {
    const joined = jobs.get(found.root);
    if (joined && !joined.released) { joined.notes.push(message.id); joined.plan = { ...joined.plan, paneId: found.paneId }; return; }
    const job: Job = { plan: found, notes: [message.id], arrival: Date.now(), abort: new AbortController() };
    jobs.set(found.root, job);
    start(job);
  }

  /** Holds this device stored and never released: a restart ended their checks. Runs before the boot re-wake, which then delivers them. */
  function boot() {
    const deviceId = deps.deviceId();
    for (const bot of store.bots) {
      const stuck: Message[] = [];
      let rows = 0;
      for (const message of store.activePathBack(bot.threadId)) {
        if (++rows > SWEEP_ROWS) break;
        if (message.hold && !message.hold.to && message.origin === deviceId) stuck.unshift(message);
      }
      stuck.forEach((row, index) => {
        const copy = store.appendMessage(bot.threadId, { role: row.role, kind: "note", text: row.text, origin: deviceId, heldFrom: row.id, ...(index === stuck.length - 1 ? { verifyNote: note("not checked, Wink restarted during the check") } : {}) });
        store.patchMessage(bot.threadId, row.id, { hold: { ...row.hold!, to: copy.id } });
        const card = row.hold!.card ? store.messagesFor(bot.threadId).find(message => message.id === row.hold!.card) : undefined;
        if (card?.verify && ["waiting", "preparing", "running"].includes(card.verify.status)) {
          const verify = { ...card.verify, status: "blocked" as const, errorCode: "cancelled" as const, endedAt: Date.now() };
          store.patchMessage(bot.threadId, card.id, { verify, text: verifyCardText(verify) });
        }
      });
    }
  }

  return { plan, held, boot, stop: () => { for (const job of jobs.values()) job.abort.abort(); } };
}
