import type { UsageBoard, UsageBoardEvent, UsageBoardSample } from "./usage-board";

const FINE_CAP = 288;
const COARSE_CAP = 168;
const EVENT_CAP = 64;
const READ_LIMIT_MS = 10_000;

/** A Main save in flight. The check stays on `from`; `after` is the read count when the POST resolved, null while posting. */
export type MainPending = { target: string; from: string | null; after: number | null };
export type UsageBoardState = {
  board: UsageBoard | null;
  status: "loading" | "ready" | "error";
  pending: Readonly<Record<string, MainPending>>;
  failed: ReadonlySet<string>;
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

export function createUsageBoardClient(
  read: (cursor: string | null, signal: AbortSignal) => Promise<UsageBoard>,
  saveMain: (accountId: string) => Promise<unknown>,
) {
  let state: UsageBoardState = { board: null, status: "loading", pending: {}, failed: new Set() };
  const listeners = new Set<() => void>();
  let inFlight = false;
  let dirty = false;
  let wanted = true;
  let started = 0;
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
    const controller = new AbortController();
    // A stalled read frees the gate after 10 s and counts as failed; whatever it returns later is ignored.
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(limit);
      inFlight = false;
      return true;
    };
    const next = () => { if (dirty) { dirty = false; load(); } };
    const limit = setTimeout(() => { if (!settle()) return; controller.abort(); set({ status: "error" }); next(); }, READ_LIMIT_MS);
    read(state.board?.cursor ?? null, controller.signal).then((reply) => {
      if (settled) return;
      // Anything that is not a board (an old host's fallback page, a stray body) is a failed read.
      if (reply?.version !== 1 || !Array.isArray(reply.engines)) throw new Error("not a usage board");
      const board = mergeBoard(state.board, reply) ?? state.board!;
      set({ board, status: "ready", pending: settlePending(ticket) });
    }).catch(() => { if (!settled) set({ status: "error" }); }).finally(() => { if (settle()) next(); });
  };

  const onFocus = () => load();
  const onVisible = () => { if (document.visibilityState === "visible") load(); };

  return {
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
      }, () => {
        const pending = { ...state.pending };
        delete pending[engine];
        set({ pending, failed: new Set(state.failed).add(engine) });
      });
    },
  };
}

type Api = (path: string, init?: RequestInit) => Promise<UsageBoard>;
let connected: Api | null = null;
/** The board hook hands over the store's api(). store.tsx imports this module for live frames, so this module never imports the store. */
export function connectUsageBoard(api: Api) { connected = api; }
const api: Api = (path, init) => connected ? connected(path, init) : Promise.reject(new Error("usage board not connected"));
const client = createUsageBoardClient(
  (cursor, signal) => api(cursor === null ? "/api/usage/board" : `/api/usage/board?cursor=${encodeURIComponent(cursor)}`, { signal }),
  (accountId) => api(`/api/accounts/${encodeURIComponent(accountId)}/default`, { method: "POST", body: "{}" }),
);

export const subscribeUsageBoard = client.subscribe;
export const usageBoardState = client.snapshot;
export const usageBoardFrame = client.frame;
export const usageBoardReconnected = client.invalidate;
export const invalidateUsageBoard = client.invalidate;
export const requestMain = client.requestMain;

/** Where the check sits: the committed Main, held on the old one while a save waits for its confirming read. */
export function checkedMain(state: UsageBoardState, engine: string): string | null {
  return state.pending[engine]?.from ?? state.board?.engines.find((each) => each.base === engine)?.mainId ?? null;
}
