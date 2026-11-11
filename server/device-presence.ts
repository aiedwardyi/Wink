import type { DeviceListItem } from "./device-sync.ts";

const CACHE_MS = 2_000;
const TIMEOUT_MS = 1_500;
const TAILNET_HOST = /^[a-z0-9-]+\.([a-z0-9-]+\.ts\.net)$/;

export function createDevicePresence(request: typeof fetch = fetch, now: () => number = Date.now) {
  const peers = new Map<string, { online?: boolean; at: number; pending: boolean }>();
  let active = 0;
  const queue: (() => Promise<void>)[] = [];
  const drain = () => {
    while (active < 4 && queue.length) {
      active += 1;
      void queue.shift()!().finally(() => { active -= 1; drain(); });
    }
  };
  return (items: DeviceListItem[], localHost: string | undefined, localChecking = false): DeviceListItem[] => {
    const tailnet = TAILNET_HOST.exec(localHost ?? "")?.[1];
    const hosts = new Set(items.map((item) => item.host));
    for (const host of peers.keys()) if (!hosts.has(host)) peers.delete(host);
    return items.map((item) => {
      if (item.current) return { ...item, offline: false, checking: false };
      // The picker polls while open; a later call probes once the local tailnet is known.
      if (!tailnet && localChecking && TAILNET_HOST.test(item.host)) return { ...item, offline: false, checking: true };
      if (!tailnet || TAILNET_HOST.exec(item.host)?.[1] !== tailnet) return item;
      let peer = peers.get(item.host);
      if (!peer) {
        peer = { at: 0, pending: false };
        peers.set(item.host, peer);
      }
      const state = peer;
      if (!state.pending && (state.online === undefined || now() - state.at >= CACHE_MS)) {
        state.pending = true;
        queue.push(async () => {
          try {
            const response = await request(`https://${item.host}/api/health`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
            const body = await response.json() as { app?: unknown } | null;
            state.online = response.ok && body?.app === "openmausbot";
          } catch {
            state.online = false;
          } finally {
            state.at = now();
            state.pending = false;
          }
        });
        drain();
      }
      // Live Wink health wins over a Drive record that has not caught up yet.
      return { ...item, checking: state.online === undefined, offline: state.online === false };
    });
  };
}
