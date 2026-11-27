import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DREAMED_FILE, DREAMED_HEAD, dreamedEntry, markUndone } from "./dream-archive.ts";
import { ensureMemorySyncDevice, markTalked, markTidied, memorySyncDir, syncBotMemory, tidiesHere, type LegacyMemoryLedger, type MemorySyncLedger } from "./memory-sync.ts";
import { MEMORY_SEED } from "./workspace.ts";
import { applyPicks, currentPicks, parseTimeline } from "./picks.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// PCs with their own Drive replicas; nothing crosses until deliver()
function pcs(count = 2) {
  const root = mkdtempSync(join(tmpdir(), "orbit-memory-sync-"));
  roots.push(root);
  return Array.from({ length: count }, (_, i) => {
    const folder = join(root, `drive-${i}`);
    mkdirSync(folder);
    const ledger: MemorySyncLedger = { bots: {} };
    const legacy: LegacyMemoryLedger = {};
    return { folder, workspace: join(root, `pc-${i}`), ledger, legacy, host: `host-${i}` };
  });
}

type PC = ReturnType<typeof pcs>[number];

const sync = (pc: PC, now?: number) => syncBotMemory(pc.folder, "bot-1", pc.workspace, pc.ledger, { legacy: pc.legacy, host: pc.host, now });
const ownSnapshot = (pc: PC) => join(memorySyncDir(pc.folder, "bot-1"), `${pc.ledger.device}.json`);
const capture = (pc: PC) => readFileSync(ownSnapshot(pc), "utf8");

// Drive hands another PC's snapshot to this one, or replays an old one
function receive(from: PC, to: PC, snapshot = capture(from)) {
  mkdirSync(memorySyncDir(to.folder, "bot-1"), { recursive: true });
  writeFileSync(join(memorySyncDir(to.folder, "bot-1"), `${from.ledger.device}.json`), snapshot);
}

function edit(pc: PC, text: string | null, file = "MEMORY.md", at?: number) {
  const path = join(pc.workspace, file);
  if (text === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  if (at) utimesSync(path, at / 1000, at / 1000);
}

const read = (pc: PC, file = "MEMORY.md") => (existsSync(join(pc.workspace, file)) ? readFileSync(join(pc.workspace, file), "utf8") : null);
const nonblankLines = (text: string) => text.split("\n").filter((line) => line.trim());
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// the set-aside copies' text, without the note memory sync puts on top
const parked = (pc: PC) =>
  existsSync(join(pc.workspace, "memory"))
    ? readdirSync(join(pc.workspace, "memory"))
        .filter((name) => name.includes(".conflict-"))
        .map((name) => read(pc, `memory/${name}`)!.replace(/^<!-- memory sync:[^\n]*\n/, ""))
        .sort()
    : [];

// every PC starts from the same notes
function seed(text: string, ...all: PC[]) {
  edit(all[0], text);
  for (const pc of all) sync(pc);
  for (const pc of all.slice(1)) {
    receive(all[0], pc);
    sync(pc);
  }
}

const DAY = 24 * 60 * 60_000;
const T0 = new Date(2026, 10, 1, 9).getTime();

// PCs whose memory devices are the ones given, in the order the tidy picks them
function devices(...ids: string[]) {
  const all = pcs(ids.length);
  all.forEach((pc, i) => Object.assign(pc.ledger, { device: ids[i], host: pc.host }));
  return all;
}

const tidying = (...all: PC[]) => all.map((pc) => tidiesHere(pc.ledger, "bot-1"));

// the message's own pass runs on the clock that stamped it
function talk(pc: PC, at: number) {
  markTalked(pc.ledger, "bot-1", at);
  sync(pc, at);
}

// each PC gets every other's latest copy
function swap(...all: PC[]) {
  for (const pc of all) sync(pc);
  for (let round = 0; round < 2; round++) {
    for (const to of all) {
      for (const from of all) if (from !== to) receive(from, to);
      sync(to);
    }
  }
}

// the host ensureMemorySyncDevice records on this machine
function thisHost() {
  const ledger: MemorySyncLedger = { bots: {} };
  ensureMemorySyncDevice(ledger);
  return ledger.host!;
}

// every PC hands its snapshot to every other until nothing changes
function settle(...all: PC[]) {
  for (let round = 0; round < 4; round++) {
    for (const from of all) for (const to of all) if (from !== to && from.ledger.device) receive(from, to);
    for (const pc of all) sync(pc);
  }
}

const HOUR = 60 * 60_000;

// seeded, so a failing order replays
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

// Times are from the laptop's message that takes the tidy, a week after the desktop's last; the desktop is opened again at `back` and the laptop is
// closed for good at `closed`. Each PC polls every six hours from `poll` on. copies(from, n): the delays after which Drive lands the n-th copy that PC
// writes, counted from its copy before the laptop took over, once the other PC is on; a copy that names the laptop can land after a later one that does too.
type Handover = { back: number; desk: number[]; laptop: number[]; closed: number; poll: number; copies: (from: "desk" | "laptop", n: number) => number[] };

// Runs a week from `back` and returns each poll that broke the handover: at or past six hours after the later of the laptop's last message and the
// desktop's latest message once it has read the laptop's claim, the desktop must tidy and the laptop must not.
// both PCs in use and the desktop tidying, a week before the laptop takes the tidy at `took`; ahead of the files' own times, so a pass that reads
// nothing new is skipped as in use
function beforeHandover() {
  const took = Date.now() + 9 * DAY;
  const pcs = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb");
  const [a, b] = pcs;
  seed(MEMORY_SEED, a, b);
  talk(a, took - 8 * DAY);
  talk(b, took - 8 * DAY);
  for (const [from, to] of [[a, b], [b, a], [a, b]]) {
    receive(from, to);
    sync(to, took - 8 * DAY);
  }
  return { took, pcs };
}

function handover(plan: Handover, { took, pcs } = beforeHandover()) {
  const [back, closed, end] = [took + plan.back, took + plan.closed, took + plan.back + 7 * DAY];
  const [desk, laptop] = [plan.desk.map((at) => took + at), plan.laptop.map((at) => took + at)];
  const [a, b] = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb");
  [a, b].forEach((pc, i) => {
    for (const key of ["folder", "workspace"] as const) if (existsSync(pcs[i][key])) cpSync(pcs[i][key], pc[key], { recursive: true });
    Object.assign(pc.ledger, structuredClone(pcs[i].ledger));
  });
  const last = Math.max(took, ...laptop);
  const on = (pc: PC, at: number) => (pc === a ? at >= back : at <= closed);
  const written = new Map([[a, [{ text: capture(a), claims: true }]], [b, [{ text: capture(b), claims: false }]]]);
  const landed = new Map([[a, 0], [b, 0]]);
  const queue: Array<{ at: number; run: () => void }> = [];
  const later = (at: number, run: () => void) => {
    if (at <= end) queue.splice(queue.findLastIndex((next) => next.at <= at) + 1, 0, { at, run });
  };
  const broke: string[] = [];
  let due: number | undefined;
  const land = (from: PC, to: PC, n: number, at: number) => {
    const sent = written.get(from)!;
    const now = landed.get(to)!;
    if (!on(to, at) || (n < now && !(from === b && sent[n].claims && sent[now].claims))) return;
    landed.set(to, n);
    receive(from, to, sent[n].text);
    // written at the landing, so the racy-file guard sees it as in use; a copy stamped by the real clock could match the last one's size and time
    utimesSync(join(memorySyncDir(to.folder, "bot-1"), `${from.ledger.device}.json`), at / 1000, at / 1000);
    pass(to, at);
  };
  const pass = (pc: PC, at: number, message = false) => {
    if (!on(pc, at)) return;
    if (message) talk(pc, at);
    else sync(pc, at);
    const [other, sent, text] = [pc === a ? b : a, written.get(pc)!, capture(pc)];
    if (sent.at(-1)!.text !== text) {
      const n = sent.push({ text, claims: JSON.parse(text).tidier === pc.ledger.device }) - 1;
      for (const delay of plan.copies(pc === a ? "desk" : "laptop", n)) {
        const lands = (other === a ? Math.max(at, back) : at) + delay;
        later(lands, () => land(pc, other, n, lands));
      }
    }
    const talked = a.ledger.talked!["bot-1"];
    if (pc === a && due === undefined && talked >= back && written.get(b)![landed.get(a)!].claims) {
      const at = (due = Math.max(last, talked) + 6 * HOUR);
      later(at, () => pass(a, at));
    }
    if (due !== undefined && at >= due && tidiesHere(pc.ledger, "bot-1") !== (pc === a)) broke.push(`${pc === a ? "desktop waits" : "laptop tidies"} ${((at - due) / HOUR).toFixed(2)}h past due`);
  };
  pass(b, took, true);
  later(back, () => pass(a, back));
  for (const at of laptop) later(at, () => pass(b, at, true));
  for (const at of desk) later(at, () => pass(a, at, true));
  for (const pc of [a, b]) for (let at = (pc === a ? back : took) + plan.poll; at <= end; at += 6 * HOUR) later(at, () => pass(pc, at));
  while (queue.length) queue.shift()!.run();
  due ??= back;
  pass(a, end);
  pass(b, end);
  return broke;
}

function shuffled(seed: number): Handover {
  const rand = random(seed);
  const between = (from: number, to: number) => Math.round(from + rand() * (to - from));
  const back = between(HOUR, 4 * DAY);
  const desk = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => between(back, back + 2 * DAY)).sort((x, y) => x - y);
  const laptop = Array.from({ length: Math.floor(rand() * 4) }, () => between(0, back + DAY));
  // a last message on the laptop just after one on the desktop, closed before the desktop's copy lands
  if (rand() < 0.3) laptop.push(desk[0] + between(0, 30 * 60_000));
  laptop.sort((x, y) => x - y);
  const last = Math.max(0, ...laptop);
  const closed = rand() < 0.4 ? last : between(last, last + 12 * HOUR);
  const copies = () => {
    const first = rand() < 0.3 ? between(0, 2 * 60_000) : between(0, 3 * HOUR);
    return rand() < 0.3 ? [first, first + between(0, 6 * HOUR)] : [first];
  };
  return { back, desk, laptop, closed, poll: between(1, 6 * HOUR), copies };
}

describe("memory sync", () => {
  it("tidies on one PC the user messages, hands that on after a week without a message there, and takes it back on the next one", () => {
    const [a, b, c] = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc");
    seed(MEMORY_SEED, a, b, c);
    for (const pc of [a, b, c]) talk(pc, T0);
    swap(a, b, c);
    expect(tidying(a, b, c)).toEqual([true, false, false]);
    // a is retired: the user goes on with the bot on b and c
    talk(b, T0 + 7 * DAY + 1);
    expect(tidying(b)).toEqual([true]);
    swap(a, b, c);
    expect(tidying(a, b, c)).toEqual([false, true, false]);
    talk(c, T0 + 15 * DAY);
    swap(a, b, c);
    expect(tidying(a, b, c)).toEqual([false, false, true]);
    talk(a, T0 + 16 * DAY);
    swap(a, b, c);
    expect(tidying(a, b, c)).toEqual([true, false, false]);
  });

  it("keeps the tidy on one PC while the user switches PCs faster than their copies arrive", () => {
    const [a, b] = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb");
    seed(MEMORY_SEED, a, b);
    talk(a, T0);
    talk(b, T0);
    swap(a, b);
    // each PC is messaged again before the other's last copy lands
    const late: Array<[PC, PC, string]> = [];
    for (let step = 1; step <= 12; step++) {
      const [pc, other] = step % 2 ? [b, a] : [a, b];
      if (late.length > 1) receive(...late.shift()!);
      talk(pc, T0 + step * 60 * 60_000);
      late.push([pc, other, capture(pc)]);
      expect(tidying(a, b)).toEqual([true, false]);
    }
  });

  it("keeps the tidy on a renamed PC, even under its old device or while its machine id cannot be read, and gives a copy on another machine none of it until that PC goes quiet", () => {
    const here = thisHost();
    const [pc, peer, copy] = devices("000000000000", "bbbbbbbbbbbb", "cccccccccccc");
    Object.assign(pc.ledger, { host: "old-name", jobDevice: "aaaaaaaaaaaa" });
    pc.host = "old-name";
    seed(MEMORY_SEED, pc, peer);
    talk(pc, T0);
    talk(peer, T0);
    swap(pc, peer);
    expect(tidying(pc, peer)).toEqual([true, false]);
    // same machine, new hostname: a new device, while the old one's copy still sorts first
    ensureMemorySyncDevice(pc.ledger, "aaaaaaaaaaaa");
    pc.host = here;
    expect(pc.ledger.device).not.toBe("000000000000");
    swap(pc, peer);
    expect(tidying(pc, peer)).toEqual([true, false]);
    ensureMemorySyncDevice(pc.ledger);
    swap(pc, peer);
    expect(tidying(pc, peer)).toEqual([true, false]);
    // its data folder copied to another machine, both in use
    Object.assign(copy.ledger, structuredClone(pc.ledger), { host: "source-pc" });
    ensureMemorySyncDevice(copy.ledger, "cccccccccccc");
    copy.host = here;
    cpSync(pc.folder, copy.folder, { recursive: true });
    cpSync(pc.workspace, copy.workspace, { recursive: true });
    swap(pc, peer, copy);
    expect(tidying(pc, peer, copy)).toEqual([true, false, false]);
    // the old PC is retired
    talk(copy, T0 + 7 * DAY + 1);
    swap(pc, peer, copy);
    expect(tidying(pc, peer, copy)).toEqual([false, false, true]);
  });

  it("keeps the last pick while a copy is still arriving, so a PC it hides cannot leave two tidying", () => {
    const [a, b] = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb");
    seed(MEMORY_SEED, a, b);
    talk(a, T0);
    talk(b, T0);
    swap(a, b);
    writeFileSync(join(memorySyncDir(b.folder, "bot-1"), "aaaaaaaaaaaa.json"), "{");
    talk(b, T0 + DAY);
    expect(tidying(a, b)).toEqual([true, false]);
    receive(a, b);
    sync(b);
    expect(tidying(a, b)).toEqual([true, false]);
  });

  it("picks from the copies it can read when a broken copy hides one and there is no pick yet, and counts a copy broken for a week as gone", () => {
    const [b] = devices("bbbbbbbbbbbb");
    const broken = join(memorySyncDir(b.folder, "bot-1"), "aaaaaaaaaaaa.json");
    mkdirSync(memorySyncDir(b.folder, "bot-1"), { recursive: true });
    writeFileSync(broken, "{");
    seed(MEMORY_SEED, b);
    talk(b, T0);
    expect(tidying(b)).toEqual([true]);
    // a pick made while that copy still read: the PC behind it is gone, so the pick moves once the copy has been broken a week
    const [a, c] = devices("aaaaaaaaaaaa", "cccccccccccc");
    seed(MEMORY_SEED, a, c);
    talk(a, T0);
    talk(c, T0);
    swap(a, c);
    writeFileSync(join(memorySyncDir(c.folder, "bot-1"), "aaaaaaaaaaaa.json"), "{");
    talk(c, T0 + 8 * DAY);
    expect(tidying(c)).toEqual([false]);
    const old = (Date.now() - 8 * DAY) / 1000;
    utimesSync(join(memorySyncDir(c.folder, "bot-1"), "aaaaaaaaaaaa.json"), old, old);
    sync(c);
    expect(tidying(c)).toEqual([true]);
  });

  it("leaves out a stamp from a clock more than a day ahead, so a retired PC's clock cannot hold the tidy", () => {
    const [a, b] = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb");
    seed(MEMORY_SEED, a, b);
    const now = Date.now();
    talk(a, now + 30 * DAY);
    talk(b, now);
    swap(a, b);
    expect(tidying(b)).toEqual([true]);
    // within a day ahead is a clock a little off, and still counts
    talk(a, now + 60 * 60_000);
    swap(a, b);
    expect(tidying(a, b)).toEqual([true, false]);
  });

  it("does not give the tidy to a renamed or copied PC's new device before the others have its copy", () => {
    const here = thisHost();
    const [p, r] = devices("eeeeeeeeeeee", "ffffffffffff");
    Object.assign(r.ledger, { host: "old-name", jobDevice: "f1f1f1f1f1f1" });
    r.host = "old-name";
    seed("# Memory\n\n- Lives in Seoul\n", p, r);
    talk(p, T0);
    talk(r, T0);
    swap(p, r);
    expect(tidying(p, r)).toEqual([true, false]);
    // same machine, new hostname; its new device sorts first
    ensureMemorySyncDevice(r.ledger, "f1f1f1f1f1f1");
    r.ledger.device = "000000000001";
    r.host = here;
    sync(r);
    talk(r, T0 + 60_000);
    expect(tidying(p, r)).toEqual([true, false]);
    // p lets go once it has the new device's copy, and r takes the tidy once it has p's copy saying so
    const renamed: boolean[][] = [];
    for (const step of [() => receive(r, p), () => sync(p), () => talk(p, T0 + 2 * 60_000), () => receive(p, r), () => sync(r)]) {
      step();
      renamed.push(tidying(p, r));
    }
    expect(renamed.every((now) => now.filter(Boolean).length <= 1)).toBe(true);
    expect(renamed.at(-1)).toEqual([false, true]);
    talk(p, T0 + 8 * DAY);
    talk(r, T0 + 8 * DAY);
    swap(p, r);
    expect(tidying(p, r)).toEqual([false, true]);
    // its data folder copied to another machine, with both in use; the copy's new device sorts first
    const [n] = pcs(1);
    Object.assign(n.ledger, structuredClone(r.ledger), { host: "source-pc" });
    ensureMemorySyncDevice(n.ledger, "c1c1c1c1c1c1");
    n.ledger.device = "000000000000";
    n.host = here;
    cpSync(r.folder, n.folder, { recursive: true });
    cpSync(r.workspace, n.workspace, { recursive: true });
    const seen: boolean[][] = [];
    for (const step of [() => sync(n), () => talk(n, T0 + 8 * DAY + 60_000), () => receive(n, r), () => sync(r), () => receive(n, p), () => sync(p), () => receive(r, n), () => receive(p, n), () => sync(n), () => swap(p, r, n)]) {
      step();
      seen.push(tidying(p, r, n));
    }
    expect(seen.every((now) => now.filter(Boolean).length <= 1)).toBe(true);
    expect(seen.at(-1)).toEqual([false, false, true]);
  });

  it("hands the tidy on only once the PC that has it lets go, or has gone a week without a message", () => {
    const [b, c] = devices("bbbbbbbbbbbb", "cccccccccccc");
    seed(MEMORY_SEED, b, c);
    talk(b, T0);
    talk(c, T0);
    swap(b, c);
    expect(tidying(b, c)).toEqual([true, false]);
    // b goes six days without a message: c takes the tidy once b's copy says b let go
    talk(c, T0 + 6 * DAY + 1);
    expect(tidying(b, c)).toEqual([true, false]);
    receive(c, b);
    sync(b);
    expect(tidying(b, c)).toEqual([false, false]);
    receive(b, c);
    sync(c);
    expect(tidying(b, c)).toEqual([false, true]);
    // the user goes back to b: b waits for c to let go
    talk(b, T0 + 7 * DAY);
    expect(tidying(b, c)).toEqual([false, true]);
    receive(b, c);
    sync(c);
    receive(c, b);
    sync(b);
    expect(tidying(b, c)).toEqual([true, false]);
    // a PC that never lets go (retired) holds it a week
    talk(c, T0 + 13 * DAY + 1);
    expect(tidying(c)).toEqual([false]);
    talk(c, T0 + 14 * DAY + 1);
    expect(tidying(c)).toEqual([true]);
  });

  it("takes the tidy six hours after a message here when the PC that has it shows nothing, closed or gone", () => {
    const [a, b] = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb");
    seed(MEMORY_SEED, a, b);
    talk(a, T0);
    talk(b, T0);
    swap(a, b);
    // a week on the laptop: it takes the tidy, then is closed
    talk(b, T0 + 8 * DAY);
    swap(a, b);
    expect(tidying(a, b)).toEqual([false, true]);
    // back at the desktop: it waits on the laptop's copy, then takes the tidy once that has shown nothing for six hours
    const back = T0 + 8 * DAY + 60 * 60_000;
    talk(a, back);
    expect(tidying(a)).toEqual([false]);
    talk(a, back + 4 * 60 * 60_000);
    sync(a, back + 6 * 60 * 60_000 - 1);
    expect(tidying(a)).toEqual([false]);
    sync(a, back + 6 * 60 * 60_000);
    expect(tidying(a)).toEqual([true]);
  });

  it("takes the tidy six hours after a message here whether the closed PC's copy lands before or after it", () => {
    for (const late of [false, true]) {
      const [a, b] = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb");
      seed(MEMORY_SEED, a, b);
      talk(a, T0);
      talk(b, T0);
      swap(a, b);
      // the laptop takes the tidy while the desktop is closed, then is closed for three days
      talk(b, T0 + 8 * DAY);
      const back = T0 + 11 * DAY;
      if (!late) {
        receive(b, a);
        sync(a, back - 60_000);
      }
      talk(a, back);
      if (late) {
        receive(b, a);
        sync(a, back + 60_000);
      }
      expect(tidying(a)).toEqual([false]);
      sync(a, back + 6 * 60 * 60_000 - 1);
      expect(tidying(a)).toEqual([false]);
      sync(a, back + 6 * 60 * 60_000);
      expect(tidying(a)).toEqual([true]);
    }
  });

  it("takes the tidy within six hours of the last message on a closed PC that has it, whatever order its copies land in", () => {
    // two late copies from a laptop closed since a day after it took the tidy, landing a minute apart after a message here
    expect(handover({ back: 4 * DAY, desk: [4 * DAY], laptop: [DAY], closed: DAY, poll: 30 * 60_000, copies: (_, n) => [n * 60_000] })).toEqual([]);
    // the laptop's last message lands a minute after one here, from a laptop closed before it got this PC's copy
    const back = 3 * DAY;
    expect(handover({ back, desk: [back], laptop: [back + 60_000], closed: back + 60_000, poll: 30 * 60_000, copies: (from, n) => [from === "desk" ? 5 * 60_000 : n === 1 ? 0 : 60_000] })).toEqual([]);
    const start = beforeHandover();
    const broke = Array.from({ length: 500 }, (_, seed) => handover(shuffled(seed), start).map((what) => `seed ${seed}: ${what}`)).flat();
    expect(broke.slice(0, 5)).toEqual([]);
  }, 300_000);

  // known case: a PC whose clock is more than a day behind leaves out this PC's stamps and keeps naming itself, while its own stamps look older than a
  // message here, as a late copy's do. This PC takes the tidy six hours after that message anyway; both tidy, the later tidy wins and the other is set aside.
  it("takes the tidy six hours after a message here beside a PC in use whose clock is more than a day behind", () => {
    const [a, b] = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb");
    seed(MEMORY_SEED, a, b);
    const now = Date.now();
    const ahead = now + 2 * DAY;
    talk(b, now);
    receive(b, a);
    talk(a, ahead);
    expect(tidying(a, b)).toEqual([false, true]);
    sync(a, ahead + 6 * 60 * 60_000 - 1);
    expect(tidying(a, b)).toEqual([false, true]);
    for (let day = 0; day < 3; day++) {
      talk(a, ahead + day * DAY + 60 * 60_000);
      talk(b, now + day * DAY + 3 * 60 * 60_000);
      receive(b, a);
      sync(a, ahead + day * DAY + 23 * 60 * 60_000);
      expect(tidying(a, b)).toEqual([true, true]);
    }
  });

  // known case: Drive replays a PC's copy from before the user went back to it. The other PC takes the tidy again until the real copy
  // lands; both may tidy meanwhile, the later tidy wins and the other is set aside, so no line is lost.
  it("gives two PCs the tidy while Drive replays an old copy, until the real one lands", () => {
    const [b, c] = devices("bbbbbbbbbbbb", "cccccccccccc");
    seed(MEMORY_SEED, b, c);
    talk(b, T0);
    talk(c, T0);
    swap(b, c);
    const stale = capture(b);
    talk(c, T0 + 8 * DAY);
    swap(b, c);
    talk(b, T0 + 9 * DAY);
    swap(b, c);
    expect(tidying(b, c)).toEqual([true, false]);
    receive(b, c, stale);
    sync(c);
    expect(tidying(b, c)).toEqual([true, true]);
    receive(b, c);
    sync(c);
    expect(tidying(b, c)).toEqual([true, false]);
  });

  it("lets go of the tidy while a split folder still holds the other PC's older copy that names itself", () => {
    const [a, b] = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb");
    seed(MEMORY_SEED, a, b);
    talk(a, T0);
    talk(b, T0);
    swap(a, b);
    // a week on the laptop: it takes the tidy
    talk(b, T0 + 8 * DAY);
    const stale = capture(b);
    const back = T0 + 11 * DAY;
    receive(b, a);
    sync(a, back - 60_000);
    talk(a, back);
    expect(tidying(a, b)).toEqual([false, true]);
    // Drive split the desktop's folder and left the laptop's older copy in the second one
    const split = join(a.folder, "memory-v2 (1)", "bot-1");
    mkdirSync(split, { recursive: true });
    writeFileSync(join(split, `${b.ledger.device}.json`), stale);
    receive(a, b);
    sync(b, back + 60_000);
    expect(tidying(b)).toEqual([false]);
    // hourly turns on both PCs, each copy landing a minute after its message
    for (let hour = 0; hour < 12; hour++) {
      const at = back + hour * HOUR;
      if (hour) {
        talk(a, at);
        receive(a, b);
        sync(b, at + 60_000);
      }
      talk(b, at + 2 * 60_000);
      receive(b, a);
      sync(a, at + 3 * 60_000);
      expect(tidying(a, b)).toEqual([true, false]);
    }
  });

  it("waits on the newest of two PCs that name themselves, so a third PC takes the tidy six hours after the last message on the one that has it", () => {
    const [a, b, c] = devices("aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc");
    seed(MEMORY_SEED, a, b, c);
    talk(b, T0);
    talk(c, T0);
    swap(b, c);
    // a week on c: it takes the tidy
    talk(c, T0 + 8 * DAY);
    expect(tidying(c)).toEqual([true]);
    // back at b: it waits on c and names itself
    const back = T0 + 11 * DAY;
    receive(c, b);
    talk(b, back - 60_000);
    expect(tidying(b)).toEqual([false]);
    talk(a, back);
    // c's last message before it is closed
    const last = back + 5 * HOUR;
    talk(c, last);
    expect(tidying(c)).toEqual([true]);
    receive(b, a);
    sync(a, last + 60_000);
    receive(c, a);
    sync(a, last + 2 * 60_000);
    sync(a, back + 6 * HOUR);
    expect(tidying(a)).toEqual([false]);
    sync(a, last + 6 * HOUR - 1);
    expect(tidying(a)).toEqual([false]);
    sync(a, last + 6 * HOUR);
    expect(tidying(a)).toEqual([true]);
  });

  it("recovers a timeline parked by an older build without asking the bot to edit it", () => {
    const [a] = pcs();
    const at = new Date(2026, 10, 17, 10).getTime();
    const file = "memory/decisions.md";
    edit(a, applyPicks("", [{ kind: "pick", at, key: "forum", picked: "A - plain list", said: "a" }])!.text, file);
    edit(a, applyPicks("", [{ kind: "pick", at: at + 60_000, key: "forum", picked: "C - Reddit cards", said: "c" }])!.text, "memory/decisions.conflict-e059d14f.md");
    sync(a);
    expect(currentPicks(read(a, file))[0]?.picked).toBe("C - Reddit cards");
    const merged = read(a, file);
    sync(a);
    expect(read(a, file)).toBe(merged);
  });
  it("merges concurrent timelines by key and pick time and converges", () => {
    const [a, b] = pcs();
    const file = "memory/decisions.md";
    const at = new Date(2026, 10, 17, 10).getTime();
    const initial = applyPicks("", [{ kind: "pick", at, key: "forum", picked: "A - plain list", said: "a" }])!.text;
    edit(a, initial, file);
    sync(a); receive(a, b); sync(b);
    edit(a, applyPicks(initial, [{ kind: "pick", at: at + 120_000, key: "forum", picked: "C - Reddit cards", said: "actually c" }])!.text, file);
    edit(b, applyPicks(initial, [
      { kind: "pick", at: at + 60_000, key: "forum", picked: "B - tiles", said: "b" },
      { kind: "pick", at: at + 60_000, key: "theme", picked: "Dark", said: "dark" },
    ])!.text, file);
    sync(a); sync(b); receive(a, b); receive(b, a); sync(a); sync(b);
    expect(currentPicks(read(a, file)).map(({ picked }) => picked).sort()).toEqual(["C - Reddit cards", "Dark"]);
    expect(parseTimeline(read(a, file)!).entries.some(({ picked, replacedBy }) => picked === "B - tiles" && replacedBy)).toBe(true);
    expect(parked(a)).toEqual([]);
    receive(a, b); sync(b); receive(b, a); sync(a);
    expect(read(a, file)).toBe(read(b, file));
    expect(sync(a)[file]).toBe("current");
  });
  it("reads split roots and keeps the local snapshot in its existing folder", () => {
    const [a, b] = pcs();
    edit(a, "from a");
    sync(a);
    renameSync(join(a.folder, "memory-v2"), join(a.folder, "memory-v2 (1)"));
    edit(a, "a later");
    sync(a);
    const path = join(a.folder, "memory-v2 (1)", "bot-1", `${a.ledger.device}.json`);
    expect(JSON.parse(readFileSync(path, "utf8")).files["MEMORY.md"].text).toBe("a later");
    expect(existsSync(ownSnapshot(a))).toBe(false);
    const target = join(b.folder, "memory-v2 (2)", "bot-1");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, `${a.ledger.device}.json`), readFileSync(path));
    sync(b);
    expect(read(b)).toBe("a later");
  });

  it("pushes local changes and pulls them on the other PC", () => {
    const [a, b] = pcs();
    edit(a, "# Memory\n- prefers pnpm\n");
    edit(a, "deploy notes\n", "memory/deploy.md");
    expect(sync(a)).toEqual({ "MEMORY.md": "pushed", "memory/deploy.md": "pushed" });
    edit(b, MEMORY_SEED);
    sync(b);
    receive(a, b);
    expect(sync(b)).toEqual({ "MEMORY.md": "pulled", "memory/deploy.md": "pulled" });
    expect(read(b)).toBe("# Memory\n- prefers pnpm\n");
    expect(read(b, "memory/deploy.md")).toBe("deploy notes\n");
    expect(sync(b)).toEqual({ "MEMORY.md": "current", "memory/deploy.md": "current" });
  });

  it("follows a delete made on the other PC", () => {
    const [a, b] = pcs();
    edit(a, "stale\n", "memory/old.md");
    sync(a);
    sync(b);
    receive(a, b);
    expect(sync(b)["memory/old.md"]).toBe("pulled");
    edit(a, null, "memory/old.md");
    expect(sync(a)["memory/old.md"]).toBe("pushed");
    receive(a, b);
    expect(sync(b)["memory/old.md"]).toBe("pulled");
    expect(read(b, "memory/old.md")).toBeNull();
  });

  it("keeps edits to different files from both PCs", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "base\nfrom a\n");
    sync(a);
    edit(b, "work notes\n", "memory/work.md");
    sync(b);
    receive(a, b);
    receive(b, a);
    sync(a);
    sync(b);
    for (const pc of [a, b]) {
      expect(read(pc)).toBe("base\nfrom a\n");
      expect(read(pc, "memory/work.md")).toBe("work notes\n");
      expect(parked(pc)).toEqual([]);
    }
  });

  it.each(["its own run", "an undo", "a hand edit"])("keeps a line one PC dreamed into the archive when the other PC's copy has %s", (variant) => {
    const [a, b] = pcs();
    const at = new Date(2026, 10, 19, 12).getTime();
    const before = "# Memory\n\n- Keeps tea in the blue tin\n- Dentist on 11-02 at 3pm\n";
    const after = "# Memory\n\n- Keeps tea in the blue tin\n";
    const archive = `${DREAMED_HEAD}\n${dreamedEntry("old", [{ at: 3, text: "- Lives in Busan", by: "", why: "replaced" }], at)}\n`;
    edit(a, before);
    edit(a, archive, DREAMED_FILE);
    settle(a, b);
    edit(a, after);
    markTidied(a.ledger, "bot-1", before, after);
    edit(a, `${archive}\n${dreamedEntry("night", [{ at: 3, text: "- Dentist on 11-02 at 3pm", by: "", why: "expired" }], at)}\n`, DREAMED_FILE);
    sync(a);
    const theirs = variant === "its own run"
      ? `${archive}\n${dreamedEntry("other", [{ at: 2, text: "- Likes green tea", by: "", why: "duplicate" }], at)}\n`
      : variant === "an undo" ? markUndone(archive, "old", at) : archive.replace("- Lives in Busan", "- Lives in Busan, Haeundae");
    edit(b, theirs, DREAMED_FILE);
    sync(b);
    settle(a, b);
    for (const pc of [a, b]) {
      expect(read(pc)).toBe(after);
      const kept = read(pc, DREAMED_FILE)!;
      expect(kept).toContain("- Dentist on 11-02 at 3pm\n");
      for (const line of nonblankLines(theirs)) expect(kept).toContain(line);
    }
    expect(read(a, DREAMED_FILE)).toBe(read(b, DREAMED_FILE));
  });

  it.each([["deletes", null], ["empties", ""]] as const)("keeps a line one PC dreamed when the PC the user last messaged %s its older archive", (_, gone) => {
    const [a, b] = pcs();
    const at = new Date(2026, 10, 19, 12).getTime();
    const archive = `${DREAMED_HEAD}\n${dreamedEntry("old", [{ at: 3, text: "- Lives in Busan", by: "", why: "replaced" }], at)}\n`;
    edit(a, "# Memory\n\n- Keeps tea in the blue tin\n");
    edit(a, archive, DREAMED_FILE);
    settle(a, b);
    edit(a, `${archive}\n${dreamedEntry("night", [{ at: 3, text: "- Opaline kestrel parcels go to Alverton", by: "", why: "expired" }], at)}\n`, DREAMED_FILE);
    markTalked(a.ledger, "bot-1", 5_000);
    sync(a);
    edit(b, gone, DREAMED_FILE);
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    settle(a, b);
    for (const pc of [a, b]) {
      expect(read(pc, DREAMED_FILE)).toContain("- Opaline kestrel parcels go to Alverton\n");
      expect(parked(pc)).toEqual([]);
    }
    expect(read(a, DREAMED_FILE)).toBe(read(b, DREAMED_FILE));
  });

  it("keeps the copy from the PC the user last messaged and sets the other aside on both PCs", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "from a\n");
    markTalked(a.ledger, "bot-1", 5_000);
    sync(a);
    edit(b, "from b\n");
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    receive(a, b);
    receive(b, a);
    expect(sync(a)["MEMORY.md"]).toBe("conflict");
    expect(sync(b)["MEMORY.md"]).toBe("conflict");
    for (const pc of [a, b]) {
      expect(read(pc)).toBe("from b\n");
      expect(parked(pc)).toEqual(["from a\n"]);
    }
    for (let round = 0; round < 2; round++) {
      receive(a, b);
      receive(b, a);
      expect(sync(a)["MEMORY.md"]).toBe("current");
      expect(sync(b)["MEMORY.md"]).toBe("current");
    }
    expect(parked(a)).toEqual(["from a\n"]);
    expect(parked(b)).toEqual(["from a\n"]);
  });

  it("dates the set-aside copy so the bot can tell how old it is", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "from a\n", "MEMORY.md", Date.UTC(2026, 9, 2, 9, 21));
    sync(a);
    edit(b, "from b\n");
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    receive(a, b);
    sync(b);
    const name = readdirSync(join(b.workspace, "memory")).find((file) => file.includes(".conflict-"))!;
    expect(name).toMatch(/^MEMORY\.conflict-[0-9a-f]{8}\.md$/);
    expect(read(b, `memory/${name}`)!.split("\n")[0]).toContain("last edited 2026-10-02 09:21 UTC");
  });

  it("breaks a tie by the later edit when the user messaged neither PC", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "from a\n", "MEMORY.md", 3_000_000_000);
    sync(a);
    edit(b, "from b\n", "MEMORY.md", 2_000_000_000);
    sync(b);
    receive(a, b);
    receive(b, a);
    sync(a);
    sync(b);
    for (const pc of [a, b]) {
      expect(read(pc)).toBe("from a\n");
      expect(parked(pc)).toEqual(["from b\n"]);
    }
  });

  it("keeps the other PC's text when a delete wins a tie", () => {
    const [a, b] = pcs();
    seed("deploy Fridays\n", a, b);
    edit(a, null);
    markTalked(a.ledger, "bot-1", 9_000);
    sync(a);
    edit(b, "deploy Fridays\nwork ready\n");
    sync(b);
    receive(a, b);
    expect(sync(b)["MEMORY.md"]).toBe("conflict");
    expect(read(b)).toBeNull();
    expect(parked(b)).toEqual(["deploy Fridays\nwork ready\n"]);
  });

  it("ignores a replayed older copy after a correction", () => {
    const [h, w] = pcs();
    seed("pnpm\n", h, w);
    edit(w, "pnpm\nincorrect deployment\n");
    sync(w);
    const stale = capture(w);
    receive(w, h);
    expect(sync(h)["MEMORY.md"]).toBe("pulled");
    edit(h, "pnpm\n");
    expect(sync(h)["MEMORY.md"]).toBe("pushed");
    receive(w, h, stale);
    expect(sync(h)["MEMORY.md"]).toBe("current");
    expect(read(h)).toBe("pnpm\n");
    expect(parked(h)).toEqual([]);
  });

  it("sets aside an edit to a copy this PC undid, however many edits ago", () => {
    for (const depth of [1, 8, 20]) {
      const [h, w] = pcs();
      seed("pnpm\n", h, w);
      edit(w, "pnpm\nincorrect deployment\n");
      sync(w);
      receive(w, h);
      sync(h);
      for (let i = 1; i < depth; i++) {
        edit(h, `intermediate ${i}\n`);
        sync(h);
      }
      edit(h, "pnpm\n");
      markTalked(h.ledger, "bot-1", 9_000);
      sync(h);
      edit(w, "pnpm\nincorrect deployment\nwork ready\n");
      sync(w);
      receive(w, h);
      expect(sync(h)["MEMORY.md"], `depth ${depth}`).toBe("conflict");
      expect(read(h), `depth ${depth}`).toBe("pnpm\n");
      expect(parked(h), `depth ${depth}`).toEqual(["pnpm\nincorrect deployment\nwork ready\n"]);
    }
  });

  it("ignores snapshots it cannot read or trust", () => {
    const [h, w] = pcs();
    seed("pnpm\n", h, w);
    const device = w.ledger.device!;
    // a snapshot claiming a newer "stale" copy, with `vv` spliced in as raw JSON
    const stale = (vv: string, { file = "MEMORY.md", version = 1, owner = device } = {}) =>
      `{"format":"orbit.memory-sync","version":${version},"device":"${owner}","talkedAt":0,"files":{${JSON.stringify(file)}:{"vv":${vv},"at":1,"text":"stale\\n"}}}`;
    const home = h.ledger.device!;
    // each would win if trusted: it claims every edit home made and more
    const newer = `{"${home}":5,"${device}":99}`;
    const bad = [
      "{ half a file",
      stale(newer, { owner: "ffffffffffff" }),
      stale(newer, { version: 2 }),
      stale(`{"${home}":5,"${device}":-1}`),
      stale(`{"${home}":5,"${device}":1.5}`),
      stale(`{"${home}":5,"${device}":9007199254740992}`),
      stale(`{"${home}":5,"not-a-device":99}`),
      stale("[99]"),
      stale(`"99"`),
      stale("null"),
      stale(newer, { file: "../escape.md" }),
      stale(newer, { file: "memory/../../escape.md" }),
    ];
    for (const snapshot of bad) {
      receive(w, h, snapshot);
      expect(sync(h)["MEMORY.md"], snapshot).toBe("current");
      expect(read(h)).toBe("pnpm\n");
    }
    expect(existsSync(join(h.workspace, "..", "escape.md"))).toBe(false);
    expect(parked(h)).toEqual([]);
    receive(w, h, stale(newer));
    expect(sync(h)["MEMORY.md"]).toBe("pulled");
    expect(read(h)).toBe("stale\n");
  });

  it("gives a ledger copied from another PC its own identity", () => {
    const [h, w] = pcs();
    edit(h, "pnpm\n");
    sync(h);
    w.ledger = structuredClone(h.ledger);
    edit(w, "pnpm\n");
    edit(h, "home correction\n");
    markTalked(h.ledger, "bot-1", 9_000);
    sync(h);
    edit(w, "work divergent\n");
    sync(w);
    edit(w, "work divergent plus\n");
    sync(w);
    expect(w.ledger.device).not.toBe(h.ledger.device);
    receive(w, h);
    expect(sync(h)["MEMORY.md"]).toBe("conflict");
    expect(read(h)).toBe("home correction\n");
    expect(parked(h)).toEqual(["work divergent plus\n"]);
  });

  it("does not reuse its counts after its ledger is rolled back", () => {
    const [h, w] = pcs();
    seed("v1\n", h, w);
    const backup = structuredClone(h.ledger);
    edit(h, "v2\n");
    sync(h);
    receive(h, w);
    sync(w);
    h.ledger = backup;
    edit(h, "v3 after restore\n");
    sync(h);
    receive(h, w);
    expect(sync(w)["MEMORY.md"]).toBe("pulled");
    expect(read(w)).toBe("v3 after restore\n");
    expect(parked(w)).toEqual([]);
  });

  it("treats the same versions with different text as a tie", () => {
    const [h, w] = pcs();
    seed("pnpm\n", h, w);
    const forged = JSON.parse(capture(h));
    forged.files["MEMORY.md"].text = "forged\n";
    receive(h, w, JSON.stringify(forged));
    expect(sync(w)["MEMORY.md"]).toBe("conflict");
    expect([read(w), ...parked(w)].sort()).toEqual(["forged\n", "pnpm\n"]);
  });

  it("relays hundreds of alternating edits to a PC that was away, without a conflict", () => {
    const [h, w, l] = pcs(3);
    seed("v0\n", h, w, l);
    for (let i = 1; i <= 320; i++) {
      const [from, to] = i % 2 ? [w, h] : [h, w];
      edit(from, `v${i}\n`);
      sync(from);
      receive(from, to);
      expect(sync(to)["MEMORY.md"]).toBe("pulled");
    }
    receive(h, l);
    receive(w, l);
    expect(sync(l)["MEMORY.md"]).toBe("pulled");
    expect(read(l)).toBe("v320\n");
    expect(parked(l)).toEqual([]);
    // ~970 fsync'd writes: 1.6 s on Linux, 17.1 s on a passing Windows CI run, over 30 s on a slow one
  }, 90_000);

  it("pulls a copy two other PCs built on since this one last synced", () => {
    const [a, b, c] = pcs(3);
    seed("v1\n", a, b, c);
    edit(a, "v2\n");
    sync(a);
    receive(a, b);
    sync(b);
    edit(b, "v3\n");
    sync(b);
    receive(b, c);
    sync(c);
    edit(c, "v4\n");
    sync(c);
    receive(c, a);
    expect(sync(a)["MEMORY.md"]).toBe("pulled");
    expect(read(a)).toBe("v4\n");
  });

  it("joins PCs that already hold the same notes without a conflict", () => {
    const [h, w] = pcs();
    edit(h, "same\n");
    edit(w, "same\n");
    sync(h);
    sync(w);
    receive(h, w);
    receive(w, h);
    expect(sync(h)["MEMORY.md"]).toBe("current");
    expect(sync(w)["MEMORY.md"]).toBe("current");
    edit(w, "same\nmore\n");
    sync(w);
    receive(w, h);
    expect(sync(h)["MEMORY.md"]).toBe("pulled");
    expect(parked(h)).toEqual([]);
  });

  it("lets a copy the older build pulled give way on first sync, and sets aside the older of two it pushed", () => {
    const [h, w] = pcs();
    edit(h, "home notes\n");
    edit(h, "home deploy\n", "memory/deploy.md", Date.UTC(2026, 9, 1));
    h.legacy = {
      "bot-1/MEMORY.md": sha("home notes\n"),
      "~bot-1/MEMORY.md": sha("older\n"),
      "bot-1/memory/deploy.md": sha("home deploy\n"),
    };
    edit(w, "older\n");
    edit(w, "work deploy\n", "memory/deploy.md", Date.UTC(2026, 9, 3));
    w.legacy = {
      "bot-1/MEMORY.md": sha("older\n"),
      "~bot-1/MEMORY.md": sha("older\n"),
      "bot-1/memory/deploy.md": sha("work deploy\n"),
      "~bot-1/memory/deploy.md": sha("home deploy\n"),
    };
    markTalked(h.ledger, "bot-1", 9_000);
    sync(h);
    sync(w);
    receive(h, w);
    receive(w, h);
    expect(sync(w)).toMatchObject({ "MEMORY.md": "pulled", "memory/deploy.md": "conflict" });
    expect(sync(h)).toMatchObject({ "MEMORY.md": "current", "memory/deploy.md": "conflict" });
    for (const pc of [h, w]) {
      expect(read(pc)).toBe("home notes\n");
      expect(read(pc, "memory/deploy.md")).toBe("work deploy\n");
      expect(parked(pc)).toEqual(["home deploy\n"]);
    }
  });

  it("lets a copy the older build last pushed lose a tie to a later edit, even on the PC the user just messaged", () => {
    const [h, l] = pcs();
    edit(h, "newer\n", "MEMORY.md", Date.UTC(2026, 9, 4));
    markTalked(h.ledger, "bot-1", 5_000);
    sync(h);
    edit(l, "oct 2\n", "MEMORY.md", Date.UTC(2026, 9, 2));
    l.legacy = { "bot-1/MEMORY.md": sha("oct 2\n"), "~bot-1/MEMORY.md": sha("older\n") };
    sync(l);
    markTalked(l.ledger, "bot-1", 9_000);
    receive(h, l);
    expect(sync(l)["MEMORY.md"]).toBe("conflict");
    expect(read(l)).toBe("newer\n");
    expect(parked(l)).toEqual(["oct 2\n"]);
    receive(l, h);
    sync(h);
    expect(read(h)).toBe("newer\n");
  });

  it("keeps a file the older build deleted from coming back from a PC that still has it", () => {
    const [h, l] = pcs();
    edit(h, "notes\n");
    h.legacy = { "bot-1/MEMORY.md": sha("notes\n"), "~bot-1/MEMORY.md": sha("notes\n") };
    const sidecar = join(h.folder, "memory", "bot-1", ".ancestry", "memory", "client.md.json");
    mkdirSync(join(sidecar, ".."), { recursive: true });
    writeFileSync(sidecar, '{"hash":null}\n');
    sync(h);
    edit(l, "notes\n");
    edit(l, "client: acme\n", "memory/client.md");
    l.legacy = {
      "bot-1/MEMORY.md": sha("notes\n"),
      "~bot-1/MEMORY.md": sha("notes\n"),
      "bot-1/memory/client.md": sha("client: acme\n"),
      "~bot-1/memory/client.md": sha("client: acme\n"),
    };
    sync(l);
    receive(h, l);
    receive(l, h);
    sync(l);
    sync(h);
    for (const pc of [h, l]) expect(read(pc, "memory/client.md")).toBeNull();
    expect(parked(l)).toEqual([]);
  });

  it("keeps a delete made on the older build during the update gap", () => {
    const [h, w] = pcs();
    edit(h, "notes\n");
    edit(h, "old topic\n", "memory/old.md", Date.UTC(2026, 9, 1));
    h.legacy = {
      "bot-1/MEMORY.md": sha("notes\n"),
      "~bot-1/MEMORY.md": sha("notes\n"),
      "bot-1/memory/old.md": sha("old topic\n"),
      "~bot-1/memory/old.md": sha("older topic\n"),
    };
    sync(h);
    edit(w, "notes\n");
    w.legacy = { "bot-1/MEMORY.md": sha("notes\n"), "~bot-1/MEMORY.md": sha("notes\n") };
    const sidecar = join(w.folder, "memory", "bot-1", ".ancestry", "memory", "old.md.json");
    mkdirSync(join(sidecar, ".."), { recursive: true });
    writeFileSync(sidecar, '{"hash":null}\n');
    sync(w);
    receive(h, w);
    sync(w);
    receive(w, h);
    sync(h);
    for (const pc of [h, w]) {
      expect(read(pc, "memory/old.md")).toBeNull();
      expect(parked(pc)).toEqual(["old topic\n"]);
    }
  });

  it("drops a set-aside copy once its file holds every line of it, on both PCs", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "from a\n");
    sync(a);
    edit(b, "from b\n");
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    receive(a, b);
    sync(b);
    receive(b, a);
    sync(a);
    expect(parked(a)).toEqual(["from a\n"]);
    edit(b, "from b\nmore\n");
    sync(b);
    expect(parked(b)).toEqual(["from a\n"]);
    edit(b, "from b\nmore\nfrom a\n");
    sync(b);
    expect(parked(b)).toEqual([]);
    receive(b, a);
    sync(a);
    expect(read(a)).toBe("from b\nmore\nfrom a\n");
    expect(parked(a)).toEqual([]);
  });

  it("drops a set-aside copy right away when it adds nothing to the copy kept", () => {
    const [h, w] = pcs();
    seed("pnpm\n", h, w);
    edit(h, "pnpm\ndeploy Fridays\n");
    sync(h);
    edit(w, "pnpm\ndeploy Fridays\nwork ready\n");
    markTalked(w.ledger, "bot-1", 9_000);
    sync(w);
    receive(h, w);
    expect(sync(w)["MEMORY.md"]).toBe("conflict");
    expect(read(w)).toBe("pnpm\ndeploy Fridays\nwork ready\n");
    expect(parked(w)).toEqual([]);
  });

  it("re-seeds Drive from local files when the folder is gone", () => {
    const [a] = pcs(1);
    edit(a, "notes\n");
    sync(a);
    rmSync(memorySyncDir(a.folder, "bot-1"), { recursive: true });
    sync(a);
    expect(read(a)).toBe("notes\n");
    expect(JSON.parse(capture(a)).files["MEMORY.md"].text).toBe("notes\n");
  });

  it("pulls into a missing workspace instead of deleting the notes everywhere", () => {
    const [a, b] = pcs();
    seed("notes\n", a, b);
    rmSync(b.workspace, { recursive: true });
    expect(sync(b)["MEMORY.md"]).toBe("pulled");
    expect(read(b)).toBe("notes\n");
    receive(b, a);
    expect(sync(a)["MEMORY.md"]).toBe("current");
    expect(read(a)).toBe("notes\n");
  });

  it("restores a missing workspace from this PC's own newest snapshot", () => {
    const [h, w] = pcs();
    seed("notes\n", h, w);
    edit(h, "notes\nnew home note\n");
    edit(h, "home only\n", "memory/home.md");
    sync(h);
    rmSync(h.workspace, { recursive: true });
    receive(w, h);
    sync(h);
    expect(read(h)).toBe("notes\nnew home note\n");
    expect(read(h, "memory/home.md")).toBe("home only\n");
    expect(parked(h)).toEqual([]);
    const published = JSON.parse(capture(h)).files;
    expect(published["MEMORY.md"].text).toBe("notes\nnew home note\n");
    expect(published["memory/home.md"].text).toBe("home only\n");
  });

  it("repairs its own snapshot when Drive puts back an older or broken copy", () => {
    const [h] = pcs(1);
    edit(h, "v1\n");
    sync(h);
    const old = capture(h);
    edit(h, "v2\n");
    sync(h);
    for (const bad of [old, "{ half a file"]) {
      writeFileSync(ownSnapshot(h), bad);
      expect(sync(h)["MEMORY.md"]).toBe("current");
      expect(JSON.parse(capture(h)).files["MEMORY.md"].text).toBe("v2\n");
    }
  });

  it("keeps the last-messaged PC's copy when a third PC relays the tie", () => {
    const [h, w, l] = pcs(3);
    seed("base\n", h, w, l);
    edit(h, "from home\n");
    markTalked(h.ledger, "bot-1", 9_000);
    sync(h);
    edit(w, "from work\n");
    markTalked(w.ledger, "bot-1", 1_000);
    sync(w);
    receive(h, l);
    expect(sync(l)["MEMORY.md"]).toBe("pulled");
    receive(w, l);
    expect(sync(l)["MEMORY.md"]).toBe("conflict");
    receive(l, w);
    sync(w);
    receive(l, h);
    sync(h);
    for (const pc of [h, w, l]) {
      expect(read(pc)).toBe("from home\n");
      expect(parked(pc)).toEqual(["from work\n"]);
    }
  });

  it("keeps a set-aside copy whose lines sit in a different order in its file", () => {
    const [a, b] = pcs();
    seed("base\n", a, b);
    edit(a, "## Ana\n- owns deploys\n## Bo\n- owns docs\n");
    sync(a);
    edit(b, "## Ana\n- owns docs\n## Bo\n- owns deploys\n");
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    receive(a, b);
    expect(sync(b)["MEMORY.md"]).toBe("conflict");
    expect(read(b)).toBe("## Ana\n- owns docs\n## Bo\n- owns deploys\n");
    expect(parked(b)).toEqual(["## Ana\n- owns deploys\n## Bo\n- owns docs\n"]);
  });

  it("joins a new PC's first notes into the full notes, whichever PC sees the other first", () => {
    const full = `# Memory\n\n${Array.from({ length: 30 }, (_, n) => `- fact ${n + 1} the user told this bot`).join("\n")}\n`;
    for (const order of ["first pass", "b sees a", "a sees b", "both at once"]) {
      const [a, b] = pcs();
      edit(a, full);
      markTalked(a.ledger, "bot-1", 5_000);
      sync(a);
      edit(b, "# Memory\n\n- Likes tea\n");
      markTalked(b.ledger, "bot-1", 9_000);
      if (order !== "first pass") sync(b);
      if (order === "first pass" || order === "b sees a") {
        receive(a, b);
        sync(b);
      } else if (order === "a sees b") {
        receive(b, a);
        sync(a);
      } else {
        receive(a, b);
        receive(b, a);
        sync(a);
        sync(b);
      }
      for (let round = 0; round < 2; round++) {
        receive(a, b);
        receive(b, a);
        sync(a);
        sync(b);
      }
      for (const pc of [a, b]) {
        expect(read(pc), order).toBe(`${full}- Likes tea\n`);
        expect(parked(pc), order).toEqual([]);
      }
    }
  });

  it("syncs side files named in any language and in subfolders, where older builds still read the rest", () => {
    const [a, b] = pcs();
    edit(a, "# Memory\n- see memory/프로젝트.md\n");
    edit(a, "Korean-named notes\n", "memory/프로젝트.md");
    edit(a, "plan in a subfolder\n", "memory/projects/launch-plan.md");
    sync(a);
    receive(a, b);
    sync(b);
    expect(read(b, "memory/프로젝트.md")).toBe("Korean-named notes\n");
    expect(read(b, "memory/projects/launch-plan.md")).toBe("plan in a subfolder\n");
    // an older build parses `files` with its ASCII, no-folder name rule and rejects the whole snapshot on any other name
    const snapshot = JSON.parse(capture(a));
    expect(Object.keys(snapshot.files).every((name) => name === "MEMORY.md" || /^memory\/[\w][\w .-]{0,199}\.md$/.test(name))).toBe(true);
    expect(Object.keys(snapshot.wide).sort()).toEqual(["memory/projects/launch-plan.md", "memory/프로젝트.md"]);
  });

  it("keeps a side file moved into a subfolder on the other PC", () => {
    const [a, b] = pcs();
    seed("# Memory\n- Launch plan: read memory/launch-plan.md before release talk\n", a, b);
    edit(a, "Launch on Dec 1.\n", "memory/launch-plan.md");
    sync(a);
    receive(a, b);
    sync(b);
    mkdirSync(join(a.workspace, "memory", "archive"));
    renameSync(join(a.workspace, "memory", "launch-plan.md"), join(a.workspace, "memory", "archive", "launch-plan.md"));
    edit(a, "# Memory\n- Launch plan: read memory/archive/launch-plan.md before release talk\n");
    sync(a);
    receive(a, b);
    sync(b);
    expect(read(b, "memory/archive/launch-plan.md")).toBe("Launch on Dec 1.\n");
    expect(read(b, "memory/launch-plan.md")).toBeNull();
  });

  it("joins a fresh third PC's notes into a file two PCs both edited, with every line kept on all three", () => {
    const full = `# Memory\n\n${Array.from({ length: 30 }, (_, n) => `- fact ${n + 1} the user told this bot`).join("\n")}\n`;
    const [a, b, c] = pcs(3);
    seed(full, a, b);
    edit(b, `${full}- fact from b\n`);
    sync(b);
    receive(b, a);
    sync(a);
    edit(a, `${full}- fact from b\n- fact from a\n`);
    sync(a);
    receive(a, b);
    sync(b);
    edit(c, "# Memory\n\n- Likes tea\n");
    markTalked(c.ledger, "bot-1", 9_000);
    settle(a, b, c);
    for (const pc of [a, b, c]) {
      expect(read(pc)).toBe(`${full}- fact from b\n- fact from a\n- Likes tea\n`);
      expect(parked(pc)).toEqual([]);
    }
  });

  it("joins a reinstalled PC's fresh notes into the pair's file", () => {
    const full = `# Memory\n\n${Array.from({ length: 30 }, (_, n) => `- fact ${n + 1}`).join("\n")}\n`;
    const [a, b] = pcs();
    seed(full, a, b);
    edit(b, `${full}- fact from b\n`);
    sync(b);
    receive(b, a);
    sync(a);
    rmSync(b.workspace, { recursive: true, force: true });
    b.ledger = { bots: {} };
    edit(b, "# Memory\n\n- Likes tea\n");
    markTalked(b.ledger, "bot-1", 9_000);
    settle(a, b);
    for (const pc of [a, b]) {
      expect(read(pc)).toBe(`${full}- fact from b\n- Likes tea\n`);
      expect(parked(pc)).toEqual([]);
    }
  });

  it("reads CRLF and LF first copies as the same lines", () => {
    const facts = Array.from({ length: 30 }, (_, n) => `- fact ${n + 1}`);
    const [a, b] = pcs();
    edit(a, `# Memory\r\n\r\n${facts.join("\r\n")}\r\n`);
    sync(a);
    edit(b, `# Memory\n\n${facts.join("\n")}\n- Likes tea\n`);
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    settle(a, b);
    for (const pc of [a, b]) {
      const lines = read(pc)!.split(/\r?\n/).filter(Boolean);
      expect(lines).toEqual(["# Memory", ...facts, "- Likes tea"]);
      expect(parked(pc)).toEqual([]);
    }
  });

  it("keeps a line deleted while a first join was on its way, whoever the user messaged last", () => {
    const facts = Array.from({ length: 30 }, (_, n) => `- fact ${n + 1}`);
    const full = `# Memory\n\n${facts.join("\n")}\n`;
    const trimmed = full.replace("- fact 3\n", "");
    for (const last of ["a", "b"]) {
      for (const joinedOnA of [false, true]) {
        const [a, b] = pcs();
        edit(a, full);
        markTalked(a.ledger, "bot-1", last === "a" ? 9_000 : 5_000);
        sync(a);
        edit(b, "# Memory\n\n- Likes tea\n");
        markTalked(b.ledger, "bot-1", last === "b" ? 9_000 : 5_000);
        sync(b);
        const bFirst = capture(b);
        receive(a, b);
        sync(b);
        if (joinedOnA) {
          receive(b, a, bFirst);
          sync(a);
          edit(a, `${trimmed}- Likes tea\n`);
        } else {
          edit(a, trimmed);
        }
        sync(a);
        settle(a, b);
        const label = `${last} talked last, ${joinedOnA ? "a joined too" : "a never saw b"}`;
        for (const pc of [a, b]) {
          expect(read(pc), label).toBe(`${trimmed}- Likes tea\n`);
          expect(parked(pc), label).toEqual([]);
        }
      }
    }
  });

  it("puts a joined line under its own heading, keeps repeated lines, and sets aside a copy whose line it moved", () => {
    const [a, b] = pcs();
    edit(a, "# Memory\n\n## Likes\n- Coffee\n- Jazz\n- Hiking\n\n## Work\n- Ships on Fridays\n- Uses vim\n");
    sync(a);
    edit(b, "# Memory\n\n## Likes\n- Tea\n\n## Dislikes\n- Coffee\n\n---\n---\n");
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    settle(a, b);
    const want = "# Memory\n\n## Likes\n- Coffee\n- Jazz\n- Hiking\n- Tea\n\n## Work\n- Ships on Fridays\n- Uses vim\n\n## Dislikes\n---\n---\n";
    for (const pc of [a, b]) {
      expect(read(pc)).toBe(want);
      expect(parked(pc)).toEqual(["# Memory\n\n## Likes\n- Tea\n\n## Dislikes\n- Coffee\n\n---\n---\n"]);
    }
  });

  it("syncs a note moved into a folder whose name ends in .md", () => {
    const [a, b] = pcs();
    edit(a, "# Memory\n- x\n");
    edit(a, "# Plan\n- p\n", "memory/plan.md");
    sync(a);
    settle(a, b);
    expect(read(b, "memory/plan.md")).toBe("# Plan\n- p\n");
    rmSync(join(a.workspace, "memory/plan.md"));
    edit(a, "# Plan\n- p\n", "memory/archive.md/plan.md");
    sync(a);
    settle(a, b);
    expect(read(b, "memory/archive.md/plan.md")).toBe("# Plan\n- p\n");
    expect(read(b, "memory/plan.md")).toBeNull();
  });

  it("keeps a line deleted on the other PC out of a copy this PC kept after losing its ledger", () => {
    const facts = Array.from({ length: 10 }, (_, n) => `- fact ${n + 1}`);
    const full = `# Memory\n\n${facts.join("\n")}\n`;
    // the new device id sorts before or after the old snapshot, so either is read first
    for (const [oldSnapshot, device] of [["kept", "000000000000"], ["kept", "ffffffffffff"], ["gone", "000000000000"]] as const) {
      const [a, b] = pcs();
      seed(full, a, b);
      if (oldSnapshot === "gone") rmSync(ownSnapshot(b));
      b.ledger = { bots: {}, device, host: b.host };
      edit(a, full.replace("- fact 4\n", ""));
      sync(a);
      markTalked(b.ledger, "bot-1", 9_000);
      sync(b);
      settle(a, b);
      for (const pc of [a, b]) {
        expect(read(pc), `${oldSnapshot} ${device}`).toBe(full.replace("- fact 4\n", ""));
        expect(parked(pc), `${oldSnapshot} ${device}`).toEqual([]);
      }
    }
  });

  it("joins back the full notes an older build set aside when it took a new PC's first notes, either way it broke the tie", () => {
    const full = `# Memory\n\n${Array.from({ length: 30 }, (_, n) => `- fact ${n + 1}`).join("\n")}\n`;
    for (const kept of ["note", "full"]) {
      const [a, b] = pcs();
      edit(a, full);
      sync(a);
      edit(b, "# Memory\n\n- Likes tea\n");
      markTalked(b.ledger, "bot-1", 9_000);
      sync(b);
      // what the older build on A publishes after its tie: one copy kept, the other set aside under the same versions
      const mine = JSON.parse(capture(a));
      delete mine.joins;
      const theirs = JSON.parse(capture(b));
      const vv = { ...mine.files["MEMORY.md"].vv, ...theirs.files["MEMORY.md"].vv };
      const lost = kept === "note" ? full : "# Memory\n\n- Likes tea\n";
      const body = `<!-- memory sync: a copy of MEMORY.md set aside when two PCs changed it at once -->\n${lost}`;
      mine.files = {
        "MEMORY.md": kept === "note" ? { vv, at: 1, text: "# Memory\n\n- Likes tea\n", by: { device: b.ledger.device, talkedAt: 9_000 } } : { vv, at: 1, text: full },
        [`memory/MEMORY.conflict-${sha(body).slice(0, 8)}.md`]: { vv, at: 1, text: body },
      };
      receive(a, b, `${JSON.stringify(mine)}\n`);
      sync(b);
      expect(read(b), kept).toBe(`${full}- Likes tea\n`);
      expect(parked(b), kept).toEqual([]);
    }
  });

  it("still sets aside one of two edits made at once to a file a join built, once the join has settled", () => {
    const [a, b] = pcs();
    edit(a, "# Memory\n\n- Budget: 100 dollars\n- Owns deploys\n");
    sync(a);
    edit(b, "# Memory\n\n- Likes tea\n");
    markTalked(b.ledger, "bot-1", 9_000);
    sync(b);
    settle(a, b);
    const joined = "# Memory\n\n- Budget: 100 dollars\n- Owns deploys\n- Likes tea\n";
    expect(read(a)).toBe(joined);
    edit(a, joined.replace("100", "200"));
    sync(a);
    edit(b, joined.replace("100", "300"));
    sync(b);
    settle(a, b);
    for (const pc of [a, b]) {
      expect(read(pc)).toBe(joined.replace("100", "300"));
      expect(parked(pc)).toEqual([joined.replace("100", "200")]);
    }
  });

  it("publishes the last good copy of a file it cannot read this pass", () => {
    const [a] = pcs(1);
    edit(a, "deploy notes\n", "memory/deploy.md");
    sync(a);
    const before = JSON.parse(capture(a)).files["memory/deploy.md"];
    rmSync(join(a.workspace, "memory/deploy.md"));
    mkdirSync(join(a.workspace, "memory/deploy.md"));
    expect(sync(a)["memory/deploy.md"]).toBe("skipped");
    expect(JSON.parse(capture(a)).files["memory/deploy.md"]).toEqual(before);
  });
});
