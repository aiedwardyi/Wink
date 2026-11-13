import { terminalReadGrant } from "./terminal-grant.ts";
import type { TerminalBridgeAccess } from "./terminal-snapshot.ts";

export function watchMapPanes(access: TerminalBridgeAccess | null, botId: string, listener: () => void, disconnected?: () => void) {
  const abort = new AbortController();
  if (access) void (async () => {
    try {
      const response = await fetch(`${access.url}/v1/bots/${encodeURIComponent(botId)}/terminal/map-events`, {
        headers: { authorization: `Bearer ${terminalReadGrant(access.token, botId)}` }, redirect: "error", signal: abort.signal,
      });
      if (!response.ok || !response.body) return;
      for await (const chunk of response.body) {
        if (abort.signal.aborted) return;
        if (chunk.length) listener();
      }
      if (!abort.signal.aborted) disconnected?.();
    } catch { if (!abort.signal.aborted) disconnected?.(); }
  })();
  return () => abort.abort();
}
