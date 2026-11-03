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
    const child = execFile("git", ["-C", cwd, ...args], { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
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
    await visit(file, stat);
    if (stat.isDirectory() && !stat.isSymbolicLink() && depth > 1) await walk(file, visit, depth - 1);
  }
  await new Promise((resolve) => setImmediate(resolve));
}

async function unlinkLinks(root) {
  await walk(root, async (file, stat) => {
    if (stat.isSymbolicLink()) await fsp.unlink(file);
  });
  await walk(root, (_file, stat) => {
    if (stat.isSymbolicLink()) throw new Error("link appeared during cleanup");
  });
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
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      warn(error);
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
  const removeScratch = async (entry, retry = true) => {
    const target = scratchFor(entry);
    if (!target || entries.findLast((other) => other.scratch && normalize(other.scratch) === normalize(target)) !== entry || scratchBusy(entry, target)) return;
    try {
      if (!await directory(target)) return;
      await unlinkLinks(target);
      if (scratchBusy(entry, target) || !await directory(target)) return;
      await fsp.rm(target, { recursive: true });
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
    const scan = async (root, depth) => walk(root, async (file, stat) => {
      if (!stat.isSymbolicLink()) return;
      const destination = path.resolve(path.dirname(file), await fsp.readlink(file));
      let real = destination;
      try { real = await fsp.realpath(file); } catch {}
      if (inside(target, destination) || inside(target, real)) linked = true;
    }, depth);
    await scan(worktreeRoot, 4);
    const roots = new Set([tempRoot, ...entries.map((entry) => entry.tempRoot)]);
    for (const root of roots) {
      if (!await directory(root)) throw new Error("linked TEMP root");
      for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
        if (!entry.name.startsWith("wink-")) continue;
        const folder = path.join(root, entry.name);
        const stat = await fsp.lstat(folder);
        if (stat.isSymbolicLink()) {
          const destination = path.resolve(root, await fsp.readlink(folder));
          if (inside(target, destination) || inside(target, await fsp.realpath(folder))) linked = true;
        } else if (stat.isDirectory()) await scan(folder, 4);
      }
    }
    return linked;
  };
  const removeWorktree = async (entry) => {
    if (!inside(worktreeRoot, entry.cwd) || normalize(entry.cwd) === normalize(worktreeRoot)) return;
    const target = await git(entry.cwd, ["rev-parse", "--show-toplevel"]);
    if (!inside(worktreeRoot, target) || normalize(target) === normalize(worktreeRoot) || !await directory(target)) return;
    if (KEEP_RE.test(path.basename(target)) || pinned.some((pin) => inside(target, pin) || inside(pin, target))) return;
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
    if (now() - changed < DAY_MS || await linkedInto(target) || busy()) return;
    await unlinkLinks(target);
    if (busy() || !await directory(target)) return;
    await git(common, ["worktree", "remove", target]);
    await record("worktree", target);
    await git(common, ["worktree", "prune"]);
  };
  const sweep = () => enqueue(async () => {
    for (const entry of entries) {
      if (!entry.closedAt || now() - entry.closedAt < DAY_MS || panes().some((pane) => pane.id === entry.id)) continue;
      if (now() - entry.closedAt >= (entry.keep ? 3 : 1) * DAY_MS) await removeScratch(entry);
      try { await removeWorktree(entry); } catch (error) { if (error.code !== "ENOENT") warn(error); }
    }
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
      Object.assign(entry, { closedAt: now(), keep: keep === true, reported: !!session.reportAt });
      save();
      return entry.reported && !entry.keep ? enqueue(() => removeScratch(entry)) : Promise.resolve();
    },
    start(openPanes) {
      panes = openPanes;
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
