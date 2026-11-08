import { randomUUID } from "node:crypto";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { canonicalAccountHome, type AccountContext } from "./account-policy.ts";
import { DATA_DIR } from "./config.ts";

const SETTLE_MS = 2000; // coarsest timestamp tick (FAT): a change in the scan's own tick leaves mtime equal
const skillScans = new Map<string, { sourceMtimeMs: number; destinationMtimeMs: number }>();

export function shareUserSetup(driver: string, account: AccountContext, baseHome: string): void {
  const attempt = (name: string, action: () => void) => {
    try { action(); return true; } catch { console.warn("Could not share user setup:", name); return false; }
  };
  let sameHome = true;
  attempt("home", () => { sameHome = canonicalAccountHome(baseHome) === canonicalAccountHome(account.home); });
  if (sameHome || !["claudeAgent", "codex"].includes(driver)) return;
  const present = (path: string) => lstatSync(path, { throwIfNoEntry: false });
  const sourceStat = (path: string) => statSync(path, { throwIfNoEntry: false });
  const link = (source: string, destination: string) => {
    if (!sourceStat(source)?.isDirectory() || present(destination)) return;
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(resolve(source), destination, "junction");
  };
  if (driver === "claudeAgent") {
    attempt("CLAUDE.md", () => {
      const destination = join(account.home, "CLAUDE.md");
      if (!sourceStat(join(baseHome, "CLAUDE.md"))?.isFile() || present(destination)) return;
      const defaultBase = canonicalAccountHome(baseHome) === canonicalAccountHome(join(homedir(), ".claude"));
      const path = resolve(baseHome).replace(/\\/g, "/");
      if (!defaultBase && /#|[^\S ]/u.test(path)) { console.warn("Cannot include user setup:", "CLAUDE.md"); return; }
      mkdirSync(account.home, { recursive: true });
      writeFileSync(destination, defaultBase ? "@~/.claude/CLAUDE.md\n" : `@${path.replace(/ /g, "\\ ")}/CLAUDE.md\n`, { encoding: "utf8", flag: "wx" });
    });
    for (const name of ["rules", "agents", "commands", "output-styles"]) attempt(name, () => link(join(baseHome, name), join(account.home, name)));
  }
  attempt("skills", () => {
    const scanStart = Date.now();
    const source = join(baseHome, "skills");
    const sourceInfo = sourceStat(source);
    if (!sourceInfo?.isDirectory()) return;
    const destination = join(account.home, "skills");
    const destinationInfo = present(destination);
    const key = `${canonicalAccountHome(source)}\0${canonicalAccountHome(destination)}`;
    const cached = skillScans.get(key);
    if (destinationInfo?.isDirectory() && cached?.sourceMtimeMs === sourceInfo.mtimeMs && cached.destinationMtimeMs === destinationInfo.mtimeMs) return;
    skillScans.delete(key);
    let complete = true;
    for (const name of readdirSync(source)) {
      if (name === "synced" || name.startsWith(".")) continue;
      if (!attempt(name, () => link(join(source, name), join(destination, name)))) complete = false;
    }
    const current = present(destination);
    if (complete && current?.isDirectory() && scanStart - Math.max(sourceInfo.mtimeMs, current.mtimeMs) > SETTLE_MS) skillScans.set(key, { sourceMtimeMs: sourceInfo.mtimeMs, destinationMtimeMs: current.mtimeMs });
  });
  if (driver === "codex") attempt("AGENTS.md", () => {
    const override = join(baseHome, "AGENTS.override.md");
    const source = sourceStat(override)?.isFile() ? override : join(baseHome, "AGENTS.md");
    const sourceInfo = sourceStat(source);
    const destination = join(account.home, "AGENTS.md");
    const destinationInfo = present(destination);
    const recordPath = join(DATA_DIR, "account-shared", `${account.id}.json`);
    type Stamp = { size: number; mtimeMs: number };
    let record: { source: Stamp; destination: Stamp } | undefined;
    const recordInfo = present(recordPath);
    if (recordInfo) {
      try { record = JSON.parse(readFileSync(recordPath, "utf8")); }
      catch { console.warn("Could not read user setup record:", "AGENTS.md"); }
    }
    const stamp = ({ size, mtimeMs }: Stamp): Stamp => ({ size, mtimeMs });
    const matches = (info: Stamp, saved?: Stamp) => info.size === saved?.size && info.mtimeMs === saved.mtimeMs;
    const owned = destinationInfo?.isFile() && matches(destinationInfo, record?.destination);
    if (!sourceInfo?.isFile()) {
      if (owned) rmSync(destination);
      if ((!destinationInfo || owned) && recordInfo) rmSync(recordPath, { force: true });
      return;
    }
    if (destinationInfo && (!owned || matches(sourceInfo, record?.source))) return;
    mkdirSync(account.home, { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      copyFileSync(source, temporary);
      renameSync(temporary, destination);
      const destinationStat = present(destination)!;
      mkdirSync(dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, JSON.stringify({ source: stamp(sourceInfo), destination: stamp(destinationStat) }), "utf8");
    } finally { rmSync(temporary, { force: true }); }
  });
}
