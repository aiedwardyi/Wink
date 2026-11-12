// Anonymous usage stats, desktop shell side: where they go, and the crashes only this process sees.

/** Empty in forks, dev and test builds: nothing is captured or sent. */
export function statsUrl(readBaked) {
  try {
    const value = readBaked();
    if (typeof value?.statsUrl === "string") return value.statsUrl;
  } catch {}
  return "";
}

/** `post` hands events to the local server; null means there is no server to take them yet. */
export function installCrashStats(app, owner, post, uptime = process.uptime) {
  let held = [];
  let posting = false;
  const flush = async () => {
    if (posting || !held.length) return;
    posting = true;
    const events = held;
    held = [];
    let status = null;
    try { status = await post(events); } catch {}
    posting = false;
    if (status === null) held = [...events, ...held].slice(0, 50);
    else void flush();
  };
  const capture = (process, kind, exit) => {
    const seconds = uptime();
    held.push({ e: "crash", process, kind, ...(Number.isInteger(exit) ? { exit } : {}), up: seconds < 60 ? 0 : seconds < 600 ? 1 : seconds < 3600 ? 2 : 3 });
    void flush();
  };
  app.on("render-process-gone", (_event, contents, details) => {
    if (contents === owner() && details.reason !== "clean-exit") capture("renderer", details.reason === "oom" ? "oom" : "renderer-gone", details.exitCode);
  });
  return { capture, flush };
}
