import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createWorkerPeak } from "./worker-peak.mjs";

const DAY_MS = 24 * 60 * 60_000;
const SWEEP_MS = 6 * 60 * 60_000;
const FOLLOW_MS = 10 * 60_000;
const NICK_RE = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const KEEP_RE = /^(?:rel-|nm-)|^(?:relay-deploy|release-gate)$/i;
const BACKUP_RE = /^\.pane-cleanup-/i;
const RECHECK = new Set(["dirty", "unpushed"]);
const SETTLE_MS = 50;
// `walk` caps the ignored-file walk per worktree; past it the worktree is kept, never deleted on a partial look.
export const SWEEP_BUDGET = { dirs: 500_000, ms: 10 * 60_000, walk: 100_000 };
// Only Windows watches recursively without a startup walk or delivery lag.
const WATCH = process.platform === "win32";
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
  const context = { norm, cache: new Map(), resolved: new Map(), pins: null, stats: { calls: 0, dirs: 0, links: 0, builds: 0, ms: 0 }, index: null, close: () => {
    for (const watcher of [...context.index?.watchers ?? [], ...context.index?.sections.values() ?? []]) watcher.close();
    context.index = null;
  } };
  return context;
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

// Status can't see ignored files, so a long run writing under one only shows in mtimes.
async function writtenSince(file, since, stats, walk) {
  const stat = await statEntry(file);
  if (!stat) return false;
  if (stat.mtimeMs > since) return true;
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  stats.dirs++;
  if (--walk.left < 0) return true;
  for (const name of await fsp.readdir(file)) if (await writtenSince(path.join(file, name), since, stats, walk)) return true;
  return false;
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
  const real = canonical(await fsp.realpath(copy));
  await walk(root, async (file, stat) => {
    const relative = path.relative(root, file);
    const destination = path.join(copy, relative);
    if (stat.isDirectory()) {
      await fsp.mkdir(destination, { recursive: true });
      const made = await fsp.lstat(destination);
      if (!made.isDirectory() || made.isSymbolicLink() || canonical(await fsp.realpath(destination)) !== canonical(path.join(real, relative))) throw new Error("linked cleanup backup destination");
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

export function createPaneCleanup({ home, tempRoot = os.tmpdir(), worktreeRoot = path.join(home, "orbit-wt"), pinned = [], now = Date.now, retryMs = 60_000, schedule = setTimeout, cancel = clearTimeout, setPriority = os.setPriority, instance = process.defaultApp ? process.env.OMB_USER_DATA || "dev" : "app", budget = SWEEP_BUDGET, peakFile = null, warn = () => {} }) {
  tempRoot = resolveTempRoot(tempRoot);
  const git = (cwd, args) => runGit(cwd, args, setPriority);
  const file = path.join(home, ".orbit", "pane-ledger.json");
  const log = path.join(home, ".orbit", "cleanup.log");
  const stamp = path.join(home, ".orbit", "cleanup-sweep.json");
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(entries)) entries = [];
  } catch { entries = []; }
  entries = entries.filter((entry) => entry && typeof entry.id === "string" && typeof entry.cwd === "string" && typeof entry.tempRoot === "string");
  // Rows from before instance ids stay closable by any instance.
  for (const entry of entries) if (!entry.closedAt && (entry.instance ?? instance) === instance) entry.closedAt = now();
  const peak = peakFile ? createWorkerPeak(peakFile, entries, now, warn) : null;
  let panes = () => [];
  let tail = Promise.resolve();
  let timer = null;
  let started = false;
  let stopped = false;
  let cursor = null;
  let closing = null;
  const retries = new Set();
  const live = new Set();
  const fresh = async (run) => {
    const context = scope();
    live.add(context);
    try { return await run(context); } finally {
      live.delete(context);
      context.close();
    }
  };
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
    for (const pane of await panes()) if (nick(pane.label) === label || contains(target, await normalizeAsync(pane.cwd, parents)) || contains(target, await normalizeAsync(await resolvePin(pane.cwd), parents))) return true;
    return false;
  };
  const finishScratch = async (target, owner, norm) => {
    const normalized = await norm(target);
    for (const entry of entries.slice(0, entries.indexOf(owner) + 1)) if (!entry.scratchDone && entry.scratch && await norm(entry.scratch) === normalized) entry.scratchDone = true;
    save();
  };
  const removeScratch = async (entry, retry, context) => {
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
      const linked = await linkedInto(target, context);
      if (linked) return kept(entry, target, linked);
      if (!await unlinkLinks(target, new Set(), current)) return;
      if (!await directory(target) || !await current()) return;
      const late = await linkedInto(target, context, true);
      if (late) return kept(entry, target, late);
      if (!await current()) return;
      await fsp.rm(target, { recursive: true });
      await finishScratch(target, entry, context.norm);
      await record("scratch", target);
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (retry && ["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(error.code)) {
        const handle = schedule(() => {
          retries.delete(handle);
          if (!stopped) void enqueue(() => fresh((context) => removeScratch(entry, false, context)));
        }, retryMs);
        handle.unref?.();
        retries.add(handle);
      } else warn(error);
    }
  };
  const drop = (index, name) => { for (const key of index.links.keys()) if (contains(name, key)) index.links.delete(key); };
  const inspect = async (context, file, name, top = null, deep = true, section = null) => {
    const { index, cache, stats } = context;
    if (index.skip && contains(index.skip.name, name)) { index.skip.seen = true; return; }
    let stat;
    let gone = false;
    try { stat = await statEntry(file); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      gone = true;
    }
    if (section && !(stat?.isDirectory() && !stat.isSymbolicLink())) {
      index.sections.get(name)?.close();
      index.sections.delete(name);
    }
    if (gone) return drop(index, name);
    if (!stat?.isSymbolicLink()) index.links.delete(name);
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      stats.links++;
      let destination;
      try { destination = path.resolve(path.dirname(file), await fsp.readlink(file)); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return drop(index, name);
      }
      let real = null;
      try { real = canonical(await fsp.realpath(file)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const link = { file, destination: await normalizeAsync(destination, index.parents), real };
      const before = index.links.get(name);
      if (!before || before.destination !== link.destination || before.real !== link.real) {
        index.relinked = true;
        index.touched = true;
      }
      index.links.set(name, link);
      return;
    }
    if (!deep || !stat.isDirectory()) return;
    stats.dirs++;
    if (section && WATCH) {
      index.sections.get(name)?.close();
      try { index.sections.set(name, watch(index, section, file)); } catch { index.doubt = true; }
    }
    let saved = cache.get(name);
    if (!saved || ["dev", "ino", "mtimeMs", "ctimeMs"].some((key) => saved[key] !== stat[key])) {
      let names;
      try { names = await fsp.readdir(file, { withFileTypes: true }); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return drop(index, name);
      }
      names = names.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !BACKUP_RE.test(entry.name)).map((entry) => entry.name);
      saved = { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, names };
      cache.set(name, saved);
      index.touched = true;
    }
    for (const child of saved.names) if (!top?.temp || child.startsWith("wink-")) await inspect(context, path.join(file, child), canonical(path.join(name, child)), null, true, top);
  };
  const linkRoots = async () => {
    const roots = [];
    try {
      if (!await directory(worktreeRoot)) return null;
      roots.push({ file: worktreeRoot, temp: false });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const root of new Set([tempRoot, ...entries.map((entry) => entry.tempRoot)])) {
      try {
        if (!await directory(root)) throw new Error("linked TEMP root");
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      roots.push({ file: root, temp: true });
    }
    return roots;
  };
  const watch = (index, root, dir = root.file) => {
    const base = path.relative(root.file, dir);
    const note = (rel, deep) => {
      const file = path.join(root.file, rel);
      index.changes.set(file, { root, rel, deep: deep || !!index.changes.get(file)?.deep });
    };
    const lost = () => { if (base) note(base, true); else index.doubt = true; };
    // A root is watched one level deep with a watcher per top folder, so deleting one floods no other.
    const watcher = fs.watch(dir, { recursive: !!base }, (type, rel) => {
      if (!["rename", "change"].includes(type)) index.doubt = true;
      else if (rel == null) lost();
      else {
        const parts = path.join(base, rel).split(path.sep);
        if (parts.some((part) => BACKUP_RE.test(part))) return;
        if (!root.temp || parts[0].startsWith("wink-") || parts[0].includes("~")) note(path.join(base, rel), type === "rename");
      }
    });
    watcher.on("error", lost);
    return watcher;
  };
  const rootId = async (file) => {
    const { dev, ino } = await fsp.stat(file, { bigint: true });
    return `${dev}:${ino}`;
  };
  const moved = async (index) => {
    for (const root of index.roots) {
      try { if (await rootId(root.file) !== root.id) return true; } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return true;
      }
    }
    return false;
  };
  const watched = (index, file) => index.roots.some((root) => contains(root.normalized, file) && (!root.temp || path.relative(root.normalized, file).startsWith("wink-")));
  const build = async (context, roots, key, skip) => {
    const index = { key, roots: [], links: new Map(), changes: new Map(), parents: new Map(), stale: !WATCH, doubt: false, touched: false, relinked: false, watchers: [], sections: new Map(), skip };
    context.index = index;
    context.stats.builds++;
    for (const root of roots) index.roots.push({ ...root, normalized: await normalizeAsync(root.file, index.parents), id: await rootId(root.file) });
    if (WATCH) {
      try { for (const root of index.roots) index.watchers.push(watch(index, root)); } catch { index.doubt = true; }
    }
    for (const root of index.roots) await inspect(context, root.file, root.normalized, root);
  };
  const refresh = async (context, normalized, links) => {
    const { index } = context;
    if (index.stale) return;
    index.parents = new Map();
    // Changes that land while a pass inspects get another pass; a pass that moves no link or folder settles.
    for (let pass = 0; pass < 20; pass++) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      if (index.doubt) return;
      index.touched = false;
      index.relinked = false;
      if (index.skip && index.skip.name !== normalized) {
        const { file, name, seen } = index.skip;
        index.skip = null;
        if (seen) {
          drop(index, name);
          await inspect(context, file, name, null, true, index.roots.find((root) => path.dirname(name) === root.normalized));
        }
      }
      if (!index.changes.size && !index.touched) return;
      const changes = [...index.changes.values()].sort((a, b) => a.rel.length - b.rel.length);
      index.changes.clear();
      const walked = new Set();
      for (const { root, rel, deep } of changes) {
        const file = path.join(root.file, rel);
        // Windows may name a change by its 8.3 alias.
        const name = rel.includes("~") ? await normalizeAsync(file, index.parents) : canonical(path.join(root.normalized, rel));
        const relative = path.relative(root.normalized, name);
        if (!relative) { index.doubt = true; return; }
        if (!contains(root.normalized, name) || relative.split(path.sep).some((part) => BACKUP_RE.test(part)) || (root.temp && !relative.startsWith("wink-"))) continue;
        let parent = name;
        while (parent.length > root.normalized.length && !walked.has(parent)) parent = path.dirname(parent);
        if (walked.has(parent)) continue;
        if (deep) { drop(index, name); walked.add(name); }
        await inspect(context, file, name, null, deep, relative.includes(path.sep) ? null : root);
      }
      // A re-pointed link can redirect any target resolved through it.
      if (links && index.relinked) for (const [name, link] of index.links) await inspect(context, link.file, name, null, false);
      if (!index.touched) return;
    }
    index.doubt = true;
  };
  const resolveLinks = async ({ index, stats }) => {
    // Only a link through another link or out of the watched folders can be re-pointed unseen.
    const groups = new Map();
    for (const link of index.links.values()) {
      stats.links++;
      if (link.real === link.destination && watched(index, link.destination)) continue;
      const group = groups.get(link.destination) ?? [];
      group.push(link);
      groups.set(link.destination, group);
    }
    const pending = [...groups.values()];
    for (let start = 0; start < pending.length; start += 64) await Promise.all(pending.slice(start, start + 64).map(async (group) => {
      let real = null;
      try { real = canonical(await fsp.realpath(group[0].destination)); } catch (error) { if (error.code !== "ENOENT") throw error; }
      for (const link of group) link.real = real;
    }));
  };
  const linkedInto = async (target, context, final = false) => {
    const started = performance.now();
    try {
      const normalized = await normalizeAsync(target);
      const roots = await linkRoots();
      if (!roots) return "linked";
      const key = roots.map(({ file, temp }) => `${temp}:${file}`).join("\0");
      if (context.index?.key !== key) context.close();
      if (context.index?.doubt) return "doubt";
      // A link can resolve through a junction no watcher sees.
      if (final && context.index?.stale === false) await resolveLinks(context);
      if (context.index) await refresh(context, normalized, true);
      if (context.index?.stale) context.close();
      if (!context.index) {
        await build(context, roots, key, { file: target, name: normalized, seen: false });
        await refresh(context, normalized, false);
      }
      // A root renamed aside and recreated leaves its watcher on the old folder.
      if (WATCH && !context.index.doubt && await moved(context.index)) context.index.doubt = true;
      if (context.index.doubt) return "doubt";
      // A watch handle on the candidate would hold up its own delete.
      const own = context.index.sections.get(normalized);
      if (own) {
        own.close();
        context.index.sections.delete(normalized);
        context.index.skip = { file: target, name: normalized, seen: true };
      }
      for (const [name, link] of context.index.links) if (!contains(normalized, name) && (contains(normalized, link.destination) || (link.real && contains(normalized, link.real)))) return "linked";
      return null;
    } catch (error) {
      // A walk cut short leaves an index that misses links.
      if (context.index) context.index.doubt = true;
      throw error;
    } finally {
      context.stats.calls++;
      context.stats.ms += performance.now() - started;
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
    if (entry.deleting) {
      if (!await resume(entry)) return;
    } else if (RECHECK.has(entry.kept) && now() - (entry.checkedAt ?? 0) < DAY_MS) return;
    const { norm } = context;
    if (retained.size) {
      const cwd = await norm(entry.cwd);
      for (const [base, reason] of retained) {
        if (!contains(base, cwd)) continue;
        if (RECHECK.has(reason)) Object.assign(entry, { kept: reason, checkedAt: now() });
        return;
      }
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
    const hold = (reason = "") => { retained.set(base, reason); };
    const keep = (reason) => {
      hold(reason);
      if (RECHECK.has(reason)) entry.checkedAt = now();
      return kept(entry, target, reason);
    };
    const covers = (file) => contains(base, file) || contains(file, base);
    // Early gates may share one lookup per sweep; the checks right before a delete stay fresh.
    const resolved = (file, fresh) => {
      if (fresh) return resolvePin(file).then(canonical);
      if (!context.resolved.has(file)) context.resolved.set(file, resolvePin(file).then(canonical));
      return context.resolved.get(file);
    };
    const pins = (fresh) => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Accept fixed pins or a loader that refreshes them.
      const load = async () => typeof pinned === "function" ? await pinned() : pinned;
      if (fresh) return load();
      context.pins ??= load();
      return context.pins;
    };
    const isPinned = async (fresh = true) => {
      for (const pin of await pins(fresh)) {
        if (covers(await norm(pin)) || covers(await resolved(pin, fresh))) return true;
      }
      return false;
    };
    if (KEEP_RE.test(path.basename(target))) return keep("keep name");
    if (await isPinned(false)) return keep("pinned");
    const recent = async (fresh = true) => {
      for (const other of entries) {
        if (other.closedAt && now() - other.closedAt >= DAY_MS) continue;
        if (contains(base, await norm(other.cwd)) || contains(base, await resolved(other.cwd, fresh))) return true;
      }
      return false;
    };
    if (await recent(false)) return hold();
    const busy = async (fresh = true) => {
      for (const pane of await panes()) if (contains(base, await norm(pane.cwd)) || contains(base, await resolved(pane.cwd, fresh))) return true;
      return false;
    };
    const dirty = () => git(target, ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]);
    const unpushed = async () => await git(target, ["rev-list", "HEAD", "--not", "--remotes"]) !== "";
    if (await busy(false) || !await directory(worktreeRoot)) return hold();
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
    for (const name of await fsp.readdir(target)) changed = Math.max(changed, (await statEntry(path.join(target, name)))?.mtimeMs ?? 0);
    for (const head of [path.join(gitdir, "HEAD"), path.join(gitdir, "logs", "HEAD")]) {
      try { changed = Math.max(changed, (await fsp.lstat(head)).mtimeMs); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const walk = { left: budget.walk ?? SWEEP_BUDGET.walk };
    const written = async () => {
      if (now() - changed < DAY_MS) return true;
      for (const file of (await git(target, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"])).split("\0").filter(Boolean)) {
        if (await writtenSince(path.join(target, file), now() - DAY_MS, context.stats, walk)) return true;
      }
      return false;
    };
    if (await written() || await busy(false)) return walk.left < 0 ? keep("walk cap") : hold();
    if (await isPinned(false)) return keep("pinned");
    const linked = await linkedInto(target, context);
    if (linked) return keep(linked);
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
      const late = await linkedInto(target, context, true);
      if (late) return late;
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
  const sweep = () => enqueue(() => fresh(async (context) => {
    const cpu = process.threadCpuUsage();
    const begun = performance.now();
    const retained = new Map();
    const start = Math.max(0, entries.indexOf(cursor));
    let processed = 0;
    cursor = null;
    for (const entry of [...entries.slice(start), ...entries.slice(0, start)]) {
      if (processed && (context.stats.dirs > budget.dirs || performance.now() - begun > budget.ms)) {
        cursor = entry;
        break;
      }
      if (!entry.closedAt || now() - entry.closedAt < DAY_MS || (await panes()).some((pane) => pane.id === entry.id)) continue;
      processed++;
      if (now() - entry.closedAt >= (entry.keep ? 3 : 1) * DAY_MS) await removeScratch(entry, true, context);
      try { await removeWorktree(entry, context, retained); } catch (error) { if (error.code !== "ENOENT") warn(error); }
    }
    entries = entries.filter((entry) => !entry.closedAt || !entry.scratchDone || !entry.worktreeDone);
    save();
    const { stats } = context;
    if (stats.calls) await record("links", undefined, { ...stats, ms: Math.round(stats.ms) });
    if (cursor) {
      await record("budget", undefined, { dirs: stats.dirs, ms: Math.round(performance.now() - begun) });
      if (started && !stopped) {
        cancel(timer);
        timer = schedule(tick, FOLLOW_MS);
        timer.unref?.();
      }
    }
    const { user, system } = process.threadCpuUsage(cpu);
    await record("sweep", undefined, { cpuMs: Math.round((user + system) / 1_000) });
    fs.writeFileSync(stamp, JSON.stringify({ at: now(), done: !cursor }), { mode: 0o600 });
  }));
  const tick = () => {
    if (stopped) return;
    void sweep();
    timer = schedule(tick, SWEEP_MS);
    timer.unref?.();
  };
  return {
    opened(session) {
      const root = resolveTempRoot(session.tempRoot || tempRoot);
      entries.push({ id: session.id, instance, botId: session.botId, label: session.label, cwd: session.cwd, tempRoot: root, scratch: nick(session.label) ? path.resolve(root, `wink-${nick(session.label)}`) : null, openedAt: now(), closedAt: null, keep: false, reported: false });
      save();
      peak?.live(entries.filter((entry) => !entry.closedAt && entry.instance === instance).length);
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
      if (!entry.reported || entry.keep) return Promise.resolve();
      // Closes that queue together share one link index.
      if (closing) {
        closing.entries.push(entry);
        return closing.done;
      }
      const batch = { entries: [entry] };
      closing = batch;
      batch.done = enqueue(() => {
        if (closing === batch) closing = null;
        return fresh(async (context) => { for (const item of batch.entries) await removeScratch(item, true, context); });
      });
      return batch.done;
    },
    start(openPanes) {
      panes = openPanes;
      started = true;
      if (timer) cancel(timer);
      save();
      let due = 1_000;
      try {
        const { at, done } = JSON.parse(fs.readFileSync(stamp, "utf8"));
        if (Number.isFinite(at)) due = Math.min(SWEEP_MS, Math.max(1_000, at + (done ? SWEEP_MS : FOLLOW_MS) - now()));
      } catch {}
      timer = schedule(tick, due);
      timer.unref?.();
    },
    sweep,
    flush: () => tail,
    dispose() {
      stopped = true;
      cancel(timer);
      for (const handle of retries) cancel(handle);
      retries.clear();
      for (const context of live) context.close();
    },
  };
}

const pick = (session) => ({ id: session.id, botId: session.botId, label: session.label, cwd: session.cwd, tempRoot: session.tempRoot, reportAt: session.reportAt, stallArmedAt: session.stallArmedAt, autoReported: session.autoReported });

export function createPaneCleanupWorker({ warn = () => {}, instance = process.defaultApp ? process.env.OMB_USER_DATA || "dev" : "app", ...options }) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { paneCleanup: { ...options, instance } } });
  const pending = new Map();
  let panes = () => [];
  let next = 0;
  let gone = false;
  const post = (message) => { if (!gone) worker.postMessage(message); };
  const call = (type, fields = {}) => {
    if (gone) return Promise.resolve();
    const id = ++next;
    worker.ref();
    return new Promise((resolve) => {
      pending.set(id, resolve);
      worker.postMessage({ type, id, ...fields });
    });
  };
  worker.on("message", (message) => {
    if (message.type === "warn") warn(message.error);
    else if (message.type === "panes") post({ type: "panes", id: message.id, panes: panes().map(({ id, label, cwd }) => ({ id, label, cwd })) });
    else {
      pending.get(message.id)?.();
      pending.delete(message.id);
      if (!pending.size) worker.unref();
    }
  });
  worker.on("error", warn);
  worker.on("exit", () => {
    gone = true;
    for (const resolve of pending.values()) resolve();
    pending.clear();
  });
  worker.unref();
  return {
    opened: (session) => post({ type: "opened", session: pick(session) }),
    exited: (session) => post({ type: "exited", session: pick(session) }),
    closed: (session, keep = false) => call("closed", { session: pick(session), keep }),
    start(openPanes) {
      panes = openPanes;
      post({ type: "start" });
    },
    sweep: () => call("sweep"),
    flush: () => call("flush"),
    dispose() {
      gone = true;
      return worker.terminate();
    },
  };
}

if (!isMainThread && workerData?.paneCleanup) {
  const { dataDir, ...options } = workerData.paneCleanup;
  const asks = new Map();
  let next = 0;
  const panes = () => new Promise((resolve) => {
    const id = ++next;
    asks.set(id, resolve);
    parentPort.postMessage({ type: "panes", id });
  });
  const cleanup = createPaneCleanup({ ...options, peakFile: path.join(dataDir, "worker-peak.json"), pinned: () => readCleanupPins(dataDir), warn: (error) => parentPort.postMessage({ type: "warn", error: error?.stack || String(error) }) });
  parentPort.on("message", async ({ type, id, session, keep, panes: open }) => {
    if (type === "panes") {
      asks.get(id)?.(open);
      asks.delete(id);
      return;
    }
    if (type === "opened") cleanup.opened(session);
    else if (type === "exited") cleanup.exited(session);
    else if (type === "start") cleanup.start(panes);
    else if (type === "closed") await cleanup.closed(session, keep);
    else if (type === "sweep") await cleanup.sweep();
    else if (type === "flush") await cleanup.flush();
    if (id) parentPort.postMessage({ type: "done", id });
  });
}
