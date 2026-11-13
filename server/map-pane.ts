import { watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type { MapSnapshot, MapWorker } from "../shared/map-pane.ts";
import { json } from "./http-helpers.ts";
import { latestMapFile, mapFileDiff, mapFiles, mapGit, mapHead, mapRepoFiles } from "./map-git.ts";
import type { Store } from "./store.ts";
import { terminalSnapshotResponse, type TerminalBridgeAccess } from "./terminal-snapshot.ts";
import { parsePaneNote } from "../shared/pane-note.ts";
import { z } from "zod";
import { watchMapPanes } from "./map-events.ts";

const paneSchema = z.object({ sessionId: z.string(), cwd: z.string(), label: z.string().nullable().optional(), baseHead: z.string().nullable().optional(), main: z.boolean().optional(), exited: z.boolean().optional() });

export interface MapPaneRecord {
  sessionId: string;
  cwd: string;
  label?: string | null;
  baseHead?: string | null;
  main?: boolean;
  exited?: boolean;
}

interface WatchedPane {
  pane: MapPaneRecord;
  root: string;
  base: string | null;
  worker: MapWorker;
  watcher?: FSWatcher;
  timer?: NodeJS.Timeout;
  running: boolean;
  dirty: boolean;
  path?: string;
}

export interface MapPaneDeps {
  panes(botId: string): Promise<MapPaneRecord[]>;
  title(botId: string): string;
  reason?(botId: string, pane: MapPaneRecord, editedAt: number): string | undefined;
  subscribe(botId: string, listener: () => void, disconnected?: () => void): () => void;
}

export function createMapPane(deps: MapPaneDeps) {
  const fallback = new Map<string, string | null>();
  const readers = new Map<string, Set<Map<string, WatchedPane>>>();

  function live(res: ServerResponse, botId: string) {
    const panes = new Map<string, WatchedPane>();
    const botReaders = readers.get(botId) ?? new Set();
    botReaders.add(panes);
    readers.set(botId, botReaders);
    let closed = false;
    let syncing = false;
    let syncAgain = false;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    res.socket?.setTimeout(0);
    const send = (error = false) => {
      if (closed) return;
      const snapshot: MapSnapshot = { workers: [...panes.values()].map(value => value.worker) };
      if (error) snapshot.error = true;
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      if (res.writableLength > 1024 * 1024) res.destroy();
    };
    const refresh = async (record: WatchedPane) => {
      if (closed || !record.base || panes.get(record.pane.sessionId) !== record) return;
      if (record.running) { record.dirty = true; return; }
      record.running = true;
      try {
        const files = await mapFiles(record.root, record.base);
        if (closed) return;
        const latest = record.path && files.some(file => file.path === record.path)
          ? { path: record.path, at: Date.now() } : await latestMapFile(record.root, files);
        record.worker = { ...record.worker, files, editedAt: latest.at, path: latest.path, reason: deps.reason?.(botId, record.pane, latest.at) };
        record.path = undefined;
        send();
      } catch { send(true); }
      finally {
        record.running = false;
        if (record.dirty && !closed) { record.dirty = false; schedule(record); }
      }
    };
    const schedule = (record: WatchedPane, path?: string) => {
      if (closed) return;
      if (path) record.path = path;
      clearTimeout(record.timer);
      record.timer = setTimeout(() => { record.timer = undefined; void refresh(record); }, 65);
    };
    const remove = (record: WatchedPane) => { record.watcher?.close(); clearTimeout(record.timer); };
    const sync = async () => {
      if (closed) return;
      if (syncing) { syncAgain = true; return; }
      syncing = true;
      try {
        const live = (await deps.panes(botId)).filter(pane => !pane.main && !pane.exited);
        if (closed) return;
        const ids = new Set(live.map(pane => pane.sessionId));
        for (const [id, record] of panes) if (!ids.has(id)) { remove(record); panes.delete(id); fallback.delete(`${botId}:${id}`); }
        for (const pane of live) {
          if (closed) return;
          const existing = panes.get(pane.sessionId);
          if (existing) { schedule(existing); continue; }
          const key = `${botId}:${pane.sessionId}`;
          let base = pane.baseHead && /^[a-f0-9]{40,64}$/.test(pane.baseHead) ? pane.baseHead : fallback.get(key);
          if (base === undefined) { base = await mapHead(pane.cwd); fallback.set(key, base); }
          if (closed) return;
          const root = base ? (await mapGit(pane.cwd, ["rev-parse", "--show-toplevel"])).trim() : pane.cwd;
          const record: WatchedPane = { pane, root, base, running: false, dirty: false,
            worker: { id: pane.sessionId, nick: pane.label?.split("|")[0].trim() || pane.sessionId.slice(0, 8), task: deps.title(botId), git: base !== null, files: [], editedAt: 0 } };
          if (closed) return;
          panes.set(pane.sessionId, record);
          if (base) {
            record.watcher = watch(root, { recursive: true }, (_event, name) => {
              if (!name) return schedule(record);
              const path = name.toString().replaceAll("\\", "/");
              if (path.split("/").some(part => part === ".git" || part === "node_modules")) return;
              schedule(record, path);
            });
            record.watcher.on("error", () => send(true));
            await refresh(record);
          }
        }
        send();
      } catch { send(true); }
      finally {
        syncing = false;
        if (syncAgain && !closed) { syncAgain = false; void sync(); }
      }
    };
    const unsubscribe = deps.subscribe(botId, () => { void sync(); }, () => res.end());
    res.once("close", () => {
      closed = true;
      unsubscribe();
      for (const record of panes.values()) remove(record);
      botReaders.delete(panes);
      if (!botReaders.size) readers.delete(botId);
    });
    void sync();
  }

  async function handle(req: IncomingMessage, res: ServerResponse, botId: string, route: string, url: URL) {
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
    if (route === "live") return live(res, botId);
    const sessionId = url.searchParams.get("worker") ?? "";
    const path = url.searchParams.get("path") ?? "";
    const record = [...(readers.get(botId) ?? [])].map(panes => panes.get(sessionId)).find(Boolean);
    if (route === "repo") {
      if (!record?.base) return json(res, 404, { error: "No such worker" });
      try { return json(res, 200, { name: basename(record.root), paths: await mapRepoFiles(record.root) }); }
      catch { return json(res, 503, { error: "Could not list the files" }); }
    }
    const file = record?.worker.files.find(file => file.path === path);
    if (!record?.base || !file) return json(res, 404, { error: "No such changed file" });
    const inside = relative(record.root, resolve(record.root, path));
    if (inside.startsWith("..") || isAbsolute(inside)) return json(res, 403, { error: "File is outside the working folder" });
    try { return json(res, 200, await mapFileDiff(record.root, record.base, file, url.searchParams.get("whole") === "1")); }
    catch { return json(res, 503, { error: "Could not read the diff" }); }
  }

  return { handle };
}

export function createWorkerMap(store: Store, access: () => TerminalBridgeAccess | null) {
  return createMapPane({
    panes: async botId => {
      const bridge = access();
      if (!bridge) return [];
      const snapshot = await terminalSnapshotResponse(bridge, botId, null, undefined, { panesOnly: true });
      if (snapshot.status === 404) return [];
      if (snapshot.status !== 200) throw new Error("Worker panes unavailable");
      const panes = snapshot.body.panes;
      return paneSchema.array().parse(panes ?? []);
    },
    title: botId => {
      const bot = store.bot(botId);
      return bot?.tasks?.find(task => task.threadId === bot.threadId)?.title ?? "";
    },
    reason: (botId, pane, editedAt) => {
      const messages = store.messagesFor(store.bot(botId)?.threadId ?? "");
      for (const message of messages.toReversed()) {
        if (message.kind !== "note" || !message.text || message.at < editedAt) continue;
        const note = parsePaneNote(message.text);
        if (note.pane8 && pane.sessionId.startsWith(note.pane8) && !note.alert) return note.body.trim().split("\n")[0].slice(0, 240) || undefined;
      }
      return undefined;
    },
    subscribe: (botId, listener, disconnected) => {
      const stopPanes = watchMapPanes(access(), botId, listener, disconnected);
      const stopStore = store.onChange(change => {
        if ("threadId" in change && change.threadId === store.bot(botId)?.threadId && (change.type === "message" || change.type === "message.patch")) {
          const message = change.message;
          if (message.kind === "launch" || message.kind === "note" || message.kind === "activity") listener();
        }
      });
      return () => { stopPanes(); stopStore(); };
    },
  });
}
