import { randomUUID } from "node:crypto";
import { usageIdentity } from "../shared/usage-identity.ts";

import type { UsageBoard, UsageBoardAccount, UsageBoardEngineId, UsageBoardEvent, UsageBoardFrame, UsageBoardRun, UsageBoardWindow } from "../src/lib/usage-board.ts";
import { isInstanceId, type AccountDrain } from "./accounts.ts";
import { CODEX_CREDIT_NAME } from "./codex-credit.ts";
import type { RateLimitsReport } from "./rate-limits-store.ts";
import type { createUsageHistory } from "./usage-history.ts";

type AccountRow = {
  id: string; of: string; driverKind: string; generation: number; existing: boolean; state: "pending" | "ready" | "stopped";
  blocked?: boolean; identity?: string; credit?: true;
  status?: { state: "available" | "unavailable"; authenticated?: boolean; account?: string; accountIdentity?: string };
};
type Bot = { id: string; name: string; base: string };
type WorkerRun = {
  botId: string; paneId: string; label: string; engine: "claude" | "codex";
  accountId: string; accountGeneration: number; state: UsageBoardRun["state"];
};
type Runs = { known: true; runs: WorkerRun[] } | { known: false; reason: "no-host" | "old-host" | "error" | "timeout" };
type MainChange = {
  base: string; engine: "claude" | "codex"; from: { id: string; generation: number }; to: { id: string; generation: number }; seq: number;
};
type Turn = { turnId: string; botId: string; accountId: string; generation: number };
type History = Pick<ReturnType<typeof createUsageHistory>, "record" | "event" | "purge" | "since" | "snapshot">;
type Deps = {
  accounts: { list(): readonly AccountRow[]; defaultFor(base: string): string | undefined; readonly drains: Readonly<Record<string, AccountDrain>> };
  names: { get(id: string): { id: string; engine: UsageBoardEngineId; number: number; nickname: string | null; name: string } | null };
  rateLimits: { get(id: string): RateLimitsReport | undefined; delete(id: string): boolean };
  accountChanged?: (id: string, ready: boolean) => void;
  history: History;
  runs(timeoutMs: number): Promise<Runs>;
  bots(): readonly Bot[];
  now?: () => number;
};
type Cursor = { boot: string; revision: number; counter: number; accounts: string; epoch: number };
const engines = new Map<string, UsageBoardEngineId>([["claudeAgent", "claude"], ["codex", "codex"], ["grok", "grok"], ["gemini", "gemini"], ["muse", "muse"]]);
const titles = { claude: "Claude", codex: "Codex", grok: "Grok", gemini: "Gemini", muse: "Muse" } satisfies Record<UsageBoardEngineId, string>;

function kind(window: { id: string; windowMinutes?: number }): UsageBoardWindow["kind"] {
  if (window.windowMinutes === 300 || window.id === "five_hour") return "session";
  if (window.windowMinutes === 10080 || window.id === "seven_day" || window.id.startsWith("seven_day_")) return "week";
  if (window.windowMinutes === undefined) {
    if (window.id === "primary") return "session";
    if (window.id === "secondary") return "week";
  }
  return "other";
}

export function createUsageBoard(deps: Deps) {
  const now = deps.now ?? Date.now;
  const boot = randomUUID();
  const cursors = new Map<string, Cursor>();
  const turns = new Map<string, Turn>();
  const reports = new Map<string, { generation: number; at: number; windows: RateLimitsReport["windows"] }>();
  const seenReports = new Set<string>();
  const mainSequences = new Map<string, number>();
  const listeners = new Set<(frame: UsageBoardFrame) => void>();
  const queue: Array<{ id: string; generation: number; report: RateLimitsReport }> = [];
  let queued = false;
  let frameTimer: ReturnType<typeof setTimeout> | undefined;
  let revision = Math.max(0, now());
  let accountSet = "";
  let epoch = 0;
  let previous = new Map<string, number>();
  const identities = new Map<string, string | null>();

  for (const row of deps.accounts.list()) {
    const report = deps.rateLimits.get(row.id);
    const at = report ? Date.parse(report.observedAt) : NaN;
    if (report && Number.isSafeInteger(at) && at >= 0) reports.set(row.id, { generation: row.generation, at, windows: report.windows.map((window) => ({ ...window })) });
  }

  function publish() {
    if (!listeners.size || frameTimer) return;
    frameTimer = setTimeout(() => {
      frameTimer = undefined;
      const frame: UsageBoardFrame = { kind: "usage.board", revision };
      for (const callback of listeners) {
        try { callback(frame); } catch {}
      }
    }, 2_000).unref();
  }

  function bump() { revision = Math.max(revision + 1, now()); publish(); }

  function accounts() {
    const rows = deps.accounts.list().filter((row) => engines.has(row.driverKind) && isInstanceId(row.id) && isInstanceId(row.of));
    for (const row of rows) {
      const identity = usageIdentity(row.status ?? {});
      if (identity === undefined) continue;
      if (identities.has(row.id) && identities.get(row.id) !== identity) {
        deps.rateLimits.delete(row.id);
        deps.history.purge(row.id);
        reports.delete(row.id);
        for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === row.id) queue.splice(i, 1);
        seenReports.clear();
        deps.accountChanged?.(row.id, row.status?.authenticated !== false);
      }
      identities.set(row.id, identity);
    }
    const signature = JSON.stringify(rows.map((row) => [row.id, row.of, row.generation, identities.get(row.id)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    if (signature !== accountSet) {
      const current = new Map(rows.map((row) => [row.id, row.generation]));
      const saved = deps.history.snapshot().accounts;
      for (const [id, generation] of new Map([...previous, ...Object.entries(saved).map(([id, value]) => [id, value.generation] as const)])) {
        if (current.get(id) !== generation) deps.history.purge(id);
      }
      for (const [id, report] of reports) if (current.get(id) !== report.generation) reports.delete(id);
      for (const [id, turn] of turns) if (current.get(turn.accountId) !== turn.generation) turns.delete(id);
      previous = current;
      accountSet = signature;
      epoch++;
      bump();
    }
    return rows;
  }

  function touch() { accounts(); bump(); return revision; }

  function drain() {
    queued = false;
    const current = new Map(accounts().map((row) => [row.id, row.generation]));
    for (const item of queue.splice(0)) {
      if (current.get(item.id) !== item.generation) continue;
      const windows = item.report.windows;
      deps.history.record(item.id, item.generation, Date.parse(item.report.observedAt),
        windows.find((window) => kind(window) === "session")?.usedPercent ?? null,
        windows.find((window) => kind(window) === "week")?.usedPercent ?? null);
    }
    bump();
  }

  function recordReport(accountId: string, report: RateLimitsReport) {
    const row = accounts().find((row) => row.id === accountId);
    const at = Date.parse(report.observedAt);
    if (!row || !Number.isSafeInteger(at) || at < 0) return;
    const last = reports.get(accountId);
    const windows = report.windows.filter((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0
      && Number.isFinite(window.resetsAt ?? 0)).map((window) => ({ id: window.id, usedPercent: window.usedPercent,
      resetsAt: window.resetsAt, windowMinutes: window.windowMinutes }));
    const key = JSON.stringify([accountId, row.generation, at, windows]);
    if (seenReports.has(key)) return;
    seenReports.add(key);
    if (seenReports.size > 1024) seenReports.delete(seenReports.values().next().value!);
    if (!last || at > last.at) {
      for (const window of windows) {
        const before = last?.windows.find((value) => value.id === window.id);
        if (window.usedPercent >= 100 && (!before || before.usedPercent < 100)) {
          deps.history.event(row.of, { kind: "limit", at, accountId, window: window.id });
        } else if (before && window.usedPercent < before.usedPercent
          && ((before.resetsAt != null && before.resetsAt <= at && window.resetsAt != null && window.resetsAt > before.resetsAt)
            || (before.usedPercent >= 95 && window.usedPercent < 10))) {
          deps.history.event(row.of, { kind: "reset", at, accountId, window: window.id });
        }
      }
      reports.set(accountId, { generation: row.generation, at, windows });
    }
    // History mutations only schedule asynchronous disk writes, including at the queue cap.
    if (queue.length === 256) drain();
    queue.push({ id: accountId, generation: row.generation, report: { observedAt: report.observedAt, windows } });
    if (!queued) { queued = true; setImmediate(() => { if (queued) drain(); }); }
    bump();
  }

  function recordMain(change: MainChange) {
    if (change.seq <= (mainSequences.get(change.base) ?? -1)) return;
    accounts();
    mainSequences.set(change.base, change.seq);
    deps.history.event(change.base, { kind: "main", at: now(), from: change.from.id, to: change.to.id });
    touch();
  }

  function turnStarted(turn: Turn) {
    const row = accounts().find((row) => row.id === turn.accountId && row.generation === turn.generation);
    if (!row || turns.has(turn.turnId)) return;
    turns.set(turn.turnId, { ...turn });
    bump();
  }

  function turnSettled(turnId: string) { if (turns.delete(turnId)) bump(); }

  function freeze(cursor?: string) {
    const rows = accounts();
    const secrets = rows.flatMap((row) => [row.identity, row.status?.account, row.status?.accountIdentity])
      .filter((value): value is string => !!value).flatMap((value) => [value, ...(value.match(/[\w.+-]+@[\w.-]+/g) ?? []).flatMap((email) => email.split("@"))])
      .map((value) => value.toLowerCase());
    const text = (value: string, fallback: string) => /\S+@\S+/.test(value) || secrets.some((secret) => value.toLowerCase().includes(secret)) ? fallback : value;
    const bots = deps.bots().map((bot) => ({ id: bot.id, base: bot.base, name: text(bot.name, "Bot") }));
    const active = [...turns.values()];
    const old = cursor && cursors.get(cursor);
    const full = !old || old.boot !== boot || old.accounts !== accountSet || old.epoch !== epoch || old.revision > revision;
    const history = deps.history.since(full ? undefined : old.counter);
    const board: UsageBoard = { version: 1, revision, cursor: "", full, at: now(), runs: "unknown", engines: [] };
    for (const row of rows) {
      const engine = engines.get(row.driverKind)!;
      let group = board.engines.find((group) => group.base === row.of);
      if (!group) {
        group = { engine, base: row.of, mainId: deps.accounts.defaultFor(row.of) ?? row.of, accounts: [], events: [] };
        group.events = (history.events[row.of] ?? []).map((event) => {
          const next: UsageBoardEvent = { seq: event.seq, at: event.at, kind: event.kind };
          if (event.accountId !== undefined) next.accountId = text(event.accountId, "");
          if (event.window !== undefined) next.window = text(event.window, "other");
          if (event.from !== undefined) next.from = text(event.from, "");
          if (event.to !== undefined) next.to = text(event.to, "");
          if (event.paneId !== undefined) next.paneId = text(event.paneId, "pane");
          if (event.label !== undefined) next.label = text(event.label, "");
          return next;
        });
        board.engines.push(group);
      }
      const named = deps.names.get(row.id);
      const number = row.credit ? Math.max(0, ...group.accounts.map((account) => account.number)) + 1 : named?.number ?? 1;
      const fallback = row.credit ? CODEX_CREDIT_NAME : engine === "claude" || engine === "codex" ? `${titles[engine]} ${number}` : titles[engine];
      // Validated user labels may match the provider's sign-in name.
      const nickname = named?.nickname && named.name === named.nickname && !named.nickname.includes("@") ? named.nickname : null;
      const report = deps.rateLimits.get(row.id);
      const windows: UsageBoardWindow[] = (report?.windows ?? []).filter((window) => Number.isFinite(window.usedPercent)).map((window) => ({
        id: text(window.id, "other"), kind: kind(window), usedPercent: window.usedPercent,
        resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
        windowMinutes: Number.isFinite(window.windowMinutes) ? window.windowMinutes! : null,
      }));
      const points = history.accounts[row.id];
      const busy = new Set(active.filter((turn) => turn.accountId === row.id).map((turn) => turn.botId));
      const accountBots = [...busy].map((botId) => ({ botId: text(botId, "bot"), bot: bots.find((bot) => bot.id === botId)?.name ?? "Bot", busy: true }));
      if (row.id === group.mainId) for (const bot of bots) {
        if (bot.base === row.of && !active.some((turn) => turn.botId === bot.id)) accountBots.push({ botId: text(bot.id, "bot"), bot: bot.name, busy: false });
      }
      let signIn: UsageBoardAccount["signIn"] = "unknown";
      if (Object.hasOwn(deps.accounts.drains, row.id)) signIn = "draining";
      else if (row.blocked || row.state === "stopped") signIn = "signed-out";
      else if (row.state === "pending") signIn = "signing-in";
      else if (!row.existing) signIn = "ready";
      else if (row.status?.authenticated === true) signIn = "ready";
      else if (row.status?.authenticated === false) signIn = "signed-out";
      const observedAt = report ? Date.parse(report.observedAt) : NaN;
      group.accounts.push({ id: row.id, number, nickname, name: nickname ?? text(named?.name ?? fallback, fallback), main: row.id === group.mainId,
        signIn, coverage: "unknown", windows, observedAt: Number.isFinite(observedAt) ? observedAt : null,
        history: points?.generation === row.generation ? { fine: points.fine, coarse: points.coarse } : { fine: [], coarse: [] },
        bots: accountBots, workers: null, ...(row.credit ? { credit: true as const } : {}) });
    }
    return { board, rows: rows.map((row) => ({ id: row.id, generation: row.generation })), bots, text, counter: history.counter, accounts: accountSet, epoch };
  }

  async function read(cursor?: string): Promise<UsageBoard> {
    let snapshot = freeze(cursor);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const runs = await Promise.race([
      Promise.resolve().then(() => deps.runs(300)).catch((): Runs => ({ known: false, reason: "error" })),
      new Promise<Runs>((resolve) => { timer = setTimeout(() => resolve({ known: false, reason: "timeout" }), 300); }),
    ]).finally(() => { clearTimeout(timer); });
    if (revision > snapshot.board.revision) snapshot = freeze(cursor);
    const { board } = snapshot;
    board.runs = runs.known ? "known" : runs.reason === "old-host" ? "old-host" : "unknown";
    for (const group of board.engines) for (const account of group.accounts) {
      if (!runs.known) continue;
      const generation = snapshot.rows.find((row) => row.id === account.id)!.generation;
      const seen = new Set<string>();
      account.workers = [];
      for (const run of runs.runs) {
        if (run.accountId !== account.id || run.accountGeneration !== generation || run.engine !== group.engine || seen.has(run.paneId)) continue;
        seen.add(run.paneId);
        account.workers.push({ botId: snapshot.text(run.botId, "bot"), bot: snapshot.bots.find((bot) => bot.id === run.botId)?.name ?? "Bot",
          paneId: snapshot.text(run.paneId, "pane"), label: snapshot.text(run.label, ""), state: run.state });
      }
    }
    board.cursor = randomUUID();
    cursors.set(board.cursor, { boot, revision: board.revision, counter: snapshot.counter, accounts: snapshot.accounts, epoch: snapshot.epoch });
    if (cursors.size > 512) cursors.delete(cursors.keys().next().value!);
    return board;
  }

  async function handle(url: URL | string) {
    let parsed: URL;
    try { parsed = new URL(url, "http://localhost"); } catch { return { status: 400, body: { error: "Invalid URL" } }; }
    if (parsed.pathname !== "/api/usage/board") return { status: 404, body: { error: "Not found" } };
    return { status: 200, body: await read(parsed.searchParams.get("cursor") ?? undefined) };
  }

  function onFrame(callback: (frame: UsageBoardFrame) => void) {
    listeners.add(callback);
    return () => { listeners.delete(callback); if (!listeners.size) { clearTimeout(frameTimer); frameTimer = undefined; } };
  }

  return { read, handle, touch, sync: accounts, turnStarted, turnSettled, recordReport, recordMain, onFrame };
}
