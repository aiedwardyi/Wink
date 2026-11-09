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
const contains = (root, file) => file === root || file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
const canonical = (file) => process.platform === "win32" ? file.toLowerCase() : file;
async function normalizeAsync(file, parents = null) {
  const resolved = path.resolve(file);
  if (process.platform !== "win32") return resolved;
  let current = path.parse(resolved).root;
  const parts = resolved.slice(current.length).split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const cached = parents?.get(current);
    if (cached) { current = cached; continue; }
    try {
      if ((await fsp.lstat(current)).isSymbolicLink()) return path.join(current, ...parts.slice(index + 1)).toLowerCase();
      const real = await fsp.realpath(current);
      parents?.set(current, real);
      current = real;
    } catch {
      return path.join(current, ...parts.slice(index + 1)).toLowerCase();
    }
  }
  return current.toLowerCase();
}
const scope = () => {
  const names = new Map();
  const parents = new Map();
  const norm = (file) => {
    const key = path.resolve(file);
    if (!names.has(key)) names.set(key, normalizeAsync(key, parents));
    return names.get(key);
  };
  return { norm, cache: new Map(), stats: { calls: 0, dirs: 0, links: 0, ms: 0 } };
};
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
  return stat.isDirectory() && !stat.isSymbolicLink() && canonical(await fsp.realpath(root)) === await normalizeAsync(root);
}

function resolveTempRoot(root) {
  if (!path.isAbsolute(root)) return root;
  try {
    const real = fs.realpathSync.native(root);
    return normalize(root) === normalize(real) ? root : real;
  } catch { return root; }
}

async function identity(file) {
  const { dev, ino } = await fsp.lstat(file, { bigint: true });
  return `${dev}:${ino}`;
}

async function absent(file) {
  try { await fsp.lstat(file); } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  return false;
}

// AF_UNIX sockets are reparse points lstat denies; readlink's EINVAL proves they are not links.
async function statEntry(file) {
  try { return await fsp.lstat(file); } catch (error) {
    if (error.code !== "EACCES") throw error;
    try { await fsp.readlink(file); } catch (link) { if (link.code === "EINVAL") return null; }
    throw error;
  }
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

async function walk(root, visit, depth = Infinity, normalized = null) {
  normalized ??= await normalizeAsync(root);
  for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    const stat = await statEntry(file);
    if (!stat) continue;
    const name = canonical(path.join(normalized, entry.name));
    if (await visit(file, stat, depth, name) !== false && stat.isDirectory() && !stat.isSymbolicLink() && depth > 1) await walk(file, visit, depth - 1, name);
  }
  await new Promise((resolve) => setImmediate(resolve));
}

async function unlinkLinks(root, tracked = new Set(), current = () => true) {
  let checkedAt = -Infinity;
  let active = true;
  const check = async (fresh) => {
    if (active && (fresh || Date.now() - checkedAt >= 250)) {
      active = await current();
      checkedAt = Date.now();
    }
    return active;
  };
  const owned = (file, stat) => stat.isSymbolicLink() && !tracked.has(file);
  await walk(root, async (file, stat, _depth, normalized) => {
    const link = owned(normalized, stat);
    if (await check(link) && link) await fsp.unlink(file);
  });
  await walk(root, async (file, stat, _depth, normalized) => {
    const link = owned(normalized, stat);
    if (await check(link) && link) throw new Error("link appeared during cleanup");
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

export function createPaneCleanup({ home, tempRoot = os.tmpdir(), worktreeRoot = path.join(home, "orbit-wt"), pinned = [], now = Date.now, retryMs = 60_000, schedule = setTimeout, cancel = clearTimeout, setPriority = os.setPriority, instance = process.defaultApp ? process.env.OMB_USER_DATA || "dev" : "app", warn = () => {} }) {
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
  // Rows from before instance ids stay closable by any instance.
  for (const entry of entries) if (!entry.closedAt && (entry.instance ?? instance) === instance) entry.closedAt = now();
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
  const record = async (kind, target, fields) => {
    await fsp.appendFile(log, JSON.stringify({ at: new Date(now()).toISOString(), kind, path: target, ...fields }) + "\n", { mode: 0o600 });
  };
  const kept = async (entry, target, reason) => {
    if (entry.kept === reason) return;
    entry.kept = reason;
    await record("kept", target, { reason });
  };
  const scratchFor = async (entry, norm) => {
    const name = nick(entry.label);
    if (!name || !path.isAbsolute(entry.tempRoot)) return null;
    const target = path.resolve(entry.tempRoot, `wink-${name}`);
    return await norm(path.dirname(target)) === await norm(entry.tempRoot) && target === entry.scratch ? target : null;
  };
  const scratchBusy = async (entry, target) => {
    const label = nick(entry.label);
    // One memo per recheck: sharing it across rechecks would hide a re-pointed junction.
    const parents = new Map();
    for (const pane of panes()) if (nick(pane.label) === label || contains(target, await normalizeAsync(pane.cwd, parents)) || contains(target, await normalizeAsync(await resolvePin(pane.cwd), parents))) return true;
    return false;
  };
  const finishScratch = async (target, owner, norm) => {
    const normalized = await norm(target);
    for (const entry of entries.slice(0, entries.indexOf(owner) + 1)) if (!entry.scratchDone && entry.scratch && await norm(entry.scratch) === normalized) entry.scratchDone = true;
    save();
  };
  const removeScratch = async (entry, retry = true, context = scope()) => {
    if (entry.scratchDone) return;
    const target = await scratchFor(entry, context.norm);
    if (!target) { entry.scratchDone = true; return; }
    const normalized = await context.norm(target);
    const name = path.basename(normalized);
    const current = async () => {
      if (await scratchBusy(entry, normalized)) return false;
      const count = entries.length;
      const parents = new Map();
      for (const other of entries.toReversed()) {
        if (!other.scratch) continue;
        const file = path.resolve(other.scratch);
        const leaf = canonical(path.basename(file));
        // Only a short alias can change a valid scratch basename.
        const alias = process.platform === "win32" && (leaf.length <= 12 || !/^wink-[a-z0-9-]+$/.test(leaf));
        if (leaf !== name && !alias) continue;
        if (await normalizeAsync(file, parents) === normalized) return other === entry && !await scratchBusy(entry, normalized) && entries.length === count;
      }
      return false;
    };
    try {
      if (!await current()) return;
      try { await fsp.lstat(target); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (await current()) await finishScratch(target, entry, context.norm);
        return;
      }
      if (!await directory(target)) return;
      if (await linkedInto(target, context)) return kept(entry, target, "linked");
      if (!await unlinkLinks(target, new Set(), current)) return;
      if (!await directory(target) || !await current()) return;
      if (await linkedInto(target, context)) return kept(entry, target, "linked");
      if (!await current()) return;
      await fsp.rm(target, { recursive: true });
      await finishScratch(target, entry, context.norm);
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
  const linkedInto = async (target, { cache, stats }) => {
    const started = performance.now();
    const normalized = await normalizeAsync(target);
    const parents = new Map();
    let linked = false;
    const inspect = async (file, name, temp = false) => {
      if (contains(normalized, name)) return;
      let stat;
      try { stat = await statEntry(file); } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      if (!stat) return;
      if (stat.isSymbolicLink()) {
        stats.links++;
        const destination = path.resolve(path.dirname(file), await fsp.readlink(file));
        let real = null;
        try { real = canonical(await fsp.realpath(file)); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (contains(normalized, await normalizeAsync(destination, parents)) || (real && contains(normalized, real))) linked = true;
        return;
      }
      if (!stat.isDirectory()) return;
      stats.dirs++;
      let saved = cache.get(name);
      if (!saved || ["dev", "ino", "mtimeMs", "ctimeMs"].some((key) => saved[key] !== stat[key])) {
        const names = (await fsp.readdir(file, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
        saved = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, names };
        cache.set(name, saved);
      }
      for (const child of saved.names) if (!temp || child.startsWith("wink-")) await inspect(path.join(file, child), canonical(path.join(name, child)));
    };
    try {
      try {
        if (!await directory(worktreeRoot)) return true;
        await inspect(worktreeRoot, await normalizeAsync(worktreeRoot, parents));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const roots = new Set([tempRoot, ...entries.map((entry) => entry.tempRoot)]);
      for (const root of roots) {
        try {
          if (!await directory(root)) throw new Error("linked TEMP root");
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        await inspect(root, await normalizeAsync(root, parents), true);
      }
      return linked;
    } finally {
      stats.calls++;
      stats.ms += performance.now() - started;
    }
  };
  const resume = async (entry) => {
    const { target, id } = entry.deleting;
    let current = null;
    try { current = await identity(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
    // A different folder at the path is a reuse, never the one being deleted.
    for (const other of entries) {
      if (other.deleting?.target !== target || other.deleting.id !== id) continue;
      delete other.deleting;
      if (current !== id) other.worktreeDone = true;
    }
    save();
    return current === id;
  };
  const removeWorktree = async (entry, context, retained) => {
    if (entry.worktreeDone) return;
    if (entry.deleting && !await resume(entry)) return;
    const { norm } = context;
    if (retained.size) {
      const cwd = await norm(entry.cwd);
      if ([...retained].some((target) => contains(target, cwd))) return;
    }
    const root = await norm(worktreeRoot);
    const cwd = await norm(entry.cwd);
    if (!contains(root, cwd) || cwd === root) { entry.worktreeDone = true; return; }
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
    const base = await norm(target);
    if (!contains(root, base) || base === root || !await directory(target)) return;
    const keep = (reason) => kept(entry, target, reason);
    const covers = (file) => contains(base, file) || contains(file, base);
    const isPinned = async () => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Accept fixed pins or a loader that refreshes them.
      for (const pin of typeof pinned === "function" ? await pinned() : pinned) {
        if (covers(await norm(pin)) || covers(canonical(await resolvePin(pin)))) return true;
      }
      return false;
    };
    if (KEEP_RE.test(path.basename(target))) return keep("keep name");
    if (await isPinned()) return keep("pinned");
    const recent = async () => {
      for (const other of entries) {
        if (other.closedAt && now() - other.closedAt >= DAY_MS) continue;
        if (contains(base, await norm(other.cwd)) || contains(base, canonical(await resolvePin(other.cwd)))) return true;
      }
      return false;
    };
    if (await recent()) return;
    const busy = async () => {
      for (const pane of panes()) if (contains(base, await norm(pane.cwd)) || contains(base, canonical(await resolvePin(pane.cwd)))) return true;
      return false;
    };
    const dirty = () => git(target, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
    const unpushed = async () => await git(target, ["rev-list", "HEAD", "--not", "--remotes"]) !== "";
    if (await busy() || !await directory(worktreeRoot)) return;
    if (await git(target, ["status", "--porcelain"])) return keep("dirty");
    if (await unpushed()) return keep("unpushed");
    const registered = await git(target, ["worktree", "list", "--porcelain"]);
    let registration;
    for (const block of registered.split("\n\n")) {
      const line = block.split("\n").find((candidate) => candidate.startsWith("worktree "));
      if (line && await norm(line.slice(9)) === base) { registration = block; break; }
    }
    if (!registration) return keep("unregistered");
    if (/^locked(?: |$)/m.test(registration)) return keep("locked");
    const common = await git(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const gitdir = await git(target, ["rev-parse", "--absolute-git-dir"]);
    if (await norm(gitdir) === await norm(common)) return keep("primary checkout");
    let changed = (await fsp.lstat(target)).mtimeMs;
    await walk(target, (_file, stat) => { changed = Math.max(changed, stat.mtimeMs); });
    if (now() - changed < DAY_MS || await busy()) return;
    if (await isPinned()) return keep("pinned");
    if (await linkedInto(target, context)) { retained.add(base); return keep("linked"); }
    const tracked = new Set((await git(target, ["ls-files", "-z"])).split("\0").filter(Boolean).map((file) => canonical(path.join(base, file))));
    await unlinkLinks(target, tracked, async () => !await busy() && !await isPinned());
    if (await busy() || !await directory(target) || await isPinned() || await git(target, ["status", "--porcelain"])) return;
    // Git can traverse tracked Windows junctions while removing the worktree.
    for (const file of tracked) if ((await fsp.lstat(file)).isSymbolicLink()) return keep("tracked link");
    const owned = [];
    for (const other of entries) if (!other.worktreeDone && contains(base, await norm(other.cwd))) owned.push(other);
    const deleting = { target, id: await identity(target) };
    const release = () => { for (const other of owned) delete other.deleting; };
    for (const other of owned) other.deleting = deleting;
    if (!save()) { release(); return; }
    let held = null;
    const final = async () => {
      if (await linkedInto(target, context)) return "linked";
      if (!await directory(target) || !await directory(worktreeRoot)) return "";
      if (await dirty()) return "dirty";
      if (await unpushed()) return "unpushed";
      if (await isPinned()) return "pinned";
      return await busy() || await recent() ? "" : null;
    };
    try {
      const removed = await removeWithBackup(target, gitdir, async () => {
        held = await final();
        return held === null && git(common, ["worktree", "remove", target]);
      }, warn);
      if (removed === false || !await absent(target)) {
        release();
        save();
        if (held) await keep(held);
        return;
      }
    } catch (error) {
      release();
      save();
      throw error;
    }
    for (const other of owned) other.worktreeDone = true;
    release();
    save();
    await record("worktree", target);
  };
  const sweep = () => enqueue(async () => {
    const context = scope();
    const cpu = process.cpuUsage();
    const retained = new Set();
    for (const entry of entries) {
      if (!entry.closedAt || now() - entry.closedAt < DAY_MS || panes().some((pane) => pane.id === entry.id)) continue;
      if (now() - entry.closedAt >= (entry.keep ? 3 : 1) * DAY_MS) await removeScratch(entry, true, context);
      try { await removeWorktree(entry, context, retained); } catch (error) { if (error.code !== "ENOENT") warn(error); }
    }
    entries = entries.filter((entry) => !entry.closedAt || !entry.scratchDone || !entry.worktreeDone);
    save();
    const { stats } = context;
    if (stats.calls) await record("links", undefined, { ...stats, ms: Math.round(stats.ms) });
    const { user, system } = process.cpuUsage(cpu);
    await record("sweep", undefined, { cpuMs: Math.round((user + system) / 1_000) });
  });
  return {
    opened(session) {
      const root = resolveTempRoot(session.tempRoot || tempRoot);
      entries.push({ id: session.id, instance, botId: session.botId, label: session.label, cwd: session.cwd, tempRoot: root, scratch: nick(session.label) ? path.resolve(root, `wink-${nick(session.label)}`) : null, openedAt: now(), closedAt: null, keep: false, reported: false });
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
