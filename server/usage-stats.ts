// Anonymous usage stats: buffer, queue file and uploader. The schema loads on the first flush, a minute
// after boot, so a capture is one array push and nothing here runs on a send, switch or startup path.
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { appendFile, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { cpus, release, totalmem, uptime } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { z } from "zod";

import type { StatsEvent } from "../shared/usage-stats.ts";
import { loadAnalyticsConsent } from "./analytics-consent.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { classifyError } from "./drivers/retry.ts";

type Schema = typeof import("../shared/usage-stats.ts");
type Row = Record<string, unknown>;
type Raw<T> = T extends unknown ? { [K in keyof T as Exclude<K, "h">]: K extends "engine" | "model" | "effort" | "from" | "to" | "code" ? string : NonNullable<T[K]> extends number ? number : T[K] } : never;
/** An event before the schema. Engine, model and effort ids and step values are raw: the lists replace them on the way to disk. */
export type StatsInput = Raw<StatsEvent>;
type Client = "desktop" | "phone" | "browser";

export interface StatsState {
  engines: { kind: string; accounts: number; signedIn: boolean; cli?: string }[];
  counts: Record<"bots" | "rooms" | "joinedRooms" | "archived" | "routines" | "skills" | "mcp" | "phones" | "pcs", number>;
  on: Record<"tailscale" | "relay" | "push" | "sync" | "syncChats" | "team" | "chief", boolean>;
  keys: string[];
}

export interface TurnFacts {
  /** Set for a turn no screen sent. */
  c?: "voice" | "system";
  /** Where the sending screen was noted, when not under the thread: a room's turns answer one post. */
  from?: string;
  surface: "chat" | "room" | "worker" | "routine" | "quick" | "verify";
  model?: string;
  effort?: string;
  startedAt?: number;
  stop?: "interrupted" | "superseded";
  chars?: number;
  images?: number;
  files?: number;
  queued?: boolean;
  resumed?: boolean;
  compacted?: boolean;
  reused?: boolean;
  spawnMs?: number;
  readyMs?: number;
}

export interface UsageStatsOptions {
  dataDir: string;
  /** Empty: nothing is captured, written or sent. */
  url: string;
  app: string;
  internal?: boolean;
  display?: { scale: number; screens: number };
  state(): StatsState;
  turn(event: RuntimeEvent): TurnFacts | null;
  /** A turn is running: the upload waits for it. */
  busy(): boolean;
  fetch?: typeof fetch;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const QUEUE_MAX = 1024 * 1024;
const KEEP_HOURS = 14 * 24;
const BUFFER_MAX = 2000;
const QUIT_MAX = 64 * 1024;
const FIRST_UPLOAD_MS = 5 * MIN;
const UPLOAD_MS = 30 * MIN;
const IDLE_WAIT_MS = 2 * MIN;
const LEN_CUTS = [50, 200, 1000, 5000];
const WORKER_ENGINES: Record<string, string> = { claude: "claudeAgent", codex: "codex", grok: "grokAgent", muse: "museAgent", agy: "antigravityAgent" };
const zip = promisify(gzip);
const hourOf = () => Math.floor(Date.now() / HOUR);
const whole = (value: number | undefined, max: number) => (value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.min(max, Math.round(value))));
let batchShape: z.ZodType<{ events: Row[]; ui?: Row; lang?: "en" | "ko" }> | undefined;

/** Unknown ids become the list's catch-all and raw minutes become steps; anything else the schema refuses is dropped. */
function clean(row: Row, schema: Schema): StatsEvent | null {
  const event = { ...row };
  const known = (list: readonly string[], key: string, other: string) => {
    if (event[key] !== undefined && !list.includes(String(event[key]))) event[key] = other;
  };
  const step = (key: string, steps: readonly number[]) => {
    if (Number.isFinite(event[key])) event[key] = schema.bucket(Number(event[key]), steps);
  };
  if (event.e !== "update" && event.e !== "setting") {
    known(schema.ENGINES, "engine", "other");
    known(schema.MODELS, "model", "custom");
    known(schema.EFFORTS, "effort", "auto");
  }
  for (const key of ["from", "to"]) {
    if (event.e === "setting" && event.key === "skin" && event[key] !== "default") known(schema.SKINS, key, "other");
    if (event.e !== "switch") continue;
    if (event.what === "model") known(schema.MODELS, key, "custom");
    else if (event.what === "engine") known(schema.ENGINES, key, "other");
    else if (event.what === "effort") known(schema.EFFORTS, key, "auto");
    else delete event[key];
  }
  if (event.e === "feature" && String(event.name).startsWith("engine.")) known(schema.ENGINES, "kind", "other");
  if (event.e === "launch") step("prevMin", schema.MINUTE_STEPS);
  if (event.e === "worker") step("min", schema.MINUTE_STEPS);
  if (event.e === "stall") step("ms", schema.STALL_STEPS);
  const parsed = schema.statsEventSchema.safeParse(event);
  if (parsed.success) return parsed.data;
  return event.e === "turn_error" ? schema.statsEventSchema.safeParse({ ...event, code: "other" }).data ?? null : null;
}

function clientOf(sender: { agent: string; local: boolean } | undefined): Client {
  if (!sender) return "desktop";
  if (sender.local && /Electron/.test(sender.agent)) return "desktop";
  return /Mobi|Android|iPhone|iPad/.test(sender.agent) ? "phone" : "browser";
}

export function createUsageStats(options: UsageStatsOptions) {
  const queue = join(options.dataDir, "stats-queue.ndjson");
  const idFile = join(options.dataDir, "stats-id");
  const marker = join(options.dataDir, "stats-active");
  const available = /^https:\/\/|^http:\/\/127\.0\.0\.1[:/]/.test(options.url);
  const send = options.fetch ?? fetch;
  // undefined until start() reads the saved choice: early events wait in the buffer.
  let on: boolean | undefined = available ? undefined : false;
  let started = false;
  let buffer: Row[] = [];
  let dropped = 0;
  // Bumped by off and quit, so work already in flight writes nothing afterwards.
  let generation = 0;
  let schema: Schema | undefined;
  let chain: Promise<void> = Promise.resolve();
  let ui: Row | undefined;
  let lang: "en" | "ko" = "en";
  let pending: { batch: string; head: string; count: number } | undefined;
  let failures = 0;
  let active: AbortController | undefined;
  let session: { start: number; day?: number } | undefined;
  let previous: { clean: boolean; min: number; cold: boolean } | undefined;
  let spans: Record<string, number> | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let lagTimer: ReturnType<typeof setInterval> | undefined;
  let uploadTimer: ReturnType<typeof setTimeout> | undefined;
  const turns = new Map<string, { first?: number; tools: number; toolFails: number; asks: number; asksAuto: number; denied: number; retries: number; stop?: "usage-limit" | "signed-out" | "timeout" }>();
  const senders = new Map<string, { agent: string; local: boolean }>();
  const workers = new Map<string, { engine: string; model: string; effort: string; at: number }>();

  const load = async () => (schema ??= await import("../shared/usage-stats.ts"));
  const run = (work: () => Promise<void>) => (chain = chain.then(work).catch(() => {}));
  const lines = async () => (await readFile(queue, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const save = (rows: string[]) => writeFile(queue, rows.length ? `${rows.join("\n")}\n` : "");

  const capture = (event: StatsInput) => {
    if (on === false) return;
    if (buffer.length >= BUFFER_MAX) dropped++;
    else buffer.push({ ...event, h: hourOf() });
  };

  const tally = (threadId: string) => {
    let turn = turns.get(threadId);
    if (!turn) turns.set(threadId, turn = { tools: 0, toolFails: 0, asks: 0, asksAuto: 0, denied: 0, retries: 0 });
    return turn;
  };

  const launch = () => {
    if (!spans || !session || !Number.isFinite(spans.mainFork)) return;
    capture({
      e: "launch", cold: previous?.cold ?? true, mainMs: whole(spans.mainFork, 7 * 24 * HOUR), windowMs: whole(spans.mainWindow, 7 * 24 * HOUR),
      serverMs: whole(spans.serverReady, 7 * 24 * HOUR), checksMs: whole(spans.checksReady, 7 * 24 * HOUR),
      prevClean: previous?.clean, prevMin: previous?.min,
    });
    spans = undefined;
  };

  const trim = async (gen: number) => {
    if (((await stat(queue).catch(() => null))?.size ?? 0) <= QUEUE_MAX) return;
    let rows = await lines();
    let bytes = rows.reduce((sum, row) => sum + row.length + 1, 0);
    const cut = (keep: (row: string) => boolean) => {
      rows = rows.filter((row) => {
        if (bytes <= QUEUE_MAX * 0.9 || keep(row)) return true;
        bytes -= row.length + 1;
        dropped++;
        return false;
      });
    };
    cut((row) => !row.includes('"e":"screen"'));
    cut(() => false);
    if (gen === generation) await save(rows);
  };

  const flush = () => run(async () => {
    if (!on || !buffer.length) return;
    const rows = buffer;
    const gen = generation;
    buffer = [];
    const lists = await load();
    const checked: string[] = [];
    for (const [index, row] of rows.entries()) {
      const event = clean(row, lists);
      if (event) checked.push(JSON.stringify(event));
      // A full buffer takes about 20 ms to check: give requests a turn every 100 rows.
      if (index % 100 === 99) await new Promise((resolve) => setImmediate(resolve));
    }
    const text = checked.join("\n");
    if (gen !== generation || !text) return;
    await appendFile(queue, `${text}\n`, { mode: 0o600 });
    if (gen !== generation) return rmSync(queue, { force: true });
    await trim(gen);
  });

  const installId = async () => {
    const saved = (await readFile(idFile, "utf8").catch(() => "")).trim();
    if (/^[a-f0-9]{32}$/.test(saved)) return saved;
    const id = randomBytes(16).toString("hex");
    await writeFile(idFile, id, { mode: 0o600 });
    return id;
  };

  const stateEvent = (lists: Schema): StatsEvent | null => {
    const now = options.state();
    const count = (value: number) => lists.bucket(value, lists.COUNT_STEPS);
    const base = {
      e: "state", h: hourOf(),
      pc: {
        cores: Math.max(1, Math.min(64, cpus().length)), ramGb: lists.bucket(Math.round(totalmem() / 2 ** 30), lists.RAM_STEPS),
        scale: lists.bucket(options.display?.scale ?? 100, lists.SCALE_STEPS), screens: Math.max(1, Math.min(3, options.display?.screens ?? 1)),
      },
      engines: now.engines.slice(0, 16).map((engine) => ({
        kind: lists.ENGINES.includes(engine.kind as never) ? engine.kind : "other", accounts: whole(engine.accounts, 9), signedIn: engine.signedIn,
        cli: /\d{1,4}\.\d{1,4}\.\d{1,5}/.exec(engine.cli ?? "")?.[0],
      })),
      counts: {
        bots: count(now.counts.bots), rooms: count(now.counts.rooms), joinedRooms: count(now.counts.joinedRooms), archived: count(now.counts.archived),
        routines: count(now.counts.routines), skills: count(now.counts.skills), mcp: count(now.counts.mcp), phones: whole(now.counts.phones, 9), pcs: whole(now.counts.pcs, 9),
      },
      on: now.on, keys: now.keys,
    };
    const skin = ui?.skin === undefined || lists.SKINS.includes(ui.skin as never) ? ui?.skin : "other";
    return lists.statsEventSchema.safeParse({ ...base, ui: ui && { ...ui, skin } }).data ?? lists.statsEventSchema.safeParse(base).data ?? null;
  };

  const plan = (ms: number) => {
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(() => attempt(0), ms);
    uploadTimer.unref();
  };
  const attempt = (waited: number) => {
    if (options.busy() && waited < IDLE_WAIT_MS) {
      uploadTimer = setTimeout(() => attempt(waited + 10_000), 10_000);
      uploadTimer.unref();
      return;
    }
    void flush();
    void upload();
  };

  const upload = () => run(async () => {
    if (!on || !session) return;
    const gen = generation;
    const lists = await load();
    const hour = hourOf();
    const today = Math.floor(hour / 24);
    const all = await lines();
    const rows: string[] = [];
    const events: StatsEvent[] = [];
    for (const row of all) {
      let event: StatsEvent | undefined;
      try { event = lists.statsEventSchema.safeParse(JSON.parse(row)).data; } catch {}
      if (!event || hour - event.h > KEEP_HOURS) continue;
      rows.push(row);
      events.push(event);
    }
    const retry = pending && rows[0] === pending.head && rows.length >= pending.count ? pending : undefined;
    let count = retry?.count ?? Math.min(rows.length, lists.STATS_MAX_EVENTS - 1);
    let next = UPLOAD_MS - 5 * MIN + Math.random() * 10 * MIN;
    if (count) {
      const state = session.day === today ? null : stateEvent(lists);
      const envelope = {
        v: 1 as const, id: await installId(), batch: retry?.batch ?? randomBytes(16).toString("hex"), app: options.app,
        channel: options.app.includes("-") ? "dev" as const : "stable" as const, internal: options.internal === true,
        os: process.platform, osBuild: /^\d{1,5}(?:\.\d{1,5}){0,2}/.exec(release())?.[0] ?? "0", arch: process.arch, lang,
        osLang: /^[a-z]{2}/.exec(Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase())?.[0] ?? "other", dropped: Math.min(dropped, 1_000_000),
      };
      const pack = async () => {
        const checked = lists.statsBatchSchema.safeParse({ ...envelope, events: [...(state ? [state] : []), ...events.slice(0, count)] });
        return checked.success ? zip(JSON.stringify(checked.data)) : null;
      };
      let body = await pack();
      while (body && body.length > lists.STATS_MAX_BYTES && count > 1 && !retry) {
        count = Math.ceil(count / 2);
        body = await pack();
      }
      let status = body ? 0 : 400;
      let wait = 0;
      if (body && gen === generation) {
        active = new AbortController();
        try {
          const response = await send(options.url, {
            method: "POST", redirect: "error", signal: AbortSignal.any([active.signal, AbortSignal.timeout(10_000)]),
            headers: { "content-type": "application/json", "content-encoding": "gzip" }, body,
          });
          status = response.status;
          const after = response.headers.get("retry-after") ?? "";
          if (status === 429 || status === 503) wait = /^\d+$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now();
          await response.body?.cancel();
        } catch {}
        active = undefined;
      }
      if (gen !== generation) return;
      if (status >= 200 && status < 300 || status >= 400 && status < 500 && status !== 408 && status !== 429) {
        rows.splice(0, count);
        pending = undefined;
        failures = 0;
        if (status < 300) {
          dropped -= envelope.dropped;
          if (state) {
            session.day = today;
            await writeFile(marker, JSON.stringify(session)).catch(() => {});
          }
        }
      } else {
        pending = { batch: envelope.batch, head: rows[0]!, count };
        failures++;
        next = Math.max(Math.min(6 * HOUR, MIN * 2 ** (failures - 1)), Number.isFinite(wait) ? Math.min(wait, 6 * HOUR) : 0);
      }
    }
    if (gen !== generation) return;
    if (rows.length !== all.length) await save(rows);
    plan(next);
  });

  const begin = () => {
    let last: { start?: number; end?: number; day?: number } | undefined;
    let seen = 0;
    try {
      last = JSON.parse(readFileSync(marker, "utf8"));
      seen = statSync(marker).mtimeMs;
    } catch {}
    if (last && Number.isFinite(last.start)) {
      const min = Math.max(0, ((last.end ?? seen) - last.start!) / MIN);
      previous = { clean: Number.isFinite(last.end), min, cold: seen < Date.now() - uptime() * 1000 };
      if (!previous.clean) capture({ e: "crash", process: "server", kind: "unclean-exit", up: min < 1 ? 0 : min < 10 ? 1 : min < 60 ? 2 : 3 });
    }
    session = { start: Date.now(), ...(Number.isInteger(last?.day) ? { day: last!.day } : {}) };
    try { writeFileSync(marker, JSON.stringify(session), { mode: 0o600 }); } catch {}
    launch();
    flushTimer = setInterval(() => {
      const at = new Date();
      void utimes(marker, at, at).catch(() => {});
      void flush();
    }, MIN);
    flushTimer.unref();
    let tick = performance.now();
    lagTimer = setInterval(() => {
      const late = performance.now() - tick - 1000;
      tick += late + 1000;
      // A gap of minutes is the PC waking from sleep, not a stall.
      if (late >= 1000 && late < 2 * MIN) capture({ e: "stall", where: "server", ms: late });
    }, 1000);
    lagTimer.unref();
    plan(FIRST_UPLOAD_MS);
  };

  const halt = () => {
    generation++;
    clearInterval(flushTimer);
    clearInterval(lagTimer);
    clearTimeout(uploadTimer);
    active?.abort();
    session = undefined;
    on = false;
  };

  const purge = () => {
    halt();
    buffer = [];
    dropped = 0;
    pending = undefined;
    ui = undefined;
    turns.clear();
    senders.clear();
    workers.clear();
    for (const path of [queue, idFile, marker]) try { rmSync(path, { force: true }); } catch {}
  };

  return {
    capture, flush, upload,
    /** Whether screens should record at all. */
    capturing: () => on !== false,
    /** Reads the saved choice. Called once the first window has painted. */
    start() {
      if (!available || started) return;
      started = true;
      if (loadAnalyticsConsent(options.dataDir)) { on = true; begin(); } else purge();
    },
    /** The switch moved, on any client. Off deletes the queue, the install id and the marker. */
    setEnabled(enabled: boolean) {
      if (!enabled) return purge();
      if (!available || on) return;
      on = started ? true : undefined;
      if (started) begin();
    },
    /** Startup spans, once the first paint and the boot checks are in. */
    launched(values: Record<string, number>) {
      spans = values;
      launch();
    },
    /** A chat POST: which screen sent the turn that follows. */
    sent(key: string | undefined, agent: string | undefined, local: boolean) {
      if (on !== false && key) senders.set(key, { agent: agent ?? "", local });
    },
    /** A worker pane opened: the engine comes from the program name, the model from its own flag. */
    workerStarted(pane: unknown, launch: unknown) {
      if (on === false || typeof pane !== "string") return;
      // SAFETY: every field is read as a string and replaced by a list value before it is queued.
      const { executable, session } = (launch ?? {}) as { executable?: unknown; session?: { engine?: unknown; model?: unknown; effort?: unknown } };
      const name = String(session?.engine ?? executable ?? "").replace(/^.*[\\/]|\.(?:exe|cmd)$/gi, "").toLowerCase();
      if (!name) return;
      const worker = { engine: WORKER_ENGINES[name] ?? "other", model: String(session?.model ?? ""), effort: String(session?.effort ?? "auto"), at: Date.now() };
      workers.set(pane, worker);
      capture({ e: "worker", phase: "start", engine: worker.engine, model: worker.model, effort: worker.effort, parallel: Math.min(32, workers.size) });
    },
    /** A worker's final report: only its leading status word is read. */
    workerReported(pane: string, text: string) {
      const worker = workers.get(pane);
      const status = /^\s*(DONE|FAIL|BLOCKED)\b/.exec(text)?.[1];
      if (!worker || !status) return;
      capture({
        e: "worker", phase: "end", engine: worker.engine, model: worker.model, effort: worker.effort, parallel: Math.min(32, workers.size),
        outcome: status === "DONE" ? "done" : status === "FAIL" ? "failed" : "stuck", min: (Date.now() - worker.at) / MIN,
      });
      workers.delete(pane);
    },
    /** A batch from a screen or from the desktop shell. False when it was refused. */
    ingest(body: unknown): boolean {
      if (on === false) return false;
      batchShape ??= z.object({ events: z.array(z.record(z.string(), z.unknown())).max(500), ui: z.record(z.string(), z.unknown()).optional(), lang: z.enum(["en", "ko"]).optional() });
      const batch = batchShape.safeParse(body);
      if (!batch.success) return false;
      if (batch.data.ui) ui = batch.data.ui;
      if (batch.data.lang) lang = batch.data.lang;
      const h = hourOf();
      for (const event of batch.data.events) {
        if (buffer.length >= BUFFER_MAX) dropped++;
        else buffer.push({ ...event, h });
      }
      return true;
    },
    runtime(event: RuntimeEvent) {
      if (on === false) return;
      switch (event.type) {
        case "content.delta":
          if (event.streamKind === "assistant_text" && event.delta) tally(event.threadId).first ??= Date.now();
          return;
        case "item.completed":
          if (event.itemType !== "tool") return;
          tally(event.threadId).tools++;
          if (!event.ok) tally(event.threadId).toolFails++;
          return;
        case "request.opened":
          tally(event.threadId).asks++;
          return;
        case "request.resolved":
          if (event.source === "auto") tally(event.threadId).asksAuto++;
          if (event.behavior === "deny") tally(event.threadId).denied++;
          return;
        case "turn.retrying":
          tally(event.threadId).retries++;
          capture({ e: "turn_error", engine: event.provider, model: options.turn(event)?.model, kind: "retry", code: event.reason });
          return;
        case "runtime.error": {
          const code = classifyError({ text: event.message }).reason;
          if (event.usageLimit || event.signedOut || code === "timeout") tally(event.threadId).stop = event.usageLimit ? "usage-limit" : event.signedOut ? "signed-out" : "timeout";
          const kind = event.setup ? "setup" : event.signIn ? "sign-in" : event.signedOut ? "signed-out" : event.usageLimit ? "usage-limit" : code === "terminal_exit" ? "crash" : "runtime";
          capture({ e: "turn_error", engine: event.provider, model: options.turn(event)?.model, kind, code });
          return;
        }
        case "turn.completed": {
          const turn = turns.get(event.threadId);
          turns.delete(event.threadId);
          const facts = options.turn(event);
          if (!facts) return;
          const sender = senders.get(facts.from ?? event.threadId);
          const since = (at: number | undefined) => (at === undefined || facts.startedAt === undefined ? undefined : whole(at - facts.startedAt, 7 * 24 * HOUR));
          capture({
            e: "turn", c: facts.c ?? clientOf(sender), surface: facts.surface, engine: event.provider, model: facts.model ?? "", effort: facts.effort ?? "auto",
            ok: event.ok, stop: facts.stop ?? (event.ok ? "done" : turn?.stop ?? "error"), retries: whole(turn?.retries, 9),
            spawnMs: whole(facts.spawnMs, 7 * 24 * HOUR), readyMs: whole(facts.readyMs, 7 * 24 * HOUR), ttftMs: since(turn?.first), doneMs: since(Date.now()),
            reused: facts.reused, tools: whole(turn?.tools, 999), toolFails: whole(turn?.toolFails, 999), asks: whole(turn?.asks, 999),
            asksAuto: whole(turn?.asksAuto, 999), denied: whole(turn?.denied, 999), tokIn: whole(event.usage?.input, 1e9), tokOut: whole(event.usage?.output, 1e9),
            tokCached: whole(event.usage?.cachedInput, 1e9), costUsd: event.cost == null ? undefined : Math.min(100_000, Math.max(0, Math.round(event.cost * 100) / 100)),
            ctxPct: event.prompt && event.contextWindow ? whole(100 * event.prompt.last / event.contextWindow, 100) : undefined,
            images: whole(facts.images, 20), files: whole(facts.files, 20),
            len: facts.chars === undefined ? undefined : LEN_CUTS.filter((cut) => facts.chars! >= cut).length,
            queued: facts.queued, resumed: facts.resumed, compacted: facts.compacted,
          });
          return;
        }
      }
    },
    /** Quit: what the last minute held goes to disk if it is small, and the session ends clean. */
    stop() {
      if (!on || !session) return;
      try {
        const text = schema && buffer.flatMap((row) => { const event = clean(row, schema!); return event ? [JSON.stringify(event)] : []; }).join("\n");
        if (text && text.length < QUIT_MAX) appendFileSync(queue, `${text}\n`, { mode: 0o600 });
        writeFileSync(marker, JSON.stringify({ ...session, end: Date.now() }), { mode: 0o600 });
      } catch {}
      halt();
    },
  };
}

export type UsageStats = ReturnType<typeof createUsageStats>;
