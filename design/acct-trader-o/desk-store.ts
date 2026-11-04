// A tiny live store for the prototype. The build keeps this state in the real
// store: windows from the existing instances frames, samples from the new
// capped sample store, switches from the account-switch policy file.
import { useEffect, useReducer, useSyncExternalStore } from "react";
import {
  ACCOUNTS, CODEX_NEXT_MORNING, ENGINES, HOUR, IN_USE, MAIN, NEXT_MORNING, NOW, SWITCHES,
  type EngineId, type FxAccount, type FxSwitch, type Kind,
} from "./fixtures";
import { MINUTES, samplesFrom, type Sample, type Win } from "./pace";

export type Account = FxAccount & { wins: Win[] };

type State = {
  accounts: Account[];
  inUse: Record<EngineId, string>;
  main: Record<EngineId, string>;
  pinned: Record<EngineId, boolean>;
  pending: string | null;
  switches: FxSwitch[];
  focus: EngineId;
  chip: Record<string, Kind | undefined>;
  quickOpen: boolean;
  /** The last automatic move per engine: shown once as a quiet line. */
  note: Partial<Record<EngineId, FxSwitch>>;
  lapsing: boolean;
};

const build = (): Account[] =>
  ACCOUNTS.map((account, i) => ({
    ...account,
    wins: account.windows.map((w, j) => ({
      kind: w.kind,
      minutes: MINUTES[w.kind],
      resetsAt: w.resetsAt,
      samples: samplesFrom(w.keys, i * 7 + j + 1),
    })),
  }));

let state: State = {
  accounts: build(),
  inUse: { ...IN_USE },
  main: { ...MAIN },
  pinned: { claude: false, codex: false, grok: false, gemini: false },
  pending: null,
  switches: [...SWITCHES],
  focus: "claude",
  chip: {},
  quickOpen: false,
  note: { claude: SWITCHES[0] },
  lapsing: false,
};

const listeners = new Set<() => void>();
const emit = (next: Partial<State> = {}) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// Clock. Inside the harness Date is pinned near NOW; anywhere else the desk runs its own clock from NOW.
const loadedAt = Date.now();
const anchored = Math.abs(loadedAt - NOW) > 12 * HOUR;
let offset = 0;
let lapse: { from: number; to: number; started: number; ms: number } | null = null;
const loadStart = performance.now();
const base = () => (anchored ? NOW + (performance.now() - loadStart) : Date.now());
const ease = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

export function deskNow(): number {
  if (lapse) {
    const p = Math.min(1, (performance.now() - lapse.started) / lapse.ms);
    return lapse.from + (lapse.to - lapse.from) * ease(p);
  }
  return base() + offset;
}

export function useDesk(): State {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Re-render every `ms` (the second hand); paused under reduced motion is fine, values still update. */
export function useTick(ms = 1000): number {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const id = setInterval(bump, ms);
    return () => clearInterval(id);
  }, [ms]);
  return deskNow();
}

export const accountById = (id: string) => state.accounts.find((a) => a.id === id);
export const accountsOf = (s: State, engine: EngineId) => s.accounts.filter((a) => a.engine === engine).sort((a, b) => a.n - b.n);
export const engineName = (engine: EngineId) => ENGINES.find((e) => e.id === engine)!.name;
export const label = (a: Pick<FxAccount, "engine" | "n" | "nickname">) => a.nickname ?? `${engineName(a.engine)} ${a.n}`;

// Actions.
export function focusEngine(engine: EngineId) {
  emit({ focus: engine });
}
export function pickChip(accountId: string, kind: Kind) {
  emit({ chip: { ...state.chip, [accountId]: kind } });
}
export function openQuick(open: boolean) {
  emit({ quickOpen: open });
}

/** One tap: the engine's new work moves to this account. Pending until the server confirms. */
export function use(engine: EngineId, id: string, confirmMs = 260) {
  if (state.pending || state.inUse[engine] === id) return;
  const from = accountById(state.inUse[engine])!.n;
  emit({ pending: id });
  setTimeout(() => {
    const move: FxSwitch = { engine, at: deskNow(), from, to: accountById(id)!.n, by: "you" };
    emit({
      pending: null,
      inUse: { ...state.inUse, [engine]: id },
      main: { ...state.main, [engine]: id },
      note: { ...state.note, [engine]: undefined },
      switches: [...state.switches, move],
    });
  }, confirmMs);
}

export function togglePin(engine: EngineId) {
  const pinned = !state.pinned[engine];
  emit({
    pinned: { ...state.pinned, [engine]: pinned },
    ...(pinned ? { main: { ...state.main, [engine]: state.inUse[engine] }, note: { ...state.note, [engine]: undefined } } : {}),
  });
}

/** A new engine report lands for one window. */
export function report(id: string, kind: Kind, used: number) {
  const account = accountById(id);
  const win = account?.wins.find((w) => w.kind === kind);
  if (!account || !win) return;
  const sample: Sample = { t: deskNow(), used };
  emit({
    accounts: state.accounts.map((a) =>
      a !== account ? a : { ...a, wins: a.wins.map((w) => (w !== win ? w : { ...w, samples: [...w.samples, sample] })) },
    ),
  });
}

/** Clip only: run the clock forward to the next morning; Codex 1 burns down and Wink moves Codex to 2. */
export function nextMorning(ms = 2400) {
  const codex = accountById("codex")!;
  const week = codex.wins[0]!;
  const future = samplesFrom(CODEX_NEXT_MORNING, 99).filter((s) => s.t > week.samples.at(-1)!.t);
  const past = week.samples;
  lapse = { from: deskNow(), to: NEXT_MORNING, started: performance.now(), ms };
  emit({ lapsing: true });
  const frame = () => {
    const now = deskNow();
    const shown = future.filter((s) => s.t <= now);
    emit({
      accounts: state.accounts.map((a) => (a.id !== "codex" ? a : { ...a, wins: [{ ...week, samples: [...past, ...shown] }] })),
    });
    if (now < NEXT_MORNING) {
      requestAnimationFrame(frame);
      return;
    }
    offset = NEXT_MORNING - base();
    lapse = null;
    const move: FxSwitch = { engine: "codex", at: NEXT_MORNING, from: 1, to: 2, by: "auto" };
    setTimeout(() => {
      emit({
        lapsing: false,
        inUse: { ...state.inUse, codex: "acct_x2" },
        note: { ...state.note, codex: move },
        switches: [...state.switches, move],
      });
    }, 380);
  };
  requestAnimationFrame(frame);
}

declare global {
  interface Window {
    __desk?: Record<string, unknown>;
  }
}
if (typeof window !== "undefined") {
  window.__desk = { report, use, focusEngine, pickChip, openQuick, nextMorning, togglePin, state: () => state, now: deskNow };
}

// Alt+U: the first press opens the quick view by the chat; a second press opens all usage,
// which is today's Alt+U (App.tsx keeps handling it). Capture phase, ahead of App's listener.
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (event) => {
    if (event.repeat || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== "KeyU") return;
    if (state.quickOpen) {
      emit({ quickOpen: false });
      return;
    }
    if (document.querySelector('[aria-modal="true"]') || !document.querySelector("[data-desk-ticker]")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    emit({ quickOpen: true });
  }, true);
}
