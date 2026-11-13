import type { UsageBoard, UsageBoardEvent, UsageBoardSample } from "./usage-board";
import { usageIdentity } from "../../shared/usage-identity";

const FINE_CAP = 288;
const COARSE_CAP = 168;
const EVENT_CAP = 64;
const READ_LIMIT_MS = 10_000;

/** A Main save in flight. The check stays on `from`; `after` is the read count when the POST resolved, null while posting. */
export type MainPending = { target: string; from: string | null; after: number | null };
/** The reason the server gave for refusing a Main save, per board group. */
export type MainRefusal = { code?: string; bot?: string };
export type UsageBoardState = {
  board: UsageBoard | null;
  status: "loading" | "ready" | "error";
  pending: Readonly<Record<string, MainPending>>;
  failed: ReadonlySet<string>;
  refused?: Readonly<Record<string, MainRefusal>>;
};

function upsertSamples(kept: UsageBoardSample[], changed: UsageBoardSample[], cap: number): UsageBoardSample[] {
  const byMinute = new Map(kept.map((sample) => [sample[0], sample]));
  for (const sample of changed) byMinute.set(sample[0], sample);
  return [...byMinute.values()].sort((a, b) => a[0] - b[0]).slice(-cap);
}

function upsertEvents(kept: UsageBoardEvent[], changed: UsageBoardEvent[]): UsageBoardEvent[] {
  const bySeq = new Map(kept.map((event) => [event.seq, event]));
  for (const event of changed) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-EVENT_CAP);
}

/** Workers and sign-in probes can change without a revision bump. */
function liveWorkers(shown: UsageBoard, reply: UsageBoard): UsageBoard | null {
  let changed = shown.runs !== reply.runs;
  const engines = shown.engines.map((engine) => {
    const latest = reply.engines.find((each) => each.base === engine.base);
    return { ...engine, accounts: engine.accounts.map((account) => {
      const live = latest?.accounts.find((each) => each.id === account.id);
      if (!live || (live.signIn === account.signIn && JSON.stringify(live.workers) === JSON.stringify(account.workers))) return account;
      changed = true;
      return { ...account, signIn: live.signIn, workers: live.workers };
    }) };
  });
  return changed ? { ...shown, runs: reply.runs, engines } : null;
}

/** UI-CONTRACT merge rule: null drops the reply. */
export function mergeBoard(shown: UsageBoard | null, reply: UsageBoard): UsageBoard | null {
  if (shown && reply.revision === shown.revision) return liveWorkers(shown, reply);
  if (shown && reply.revision < shown.revision) return null;
  if (!shown || reply.full) return reply;
  return {
    ...reply,
    engines: reply.engines.map((engine) => {
      const before = shown.engines.find((each) => each.base === engine.base);
      if (!before) return engine;
      return {
        ...engine,
        events: upsertEvents(before.events, engine.events),
        accounts: engine.accounts.map((account) => {
          const old = before.accounts.find((each) => each.id === account.id);
          return old ? { ...account, history: {
            fine: upsertSamples(old.history.fine, account.history.fine, FINE_CAP),
            coarse: upsertSamples(old.history.coarse, account.history.coarse, COARSE_CAP),
          } } : account;
        }),
      };
    }),
  };
}

type UsageBoardCache = { read: () => UsageBoard | null; write: (board: UsageBoard) => void };

export function createUsageBoardClient(
  read: (cursor: string | null, signal: AbortSignal) => Promise<UsageBoard>,
  saveMain: (accountId: string) => Promise<unknown>,
  cache?: UsageBoardCache,
) {
  let state: UsageBoardState = { board: cache?.read() ?? null, status: "loading", pending: {}, failed: new Set() };
  // The last launch's board paints at once; the server's revision may have restarted, so the first read replaces it whole.
  let cached = state.board !== null;
  const listeners = new Set<() => void>();
  let inFlight = false;
  let dirty = false;
  let wanted = true;
  let started = 0;
  let identityEpoch = 0;
  const identities = new Map<string, string | null>();
  const set = (patch: Partial<UsageBoardState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const active = () => listeners.size > 0 && document.visibilityState !== "hidden";

  // The first read started after a save resolved decides it: the target as Main confirms, any other Main ends the wait.
  const settlePending = (ticket: number) => {
    const kept = Object.entries(state.pending).filter(([, wait]) => wait.after === null || ticket <= wait.after);
    return kept.length === Object.keys(state.pending).length ? state.pending : Object.fromEntries(kept);
  };

  const load = () => {
    if (!active()) { wanted = true; return; }
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    wanted = false;
    const ticket = ++started;
    const epoch = identityEpoch;
    const controller = new AbortController();
    // A stalled read frees the gate after 10 s; whatever it returns later is ignored. With no board yet it asks again: a slow boot is not a failure.
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(limit);
      inFlight = false;
      return true;
    };
    const next = () => { if (dirty) { dirty = false; load(); } };
    const limit = setTimeout(() => { if (!settle()) return; controller.abort(); if (state.board) set({ status: "error" }); else dirty = true; next(); }, READ_LIMIT_MS);
    read(cached ? null : state.board?.cursor ?? null, controller.signal).then((reply) => {
      if (settled || epoch !== identityEpoch) return;
      // Anything that is not a board (an old host's fallback page, a stray body) is a failed read.
      if (reply?.version !== 1 || !Array.isArray(reply.engines)) throw new Error("not a usage board");
      const board = mergeBoard(cached ? null : state.board, reply) ?? state.board!;
      cached = false;
      set({ board, status: "ready", pending: settlePending(ticket) });
      cache?.write(board);
    }).catch(() => { if (!settled) set({ status: "error" }); }).finally(() => { if (settle()) next(); });
  };

  const onFocus = () => load();
  const onVisible = () => { if (document.visibilityState === "visible") load(); };

  return {
    instances(instances: Array<{ instanceId: string; snapshot: Parameters<typeof usageIdentity>[0] }>) {
      const changed = new Set<string>();
      for (const instance of instances) {
        const identity = usageIdentity(instance.snapshot);
        if (identity === undefined) continue;
        if (identities.has(instance.instanceId) && identities.get(instance.instanceId) !== identity) changed.add(instance.instanceId);
        identities.set(instance.instanceId, identity);
      }
      if (!changed.size) return;
      identityEpoch++;
      if (state.board) set({ board: { ...state.board, revision: -1, cursor: "", engines: state.board.engines.map((engine) => ({ ...engine,
        events: engine.events.filter((event) => ![event.accountId, event.from, event.to].some((id) => id && changed.has(id))),
        accounts: engine.accounts.map((account) => changed.has(account.id)
          ? { ...account, windows: [], observedAt: null, history: { fine: [], coarse: [] } } : account),
      })) } });
      load();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        window.addEventListener("focus", onFocus);
        document.addEventListener("visibilitychange", onVisible);
      }
      // A read already in flight serves a new subscriber; only a trigger missed while idle asks for another.
      if (inFlight) dirty ||= wanted;
      else if (wanted || !state.board || listeners.size === 1) load();
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        window.removeEventListener("focus", onFocus);
        document.removeEventListener("visibilitychange", onVisible);
      };
    },
    snapshot: () => state,
    frame(revision: number) {
      if (state.board && revision <= state.board.revision) return;
      load();
    },
    invalidate: load,
    /** One save per board group (its `base`): a repeat while one is pending sends nothing. The check moves only on the confirming read. */
    requestMain(engine: string, accountId: string, afterSave?: () => unknown) {
      if (state.pending[engine]) return;
      const failed = new Set(state.failed);
      failed.delete(engine);
      const from = state.board?.engines.find((each) => each.base === engine)?.mainId ?? null;
      set({ pending: { ...state.pending, [engine]: { target: accountId, from, after: null } }, failed });
      saveMain(accountId).then(() => {
        set({ pending: { ...state.pending, [engine]: { target: accountId, from, after: started } } });
        void Promise.resolve(afterSave?.()).catch(() => {});
        if (inFlight) dirty = true;
        else { wanted = true; load(); }
      }, (error: MainRefusal | undefined) => {
        const pending = { ...state.pending };
        delete pending[engine];
        set({ pending, failed: new Set(state.failed).add(engine), refused: { ...state.refused, [engine]: { code: error?.code, bot: error?.bot } } });
      });
    },
  };
}

const BOARD_CACHE_KEY = "omb-usage-board-v1";

/** A private window or blocked site data throws on access; the board then just waits for its read. */
const localBoardCache: UsageBoardCache = {
  read() {
    try {
      // SAFETY: the same check a live read passes; the first read replaces it.
      const board = JSON.parse(localStorage.getItem(BOARD_CACHE_KEY) ?? "null") as UsageBoard | null;
      return board?.version === 1 && Array.isArray(board.engines) ? board : null;
    } catch {
      return null;
    }
  },
  write(board) {
    try { localStorage.setItem(BOARD_CACHE_KEY, JSON.stringify(board)); } catch { /* over quota or blocked */ }
  },
};

type Api = (path: string, init?: RequestInit) => Promise<UsageBoard>;
let connected: Api | null = null;
/** The board hook hands over the store's api(). store.tsx imports this module for live frames, so this module never imports the store. */
export function connectUsageBoard(api: Api) { connected = api; }
const api: Api = (path, init) => connected ? connected(path, init) : Promise.reject(new Error("usage board not connected"));
const client = createUsageBoardClient(
  (cursor, signal) => api(cursor === null ? "/api/usage/board" : `/api/usage/board?cursor=${encodeURIComponent(cursor)}`, { signal }),
  (accountId) => api(`/api/accounts/${encodeURIComponent(accountId)}/default`, { method: "POST", body: "{}" }),
  localBoardCache,
);

export const subscribeUsageBoard = client.subscribe;
export const usageBoardState = client.snapshot;
export const usageBoardFrame = client.frame;
export const usageBoardReconnected = client.invalidate;
export const invalidateUsageBoard = client.invalidate;
export const usageBoardInstances = client.instances;
export const requestMain = client.requestMain;

/** Where the check sits: the committed Main, held on the old one while a save waits for its confirming read. */
export function checkedMain(state: UsageBoardState, engine: string): string | null {
  return state.pending[engine]?.from ?? state.board?.engines.find((each) => each.base === engine)?.mainId ?? null;
}
