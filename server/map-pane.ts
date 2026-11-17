import { existsSync, watch, type FSWatcher } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { MapSnapshot, MapWorker } from "../shared/map-pane.ts";
import { json } from "./http-helpers.ts";
import { latestMapFile, mapFileDiff, mapFiles, mapFork, mapGit, mapHead, mapRepoFiles, mapTrunkFork, mapWalkFiles } from "./map-git.ts";
import type { Store } from "./store.ts";
import { DATA_DIR } from "./config.ts";
import { terminalSnapshotResponse, type TerminalBridgeAccess } from "./terminal-snapshot.ts";
import { parsePaneNote } from "../shared/pane-note.ts";
import { z } from "zod";
import { watchMapPanes } from "./map-events.ts";
import { createMapFlow, type MapGh } from "./map-pr.ts";
import { mapBotSelf, mapGitRefs } from "./map-bot-self.ts";

const paneSchema = z.object({ sessionId: z.string(), cwd: z.string(), label: z.string().nullable().optional(), baseHead: z.string().nullable().optional(), host: z.string().nullable().optional(), main: z.boolean().optional(), exited: z.boolean().optional() });

export interface MapPaneRecord {
  sessionId: string;
  cwd: string;
  label?: string | null;
  baseHead?: string | null;
  host?: string | null;
  main?: boolean;
  exited?: boolean;
  /** The bot itself: the files its own turns wrote here, relative to cwd. */
  self?: string[];
}

interface WatchedPane {
  pane: MapPaneRecord;
  root: string;
  base: string | null;
  fork?: string;
  worker: MapWorker;
  watcher?: FSWatcher;
  refs?: FSWatcher;
  timer?: NodeJS.Timeout;
  running: boolean;
  dirty: boolean;
  path?: string;
}

export interface MapPaneDeps {
  panes(botId: string): Promise<MapPaneRecord[]>;
  reason?(botId: string, pane: MapPaneRecord, editedAt: number): string | undefined;
  subscribe(botId: string, listener: () => void, disconnected?: () => void): () => void;
  gh?: MapGh;
  /** Where the last Git rows per checkout are kept across restarts. */
  flows?: string;
}

// The bot's own row lasts while a file it wrote is still unshipped there: uncommitted, unpushed or on an unmerged branch.
const shown = ({ pane, worker }: WatchedPane) => {
  if (!pane.self) return true;
  const own = new Set(pane.self.map(path => path.toLowerCase()));
  return !worker.error && worker.files.some(file => own.has(file.path.toLowerCase()));
};

export function createMapPane(deps: MapPaneDeps) {
  const fallback = new Map<string, string | null>();
  const readers = new Map<string, Set<Map<string, WatchedPane>>>();
  // The workers each bot's Map last saw, so a reopen paints before git has read them again.
  const known = new Map<string, Map<string, WatchedPane>>();
  const lists = new Map<string, string[]>();
  const flows = createMapFlow(deps.gh, deps.flows);

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
    let resend = true;
    const send = (error = false) => {
      if (closed) return;
      resend = error;
      const snapshot: MapSnapshot = { workers: [...panes.values()].filter(shown).map(value => value.worker) };
      if (error) snapshot.error = true;
      else {
        known.set(botId, panes);
        const roots = new Set([...known.values()].flatMap(seen => [...seen.values()].map(record => record.root)));
        for (const root of lists.keys()) if (!roots.has(root)) lists.delete(root);
      }
      write(snapshot);
    };
    const write = (snapshot: MapSnapshot) => {
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      if (res.writableLength > 1024 * 1024) res.destroy();
    };
    const refresh = async (record: WatchedPane, quiet = false) => {
      if (closed || !record.watcher || panes.get(record.pane.sessionId) !== record) return;
      if (record.running) { record.dirty = true; return; }
      record.running = true;
      try {
        if (!record.base) {
          // A folder that becomes a repo later turns to git here; until then Map lists the folder again on each edit.
          const base = existsSync(resolve(record.pane.cwd, ".git")) ? await mapHead(record.pane.cwd) : null;
          if (closed || !record.watcher) return;
          if (!base) { record.worker = { ...record.worker, editedAt: Date.now() }; if (!quiet) send(); return; }
          record.root = (await mapGit(record.pane.cwd, ["rev-parse", "--show-toplevel"])).trim();
          record.base = base;
          fallback.set(`${botId}:${record.pane.sessionId}`, base);
          record.worker = { ...record.worker, git: true };
        }
        const fork = record.pane.self ? await mapTrunkFork(record.root) ?? record.base : await mapFork(record.root, record.base);
        const { files, more } = await mapFiles(record.root, fork, [...panes.values()].find(value => value.base)?.base ?? undefined);
        if (closed || !record.watcher) return;
        const latest = record.path && files.some(file => file.path === record.path)
          ? { path: record.path, at: Date.now() } : await latestMapFile(record.root, files);
        record.fork = fork;
        record.worker = { ...record.worker, files, more: more || undefined, error: undefined, editedAt: latest.at, path: latest.path, reason: deps.reason?.(botId, record.pane, latest.at) };
        record.path = undefined;
        if (!quiet) send();
      } catch {
        const failed = record.worker.error;
        record.worker = { ...record.worker, error: true };
        if (!quiet && !failed) send();
      } finally {
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
    const remove = (record: WatchedPane) => { record.watcher?.close(); record.refs?.close(); clearTimeout(record.timer); };
    const fail = (record: WatchedPane) => {
      remove(record);
      record.watcher = undefined;
      record.worker = { ...record.worker, error: true };
    };
    const sync = async () => {
      if (closed) return;
      if (syncing) { syncAgain = true; return; }
      syncing = true;
      try {
        const live = (await deps.panes(botId)).filter(pane => !pane.main && !pane.exited);
        if (closed) return;
        const ids = new Set(live.map(pane => pane.sessionId));
        let changed = resend;
        for (const [id, record] of panes) if (!ids.has(id)) { remove(record); panes.delete(id); fallback.delete(`${botId}:${id}`); changed = true; }
        const fresh: MapPaneRecord[] = [];
        for (const pane of live) {
          const existing = panes.get(pane.sessionId);
          if (!existing) { fresh.push(pane); continue; }
          // Only the watcher re-reads git: a chat event can change no more than the reason line and the bot's own files.
          if (pane.self?.join("\0") !== existing.pane.self?.join("\0")) { existing.pane = pane; changed = true; }
          const reason = deps.reason?.(botId, existing.pane, existing.worker.editedAt);
          if (reason !== existing.worker.reason) { existing.worker = { ...existing.worker, reason }; changed = true; }
        }
        const last = known.get(botId);
        if (!panes.size && fresh.length && last && fresh.every(pane => last.has(pane.sessionId))) write({ workers: fresh.map(pane => last.get(pane.sessionId)!).filter(shown).map(record => record.worker) });
        // New workers are read together and sent once: sent one by one, Map rebuilt its tree per worker as it opened.
        const records = await Promise.all(fresh.map(async (pane): Promise<WatchedPane> => {
          const key = `${botId}:${pane.sessionId}`;
          const worker: MapWorker = { id: pane.sessionId, nick: pane.label?.split("|")[0].trim() || pane.sessionId.slice(0, 8), git: false, files: [], editedAt: 0 };
          // A remote pane's folder is on its host: the path here is only where its ssh runs.
          if (pane.host) return { pane, root: "", base: null, running: false, dirty: false, worker };
          try {
            let base = pane.baseHead && /^[a-f0-9]{40,64}$/.test(pane.baseHead) ? pane.baseHead : fallback.get(key);
            if (base === undefined) { base = await mapHead(pane.cwd); fallback.set(key, base); }
            const root = base ? (await mapGit(pane.cwd, ["rev-parse", "--show-toplevel"])).trim() : pane.cwd;
            return { pane, root, base, running: false, dirty: false, worker: { ...worker, git: base !== null } };
          } catch { return { pane, root: "", base: null, running: false, dirty: false, worker: { ...worker, error: true } }; }
        }));
        if (closed) return;
        for (const record of records) {
          panes.set(record.pane.sessionId, record);
          if (!record.root) continue;
          try {
            record.watcher = watch(record.root, { recursive: true }, (event, name) => {
              // Windows repeats this event without end once the folder is gone.
              if (event === "rename" && !existsSync(record.root)) { fail(record); return send(); }
              if (!name) return schedule(record);
              const path = name.toString().replaceAll("\\", "/");
              // The bot's row is measured against the trunk, so its commits, pushes and checkouts change it with no file edit.
              if (record.pane.self && /^\.git\/(HEAD|packed-refs|refs\/)/.test(path)) return schedule(record);
              // A folder without git yet still hears its .git: that is how it becomes a repo.
              if (path.split("/").some(part => (part === ".git" && record.base) || part === "node_modules")) return;
              schedule(record, path);
            });
            record.watcher.on("error", () => { fail(record); send(); });
            const refs = record.pane.self ? mapGitRefs(record.root) : null;
            if (refs) {
              record.refs = watch(refs.dir, { recursive: true }, (_event, name) => { if (name && refs.match(name.toString().replaceAll("\\", "/"))) schedule(record); });
              record.refs.on("error", () => { fail(record); send(); });
            }
          } catch { fail(record); }
        }
        await Promise.all(records.filter(record => record.base).map(record => refresh(record, true)));
        if (changed || records.length) send();
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
    const open = readers.get(botId);
    // What Map was last sent, not a worker still in its first read: a reopen shows the last snapshot until its own read is done.
    const record = open && (known.get(botId)?.get(sessionId) ?? [...open].map(panes => panes.get(sessionId)).find(Boolean));
    if (route === "repo") {
      if (!record) return json(res, 404, { error: "No such worker" });
      const { root } = record;
      const read = (record.base ? mapRepoFiles(root) : root ? mapWalkFiles(root) : Promise.resolve([])).then(paths => { if (record.base) lists.set(root, paths); return paths; });
      // A Git list drifts mostly by the worker's own edits, which Map adds from the snapshot: the last list paints at once, this read serves the next open.
      const last = lists.get(root);
      if (last) { read.catch(() => lists.delete(root)); return json(res, 200, { name: basename(root), paths: last }); }
      try { return json(res, 200, { name: basename(root), paths: await read }); }
      catch { return json(res, 503, { error: "Could not list the files" }); }
    }
    if (route === "flow") {
      if (!record?.base) return json(res, 404, { error: "No such worker" });
      if (url.searchParams.get("cached") === "1") return json(res, 200, await flows.last(record.root, record.fork ?? record.base));
      try { return json(res, 200, await flows.flow(record.root, record.fork ?? record.base)); }
      catch { return json(res, 503, { error: "Could not read git" }); }
    }
    const file = record?.worker.files.find(file => file.path === path);
    if (!record?.base || !file) return json(res, 404, { error: "No such changed file" });
    const inside = relative(record.root, resolve(record.root, path));
    if (inside.startsWith("..") || isAbsolute(inside)) return json(res, 403, { error: "File is outside the working folder" });
    try { return json(res, 200, await mapFileDiff(record.root, record.fork ?? record.base, file, url.searchParams.get("whole") === "1")); }
    catch { return json(res, 503, { error: "Could not read the diff" }); }
  }

  return { handle };
}

export function createWorkerMap(store: Store, access: () => TerminalBridgeAccess | null) {
  return createMapPane({
    flows: join(DATA_DIR, "map-flows.json"),
    panes: async botId => {
      const bot = store.bot(botId);
      const task = bot && store.taskByThread(bot.id, bot.threadId);
      // The engine runs in the task's pinned folder: a new bot folder applies from its next task.
      const self = bot ? mapBotSelf(store.messagesFor(bot.threadId), bot.name, task && task.cwd !== undefined ? task.cwd : bot.cwd ?? bot.lastProjectCwd) : [];
      const bridge = access();
      if (!bridge) return self;
      const snapshot = await terminalSnapshotResponse(bridge, botId, null, undefined, { panesOnly: true });
      if (snapshot.status === 404) return self;
      if (snapshot.status !== 200) throw new Error("Worker panes unavailable");
      return [...paneSchema.array().parse(snapshot.body.panes ?? []), ...self];
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
