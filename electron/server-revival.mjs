// Packaged-server restart after a good boot: main.mjs forks the server once,
// so a child that dies later would otherwise leave the window on
// "Reconnecting" forever. Extracted so the rules carry tests without Electron.
//
// - Only an exit nobody asked for restarts: quitting stays quiet.
// - One restart at a time; exits during a restart join it.
// - A restarted server that dies again before `settleMs` is not restarted a
//   second time: the window gets the failed page instead of flapping.

/**
 * @param {{
 *   start: () => Promise<boolean>,
 *   show: (state: "restarting" | "ready" | "failed" | "stopped") => void,
 *   quitting: () => boolean,
 *   now?: () => number,
 *   settleMs?: number,
 * }} options
 */
export function createServerRevival({ start, show, quitting, now = Date.now, settleMs = 30_000 }) {
  let reviving = null;
  let revivedAt = null;
  return function revive() {
    if (quitting()) return null;
    if (reviving) return reviving;
    if (revivedAt !== null && now() - revivedAt < settleMs) {
      revivedAt = null;
      show("stopped");
      return null;
    }
    show("restarting");
    reviving = Promise.resolve()
      .then(start)
      .catch(() => false)
      .then((ok) => {
        reviving = null;
        revivedAt = ok ? now() : null;
        if (!quitting()) show(ok ? "ready" : "failed");
        return ok;
      });
    return reviving;
  };
}
