import { useLayoutEffect, useSyncExternalStore } from "react";
import { api, useStore } from "@/state/store";
import type { UsageOrderStatus } from "@/state/store-types";

/** Lists by engine base, plus "engines" for the sections. */
export type UsageOrders = Record<string, string[]>;

/** Wink keeps the order, so the desktop app, every phone link and every browser show the one the user set.
 * A browser kept it here before; that copy goes up once and is then removed. */
const LEGACY_KEY = "openmausbot.usageOrder.v1";
const PATH = "/api/usage-order";

let orders: UsageOrders = {};
let shown = "{}";
let writes = 0;
let legacyDone = false;
const watchers = new Set<() => void>();

function show(next: UsageOrders) {
  const text = JSON.stringify(next);
  if (text === shown) return;
  orders = next;
  shown = text;
  watchers.forEach((notify) => notify());
}

function isOrders(value: unknown): value is UsageOrders {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as object).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"));
}

function isStatus(value: unknown): value is UsageOrderStatus {
  return value === null || (Boolean(value) && typeof value === "object" && isOrders((value as { orders?: unknown }).orders));
}

function readLegacy(): UsageOrders | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((id) => typeof id === "string"));
    return entries.length ? Object.fromEntries(entries) : null;
  } catch {
    return null;
  }
}

function dropLegacy() {
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* storage blocked: nothing reads it again this load */ }
}

/** A write in flight holds the shown order, so a config frame from an earlier write cannot flick it back. */
function put(body: object): Promise<{ ok: boolean; status?: UsageOrderStatus }> {
  writes += 1;
  return Promise.resolve()
    .then(() => api(PATH, { method: "PUT", body: JSON.stringify(body) }))
    .then((reply: { usageOrder?: unknown } | undefined) => ({ ok: true, status: isStatus(reply?.usageOrder) ? reply.usageOrder : undefined }), () => ({ ok: false }))
    .finally(() => { writes -= 1; });
}

/** Without a server answer (offline, a failed write) the session keeps the order it shows. */
function land(status: UsageOrderStatus | undefined) {
  if (status !== undefined && !writes) show(status?.orders ?? {});
}

/** The one-time move of this browser's old order. The desktop app's copy is what the user set,
 * so it also replaces an order another browser sent up first. */
function moveLegacy(status: UsageOrderStatus) {
  if (legacyDone) return;
  legacyDone = true;
  const local = readLegacy();
  if (!local) return;
  const from = typeof window !== "undefined" && window.ogb ? "desktop" : "browser";
  if (status && !(status.seed === "browser" && from === "desktop")) {
    dropLegacy();
    return;
  }
  show(local);
  void put({ seed: local, from }).then((result) => {
    if (result.ok) dropLegacy();
    else legacyDone = false;
    land(result.status);
  });
}

/** Takes the server's copy from a config load or frame. */
export function receiveUsageOrder(status: UsageOrderStatus | undefined) {
  if (status === undefined || !isStatus(status)) return;
  land(status);
  moveLegacy(status);
}

export function saveUsageOrder(key: string, order: string[]) {
  show({ ...orders, [key]: order });
  void put({ key, order }).then((result) => land(result.status));
}

/** Tests start each case as a fresh page. */
export function resetUsageOrder() {
  orders = {};
  shown = "{}";
  writes = 0;
  legacyDone = false;
}

function subscribe(notify: () => void) {
  watchers.add(notify);
  return () => { watchers.delete(notify); };
}

/** Feeds the server's copy in; App runs it so the old local order moves up at start. */
export function useUsageOrderSync() {
  const status = useStore().state.config?.usageOrder;
  useLayoutEffect(() => receiveUsageOrder(status), [status]);
}

export function useUsageOrders(): UsageOrders {
  useUsageOrderSync();
  return useSyncExternalStore(subscribe, () => orders, () => orders);
}
