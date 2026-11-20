import { useEffect, useRef, useSyncExternalStore } from "react";
import { accountReady } from "@/lib/accounts";
import { usageIdentity } from "../../shared/usage-identity";
import type { UsageBoard } from "@/lib/usage-board";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { localUsageObservation } from "@/state/usage-instances";

const MANUAL_DRIVERS = ["claudeAgent", "codex", "grokAgent", "antigravityAgent", "museAgent"];

const AUTO_REFRESH_MS = 5 * 60_000;
const OPEN_REFRESH_MS = 30_000;
// A failed or empty attempt waits at least this long, or until the server's retryAt.
const AUTO_RETRY_MS = 60_000;
// Above the server's serialized Claude account reads (15 s each).
const REFRESH_TIMEOUT_MS = 120_000;
// Subscription engines with a documented usage surface answer a refresh POST.
// Muse limits arrive only inside a model reply, so Muse never refreshes by itself.
const REFRESH_DRIVERS = new Set(["claudeAgent", "codex", "grokAgent"]);
export const canRefresh = (instance: InstanceInfo) => REFRESH_DRIVERS.has(instance.driverKind)
  && instance.canRefreshUsage !== false;
export const refreshReady = (instance: InstanceInfo) => instance.snapshot.authenticated !== false
  && (!instance.accountState || accountReady(instance));
// The open quick view also refreshes what the Refresh button does: Muse, and Gemini once the board shows it.
const refreshable = (instance: InstanceInfo, board?: UsageBoard | null) => canRefresh(instance) || Boolean(board && instance.canRefreshUsage !== false
  && (instance.driverKind === "museAgent" || (instance.driverKind === "antigravityAgent"
    && board.engines.some((engine) => engine.accounts.some((account) => account.id === instance.instanceId)))));
const eligible = (instance: InstanceInfo, board?: UsageBoard | null) => refreshable(instance, board) && refreshReady(instance)
  && (instance.snapshot.state === "available" || Boolean(instance.rateLimits));

const pending = new Map<string, Promise<any>>();
const manual = new Map<string, Promise<any>>();
const retryAfter = new Map<string, { identity: ReturnType<typeof usageIdentity>; at: number }>();
let manualIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const announce = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useRefreshPending = () => useSyncExternalStore(subscribe, () => manualIds, () => manualIds);

function joinRefresh(instanceId: string, start: (signal: AbortSignal) => Promise<any>): Promise<any> {
  const running = pending.get(instanceId);
  if (running) return running;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Refresh timed out");
      reject(error);
      controller.abort(error);
    }, REFRESH_TIMEOUT_MS);
  });
  const work = start(controller.signal);
  const call = Promise.race([work, deadline]);
  // Keep the slot until the request settles, even if a caller times out first.
  const settle = () => {
    clearTimeout(timer);
    pending.delete(instanceId);
    announce();
  };
  void work.then(settle, settle);
  pending.set(instanceId, call);
  return call;
}

function joinManualRefresh(instanceId: string, start: () => Promise<any>): Promise<any> {
  const running = manual.get(instanceId);
  if (running) return running;
  const changed = () => { manualIds = new Set(manual.keys()); announce(); };
  const call = start().finally(() => { manual.delete(instanceId); changed(); });
  manual.set(instanceId, call);
  changed();
  return call;
}

/** The Refresh button: forces every listed account (default all), ignoring reading age. */
export async function refreshUsage(instances: InstanceInfo[], board: UsageBoard, dispatch: ReturnType<typeof useStore>["dispatch"],
  only?: ReadonlySet<string>): Promise<{ failed: boolean; museAuthFailed: boolean }> {
  let museAuthFailed = false;
  const results = await Promise.allSettled(instances.filter((each) => each.canRefreshUsage !== false && refreshReady(each)
    && (!only || only.has(each.instanceId))
    && MANUAL_DRIVERS.includes(each.driverKind)
    && (each.driverKind !== "antigravityAgent" || board.engines.some((engine) => engine.accounts.some((account) => account.id === each.instanceId))))
    .map(async (each) => {
      const { instanceId } = each;
      const result = await joinManualRefresh(instanceId, async () => {
        let outcome = await joinRefresh(instanceId, (signal) => api(`/api/usage/refresh/${instanceId}?fresh=1`, { method: "POST", signal }));
        if (each.driverKind === "museAgent" && outcome.status === "no_observation" && !outcome.error) {
          outcome = await joinRefresh(instanceId, (signal) => api(`/api/usage/check/${instanceId}`, { method: "POST", signal }));
        }
        if (outcome.report) dispatch({ type: "rateLimits", instanceId, report: outcome.report, identity: usageIdentity(each.snapshot) });
        return outcome;
      });
      if (each.driverKind === "museAgent" && result.status === "auth_error") museAuthFailed = true;
      if (result.error) throw new Error("refresh");
    }));
  return { failed: results.some((each) => each.status === "rejected"), museAuthFailed };
}

/** Alt+R runs `refresh` while its view is mounted; null (busy or shut) ignores it. */
export function useRefreshKey(refresh: (() => void) | null) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || event.code !== "KeyR" || !latest.current) return;
      event.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
}

const refreshAt = (instance: InstanceInfo, maxAge: number) => {
  const observed = instance.rateLimits ? localUsageObservation(instance.rateLimits) : -Infinity;
  const retry = retryAfter.get(instance.instanceId);
  return Math.max(observed + maxAge, retry && retry.identity === usageIdentity(instance.snapshot) ? retry.at : 0);
};

export function useAutoRefresh(board?: UsageBoard | null, surface?: "desk" | "quick") {
  const { state, dispatch } = useStore();
  const latest = useRef({ instances: state.instances, dispatch });
  latest.current = { instances: state.instances, dispatch };
  useEffect(() => {
    if (!surface) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const live = (instance: InstanceInfo) => instance.driverKind !== "museAgent";
    const maxAge = (instance: InstanceInfo) => live(instance) ? OPEN_REFRESH_MS : AUTO_REFRESH_MS;
    const candidates = () => latest.current.instances.filter((instance) => (surface === "quick" || live(instance))
      && eligible(instance, board) && !pending.has(instance.instanceId) && !manual.has(instance.instanceId));
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      const next = candidates().filter(live).reduce((at, instance) => Math.min(at, refreshAt(instance, OPEN_REFRESH_MS)), Infinity);
      if (Number.isFinite(next)) timer = setTimeout(run, Math.max(0, Math.ceil(next - performance.now())));
    };
    const run = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      const now = performance.now();
      for (const instance of candidates().filter((each) => refreshAt(each, maxAge(each)) <= now)) {
        const { instanceId, snapshot } = instance;
        const identity = usageIdentity(snapshot);
        const current = () => latest.current.instances.some((each) => each.instanceId === instanceId && usageIdentity(each.snapshot) === identity);
        const defer = (at: number) => retryAfter.set(instanceId, { identity, at });
        const cooldown = (retryInMs = 0) => defer(performance.now() + Math.max(retryInMs, AUTO_RETRY_MS));
        joinRefresh(instanceId, (signal) => api(`/api/usage/refresh/${instanceId}`, { method: "POST", signal }).then((result) => {
          if (!current()) return result;
          const received = performance.now();
          const age = maxAge(instance);
          const due = result.report ? localUsageObservation(result.report, result.status === "retained" ? Infinity : 0) + age : 0;
          if (result.error || result.status === "no_observation" || due <= received) cooldown(result.retryInMs);
          else defer(due);
          if (result.report) latest.current.dispatch({ type: "rateLimits", instanceId, report: result.report, identity });
          return result;
        }, (error) => { if (current()) cooldown(); throw error; })).catch(() => { if (current()) cooldown(); });
      }
      schedule();
    };
    const stop = subscribe(schedule);
    run();
    document.addEventListener("visibilitychange", run);
    return () => {
      stop();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [state.instances, board, surface]);
}
