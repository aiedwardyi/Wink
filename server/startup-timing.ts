export function createStartupTiming(options: {
  now?: () => number;
  write?: (line: string) => void;
  fallbackMs?: number;
  main?: Record<string, number>;
} = {}) {
  const now = options.now ?? (() => process.uptime() * 1000);
  const write = options.write ?? console.log;
  const spans: Record<string, number> = { ...options.main };
  const tasks = new Map<string, Promise<unknown>>();
  let release!: () => void;
  const painted = new Promise<void>((resolve) => { release = resolve; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = 0;
  let serving = false;
  let released = false;
  let logged = false;
  let closed = false;
  let errors = 0;
  let replay: ReadonlyArray<readonly [string, number | null]> = [];

  const finish = (force = false) => {
    if ((!serving && !force) || !released || (!force && pending) || logged) return;
    logged = true;
    const values = Object.fromEntries(Object.entries({ ...spans, ...(pending ? { pending, closedAt: now() } : { checksReady: now() }), errors })
      .filter(([, value]) => Number.isFinite(value))
      .map(([key, value]) => [key, Math.round(value)]));
    write(`startup ${JSON.stringify(values)}`);
    if (replay.length) write(`startup replay ${JSON.stringify(replay)}`);
  };
  const mark = (name: string) => { spans[name] = now(); };
  const measure = <T>(name: string, work: () => T): T => {
    const start = now();
    try { return work(); }
    finally { spans[name] = (spans[name] ?? 0) + now() - start; }
  };
  const track = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    pending++;
    const start = now();
    try { return await work(); }
    finally {
      spans[name] = (spans[name] ?? 0) + now() - start;
      pending--;
      finish();
    }
  };
  const paint = (timings?: { firstResponse?: number; chatPaint?: number }) => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    Object.assign(spans, timings);
    mark("paintReceived");
    release();
    queueMicrotask(() => finish());
  };
  return {
    mark,
    measure,
    track,
    paint,
    afterPaint(name: string, work: () => Promise<unknown>): void {
      pending++;
      const task = painted.then(async () => {
        const start = now();
        try { if (!closed) return await work(); }
        catch (error) { errors++; throw error; }
        finally {
          spans[name] = now() - start;
          pending--;
          finish();
        }
      });
      tasks.set(name, task);
      void task.catch(() => console.error(`startup task failed: ${name}`));
    },
    waitFor(name: string): Promise<unknown> {
      return tasks.get(name)?.then(() => {}, () => {}) ?? Promise.resolve();
    },
    beforeRequest(method: string, path: string): Promise<unknown> | undefined {
      if (["GET", "HEAD", "OPTIONS"].includes(method) || ["/api/diag/cold-open", "/api/internal/google-account", "/api/internal/terminal-bridge"].includes(path)) return;
      const waits = ["accounts", "recovery"].flatMap((name) => tasks.get(name) ?? []);
      if (waits.length) return Promise.allSettled(waits);
    },
    /** Requests held during boot, in replay order; null is one still open when the line is written. */
    replayed(routes: typeof replay): void {
      replay = routes;
    },
    close(): void {
      closed = true;
      spans.closed = 1;
      paint();
      finish(true);
    },
    serving(): void {
      serving = true;
      mark("serverReady");
      timer = setTimeout(() => {
        spans.paintTimeout = 1;
        paint();
      }, options.fallbackMs ?? 5_000);
      timer.unref?.();
    },
  };
}

type StartupTiming = ReturnType<typeof createStartupTiming>;
const SLOT = Symbol.for("wink.startupTiming");
const shared = globalThis as typeof globalThis & { [SLOT]?: StartupTiming };
export const startupTiming = shared[SLOT] ??= createStartupTiming({ main: {
  mainWindow: Number(process.env.OMB_STARTUP_WINDOW_MS),
  mainFork: Number(process.env.OMB_STARTUP_FORK_MS),
} });
