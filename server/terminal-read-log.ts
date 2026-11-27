import type { ServerResponse } from "node:http";

// One server.log line per phone or web terminal read: when it arrived, whether the relay carried it, how long the answer took, its size and its status.
// The bot id only; never terminal text, tokens or headers.
export const TERMINAL_READ_SLOW_MS = 1_000;
// An open terminal polls about once a second and server.log never rotates, so quick good reads log once per bot per this long.
export const TERMINAL_READ_QUIET_MS = 10_000;

const lastLogged = new Map<string, number>();

/** `started` is performance.now() when the request reached the server, before any sign-in check. */
export function traceTerminalRead(
  botId: string,
  relay: boolean,
  started: number,
  res: Pick<ServerResponse, "once" | "statusCode" | "writableFinished" | "socket">,
  log: (line: string) => void = console.log,
) {
  const arrived = Date.now() - (performance.now() - started);
  const socket = res.socket;
  const sent = socket?.bytesWritten ?? 0;
  res.once("close", () => {
    const ms = Math.round(performance.now() - started);
    const answered = res.writableFinished;
    const healthy = answered && res.statusCode < 400 && ms < TERMINAL_READ_SLOW_MS;
    const last = lastLogged.get(botId);
    if (healthy && last !== undefined && arrived - last < TERMINAL_READ_QUIET_MS) return;
    lastLogged.set(botId, Math.max(arrived, last ?? arrived));
    const bytes = Math.max(0, (socket?.bytesWritten ?? 0) - sent);
    log(`terminal read: bot=${botId} via=${relay ? "relay" : "local"} arrived=${new Date(arrived).toISOString()} ms=${ms} bytes=${bytes} status=${answered ? res.statusCode : "aborted"}`);
  });
}
