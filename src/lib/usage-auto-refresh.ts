import { useEffect, useRef, useSyncExternalStore } from "react";
import { accountReady } from "@/lib/accounts";
import { usageIdentity } from "../../shared/usage-identity";
import type { UsageBoard } from "@/lib/usage-board";
import { api, useStore, type InstanceInfo } from "@/state/store";

const MANUAL_DRIVERS = ["claudeAgent", "codex", "grokAgent", "antigravityAgent", "museAgent"];

export const AUTO_REFRESH_MS = 5 * 60_000;
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
const refreshable = (instance: InstanceInfo, board?: UsageBoard) => canRefresh(instance) || Boolean(board && instance.canRefreshUsage !== false
  && (instance.driverKind === "museAgent" || (instance.driverKind === "antigravityAgent"
    && board.engines.some((engine) => engine.accounts.some((account) => account.id === instance.instanceId)))));
const eligible = (instance: InstanceInfo, board?: UsageBoard) => refreshable(instance, board) && refreshReady(instance)
  && (instance.snapshot.state === "available" || Boolean(instance.rateLimits));

const pending = new Map<string, Promise<any>>();
const retryAfter = new Map<string, number>();
let pendingIds: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const announce = () => {
  pendingIds = new Set(pending.keys());
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The accounts with a refresh running, whether automatic, Refresh All or Alt+R. */
export const useRefreshPending = () => useSyncExternalStore(subscribe, () => pendingIds, () => pendingIds);

/** One refresh per account at a time: every caller joins the running one, and a hung request is let go after a deadline. */
export function joinRefresh(instanceId: string, start: () => Promise<any>): Promise<any> {
  const running = pending.get(instanceId);
  if (running) return running;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Refresh timed out")), REFRESH_TIMEOUT_MS); });
  const call = Promise.race([start(), deadline]).finally(() => {
    clearTimeout(timer);
    pending.delete(instanceId);
    announce();
  });
  pending.set(instanceId, call);
  announce();
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
    .map((each) => joinRefresh(each.instanceId, async () => {
      let result = await api(`/api/usage/refresh/${each.instanceId}`, { method: "POST" });
      if (each.driverKind === "museAgent" && result.status === "no_observation" && !result.error) {
        result = await api(`/api/usage/check/${each.instanceId}`, { method: "POST" });
      }
      if (result.report) dispatch({ type: "rateLimits", instanceId: each.instanceId, report: result.report, identity: usageIdentity(each.snapshot) });
      if (each.driverKind === "museAgent" && result.status === "auth_error") museAuthFailed = true;
      if (result.error) throw new Error("refresh");
      return result;
    })));
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

export function staleAccounts(instances: InstanceInfo[], now = Date.now(), board?: UsageBoard): InstanceInfo[] {
  return instances.filter((instance) => eligible(instance, board)
    && !pending.has(instance.instanceId)
    && (retryAfter.get(instance.instanceId) ?? 0) <= now
    && !(instance.rateLimits && now - Date.parse(instance.rateLimits.observedAt) <= AUTO_REFRESH_MS));
}

/** Refreshes every account whose reading is older than 5 minutes when it mounts, when account data
 * changes, and when the tab returns. Pending, fresh and cooling-down accounts are skipped; a failure keeps the old reading. */
export function useAutoRefresh(board?: UsageBoard) {
  const { state, dispatch } = useStore();
  const latest = useRef({ instances: state.instances, dispatch, board });
  latest.current = { instances: state.instances, dispatch, board };
  useEffect(() => {
    const run = () => {
      if (document.visibilityState === "hidden") return;
      for (const { instanceId, snapshot } of staleAccounts(latest.current.instances, Date.now(), latest.current.board)) {
        const current = () => usageIdentity(latest.current.instances.find((instance) => instance.instanceId === instanceId)?.snapshot ?? {}) === usageIdentity(snapshot);
        const cooldown = (retryAt = 0) => retryAfter.set(instanceId, Math.max(retryAt, Date.now() + AUTO_RETRY_MS));
        joinRefresh(instanceId, () => api(`/api/usage/refresh/${instanceId}`, { method: "POST" }).then((result) => {
          if (!current()) return result;
          if (result.report) latest.current.dispatch({ type: "rateLimits", instanceId, report: result.report });
          if (!result.report || result.error || result.status === "retained" || result.status === "no_observation") cooldown(result.retryAt);
          return result;
        }, (error) => { if (current()) cooldown(); throw error; })).catch(() => { if (current()) cooldown(); });
      }
    };
    run();
    document.addEventListener("visibilitychange", run);
    return () => document.removeEventListener("visibilitychange", run);
  }, [state.instances]);
}
