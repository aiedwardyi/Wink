import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { request } from "./api-request";

export type TerminalBridge = NonNullable<NonNullable<Window["ogb"]>["terminal"]>;
export type WebTerminalBridge = TerminalBridge & { setVisible(visible: boolean): void };
// done fires once xterm has parsed the chunk; the stream pauses on what is still unparsed.
export type LiveOutput = { id: string; data: string; seq: number; done?: () => void };
type Size = { cols: number; rows: number };
type Waiter = { data: string; resolve: () => void; reject: (cause: unknown) => void };

const DESKTOP_QUERY = "(pointer: fine) and (min-width: 768px)";
const LEASE_MS = 50_000;
const PAUSE_BYTES = 100 * 1024;
const RESUME_BYTES = 10 * 1024;
const RETRY_MS = 1_000;
const PANES_MS = 2_000;
// Under the server's 64 KB input cap even at 3 bytes per char.
const BATCH_CHARS = 16 * 1024;
const WEB_FONTS = '"JetBrains Mono", "Symbols Nerd Font Mono"';

const snapshotSchema = z.object({
  kind: z.literal("snapshot"),
  lease: z.string(),
  sessionId: z.string(),
  generation: z.number(),
  output: z.string(),
  seq: z.number(),
  cols: z.number().optional(),
  rows: z.number().optional(),
  modes: z.array(z.number()).optional(),
  resetModes: z.array(z.number()).optional(),
  exitCode: z.number().nullable(),
});
const frameSchema = z.discriminatedUnion("kind", [
  snapshotSchema,
  z.object({ kind: z.literal("output"), seq: z.number(), data: z.string() }),
  z.object({ kind: z.literal("resize"), cols: z.number(), rows: z.number() }),
  z.object({ kind: z.literal("exit"), exitCode: z.number() }),
  z.object({ kind: z.literal("ping") }),
]);
const errorSchema = z.object({ error: z.string().optional() }).catch({});
type Snapshot = z.infer<typeof snapshotSchema>;
type Frame = z.infer<typeof frameSchema>;

class LiveError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** The bundled mono and icon fonts, ahead of the generic fallback; a browser PC may lack the app's Nerd Fonts. */
export function webTerminalFonts(stack: string): string {
  return stack.replace(/,\s*monospace$/, `, ${WEB_FONTS}, monospace`);
}

let fontsReady: Promise<void> | null = null;
export function loadWebTerminalFonts(): Promise<void> {
  fontsReady ??= Promise.all([
    document.fonts?.load('13px "JetBrains Mono"'),
    document.fonts?.load('13px "Symbols Nerd Font Mono"', ""),
  ]).then(() => {}, () => {});
  return fontsReady;
}

function restoreModes(snapshot: Snapshot): string {
  return [
    ...(snapshot.resetModes ?? []).map((mode) => `\x1b[?${mode}l`),
    ...(snapshot.modes ?? []).filter((mode) => mode !== 47 && mode !== 1047 && mode !== 1049).map((mode) => `\x1b[?${mode}h`),
  ].join("");
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffered += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffered.indexOf("\n\n")) >= 0) {
      const block = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
      if (data) yield data;
    }
  }
}

/** The app terminal pane's bridge for a desktop browser: output over SSE, keys and size over POST, one POST in flight. */
export function createWebTerminalBridge(botId: string): WebTerminalBridge {
  const base = `/api/bots/${encodeURIComponent(botId)}/terminal`;
  const dataListeners = new Set<(event: LiveOutput) => void>();
  const exitListeners = new Set<(event: { id: string; exitCode: number }) => void>();
  const errorListeners = new Set<(event: { id: string; message: string }) => void>();
  const openedListeners = new Set<(event: { id: string; botId: string; label: string | null; generation: number }) => void>();
  const closedListeners = new Set<(event: { id: string; botId: string }) => void>();
  let attached: { sessionId: string; generation: number; seq: number; lease: string; exited: boolean } | null = null;
  let stream: AbortController | null = null;
  let lease: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let paneTimer: ReturnType<typeof setInterval> | undefined;
  let visible = true;
  let paused = false;
  let unparsed = 0;
  let epoch = 0;
  let remote: Size | null = null;
  let wanted: Size | null = null;
  let owner = false;
  let sending = false;
  let writes: Waiter[] = [];
  let panes: Set<string> | null = null;

  const listen = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => { set.delete(cb); };
  };
  const sameSize = (a: Size | null, b: Size | null) => a?.cols === b?.cols && a?.rows === b?.rows;
  const live = () => Boolean(attached && !attached.exited && visible && !paused && document.visibilityState !== "hidden");

  const close = () => {
    clearInterval(lease);
    clearTimeout(retry);
    lease = undefined;
    stream?.abort();
    stream = null;
  };

  const emit = (data: string, seq: number, counted: boolean) => {
    if (!attached) return;
    const mine = epoch;
    let pending = counted;
    if (counted) unparsed += data.length;
    const done = () => {
      if (!pending || mine !== epoch) return;
      pending = false;
      unparsed -= data.length;
      if (paused && unparsed <= RESUME_BYTES) {
        paused = false;
        resume();
      }
    };
    const event = { id: attached.sessionId, data, seq, done };
    for (const cb of dataListeners) cb(event);
    if (!paused && unparsed > PAUSE_BYTES) {
      paused = true;
      close();
    }
  };

  const fail = (message: string) => {
    if (!attached) return;
    const id = attached.sessionId;
    for (const cb of errorListeners) cb({ id, message });
  };

  const exit = (exitCode: number) => {
    if (!attached || attached.exited) return;
    attached.exited = true;
    const id = attached.sessionId;
    close();
    for (const cb of exitListeners) cb({ id, exitCode });
  };

  const onFrame = (frame: Exclude<Frame, Snapshot>) => {
    if (!attached) return;
    if (frame.kind === "output" && frame.seq > attached.seq) {
      attached.seq = frame.seq;
      emit(frame.data, frame.seq, true);
    } else if (frame.kind === "resize") {
      // Our own resize echoes back; any other size means the app or another viewer took it.
      if (!sameSize(frame, remote)) owner = false;
      remote = { cols: frame.cols, rows: frame.rows };
    } else if (frame.kind === "exit") exit(frame.exitCode);
  };

  const renew = (abort: AbortController) => {
    clearInterval(lease);
    lease = setInterval(() => {
      if (!attached || stream !== abort) return;
      void request(`${base}/lease`, { method: "POST", body: JSON.stringify({ lease: attached.lease }) }).catch(() => {
        // The server already dropped this stream; take a fresh one.
        if (stream !== abort) return;
        close();
        resume();
      });
    }, LEASE_MS);
  };

  // Resolves on the snapshot frame, after adopt ran, then keeps reading in the background.
  const connect = (sessionId: string | undefined, adopt: (snapshot: Snapshot) => void): Promise<Snapshot> => {
    close();
    const abort = new AbortController();
    stream = abort;
    const qs = sessionId ? `?${new URLSearchParams({ sessionId })}` : "";
    return new Promise((resolve, reject) => {
      let first = true;
      void (async () => {
        try {
          const res = await fetch(`${base}/live${qs}`, { signal: abort.signal, headers: { accept: "text/event-stream" } });
          if (!res.ok || !res.body) {
            const { error } = errorSchema.parse(await res.json().catch(() => ({})));
            throw new LiveError(error ?? `${res.status} ${res.statusText}`, res.status);
          }
          for await (const text of sseData(res.body)) {
            const parsed = frameSchema.safeParse(JSON.parse(text));
            if (!parsed.success || stream !== abort) continue;
            const frame = parsed.data;
            if (frame.kind === "snapshot") {
              if (!first) continue;
              first = false;
              adopt(frame);
              resolve(frame);
              if (stream === abort) renew(abort);
            } else if (!first) onFrame(frame);
          }
        } catch (cause) {
          if (first) reject(cause);
        } finally {
          if (stream === abort) {
            stream = null;
            clearInterval(lease);
            // A dropped or slow-reader stream reattaches; an exit or a hide does not.
            if (!first && live()) retry = setTimeout(resume, RETRY_MS);
          }
        }
      })();
    });
  };

  // Reattach after a pause, a hidden tab or a drop: a fresh snapshot replaces the screen only if output was missed.
  function resume() {
    if (!live() || stream) return;
    const target = attached;
    if (!target) return;
    void connect(target.sessionId, (snapshot) => {
      if (attached !== target) return;
      const missed = snapshot.seq > target.seq || snapshot.generation !== target.generation;
      target.generation = snapshot.generation;
      target.seq = snapshot.seq;
      target.lease = snapshot.lease;
      if (snapshot.cols && snapshot.rows) {
        const size = { cols: snapshot.cols, rows: snapshot.rows };
        if (!sameSize(size, remote)) owner = false;
        remote = size;
      }
      if (missed) emit(`\x1bc${snapshot.output}${restoreModes(snapshot)}`, snapshot.seq, false);
      if (snapshot.exitCode !== null) exit(snapshot.exitCode);
    }).catch((cause) => {
      // A network drop or a server hiccup keeps retrying; a refusal is final.
      if (!(cause instanceof LiveError && cause.status < 500)) {
        if (!stream && live()) retry = setTimeout(resume, RETRY_MS);
      } else fail(cause.message);
    });
  }

  const onVisibility = () => {
    if (document.visibilityState === "hidden") close();
    else resume();
  };
  const onPageHide = () => close();
  const watchPage = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    document[method]("visibilitychange", onVisibility);
    window[method]("pagehide", onPageHide);
  };

  const post = (route: "input" | "resize", body: { data: string } | Size) => {
    if (!attached) return Promise.reject(new Error("Terminal is not attached"));
    return request(`${base}/${route}`, { method: "POST", body: JSON.stringify({ sessionId: attached.sessionId, generation: attached.generation, ...body }) });
  };

  // The typer owns the size, so the size goes first; keys typed meanwhile ride the next POST together.
  const pump = async () => {
    if (sending) return;
    sending = true;
    try {
      while (attached) {
        if (owner && wanted && !sameSize(wanted, remote)) {
          const size = wanted;
          remote = size;
          await post("resize", size).catch(() => {});
          continue;
        }
        if (!writes.length) break;
        let length = 0;
        const batch: Waiter[] = [];
        while (writes.length && (!batch.length || length + writes[0].data.length <= BATCH_CHARS)) {
          const next = writes.shift()!;
          length += next.data.length;
          batch.push(next);
        }
        try {
          await post("input", { data: batch.map((item) => item.data).join("") });
          for (const item of batch) item.resolve();
        } catch (cause) {
          for (const item of batch) item.reject(cause);
        }
      }
    } finally {
      sending = false;
    }
  };

  const detach = () => {
    epoch++;
    close();
    watchPage(false);
    clearInterval(paneTimer);
    attached = null;
    paused = false;
    unparsed = 0;
    owner = false;
    const dropped = writes;
    writes = [];
    for (const item of dropped) item.reject(new Error("Terminal is not attached"));
  };

  const refreshPanes = async () => {
    if (!panes) return;
    const known = panes;
    const snapshot = await request(`${base}?panes=1`).catch(() => null);
    const list: Array<{ sessionId: string; label: string | null; generation: number; main: boolean }> = snapshot?.panes ?? [];
    if (panes !== known) return;
    const now = new Set(list.filter((pane) => !pane.main).map((pane) => pane.sessionId));
    for (const pane of list) {
      if (pane.main || known.has(pane.sessionId)) continue;
      for (const cb of openedListeners) cb({ id: pane.sessionId, botId, label: pane.label, generation: pane.generation });
    }
    for (const id of known) {
      if (now.has(id)) continue;
      for (const cb of closedListeners) cb({ id, botId });
    }
    panes = now;
  };

  const readBot = async (id: string) => {
    const snapshot = await request(`/api/bots/${encodeURIComponent(id)}/terminal`);
    if (id === botId && Array.isArray(snapshot?.panes)) panes = new Set(snapshot.panes.filter((pane: { main: boolean }) => !pane.main).map((pane: { sessionId: string }) => pane.sessionId));
    return snapshot;
  };

  return {
    appearance: async () => null,
    // SAFETY: both overloads answer the same route; panesOnly only trims fields this view ignores.
    readBot: readBot as TerminalBridge["readBot"],
    async open(input) {
      detach();
      watchPage(true);
      paneTimer = setInterval(() => {
        if (visible && document.visibilityState !== "hidden") void refreshPanes();
      }, PANES_MS);
      const mine = epoch;
      const adopt = (snapshot: Snapshot) => {
        if (mine !== epoch) return;
        attached = { sessionId: snapshot.sessionId, generation: snapshot.generation, seq: snapshot.seq, lease: snapshot.lease, exited: snapshot.exitCode !== null };
        remote = snapshot.cols && snapshot.rows ? { cols: snapshot.cols, rows: snapshot.rows } : null;
        if (!live()) close();
      };
      if (!input.sessionId) {
        // The host attaches a bare open to any live pane, so a bot with only workers needs its main shell first.
        const roster = await request(`${base}?panes=1`).catch(() => null);
        const list: Array<{ main: boolean }> = Array.isArray(roster?.panes) ? roster.panes : [];
        if (list.length && !list.some((pane) => pane.main)) await request(`${base}/start`, { method: "POST" });
        if (mine !== epoch) throw new Error("Terminal open was canceled");
      }
      let snapshot: Snapshot;
      try {
        snapshot = await connect(input.sessionId, adopt);
      } catch (cause) {
        // A bot whose main shell is not running yet gets it started, as the app's own open does.
        if (input.sessionId || mine !== epoch || !(cause instanceof LiveError && cause.status === 409 && /no active/i.test(cause.message))) throw cause;
        await request(`${base}/start`, { method: "POST" });
        if (mine !== epoch) throw new Error("Terminal open was canceled");
        snapshot = await connect(undefined, adopt);
      }
      return { id: snapshot.sessionId, cwd: "", shell: "", output: snapshot.output, exitCode: snapshot.exitCode, seq: snapshot.seq, cols: snapshot.cols, rows: snapshot.rows, modes: snapshot.modes, resetModes: snapshot.resetModes };
    },
    async cancelOpen() {
      detach();
      return true;
    },
    write(id, data) {
      if (!attached || attached.sessionId !== id) return Promise.reject(new Error("Terminal is not attached"));
      owner = true;
      return new Promise<void>((resolve, reject) => {
        writes.push({ data, resolve, reject });
        void pump();
      });
    },
    async resize(id, cols, rows) {
      if (!attached || attached.sessionId !== id) return;
      wanted = { cols, rows };
      if (owner) void pump();
    },
    onData: (cb) => listen(dataListeners, cb),
    onExit: (cb) => listen(exitListeners, cb),
    onError: (cb) => listen(errorListeners, cb),
    onOpened: (cb) => listen(openedListeners, cb),
    onClosed: (cb) => listen(closedListeners, cb),
    setVisible(next) {
      if (visible === next) return;
      visible = next;
      if (!next) close();
      else {
        resume();
        void refreshPanes();
      }
    },
  };
}

function desktopPointer(): boolean {
  return window.matchMedia?.(DESKTOP_QUERY).matches ?? false;
}

/** A live bridge for this bot in a desktop browser, or null where the app has its own or the server lacks live routes. */
export function useWebTerminalBridge(botId: string | undefined, liveRoutes: boolean, visible: boolean): WebTerminalBridge | null {
  const [desktop, setDesktop] = useState(desktopPointer);
  useEffect(() => {
    const media = window.matchMedia?.(DESKTOP_QUERY);
    const flip = () => setDesktop(desktopPointer());
    media?.addEventListener?.("change", flip);
    return () => media?.removeEventListener?.("change", flip);
  }, []);
  const bridge = useMemo(() => (botId && liveRoutes && desktop && !window.ogb ? createWebTerminalBridge(botId) : null), [botId, liveRoutes, desktop]);
  useEffect(() => bridge?.setVisible(visible), [bridge, visible]);
  return bridge;
}
