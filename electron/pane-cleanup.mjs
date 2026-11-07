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
const contains = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const inside = (root, file) => contains(normalize(root), normalize(file));
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

function resolveTempRoot(root) {
  if (!path.isAbsolute(root)) return root;
  try {
    const real = fs.realpathSync.native(root);
    return normalize(root) === normalize(real) ? root : real;
  } catch { return root; }
}

async function resolvePin(file) {
  try { return await fsp.realpath(file); } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
  }
  try {
    if ((await fsp.lstat(file)).isSymbolicLink()) throw new Error("unresolved cleanup pin");
  } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
  const parent = path.dirname(file);
  return parent === file ? file : path.join(await resolvePin(parent), path.basename(file));
}

async function walk(root, visit, depth = Infinity) {
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    const stat = await fsp.lstat(file);
    if (await visit(file, stat, depth) !== false && stat.isDirectory() && !stat.isSymbolicLink() && depth > 1) await walk(file, visit, depth - 1);
  }
  await new Promise((resolve) => setImmediate(resolve));
}

async function unlinkLinks(root, tracked = new Set(), current = () => true) {
  let checkedAt = -Infinity;
  let active = true;
  const check = async () => {
    if (active && Date.now() - checkedAt >= 250) {
      active = await current();
      checkedAt = Date.now();
    }
    return active;
  };
  await walk(root, async (file, stat) => {
    if (await check() && stat.isSymbolicLink() && !tracked.has(normalize(file))) await fsp.unlink(file);
  });
  await walk(root, async (file, stat) => {
    if (await check() && stat.isSymbolicLink() && !tracked.has(normalize(file))) throw new Error("link appeared during cleanup");
  });
  return active;
}

async function linkTree(root, copy) {
  await fsp.mkdir(copy, { recursive: true });
  if (!await directory(copy)) throw new Error("linked cleanup backup destination");
  await walk(root, async (file, stat) => {
    const destination = path.join(copy, path.relative(root, file));
    if (stat.isDirectory()) {
      await fsp.mkdir(destination, { recursive: true });
      if (!await directory(destination)) throw new Error("linked cleanup backup destination");
    } else {
      try {
        if (stat.isFile()) await fsp.link(file, destination);
        else throw new Error("unsupported cleanup backup entry");
      } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  });
}

async function removeWithBackup(target, gitdir, remove, warn) {
  const backup = await fsp.mkdtemp(path.join(path.dirname(target), ".pane-cleanup-"));
  const tree = path.join(backup, "tree");
  const metadata = path.join(backup, "git");
  let retain = false;
  try {
    // Git also deletes registration metadata after a partial filesystem failure.
    await linkTree(target, tree);
    await fsp.cp(gitdir, metadata, { recursive: true });
    retain = true;
    let result;
    try { result = await remove(); } catch (error) {
      await fsp.cp(metadata, gitdir, { recursive: true, force: false });
      await linkTree(tree, target);
      retain = false;
      throw error;
    }
    retain = false;
    return result;
  } finally {
    if (!retain) await fsp.rm(backup, { recursive: true }).catch(warn);
  }
}

export async function readCleanupPins(dataDir) {
  const pins = [];
  for (const name of ["bots.json", "groups.json"]) {
    const file = path.join(dataDir, name);
    let text;
    try { text = await fsp.readFile(file, "utf8"); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { await fsp.lstat(file); } catch (missing) {
        if (missing.code === "ENOENT") continue;
        throw missing;
      }
      throw error;
    }
    const records = JSON.parse(text);
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
  tempRoot = resolveTempRoot(tempRoot);
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
  const scratchBusy = async (entry, target) => {
    const label = nick(entry.label);
    for (const pane of panes()) if (nick(pane.label) === label || contains(target, normalize(pane.cwd)) || contains(target, normalize(await resolvePin(pane.cwd)))) return true;
    return false;
  };
  const finishScratch = (target, owner) => {
    const normalized = normalize(target);
    for (const entry of entries.slice(0, entries.indexOf(owner) + 1)) if (entry.scratch && normalize(entry.scratch) === normalized) entry.scratchDone = true;
    save();
  };
  const removeScratch = async (entry, retry = true) => {
    if (entry.scratchDone) return;
    const target = scratchFor(entry);
    if (!target) { entry.scratchDone = true; return; }
    const current = async () => {
      const normalized = normalize(target);
      return !await scratchBusy(entry, normalized) && entries.findLast((other) => other.scratch && normalize(other.scratch) === normalized) === entry;
    };
    try {
      if (!await current()) return;
      try { await fsp.lstat(target); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (await current()) finishScratch(target, entry);
        return;
      }
      if (!await directory(target)) return;
      if (!await unlinkLinks(target, new Set(), current)) return;
      if (!await directory(target) || !await current()) return;
      await fsp.rm(target, { recursive: true });
      finishScratch(target, entry);
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
    const inspect = async (file, stat) => {
      if (linked || inside(target, file)) return false;
      if (!stat.isSymbolicLink()) return;
      const destination = path.resolve(path.dirname(file), await fsp.readlink(file));
      let real = destination;
      try { real = await fsp.realpath(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (inside(target, destination) || inside(target, real)) linked = true;
    };
    await walk(worktreeRoot, inspect);
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
          await inspect(folder, stat);
        } else if (stat.isDirectory()) await walk(folder, inspect);
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
    let target;
    try { target = await git(entry.cwd, ["rev-parse", "--show-toplevel"]); } catch (error) {
      if (error.code !== 128 || !error.message.includes("not a git repository")) throw error;
      entry.worktreeDone = true;
      return;
    }
    if (!inside(worktreeRoot, target) || normalize(target) === normalize(worktreeRoot) || !await directory(target)) return;
    const isPinned = async () => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Accept fixed pins or a loader that refreshes them.
      for (const pin of typeof pinned === "function" ? await pinned() : pinned) {
        if (inside(target, pin) || inside(pin, target)) return true;
        const resolved = await resolvePin(pin);
        if (inside(target, resolved) || inside(resolved, target)) return true;
      }
      return false;
    };
    if (KEEP_RE.test(path.basename(target)) || await isPinned()) return;
    const recent = async () => {
      for (const other of entries) {
        if (other.closedAt && now() - other.closedAt >= DAY_MS) continue;
        if (inside(target, other.cwd) || inside(target, await resolvePin(other.cwd))) return true;
      }
      return false;
    };
    if (await recent()) return;
    const busy = async () => {
      for (const pane of panes()) if (inside(target, pane.cwd) || inside(target, await resolvePin(pane.cwd))) return true;
      return false;
    };
    if (await busy() || !await directory(worktreeRoot)) return;
    if (await git(target, ["status", "--porcelain"])) return;
    if (await git(target, ["rev-list", "HEAD", "--not", "--remotes"]) !== "") return;
    const registered = await git(target, ["worktree", "list", "--porcelain"]);
    const registration = registered.split("\n\n").find((record) => record.split("\n").some((line) => line.startsWith("worktree ") && normalize(line.slice(9)) === normalize(target)));
    if (!registration || /^locked(?: |$)/m.test(registration)) return;
    const common = await git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const gitdir = await git(target, ["rev-parse", "--absolute-git-dir"]);
    if (normalize(gitdir) === normalize(common)) return;
    let changed = (await fsp.lstat(target)).mtimeMs;
    await walk(target, (_file, stat) => { changed = Math.max(changed, stat.mtimeMs); });
    if (now() - changed < DAY_MS || await linkedInto(target) || await busy() || await isPinned()) return;
    const tracked = new Set((await git(target, ["ls-files", "-z"])).split("\0").filter(Boolean).map((file) => normalize(path.resolve(target, file))));
    await unlinkLinks(target, tracked);
    if (await busy() || !await directory(target) || await isPinned() || await git(target, ["status", "--porcelain"])) return;
    // Git can traverse tracked Windows junctions while removing the worktree.
    for (const file of tracked) if ((await fsp.lstat(file)).isSymbolicLink()) return;
    const owned = entries.filter((other) => !other.worktreeDone && inside(target, other.cwd));
    for (const other of owned) other.worktreeDone = true;
    if (!save()) { for (const other of owned) other.worktreeDone = false; return; }
    try {
      const removed = await removeWithBackup(target, gitdir, async () => {
        if (!await directory(target) || !await directory(worktreeRoot) || await git(target, ["status", "--porcelain"]) || await isPinned() || await busy() || await recent()) return false;
        return git(common, ["worktree", "remove", target]);
      }, warn);
      if (removed === false) {
        for (const other of owned) other.worktreeDone = false;
        save();
        return;
      }
    } catch (error) {
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
      const root = resolveTempRoot(session.tempRoot || tempRoot);
      entries.push({ id: session.id, botId: session.botId, label: session.label, cwd: session.cwd, tempRoot: root, scratch: nick(session.label) ? path.resolve(root, `wink-${nick(session.label)}`) : null, openedAt: now(), closedAt: null, keep: false, reported: false });
      save();
    },
    exited(session) {
      const entry = entries.findLast((candidate) => candidate.id === session.id);
      if (entry && !entry.closedAt) { entry.closedAt = now(); save(); }
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
