import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir, hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import { readOsMachineId } from "./device-sync.ts";
import { DREAMED_FILE } from "./dream-archive.ts";
import { mergeTimelines, PICKS_FILE } from "./picks.ts";
import { syncRoots, syncWriteRoot } from "./sync-roots.ts";
import { isMemoryTopicName, MEMORY_SEED } from "./workspace.ts";

// each PC writes only its own snapshot here; builds before it share one copy per file under "memory" and never read this folder
export const MEMORY_SYNC_DIR = "memory-v2";
const FORMAT = "orbit.memory-sync";
const LEDGER_FILE = "memory-sync-v2.json";
const LEGACY_LEDGER_FILE = "memory-sync.json";
const LEGACY_SYNC_DIR = "memory";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const DEVICE = /^[0-9a-f]{12}$/;
const SNAPSHOT_FILE = /^([0-9a-f]{12})\.json$/;
const PARKED_FILE = /^memory\/(.+)\.conflict-[0-9a-f]{8}\.md$/;
const PARKED_NOTE = "<!-- memory sync:";
const MEMORY_FILE = "MEMORY.md";

// any language's letters, up to 3 folders deep; never "..", a hidden name or a folder Windows would rename
const TOPIC_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_ .-]{0,199}\.md$/u;
const TOPIC_FOLDER = /^[\p{L}\p{N}_][\p{L}\p{N}\p{M}_ .-]{0,99}(?<![ .])$/u;
const TOPIC_DEPTH = 3;

/** MEMORY.md, or a side file under memory/ that sync carries. */
export const isSyncedFile = (file: string) => {
  if (file === MEMORY_FILE) return true;
  const parts = file.split("/");
  return parts[0] === "memory" && parts.length >= 2 && parts.length <= TOPIC_DEPTH + 2 && TOPIC_NAME.test(parts.at(-1)!) && parts.slice(1, -1).every((part) => TOPIC_FOLDER.test(part));
};
// older builds reject a whole snapshot that names a file outside their rule, so those files ride under a key they skip
const isOlderBuildFile = (file: string) => file === MEMORY_FILE || (file.startsWith("memory/") && isMemoryTopicName(file.slice("memory/".length)));

/** Device id -> the newest edit from that PC a copy includes. */
const versionsSchema = z.record(z.string().regex(DEVICE), z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
type Versions = z.infer<typeof versionsSchema>;
// epoch ms a Date can hold
const time = z.number().int().nonnegative().max(8.64e15);
// the PC a copy came from and when the user last messaged the bot there, so every PC ranks a relayed copy the same
const rankSchema = z.object({ device: z.string().regex(DEVICE), talkedAt: time });
type Rank = z.infer<typeof rankSchema>;

// a copy's lineage: joined, the texts (short hashes) a join built it from; edits, each local edit since, as the text it started from and the lines it cut
const lineage = { joined: z.array(z.string()).optional(), edits: z.array(z.object({ from: z.string(), cut: z.array(z.string()) })).optional() };
type Lineage = { joined?: string[]; edits?: Array<{ from: string; cut: string[] }> };

const filesSchema = z.record(
  z.string().refine(isSyncedFile),
  // tidied: the versions an idle tidy removed lines from, when that is all that changed since them
  z.object({ vv: versionsSchema, at: time, text: z.string().nullable(), by: rankSchema.optional(), tidied: versionsSchema.optional(), ...lineage }),
);

const snapshotSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(1),
  device: z.string().regex(DEVICE),
  // when the user last messaged this bot on that PC
  talkedAt: time,
  files: filesSchema,
  wide: filesSchema.optional(),
  // this build joins copies by line, so a set-aside copy in its snapshot is one it meant to keep apart
  joins: z.literal(1).optional(),
}).transform(({ wide, ...snapshot }) => ({ ...snapshot, files: { ...snapshot.files, ...wide } }));
type Snapshot = z.infer<typeof snapshotSchema>;

const ledgerSchema = z.object({
  device: z.string().regex(DEVICE).optional(),
  jobDevice: z.string().regex(DEVICE).optional(),
  jobOwners: z.record(z.string().regex(ID), z.string().regex(ID)).optional(),
  host: z.string().optional(),
  clock: z.number().int().nonnegative().optional(),
  talked: z.record(z.string(), time).optional(),
  bots: z.record(
    z.string(),
    z.object({
      // per file: the versions this PC holds, the hash of the text they describe, when that text was edited, and the PC it came from
      files: z.record(z.string(), z.object({ vv: versionsSchema, hash: z.string().nullable(), at: time, by: rankSchema.optional(), tidied: versionsSchema.optional(), ...lineage })),
      // what the last pass read, so a bot nothing touched since skips reading every PC's copy
      seen: z.string().optional(),
      // the idle tidy's last change to MEMORY.md, as text hashes, until a pass takes it in
      tidy: z.object({ from: z.string(), to: z.string() }).optional(),
    }),
  ),
});
export type MemorySyncLedger = z.infer<typeof ledgerSchema>;
type FileState = MemorySyncLedger["bots"][string]["files"][string];

/** The older build's ledger: `<botSyncId>/<file>` -> the hash it last agreed on; `~<botSyncId>/<file>` -> the other PC's hash its copy builds on. */
export type LegacyMemoryLedger = Record<string, string>;

export type MemorySyncResult = "pushed" | "pulled" | "conflict" | "current" | "skipped";

export function loadMemorySyncLedger(dataDir: string): MemorySyncLedger {
  try {
    return ledgerSchema.parse(JSON.parse(readFileSync(join(dataDir, LEDGER_FILE), "utf8")));
  } catch {
    return { bots: {} };
  }
}

export function saveMemorySyncLedger(dataDir: string, ledger: MemorySyncLedger): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(join(dataDir, LEDGER_FILE), `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
}

/** Saves the ledger unless it equals `saved`, the text last written; returns what is now on disk. A failed save throws, so the caller still holds the old text and the next call retries. */
export function saveMemorySyncLedgerIfChanged(dataDir: string, ledger: MemorySyncLedger, saved: string): string {
  const text = JSON.stringify(ledger);
  if (text === saved) return saved;
  saveMemorySyncLedger(dataDir, ledger);
  return text;
}

export function loadLegacyMemoryLedger(dataDir: string): LegacyMemoryLedger {
  try {
    return z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(join(dataDir, LEGACY_LEDGER_FILE), "utf8")));
  } catch {
    return {};
  }
}

export function memorySyncDir(folder: string, botSyncId: string): string {
  if (!ID.test(botSyncId)) throw new Error("Invalid bot sync id");
  return join(folder, MEMORY_SYNC_DIR, botSyncId);
}

/** The user messaged this bot on this PC, so this PC's copy wins a tie. */
export function markTalked(ledger: MemorySyncLedger, botSyncId: string, now = Date.now()): void {
  (ledger.talked ??= {})[botSyncId] = now;
}

/** A peer's snapshot landed: idle bots take it now; a bot mid-turn is skipped, so its turn's settle must sync it. */
export function peerMemoryLanded(botSyncId: string, botMap: Record<string, string>, busy: (botId: string) => boolean, sync: (botId: string) => void): void {
  for (const [botId, syncId] of Object.entries(botMap)) if (syncId === botSyncId && !busy(botId)) sync(botId);
}

const hash = (text: string | null) => (text === null ? null : createHash("sha256").update(text).digest("hex"));

// null = absent; undefined = unreadable (a Drive placeholder), left alone until a later pass
function readText(path: string, file: string): string | null | undefined {
  try {
    const text = readFileSync(path, "utf8");
    return file === MEMORY_FILE && (!text.trim() || text === MEMORY_SEED) ? null : text;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    return undefined;
  }
}

function writeText(path: string, text: string | null): void {
  if (text === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, text, { mode: 0o600 });
}

// MEMORY.md plus every synced file under memory/; undefined when a topic folder exists but cannot be listed
function memoryFiles(root: string): string[] | undefined {
  const files = [MEMORY_FILE];
  const walk = (folder: string, depth: number): boolean => {
    if (!existsSync(join(root, folder))) return true;
    try {
      for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
        const file = `${folder}/${entry.name}`;
        if (entry.isDirectory()) {
          if (depth < TOPIC_DEPTH && TOPIC_FOLDER.test(entry.name) && !walk(file, depth + 1)) return false;
        } else if (isSyncedFile(file)) files.push(file);
      }
      return true;
    } catch {
      return false;
    }
  };
  return walk("memory", 0) ? files : undefined;
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// partial: a snapshot file could not be read or parsed (a Drive placeholder), so a pass over it must not be taken as seen
type Snapshots = Snapshot[] & { partial?: true };

const partialOf = (snapshots: Snapshot[], partial: boolean): Snapshots => (partial ? Object.assign(snapshots, { partial: true as const }) : snapshots);

// undefined when the folder cannot be listed; a snapshot Drive has not finished delivering is skipped until it parses
function readSnapshots(dir: string): Snapshots | undefined {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  let partial = false;
  const read = names.sort().flatMap((name) => {
    const device = SNAPSHOT_FILE.exec(name)?.[1];
    try {
      const parsed = device ? snapshotSchema.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8"))) : undefined;
      return parsed?.success && parsed.data.device === device ? [parsed.data] : [];
    } catch {
      partial ||= Boolean(device);
      return [];
    }
  });
  return partialOf(read, partial);
}

// a file written within this of the pass may change again under the same time and size, so it is never taken as seen
const RACY_MS = 2_000;

// sizes and times of every file a pass reads, plus the state it compares them to; undefined when a folder cannot be listed or a file is too new to trust
function passInputs(dirs: string[], workspace: string, local: string[], bot: MemorySyncLedger["bots"][string], talkedAt: number, me: string, now: number) {
  const paths = local.map((file) => join(workspace, file));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      paths.push(...readdirSync(dir).sort().map((name) => join(dir, name)));
    } catch {
      return undefined;
    }
  }
  const stats: string[] = [String(existsSync(workspace))];
  for (const path of paths) {
    try {
      const stat = statSync(path);
      if (Math.max(stat.mtimeMs, stat.ctimeMs) > now - RACY_MS) return undefined;
      stats.push(`${path}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
    } catch {
      stats.push(`${path}:-`);
    }
  }
  return hash(JSON.stringify([stats, bot.files, talkedAt, me])) ?? undefined;
}

async function readSnapshotsAsync(dir: string): Promise<Snapshots | undefined> {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  let partial = false;
  const read = await Promise.all(names.sort().map(async (name) => {
    const device = SNAPSHOT_FILE.exec(name)?.[1];
    try {
      const parsed = device ? snapshotSchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8"))) : undefined;
      return parsed?.success && parsed.data.device === device ? [parsed.data] : [];
    } catch {
      partial ||= Boolean(device);
      return [];
    }
  }));
  return partialOf(read.flat(), partial);
}

type SnapshotsRead = Array<Snapshots | undefined> & { at?: number };

/** One bot's snapshots per sync root, read off the event loop; pass them to syncBotMemory as `snapshots`. */
export async function readMemorySnapshots(folder: string, botSyncId: string): Promise<SnapshotsRead> {
  const at = Date.now();
  try {
    return Object.assign(await Promise.all(syncRoots(folder, MEMORY_SYNC_DIR).map((root) => readSnapshotsAsync(join(root, botSyncId)))), { at });
  } catch {
    return Object.assign([undefined], { at });
  }
}

/** Background jobs belong to the bot's original profile publisher, even during delayed sync. */
export function tidiesHere(ledger: MemorySyncLedger, botSyncId: string, device: string, jobMachine?: string): boolean {
  return Boolean(ledger.device && ledger.jobDevice === (jobMachine ?? ledger.device) && ledger.jobOwners?.[botSyncId] === device);
}

/** Kept across a hostname change, different for a copied ~/.orbit; undefined when the OS has no machine id. */
export function memoryJobMachine(dataDir: string): string | undefined {
  const id = readOsMachineId();
  return id && createHash("sha256").update(`wink-memory-jobs\0${id}\0${resolve(dataDir)}`).digest("hex").slice(0, 12);
}

export function pinMemoryJobOwner(ledger: MemorySyncLedger, botSyncId: string, owner: string): boolean {
  const owners = ledger.jobOwners ??= {};
  if (Object.hasOwn(owners, botSyncId)) return false;
  owners[botSyncId] = owner;
  return true;
}

/** The idle tidy changed MEMORY.md from `before` to `after`: if the next pass finds only that change, a copy that holds what the tidy started from wins over it with nothing set aside. Save the ledger after it. */
export function markTidied(ledger: MemorySyncLedger, botSyncId: string, before: string, after: string): void {
  const bot = ledger.bots[botSyncId];
  if (bot) bot.tidy = { from: hash(before)!, to: hash(after)! };
}

let machineId: string | undefined;

function machine(): string {
  if (machineId) return machineId;
  let user = "";
  try {
    user = userInfo().username;
  } catch {
    user = "";
  }
  machineId = createHash("sha256").update([hostname(), user, homedir()].join("\0")).digest("hex");
  return machineId;
}

// a ledger copied or restored onto another PC must not keep writing as the PC it came from
function deviceId(ledger: MemorySyncLedger, host: string, jobMachine?: string): string {
  const moved = Boolean(ledger.device && ledger.host !== host);
  // A copied ledger gets a new sync device, but keeps its original job binding; one bound to this unmoved device moves to the machine key.
  if (moved) ledger.jobDevice ??= ledger.device;
  else if (jobMachine && ledger.jobDevice === ledger.device) ledger.jobDevice = jobMachine;
  if (!ledger.device || moved) {
    ledger.device = randomBytes(6).toString("hex");
    ledger.host = host;
  }
  ledger.jobDevice ??= jobMachine ?? ledger.device;
  return ledger.device;
}

/** Mints this PC's memory device before the first sync, as the first sync would. */
export function ensureMemorySyncDevice(ledger: MemorySyncLedger, jobMachine?: string): string {
  return deviceId(ledger, machine(), jobMachine);
}

function tick(ledger: MemorySyncLedger): number {
  ledger.clock = (ledger.clock ?? 0) + 1;
  return ledger.clock;
}

// a includes every edit b does
const covers = (a: Versions, b: Versions) => Object.entries(b).every(([device, count]) => (a[device] ?? 0) >= count);

function joined(a: Versions, b: Versions): Versions {
  const out = { ...a };
  for (const [device, count] of Object.entries(b)) out[device] = Math.max(out[device] ?? 0, count);
  return out;
}

type Side = Rank & { at: number };

// a tie goes to the PC where the user last messaged the bot, then to the later edit; device order makes every PC pick the same one
function wins(a: Side, b: Side): boolean {
  if (a.talkedAt !== b.talkedAt) return a.talkedAt > b.talkedAt;
  if (a.at !== b.at) return a.at > b.at;
  return a.device > b.device;
}

// the older build agreed on this copy by pulling it from another PC, so it holds nothing that PC lacks
function settled(legacy: LegacyMemoryLedger | undefined, botSyncId: string, file: string, localHash: string | null): boolean {
  const base = legacy?.[`${botSyncId}/${file}`];
  return localHash !== null && base === localHash && legacy?.[`~${botSyncId}/${file}`] === base;
}

function editedAt(path: string, now: number): number {
  try {
    return Math.round(statSync(path).mtimeMs);
  } catch {
    return now;
  }
}

// files the older build deleted, and when: it kept no ledger entry for them, only a sidecar in its shared copy saying so
function olderBuildDeletes(folder: string, botSyncId: string, now: number): Map<string, number> {
  const root = join(folder, LEGACY_SYNC_DIR, botSyncId, ".ancestry");
  let topics: string[];
  try {
    topics = readdirSync(join(root, "memory")).filter((name) => name.endsWith(".md.json"));
  } catch {
    topics = [];
  }
  const deletes = new Map<string, number>();
  for (const file of [MEMORY_FILE, ...topics.map((name) => `memory/${name.slice(0, -".json".length)}`)]) {
    if (!isSyncedFile(file)) continue;
    const path = join(root, `${file}.json`);
    let sidecar: unknown;
    try {
      sidecar = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (z.object({ hash: z.null() }).safeParse(sidecar).success) deletes.set(file, editedAt(path, now));
  }
  return deletes;
}

// named by its contents, so two PCs setting aside the same copy write the same file
function park(workspace: string, file: string, text: string, at: number) {
  const stem = file === MEMORY_FILE ? "MEMORY" : file.slice("memory/".length, -".md".length);
  const when = at ? `, last edited ${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  const body = `${PARKED_NOTE} a copy of ${file} set aside when two PCs changed it at once${when} -->\n${text}`;
  const name = `memory/${stem.slice(0, 170)}.conflict-${hash(body)!.slice(0, 8)}.md`;
  if (!existsSync(join(workspace, name))) writeText(join(workspace, name), body);
  return { name, body };
}

const MAX_EDITS = 32;
const MAX_CUT_LINES = 400;
const short = (text: string) => hash(text)!.slice(0, 16);
// CRLF and LF copies hold the same lines
const linesOf = (text: string) => text.split("\n").map((line) => line.replace(/\r$/, ""));
const nonblank = (text: string) => linesOf(text).filter((line) => line.trim());
const HEADING = /^#{1,6}\s/;

function counts(lines: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) if (line.trim()) out.set(line, (out.get(line) ?? 0) + 1);
  return out;
}

// what the other copy's own edits cut stays cut
function without(text: string, cut: string[]): string {
  const left = counts(cut);
  return linesOf(text).filter((line) => {
    const n = left.get(line) ?? 0;
    if (n) left.set(line, n - 1);
    return !n;
  }).join("\n");
}

// a copy only its own PC ever edited, and not one the older build handed over
const firstCopy = (vv: Versions, by: Rank | undefined) => Object.keys(vv).length === 1 && !by;

const ancestors = (copy: Lineage) => [...(copy.joined ?? []), ...(copy.edits ?? []).map((edit) => edit.from)];

// the lines a copy's own edits cut since it held `base`; undefined when it never did, or that part of its lineage was dropped
function cutSince(copy: Lineage, base: string): string[] | undefined {
  if (copy.joined?.includes(base)) return (copy.edits ?? []).flatMap((edit) => edit.cut);
  const at = (copy.edits ?? []).findIndex((edit) => edit.from === base);
  return at < 0 ? undefined : copy.edits!.slice(at).flatMap((edit) => edit.cut);
}

// legacy: the older build handed this copy over, so its history with every PC is unknown
type Copy = Lineage & { vv: Versions; by?: Rank; legacy?: boolean };

// a first copy the other never saw: neither removed anything from the other
const unseen = (x: Copy, y: Copy) => firstCopy(x.vv, x.by) && !Object.hasOwn(y.vv, Object.keys(x.vv)[0]!) && Object.keys(y.vv).length > 0 && !y.legacy;

// lineage only settles copies a join made or would make; two edits of one shared copy still tie
const joinsOrJoined = (a: Copy, b: Copy) => Boolean(a.joined || b.joined) || unseen(a, b) || unseen(b, a);

// a join nobody has edited since, built from `base`
const freshJoinOf = (copy: Copy, base: string) => Boolean(copy.joined?.includes(base) && !copy.edits?.length);

// two copies changed at once are joined line by line when nothing either removed would come back: one is a first copy the other never saw, or one is an unedited join of a text the other grew from, with the other's cuts since that text known
function joinCuts(a: Copy, b: Copy): [string[], string[]] | undefined {
  if (unseen(a, b) || unseen(b, a)) return [[], []];
  for (const base of ancestors(a).reverse()) {
    if (!freshJoinOf(a, base) && !freshJoinOf(b, base)) continue;
    const cutB = cutSince(b, base);
    if (cutB) return [cutSince(a, base)!, cutB];
  }
  return undefined;
}

// every line of both copies, as many times as either holds it, minus what the other side cut; the longer copy is the frame and the other's lines land under their own heading
function joinCopies(a: string, b: string, cutA: string[] = [], cutB: string[] = []): string {
  const longer = nonblank(a).length - nonblank(b).length;
  const [plainA, plainB] = [short(linesOf(a).join("\n")), short(linesOf(b).join("\n"))];
  const order = longer || (plainA !== plainB ? (plainA > plainB ? 1 : -1) : short(a) > short(b) ? 1 : -1);
  const [base, other, baseCutByOther, otherCutByBase] = order > 0 ? [a, b, cutB, cutA] : [b, a, cutA, cutB];
  const eol = base.includes("\r\n") ? "\r" : "";
  const inBase = counts(linesOf(base));
  const inOther = counts(linesOf(other));
  const cutOfBase = counts(baseCutByOther);
  const cutOfOther = counts(otherCutByBase);
  const want = new Map<string, number>();
  for (const line of new Set([...inBase.keys(), ...inOther.keys()])) {
    want.set(line, Math.max(0, (inBase.get(line) ?? 0) - (cutOfBase.get(line) ?? 0), (inOther.get(line) ?? 0) - (cutOfOther.get(line) ?? 0)));
  }
  const raw = base.split("\n");
  const out: string[] = [];
  const have = new Map<string, number>();
  for (let at = raw.length - 1; at >= 0; at--) {
    const line = raw[at]!.replace(/\r$/, "");
    if (line.trim()) {
      if ((have.get(line) ?? 0) >= want.get(line)!) continue;
      have.set(line, (have.get(line) ?? 0) + 1);
    }
    out.unshift(raw[at]!);
  }
  const key = (at: number) => out[at]!.replace(/\r$/, "");
  // before the blank lines that close the section starting at `from` (the whole file when -1)
  const sectionEnd = (from: number) => {
    let end = from + 1;
    while (end < out.length && !(from >= 0 && HEADING.test(key(end)))) end++;
    while (end > from + 1 && !key(end - 1).trim()) end--;
    return end;
  };
  let heading = -1;
  for (const line of linesOf(other)) {
    if (!line.trim() || (have.get(line) ?? 0) >= want.get(line)!) {
      if (HEADING.test(line)) heading = out.findIndex((_, at) => key(at) === line);
      continue;
    }
    have.set(line, (have.get(line) ?? 0) + 1);
    const at = sectionEnd(HEADING.test(line) ? -1 : heading);
    const lead = HEADING.test(line) && at > 0 && key(at - 1).trim() ? [eol] : [];
    out.splice(at, 0, ...lead, line + eol);
    if (HEADING.test(line)) heading = at + lead.length;
  }
  return out.join("\n");
}

// every nonblank line of a set-aside copy is in its file, in the same order
function covered(main: string, copy: string): boolean {
  const lines = linesOf(main);
  let at = 0;
  for (const line of linesOf(copy)) {
    if (!line.trim()) continue;
    while (at < lines.length && lines[at] !== line) at++;
    if (at === lines.length) return false;
    at++;
  }
  return true;
}

// the lines a local edit removed from the text it started from
function cutLines(before: string, after: string): string[] {
  const left = counts(linesOf(after));
  return linesOf(before).filter((line) => {
    if (!line.trim()) return false;
    const n = left.get(line) ?? 0;
    if (n) left.set(line, n - 1);
    return !n;
  });
}

// the newest edits, so a long-lived copy's lineage stays small
function recent(edits: NonNullable<Lineage["edits"]>): Lineage["edits"] {
  let lines = 0;
  let at = edits.length;
  while (at > 0 && edits.length - at < MAX_EDITS && lines + edits[at - 1]!.cut.length <= MAX_CUT_LINES) lines += edits[--at]!.cut.length;
  return edits.slice(at);
}

// an older build that lost a tie to this PC's first copy, or won it, set the other copy aside under the same versions
function setAsideTwin(snapshot: Snapshot, file: string, vv: Versions): string | null {
  const stem = file === MEMORY_FILE ? "MEMORY" : file.slice("memory/".length, -".md".length);
  const same = (other: Versions) => covers(other, vv) && covers(vv, other);
  for (const [name, entry] of Object.entries(snapshot.files)) {
    if (PARKED_FILE.exec(name)?.[1] === stem.slice(0, 170) && entry.text?.startsWith(PARKED_NOTE) && same(entry.vv)) return entry.text.slice(entry.text.indexOf("\n") + 1);
  }
  return null;
}

// a set-aside copy its file already holds has nothing left to merge
function dropMergedCopies(workspace: string, files: Iterable<string>): string[] {
  const dropped: string[] = [];
  for (const file of files) {
    const stem = PARKED_FILE.exec(file)?.[1];
    const parked = stem ? readText(join(workspace, file), file) : null;
    if (!stem || !parked) continue;
    const source = stem === "MEMORY" ? MEMORY_FILE : `memory/${stem}.md`;
    const main = readText(join(workspace, source), source);
    if (!main) continue;
    const body = parked.startsWith(PARKED_NOTE) ? parked.slice(parked.indexOf("\n") + 1) : parked;
    if (!covered(main, body)) continue;
    rmSync(join(workspace, file), { force: true });
    dropped.push(file);
  }
  return dropped;
}

/** True when nothing a pass reads has changed since the last one, so its snapshots need not be read at all. */
export function memorySyncUnchanged(folder: string, botSyncId: string, workspace: string, ledger: MemorySyncLedger, { now = Date.now(), host = machine() }: MemorySyncOptions = {}): boolean {
  const known = ledger.bots[botSyncId];
  if (!known?.seen) return false;
  try {
    const local = memoryFiles(workspace);
    const dirs = syncRoots(folder, MEMORY_SYNC_DIR).map((root) => join(root, botSyncId));
    return Boolean(local) && known.seen === passInputs(dirs, workspace, local ?? [], known, ledger.talked?.[botSyncId] ?? 0, deviceId(ledger, host), now);
  } catch {
    return false;
  }
}

export type MemorySyncOptions = { now?: number; legacy?: LegacyMemoryLedger; host?: string; snapshots?: SnapshotsRead };

/** Syncs one bot's memory through one snapshot per PC: a copy is replaced only by one that includes it, and a tie sets the losing copy aside. */
export function syncBotMemory(
  folder: string,
  botSyncId: string,
  workspace: string,
  ledger: MemorySyncLedger,
  { now = Date.now(), legacy, host = machine(), snapshots: read }: MemorySyncOptions = {},
): Record<string, MemorySyncResult> {
  memorySyncDir(folder, botSyncId);
  const me = deviceId(ledger, host);
  let dir: string;
  let dirs: string[];
  try {
    dir = join(syncWriteRoot(folder, MEMORY_SYNC_DIR, join(botSyncId, `${me}.json`)), botSyncId);
    dirs = syncRoots(folder, MEMORY_SYNC_DIR).map((root) => join(root, botSyncId));
  } catch {
    return {};
  }
  const localFiles = memoryFiles(workspace);
  if (!localFiles) return {};
  const talkedAt = ledger.talked?.[botSyncId] ?? 0;
  const known = ledger.bots[botSyncId];
  if (!read && known?.seen && known.seen === passInputs(dirs, workspace, localFiles, known, talkedAt, me, now)) return {};
  const groups = read ?? dirs.map(readSnapshots);
  if (groups.some((group) => !group)) return {};
  const snapshots = groups.flatMap((group) => group ?? []);
  const firstSync = !ledger.bots[botSyncId];
  const bot = (ledger.bots[botSyncId] ??= { files: {} });
  // a wiped or never-created workspace has nothing to publish; forgetting it pulls instead of deleting everywhere, from this PC's own snapshot too
  const restore = !existsSync(workspace);
  if (restore) bot.files = {};
  // a restored ledger must not hand out counts this PC already published
  for (const entry of snapshots.flatMap((snapshot) => Object.values(snapshot.files))) {
    ledger.clock = Math.max(ledger.clock ?? 0, entry.vv[me] ?? 0);
  }
  const own = snapshots.find((snapshot) => snapshot.device === me);
  const remotes = snapshots.filter((snapshot) => restore || snapshot !== own);
  const mine: Rank = { talkedAt, device: me };
  // a copy keeps its first PC's rank as other PCs relay it; this PC's own copies rank by its current talkedAt
  const from = (snapshot: Snapshot, entry: Snapshot["files"][string]): Rank | undefined => {
    const by = entry.by ?? { talkedAt: snapshot.talkedAt, device: snapshot.device };
    return by.device === me ? undefined : by;
  };
  // a delete the older build finished must not come back from another PC's copy
  const migrating = firstSync && Object.keys(legacy ?? {}).some((key) => key.startsWith(`${botSyncId}/`));
  const deletes = migrating ? olderBuildDeletes(folder, botSyncId, now) : new Map<string, number>();
  const files = [
    ...new Set([...localFiles, ...Object.keys(bot.files), ...deletes.keys(), ...remotes.flatMap((snapshot) => Object.keys(snapshot.files))]),
  ].sort();
  const results: Record<string, MemorySyncResult> = {};
  const texts = new Map<string, string | null>();
  for (const file of files) {
    const path = join(workspace, file);
    let text = readText(path, file);
    if (text === undefined) {
      results[file] = "skipped";
      continue;
    }
    let state: FileState | undefined = bot.files[file];
    let result: MemorySyncResult = "current";
    const localHash = hash(text);
    const tidy = file === MEMORY_FILE ? bot.tidy : undefined;
    if (tidy) delete bot.tidy;
    // a PC that lost its ledger holds a copy another PC already published: that copy, not a new edit, whichever snapshot it reads first
    const published = !state && localHash !== null && legacy?.[`${botSyncId}/${file}`] !== localHash ? remotes.flatMap((snapshot) => (snapshot.files[file] && hash(snapshot.files[file].text) === localHash ? [{ snapshot, entry: snapshot.files[file] }] : [])) : [];
    if (published.length) {
      const [{ snapshot, entry }] = published;
      state = bot.files[file] = { vv: published.reduce((vv, copy) => joined(vv, copy.entry.vv), {}), hash: localHash, at: entry.at, by: from(snapshot, entry), tidied: entry.tidied, joined: entry.joined, edits: entry.edits };
    }
    if (state ? state.hash !== localHash : localHash !== null) {
      // a copy unchanged since the older build agreed on it is no new edit: a pulled one gives way, and none wins a tie on talkedAt
      const legacyCopy = !state && firstSync && legacy?.[`${botSyncId}/${file}`] === localHash;
      // versions the tidy started from; none at all would be held by every copy
      const tidied = state && Object.keys(state.vv).length && tidy?.from === state.hash && tidy.to === localHash ? (state.tidied ?? state.vv) : undefined;
      const vv = legacyCopy && settled(legacy, botSyncId, file, localHash) ? {} : { ...state?.vv, [me]: tick(ledger) };
      // the text this edit started from is what this PC last published; without it the lineage ends here
      const before = own?.files[file]?.text;
      const from = state && before !== undefined && before !== null && text !== null && hash(before) === state.hash ? before : undefined;
      const edits = from === undefined || text === null ? undefined : recent([...(state?.edits ?? []), { from: short(from), cut: cutLines(from, text) }]);
      const next: FileState = { vv, hash: localHash, at: editedAt(path, now), by: legacyCopy ? { device: me, talkedAt: 0 } : undefined, tidied };
      if (edits) {
        next.joined = state?.joined;
        next.edits = edits;
      }
      state = bot.files[file] = next;
      result = "pushed";
    } else if (!state && deletes.has(file)) {
      state = bot.files[file] = { vv: { [me]: tick(ledger) }, hash: null, at: deletes.get(file)!, by: { device: me, talkedAt: 0 } };
    }
    for (const snapshot of remotes) {
      const entry = snapshot.files[file];
      if (!entry) continue;
      const theirs = hash(entry.text);
      const by = from(snapshot, entry);
      const newer: boolean = state ? covers(entry.vv, state.vv) : true;
      // an older build broke a tie against this PC's untouched first copy and set the other copy aside: both copies' lines, as this build would have joined them
      const twin: string | null = state && text !== null && entry.text !== null && newer && !snapshot.joins && firstCopy(state.vv, state.by) && Object.keys(entry.vv).length > 1 ? setAsideTwin(snapshot, file, entry.vv) : null;
      if (state && twin !== null && entry.text !== null) {
        const both = joinCopies(entry.text, twin);
        if (!covered(both, entry.text)) {
          const parked = park(workspace, file, entry.text, entry.at);
          if (!bot.files[parked.name]) {
            bot.files[parked.name] = { vv: entry.vv, hash: hash(parked.body), at: entry.at };
            texts.set(parked.name, parked.body);
          }
        }
        writeText(path, both);
        text = both;
        state = bot.files[file] = { vv: { ...joined(state.vv, entry.vv), [me]: tick(ledger) }, hash: hash(both), at: Math.max(state.at, entry.at), joined: [short(entry.text), short(twin)].sort() };
        result = "pulled";
        continue;
      }
      if (!state || theirs === state.hash) {
        // nothing here yet, or the same text: take what it knows
        if (!state && theirs !== null) {
          writeText(path, entry.text);
          text = entry.text;
          result = "pulled";
        }
        state = bot.files[file] = state ? { ...state, vv: joined(state.vv, entry.vv) } : { vv: entry.vv, hash: theirs, at: entry.at, by, tidied: entry.tidied, joined: entry.joined, edits: entry.edits };
        continue;
      }
      const older = covers(state.vv, entry.vv);
      if (older && !newer) continue;
      // a copy built on this one's exact text holds every change of it, whatever the versions say
      const mineCopy: Copy = { ...state, legacy: state.by?.device === me };
      const theirCopy = { ...entry, legacy: entry.by?.device === snapshot.device };
      const related = joinsOrJoined(mineCopy, theirCopy);
      const grewFromMine = related && text !== null && ancestors(entry).includes(short(text));
      if (grewFromMine || (newer && !older)) {
        writeText(path, entry.text);
        text = entry.text;
        state = bot.files[file] = { vv: grewFromMine ? joined(state.vv, entry.vv) : entry.vv, hash: theirs, at: entry.at, by, tidied: entry.tidied, joined: entry.joined, edits: entry.edits };
        result = "pulled";
        continue;
      }
      if (related && entry.text !== null && ancestors(state).includes(short(entry.text))) {
        state = bot.files[file] = { ...state, vv: joined(state.vv, entry.vv) };
        continue;
      }
      // changed on two PCs at once, or the same versions with different text from a copied ledger
      const timeline = file === `memory/${PICKS_FILE}`;
      // the archive only ever gains lines, so its two copies join even when no lineage settles them, and a deleted copy joins as an empty one
      const archive = file === DREAMED_FILE;
      const [here, there]: [string | null, string | null] = archive ? [text ?? "", entry.text ?? ""] : [text, entry.text];
      const cuts: [string[], string[]] | undefined = here === null || there === null || timeline ? undefined : joinCuts(mineCopy, theirCopy) ?? (archive ? [[], []] : undefined);
      const merged: string | null = here === null || there === null
        ? null
        : timeline ? mergeTimelines(here, there) : cuts ? joinCopies(here, there, cuts[0], cuts[1]) : null;
      if (merged !== null) {
        // a line the join dropped or moved, beyond what a side cut on purpose, keeps a set-aside copy
        if (cuts) {
          for (const [copy, at, cut] of [[here!, state.at, cuts[1]], [there!, entry.at, cuts[0]]] as const) {
            if (covered(merged, without(copy, cut))) continue;
            const parked = park(workspace, file, copy, at);
            if (!bot.files[parked.name]) {
              bot.files[parked.name] = { vv: joined(state.vv, entry.vv), hash: hash(parked.body), at };
              texts.set(parked.name, parked.body);
            }
          }
        }
        writeText(path, merged);
        const inputs = [short(here!), short(there!)].sort();
        text = merged;
        const next: FileState = { vv: { ...joined(state.vv, entry.vv), [me]: tick(ledger) }, hash: hash(merged), at: Math.max(state.at, entry.at) };
        if (cuts) next.joined = inputs;
        state = bot.files[file] = next;
        result = "pulled";
        continue;
      }
      const vv = joined(state.vv, entry.vv);
      // a copy the idle tidy only took lines out of gives way, with nothing set aside, to a copy that holds every line it started from
      const ours: boolean = Boolean(state.tidied && !entry.tidied && covers(entry.vv, state.tidied));
      if (ours || (entry.tidied && !state.tidied && covers(state.vv, entry.tidied))) {
        if (ours) {
          writeText(path, entry.text);
          text = entry.text;
          result = "pulled";
        }
        state = bot.files[file] = ours ? { vv, hash: theirs, at: entry.at, by, joined: entry.joined, edits: entry.edits } : { ...state, vv };
        continue;
      }
      const keep = wins({ ...(state.by ?? mine), at: state.at }, { ...(by ?? mine), at: entry.at });
      const lost = keep ? entry.text : text;
      const lostAt = keep ? entry.at : state.at;
      const parked = lost === null ? null : park(workspace, file, lost, lostAt);
      // both PCs park the same copy under the same versions, so either bot deleting it deletes it everywhere
      if (parked && !bot.files[parked.name]) {
        bot.files[parked.name] = { vv, hash: hash(parked.body), at: lostAt };
        texts.set(parked.name, parked.body);
      }
      if (!keep) {
        writeText(path, entry.text);
        text = entry.text;
      }
      state = bot.files[file] = keep ? { ...state, vv } : { vv, hash: theirs, at: entry.at, by, tidied: entry.tidied, joined: entry.joined, edits: entry.edits };
      result = "conflict";
      console.warn(
        `memory sync: ${botSyncId}/${file} changed on two PCs; kept ${keep ? "this" : "the other"} PC's copy${parked ? `, set the other aside as ${parked.name}` : ""}`,
      );
    }
    if (file === `memory/${PICKS_FILE}` && typeof text === "string") {
      for (const copy of files.filter((name) => /^memory\/decisions\.conflict-[0-9a-f]{8}\.md$/.test(name))) {
        const body = texts.get(copy) ?? readText(join(workspace, copy), copy);
        const merged: string | null = body ? mergeTimelines(text, body.replace(/^<!-- memory sync:[^\n]*\n/, "")) : null;
        if (merged === null || merged === text) continue;
        writeText(path, merged);
        text = merged;
        state = bot.files[file] = { vv: { ...state?.vv, [me]: tick(ledger) }, hash: hash(merged), at: now };
        result = "pulled";
      }
    }
    results[file] = result;
    texts.set(file, text);
  }
  for (const file of dropMergedCopies(workspace, texts.keys())) {
    const state = bot.files[file];
    texts.set(file, null);
    if (state?.hash) bot.files[file] = { vv: { ...state.vv, [me]: tick(ledger) }, hash: null, at: now };
    results[file] = "pushed";
  }
  const published: Snapshot["files"] = {};
  const wide: Snapshot["files"] = {};
  for (const [file, state] of Object.entries(bot.files)) {
    const text = texts.get(file);
    // unreadable this pass: keep what this PC last published rather than claim a delete
    const entry = text === undefined ? own?.files[file] : { vv: state.vv, at: state.at, text, by: state.by, tidied: state.tidied, joined: state.joined, edits: state.edits };
    if (entry) (isOlderBuildFile(file) ? published : wide)[file] = entry;
  }
  const snapshot: z.input<typeof snapshotSchema> = { format: FORMAT, version: 1, device: me, talkedAt, files: published, joins: 1 };
  if (Object.keys(wide).length) snapshot.wide = wide;
  const body = `${JSON.stringify(snapshot)}\n`;
  const path = join(dir, `${me}.json`);
  // a replayed, half-written or placeholder copy of this PC's snapshot is rewritten, not trusted
  if (readRaw(path) !== body) {
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(path, body, { mode: 0o600 });
  }
  const after = memoryFiles(workspace);
  // a skipped file or snapshot is retried by the next poll, so the pass is not recorded as seen
  const complete = !groups.some((group) => group?.partial) && !Object.values(results).includes("skipped");
  // a file written after the snapshots were read may not be what was read, so the racy window starts at the read
  bot.seen = complete && after ? passInputs(dirs, workspace, after, { files: bot.files }, talkedAt, me, Math.min(now, read?.at ?? now)) : undefined;
  return results;
}
