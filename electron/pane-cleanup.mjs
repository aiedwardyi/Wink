import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DAY_MS = 24 * 60 * 60_000;
const SWEEP_MS = 6 * 60 * 60_000;
const NICK_RE = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const KEEP_RE = /^(?:rel-|nm-)|^(?:relay-deploy|release-gate)$/i;
const normalize = (file) => {
  const resolved = path.resolve(file);
  if (process.platform !== "win32") return resolved;
  let current = path.parse(resolved).root;
  const parts = resolved.slice(current.length).split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return path.join(current, ...parts.slice(index + 1)).toLowerCase();
      current = fs.realpathSync.native(current);
    } catch {
      return path.join(current, ...parts.slice(index + 1)).toLowerCase();
    }
  }
  return current.toLowerCase();
};
const inside = (root, file) => normalize(file) === normalize(root) || normalize(file).startsWith(`${normalize(root)}${path.sep}`);
const nick = (label) => {
  const first = label?.split("|")[0].trim();
  return NICK_RE.test(first ?? "") ? first : null;
};

async function runGit(cwd, args, setPriority) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(args.includes("-z") ? stdout : stdout.trim()));
    child.once("spawn", () => {
      try { setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch {}
    });
  });
}

async function directory(root) {
  const stat = await fsp.lstat(root);
  return stat.isDirectory() && !stat.isSymbolicLink() && normalize(await fsp.realpath(root)) === normalize(root);
}

async function walk(root, visit, depth = Infinity) {
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    const stat = await fsp.lstat(file);
    if (await visit(file, stat, depth) !== false && stat.isDirectory() && !stat.isSymbolicLink() && depth > 1) await walk(file, visit, depth - 1);
  }
  await new Promise((resolve) => setImmediate(resolve));
}

async function unlinkLinks(root, tracked = new Set()) {
  await walk(root, async (file, stat) => {
    if (stat.isSymbolicLink() && !tracked.has(normalize(file))) await fsp.unlink(file);
  });
  await walk(root, (file, stat) => {
    if (stat.isSymbolicLink() && !tracked.has(normalize(file))) throw new Error("link appeared during cleanup");
  });
}

export async function readCleanupPins(dataDir) {
  const pins = [];
  for (const name of ["bots.json", "groups.json"]) {
    const records = JSON.parse(await fsp.readFile(path.join(dataDir, name), "utf8"));
    if (!Array.isArray(records)) throw new Error("invalid cleanup pins");
    for (const record of records) {
      for (const item of [record, ...(record.tasks ?? [])]) {
        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Malformed persisted pins must prevent deletion.
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid cleanup pin");
        for (const cwd of [item.cwd, item.pinnedCwd]) {
          if (cwd == null || cwd === "") continue;
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Pin paths cross the persisted JSON boundary.
          if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("invalid cleanup pin");
          pins.push(cwd);
        }
      }
    }
  }
  return pins;
}

export function createPaneCleanup({ home, tempRoot = os.tmpdir(), worktreeRoot = path.join(home, "orbit-wt"), pinned = [], now = Date.now, retryMs = 60_000, schedule = setTimeout, cancel = clearTimeout, setPriority = os.setPriority, warn = () => {} }) {
  const git = (cwd, args) => runGit(cwd, args, setPriority);
  const file = path.join(home, ".orbit", "pane-ledger.json");
  const log = path.join(home, ".orbit", "cleanup.log");
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(entries)) entries = [];
  } catch { entries = []; }
  entries = entries.filter((entry) => entry && typeof entry.id === "string" && typeof entry.cwd === "string" && typeof entry.tempRoot === "string");
  for (const entry of entries) if (!entry.closedAt) entry.closedAt = now();
  let panes = () => [];
  let tail = Promise.resolve();
  let timer = null;
  let stopped = false;
  const retries = new Set();
  const save = () => {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
      fs.renameSync(temporary, file);
      return true;
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      warn(error);
      return false;
    }
  };
  const enqueue = (run) => {
    const result = tail.then(run).catch(warn);
    tail = result;
    return result;
  };
  const record = async (kind, target) => {
    await fsp.appendFile(log, JSON.stringify({ at: new Date(now()).toISOString(), kind, path: target }) + "\n", { mode: 0o600 });
  };
  const scratchFor = (entry) => {
    const name = nick(entry.label);
    if (!name || !path.isAbsolute(entry.tempRoot)) return null;
    const target = path.resolve(entry.tempRoot, `wink-${name}`);
    return normalize(path.dirname(target)) === normalize(entry.tempRoot) && target === entry.scratch ? target : null;
  };
  const scratchBusy = (entry, target) => panes().some((pane) => nick(pane.label) === nick(entry.label) || inside(target, pane.cwd));
  const finishScratch = (target) => {
    for (const entry of entries) if (entry.scratch && normalize(entry.scratch) === normalize(target)) entry.scratchDone = true;
    save();
  };
  const removeScratch = async (entry, retry = true) => {
    if (entry.scratchDone) return;
    const target = scratchFor(entry);
    if (!target) { entry.scratchDone = true; return; }
    if (entries.findLast((other) => other.scratch && normalize(other.scratch) === normalize(target)) !== entry || scratchBusy(entry, target)) return;
    try {
      try { await fsp.lstat(target); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        finishScratch(target);
        return;
      }
      if (!await directory(target)) return;
      await unlinkLinks(target);
      if (scratchBusy(entry, target) || !await directory(target)) return;
      await fsp.rm(target, { recursive: true });
      finishScratch(target);
      await record("scratch", target);
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (retry && ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error.code)) {
        const handle = schedule(() => {
          retries.delete(handle);
          if (!stopped) void enqueue(() => removeScratch(entry, false));
        }, retryMs);
        handle.unref?.();
        retries.add(handle);
      } else warn(error);
    }
  };
  const linkedInto = async (target) => {
    let linked = false;
    const inspect = async (file, stat, depth) => {
      if (inside(target, file)) return false;
      if (stat.isDirectory() && !stat.isSymbolicLink() && depth === 1) linked = true;
      if (!stat.isSymbolicLink()) return;
      const destination = path.resolve(path.dirname(file), await fsp.readlink(file));
      let real = destination;
      try { real = await fsp.realpath(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (inside(target, destination) || inside(target, real)) linked = true;
    };
    await walk(worktreeRoot, inspect, 4);
    const roots = new Set([tempRoot, ...entries.map((entry) => entry.tempRoot)]);
    for (const root of roots) {
      try {
        if (!await directory(root)) throw new Error("linked TEMP root");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
        if (!entry.name.startsWith("wink-")) continue;
        const folder = path.join(root, entry.name);
        const stat = await fsp.lstat(folder);
        if (stat.isSymbolicLink()) {
          await inspect(folder, stat, 1);
        } else if (stat.isDirectory()) await walk(folder, inspect, 4);
      }
    }
    return linked;
  };
  const removeWorktree = async (entry) => {
    if (entry.worktreeDone) return;
    if (!inside(worktreeRoot, entry.cwd) || normalize(entry.cwd) === normalize(worktreeRoot)) { entry.worktreeDone = true; return; }
    try { await fsp.lstat(entry.cwd); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entry.worktreeDone = true;
      return;
    }
    const target = await git(entry.cwd, ["rev-parse", "--show-toplevel"]);
    if (!inside(worktreeRoot, target) || normalize(target) === normalize(worktreeRoot) || !await directory(target)) return;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Accept fixed pins or a loader that refreshes them.
    const isPinned = async () => (typeof pinned === "function" ? await pinned() : pinned).some((pin) => inside(target, pin) || inside(pin, target));
    if (KEEP_RE.test(path.basename(target)) || await isPinned()) return;
    if (entries.some((other) => inside(target, other.cwd) && (!other.closedAt || now() - other.closedAt < DAY_MS))) return;
    const busy = () => panes().some((pane) => inside(target, pane.cwd));
    if (busy() || !await directory(worktreeRoot)) return;
    if (await git(target, ["status", "--porcelain"])) return;
    if (await git(target, ["rev-list", "HEAD", "--not", "--remotes"]) !== "") return;
    const registered = await git(target, ["worktree", "list", "--porcelain"]);
    const registration = registered.split("\n\n").find((record) => record.split("\n").some((line) => line.startsWith("worktree ") && normalize(line.slice(9)) === normalize(target)));
    if (!registration || /^locked(?: |$)/m.test(registration)) return;
    const common = await git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (normalize(await git(target, ["rev-parse", "--absolute-git-dir"])) === normalize(common)) return;
    let changed = (await fsp.lstat(target)).mtimeMs;
    await walk(target, (_file, stat) => { changed = Math.max(changed, stat.mtimeMs); });
    if (now() - changed < DAY_MS || await linkedInto(target) || busy() || await isPinned()) return;
    const tracked = new Set((await git(target, ["ls-files", "-z"])).split("\0").filter(Boolean).map((file) => normalize(path.resolve(target, file))));
    await unlinkLinks(target, tracked);
    if (busy() || !await directory(target) || await isPinned()) return;
    const owned = entries.filter((other) => !other.worktreeDone && inside(target, other.cwd));
    for (const other of owned) other.worktreeDone = true;
    if (!save()) { for (const other of owned) other.worktreeDone = false; return; }
    try { await git(common, ["worktree", "remove", target]); } catch (error) {
      for (const other of owned) other.worktreeDone = false;
      save();
      throw error;
    }
    await record("worktree", target);
    await git(common, ["worktree", "prune"]);
  };
  const sweep = () => enqueue(async () => {
    for (const entry of entries) {
      if (!entry.closedAt || now() - entry.closedAt < DAY_MS || panes().some((pane) => pane.id === entry.id)) continue;
      if (now() - entry.closedAt >= (entry.keep ? 3 : 1) * DAY_MS) await removeScratch(entry);
      try { await removeWorktree(entry); } catch (error) { if (error.code !== "ENOENT") warn(error); }
    }
    entries = entries.filter((entry) => !entry.closedAt || !entry.scratchDone || !entry.worktreeDone);
    save();
  });
  return {
    opened(session) {
      const root = session.tempRoot || tempRoot;
      entries.push({ id: session.id, botId: session.botId, label: session.label, cwd: session.cwd, tempRoot: root, scratch: nick(session.label) ? path.resolve(root, `wink-${nick(session.label)}`) : null, openedAt: now(), closedAt: null, keep: false, reported: false });
      save();
    },
    closed(session, keep = false) {
      const entry = entries.findLast((candidate) => candidate.id === session.id);
      if (!entry) return Promise.resolve();
      Object.assign(entry, { closedAt: now(), keep: keep === true, reported: !!session.reportAt && session.reportAt >= (session.stallArmedAt || 0) && session.autoReported !== false });
      save();
      return entry.reported && !entry.keep ? enqueue(() => removeScratch(entry)) : Promise.resolve();
    },
    start(openPanes) {
      panes = openPanes;
      if (timer) cancel(timer);
      save();
      const tick = () => {
        if (stopped) return;
        void sweep();
        timer = schedule(tick, SWEEP_MS);
        timer.unref?.();
      };
      timer = schedule(tick, 1_000);
      timer.unref?.();
    },
    sweep,
    flush: () => tail,
    dispose() {
      stopped = true;
      cancel(timer);
      for (const handle of retries) cancel(handle);
      retries.clear();
    },
  };
}
