const SLICE_MS = 8;
const PIECE = 16 * 1024;
const RETRY_MS = 30_000;
const UNKNOWN_BOT_MS = 10 * 60_000;
const REPLAY_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
const paneName = (run) => `${run.label ? `${run.label} ` : ""}[pane ${run.id.slice(0, 8)}]`;

function* pieces(text, size) {
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end--;
    yield text.slice(start, end);
    start = end;
  }
}

/** Hands kept panes' old output on in slices of 8 ms or less, one queue for every pane, so taking back 20 panes never freezes the app. */
export function createReplayPacer({ sliceMs = SLICE_MS, clock = () => performance.now(), defer = setImmediate } = {}) {
  let queue = [];
  let head = 0;
  let scheduled = false;
  const drain = () => {
    const began = clock();
    while (head < queue.length) {
      const run = queue[head];
      queue[head++] = undefined;
      try { run(); } catch (error) { queueMicrotask(() => { throw error; }); }
      if (clock() - began >= sliceMs) break;
    }
    if (head < queue.length) return void defer(drain);
    queue = [];
    head = 0;
    scheduled = false;
  };
  const push = (run) => {
    queue.push(run);
    if (scheduled) return;
    scheduled = true;
    defer(drain);
  };
  return {
    /** Wraps what the client's `attach()` returned. Once the old output is in, live output goes straight through again. */
    wrap({ pty, replayed }) {
      let pacing = true;
      let pending = 0;
      const hand = (run) => {
        if (!pacing && !pending) return run();
        pending++;
        push(() => {
          pending--;
          run();
        });
      };
      const paced = Object.create(pty, {
        onData: { value: (listener) => pty.onData((text) => { for (const piece of pieces(text, pacing ? PIECE : Infinity)) hand(() => listener(piece)); }) },
        onExit: { value: (listener) => pty.onExit((event) => hand(() => listener(event))) },
        onError: { value: (listener) => pty.onError((error) => hand(() => listener(error))) },
      });
      return { pty: paced, replayed: replayed.then(() => new Promise((resolve) => push(() => { pacing = false; resolve(); }))) };
    },
  };
}

/** The lines a bot reads about the panes the worker host held on to for it. */
export function keptNoteText({ running = [], finished = [], unreachable = [] }) {
  const lines = [];
  if (running.length) lines.push(`KEPT RUNNING: ${running.map((run) => `${paneName(run)} (${run.engine ?? "script"}) still ${run.engine ? "working" : "running"}`).join("; ")}.`);
  if (finished.length) lines.push(`FINISHED WHILE WINK WAS DOWN: ${finished.map(({ run, reported, exitCode }) => `${paneName(run)} ${reported ? "reported (report above)" : `${exitCode === null ? "command ended" : `exit ${exitCode}`}, no report: read it, then close it`}`).join("; ")}.`);
  if (unreachable.length) lines.push(`WORKERS UNAVAILABLE: Wink cannot reach its background worker host, so it cannot tell whether these panes still run: ${unreachable.map(paneName).join("; ")}. It does not restart them, and checks again every ${RETRY_MS / 1000} s.`);
  return lines.join("\n");
}

/**
 * Takes back the panes a worker host kept through a quit, an update or a crash, then lets `recover` restart only the ones really gone.
 * A host this app cannot reach blocks both: its panes are neither stopped nor started a second time.
 */
export async function adoptWorkers({ client, runs, host, mailbox = async () => null, botNames = async () => null, recover = async () => {}, warn = () => {}, pacer = createReplayPacer(), wait = sleep, retryMs = RETRY_MS, unknownBotMs = UNKNOWN_BOT_MS, replayMs = REPLAY_MS }) {
  const records = new Map(runs.left().map((run) => [run.id, run]));
  const groups = new Map();
  const group = (run) => {
    if (!groups.has(run.botId)) groups.set(run.botId, { pane: run, running: [], finished: [], unreachable: [], close: [] });
    return groups.get(run.botId);
  };
  const report = async () => {
    const kept = new Map([...groups].map(([botId, { pane, close, ...lists }]) => [botId, {
      pane,
      text: keptNoteText({ ...lists, running: lists.running.sort((a, b) => a.spawnedAt - b.spawnedAt), finished: lists.finished.sort((a, b) => a.run.spawnedAt - b.run.spawnedAt) }),
      delivered: () => { for (const id of close) void Promise.resolve().then(() => host.closeForBot(botId, id)).catch(() => {}); },
    }]));
    groups.clear();
    await recover(kept);
  };
  // Listeners go on in the same tick as `attach()`: the host sends the old output right behind its reply.
  const take = (run, pane, mail) => {
    const attached = client.attach(pane.id, 0);
    const outcome = attached && host.adoptPane(run, pane, pacer.wrap(attached), mail);
    if (!outcome) {
      attached?.pty.detach();
      runs.held(run.id);
      warn(`worker host pane ${run.id.slice(0, 8)} not taken back`);
      return null;
    }
    return Promise.race([outcome, wait(replayMs).then(() => "late")]).then((result) => {
      if (result === "late" || !result) {
        runs.held(run.id);
        return warn(`worker host pane ${run.id.slice(0, 8)} did not finish its replay`);
      }
      const finished = result.exitCode !== null || !result.running || (result.reported && !result.busy);
      if (!finished) return group(run).running.push(run);
      group(run).finished.push({ run, reported: result.reported, exitCode: result.exitCode });
      if (result.reported) group(run).close.push(run.id);
    });
  };
  const adopt = async (panes) => {
    const [mail, names] = await Promise.all([Promise.resolve().then(mailbox).catch(() => null), Promise.resolve().then(botNames).catch(() => null)]);
    const strangers = [];
    const taken = [];
    for (const pane of panes) {
      const run = records.get(pane.id);
      records.delete(pane.id);
      // A pane with no record belongs to nobody: it never becomes a row.
      if (!run) client.drop(pane.id);
      else if (names && !Object.hasOwn(names, run.botId)) {
        runs.held(run.id);
        strangers.push([run, pane]);
      } else taken.push(take(run, pane, mail));
    }
    await Promise.all(taken);
    // The bot list may still be loading, so an unknown owner gets one more look before its pane is stopped.
    if (strangers.length) void wait(unknownBotMs).then(async () => {
      const [mail, names] = await Promise.all([Promise.resolve().then(mailbox).catch(() => null), Promise.resolve().then(botNames).catch(() => null)]);
      await Promise.all(strangers.map(([run, pane]) => {
        if (!names || Object.hasOwn(names, run.botId)) return take(run, pane, mail);
        client.drop(run.id);
        return runs.closed(run.id);
      }));
      if (groups.size) await report();
    }).catch(warn);
  };
  for (let told = false; ; await wait(retryMs)) {
    const left = client.left();
    const panes = left === "none" ? [] : left === "kept" && await client.prewarm() ? await client.panes().catch(() => null) : null;
    if (!panes && records.size) {
      // No adopt, no stop and no restart while the host cannot be asked.
      for (const run of records.values()) runs.held(run.id);
      if (told) continue;
      told = true;
      warn(`worker host unreachable (${client.state().fault?.detail ?? left}): its panes are left alone`);
      for (const run of records.values()) group(run).unreachable.push(run);
      void report().catch(warn);
      continue;
    }
    if (!panes) return report();
    if (left === "none") void client.prewarm();
    await adopt(panes);
    // What no host holds any more takes the restart path, or is over if its run had ended.
    for (const run of records.values()) {
      runs.released(run.id);
      if (run.state !== "running") runs.closed(run.id);
    }
    return report();
  }
}
