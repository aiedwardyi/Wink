import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GoogleAccount, type GoogleSession } from "./google-account.ts";
import { createGoogleSync, type GoogleSync } from "./google-sync.ts";
import { parseHistory } from "./memory-clean.ts";
import { loadOrCreateSyncWorkspace, loadProfileSyncSettings, saveProfileSyncSettings, syncedInFolder } from "./profile-sync.ts";
import { FakeDrive } from "./testing/fake-drive.ts";
import type { ReportBot, TestArgs, TestResult } from "./testing/google-sync-pc.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const A: GoogleSession = { refreshToken: "refresh-a", sub: "account-a", email: "a@example.com" };
const tokenFetch: typeof fetch = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));
const BOT = "Counsel";
// 167 lines, so the size check queues a cleanup
const DONE = Array.from({ length: 12 }, (_, i) => `- done: picked up parcel ${i + 1}`);
const MEMORY = ["# Counsel memory", "", "## Notes", ...Array.from({ length: 150 }, (_, i) => `- note ${i + 1}: the blue folder holds receipts for week ${i + 1}`), "", "## Done", ...DONE, ""].join("\n");

interface PC {
  dataDir: string; account: GoogleAccount; sync: GoogleSync;
  call(method: string, args?: TestArgs): Promise<TestResult>;
  close(): Promise<void>;
}

let root: string;
let drive: FakeDrive;
let pcs: PC[];
let written: Set<string>;

function boot(pc: Omit<PC, "sync">): GoogleSync {
  return createGoogleSync({
    dataDir: pc.dataDir,
    account: pc.account,
    folder: () => loadProfileSyncSettings(pc.dataDir).folder,
    prepare: () => {},
    unusedBots: () => [],
    activate: (mirror) => {
      let settings = loadProfileSyncSettings(pc.dataDir);
      if (settings.folder !== mirror) settings = { ...settings, reviewedResolutions: {}, seenCheckpoint: "" };
      const workspaceId = loadOrCreateSyncWorkspace(mirror, settings.workspaceId);
      if (workspaceId !== settings.workspaceId) settings = { ...settings, workspaceId, botMap: {}, sectionMap: {}, reviewedResolutions: {}, seenCheckpoint: "", syncedHashes: {} };
      saveProfileSyncSettings(pc.dataDir, { ...settings, folder: mirror, syncChats: true, syncedHashes: syncedInFolder(settings.syncedHashes, mirror) });
      void pc.call("republish");
      return workspaceId;
    },
    fetch: (input, init) => drive.fetch(input, init),
    log: () => {},
  });
}

function makePC(name: string, oldBuild = false): PC {
  const dataDir = join(root, name);
  const worker = new Worker(new URL("./testing/google-sync-pc.ts", import.meta.url), {
    workerData: { dataDir, oldBuild }, env: { ...process.env, OMB_DATA_DIR: dataDir, OMB_THREAD_SYNC_V2: "1" }, execArgv: ["--experimental-strip-types"],
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: TestResult): void; reject(error: Error): void }>();
  worker.on("message", ({ id, value, error }: { id: number; value: TestResult; error?: string }) => {
    const request = pending.get(id);
    pending.delete(id);
    if (error) request?.reject(new Error(error));
    else request?.resolve(value);
  });
  worker.on("error", (error: Error) => { for (const request of pending.values()) request.reject(error); });
  const exited = new Promise<void>((resolve) => worker.on("exit", () => resolve()));
  const base: Omit<PC, "sync"> & { sync?: GoogleSync } = {
    dataDir,
    account: new GoogleAccount(CLIENT, null, { fetch: tokenFetch, log: () => {} }),
    call: (method, args = {}) => new Promise<TestResult>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    }),
    async close() {
      base.sync?.stop();
      await base.sync?.idle();
      await base.call("close");
      await worker.terminate();
      await exited;
    },
  };
  const pc: PC = Object.assign(base, { sync: boot(base) });
  pcs.push(pc);
  return pc;
}

async function pass(pc: PC): Promise<void> {
  await pc.call("pass");
  await pc.sync.kick();
  await pc.sync.idle();
}

async function rounds(n: number, list = pcs): Promise<void> {
  for (let i = 0; i < n; i++) for (const pc of list) await pass(pc);
}

/** Every PC on one Google account; the first one has the bot. */
async function setup(names: string[], old: string[] = []): Promise<PC[]> {
  const list = names.map((name) => makePC(name, old.includes(name)));
  await list[0]!.call("seed", { bots: [{ name: BOT, memory: MEMORY }] });
  for (const pc of list) {
    pc.account.setSession(A);
    await pc.sync.read();
    await pc.sync.start();
    await pc.sync.idle();
    await rounds(2);
  }
  await rounds(2);
  for (const pc of list) expect(await memory(pc)).toBe(MEMORY);
  return list;
}

async function memory(pc: PC): Promise<string> {
  // SAFETY: the fixture's report method answers ReportBot[].
  return ((await pc.call("report")) as ReportBot[]).find((bot) => bot.name === BOT)!.memory!;
}

async function edit(pc: PC, line: string, typed = false): Promise<void> {
  written.add(line);
  const text = await memory(pc);
  await pc.call("memory", { bot: BOT, text: `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n`, typed });
}

function files(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(join(dir, entry.name), path) : [path];
  });
}

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const pinned = (list: PC[]) => list.map((pc) => ({ profile: sha(join(pc.dataDir, "profile-sync.json")), binding: sha(join(pc.dataDir, "google-binding.json")) }));
const runIds = (text: string, kind: "run" | "undo") => [...text.matchAll(new RegExp(`^<!-- mc-${kind} (.*) -->\\r?$`, "gm"))].map((match) => String(JSON.parse(match[1]!).runId));

/** Lost lines, conflict copies and duplicate archive blocks in one PC's bot workspace. */
function audit(pc: PC) {
  const workspaces = join(pc.dataDir, "workspaces");
  const dir = join(workspaces, readdirSync(workspaces).find((id) => existsSync(join(workspaces, id, "MEMORY.md")))!);
  const all = files(dir).filter((path) => path.endsWith(".md"));
  const copies = all.filter((path) => /\.conflict-/.test(path));
  const histories = all.filter((path) => /^memory\/memory-history(?:-\d+)?\.md$/.test(path)).map((path) => readFileSync(join(dir, path), "utf8"));
  const live = all.filter((path) => !copies.includes(path) && !/memory-history/.test(path)).flatMap((path) => readFileSync(join(dir, path), "utf8").split("\n"));
  const archived = histories.flatMap((text) => parseHistory(text).flatMap((run) => run.entries.flatMap((entry) => entry.lines)));
  const kept = new Set([...live, ...archived].map((line) => line.trim()));
  const count = (ids: string[]) => ids.length - new Set(ids).size;
  return {
    lost: [...written].filter((line) => !kept.has(line)),
    copies,
    duplicates: count(histories.flatMap((text) => runIds(text, "run"))) + count(histories.flatMap((text) => runIds(text, "undo"))),
  };
}

const fingerprint = (dir: string) => files(dir).sort().map((path) => `${path}:${sha(join(dir, path))}`).join("\n");
// a change waits a round in the mirror before the next pass applies it, so the mirrors count too
const state = () => pcs.map((pc) => `${fingerprint(join(pc.dataDir, "workspaces"))}\n${fingerprint(join(loadProfileSyncSettings(pc.dataDir).folder!, "memory-v2"))}`).join("\n\n");

/** Syncs until two rounds in a row change no memory file on any PC or mirror, then checks the bars. */
async function settle(list: PC[], before: ReturnType<typeof pinned>): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < 12 && quiet < 2; i++) {
    const last = state();
    await rounds(1);
    quiet = state() === last ? quiet + 1 : 0;
  }
  expect(quiet).toBe(2);
  expect(list.map(audit)).toEqual(list.map(() => ({ lost: [], copies: [], duplicates: 0 })));
  expect(pinned(list)).toEqual(before);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-memory-clean-sync-"));
  drive = new FakeDrive();
  drive.pageSize = 1000;
  pcs = [];
  written = new Set(MEMORY.split("\n").map((line) => line.trim()).filter(Boolean));
});

afterEach(async () => {
  for (const pc of pcs) await pc.close();
  rmSync(root, { recursive: true, force: true });
});

describe("memory cleanup across two PCs", { timeout: 180_000 }, () => {
  it("keeps an edit made on the other PC while the cleanup writes", async () => {
    const [home, work] = await setup(["home", "work"]);
    await home.call("talk", { bot: BOT });
    await rounds(2);
    const before = pinned(pcs);
    expect(await home.call("clean", { bot: BOT, retire: DONE.slice(0, 3) })).toMatch(/^mc-/);
    await edit(work!, "- work note: call the plumber on Friday");
    await settle(pcs, before);
  });

  it("drops a run when an edit lands mid-run, then cleans the new text", async () => {
    const [home, work] = await setup(["home", "work"]);
    await home.call("talk", { bot: BOT });
    await rounds(2);
    const before = pinned(pcs);
    expect(await home.call("clean", { bot: BOT, retire: DONE.slice(0, 3), hold: true })).toBeNull();
    await edit(work!, "- work note: the van is booked for Monday");
    await pass(work!);
    await pass(home!);
    await pass(home!);
    expect(await memory(home!)).toContain("- work note: the van is booked for Monday");
    expect(await home.call("release", { bot: BOT })).toBeNull();
    await rounds(2);
    expect(await home.call("clean", { bot: BOT, retire: DONE.slice(0, 3), days: 1 })).toMatch(/^mc-/);
    await settle(pcs, before);
  });

  it("brings an offline PC back after two runs without bringing retired lines back", async () => {
    const [home, work, laptop] = await setup(["home", "work", "laptop"]);
    await home.call("talk", { bot: BOT });
    await rounds(2);
    const before = pinned(pcs);
    await edit(laptop!, "- laptop note: passport renewal form is in the drawer");
    const first = await home.call("clean", { bot: BOT, retire: DONE.slice(0, 3) });
    expect(first).toMatch(/^mc-/);
    await rounds(3, [home!, work!]);
    const second = await home.call("clean", { bot: BOT, retire: DONE.slice(3, 6), days: 8 });
    expect(second).toMatch(/^mc-/);
    expect(second).not.toBe(first);
    await rounds(3, [home!, work!]);
    await settle(pcs, before);
    for (const pc of pcs) for (const line of DONE.slice(0, 6)) expect((await memory(pc)).split("\n")).not.toContain(line);
  });

  it("syncs with an old-build PC that has no typed lines and no parked-copy merge", async () => {
    const [home, old] = await setup(["home", "old"], ["old"]);
    await home.call("talk", { bot: BOT });
    await edit(home!, "- typed: the gate code changes every March", true);
    await rounds(2);
    const before = pinned(pcs);
    expect(await home.call("clean", { bot: BOT, retire: DONE.slice(0, 3) })).toMatch(/^mc-/);
    await edit(old!, "- old note: the landlord prefers texts");
    await settle(pcs, before);
  });

  it("undoes on the other PC and restores the lines on both", async () => {
    const [home, work] = await setup(["home", "work"]);
    await home.call("talk", { bot: BOT });
    await rounds(2);
    const before = pinned(pcs);
    expect(await home.call("clean", { bot: BOT, retire: DONE.slice(0, 3) })).toMatch(/^mc-/);
    await rounds(3);
    expect(await work.call("undo", { bot: BOT })).toBe(true);
    await settle(pcs, before);
    for (const pc of pcs) for (const line of DONE.slice(0, 3)) expect((await memory(pc)).split("\n")).toContain(line);
  });

  it("merges two runs from two PCs that each ranked themselves home", async () => {
    const [home, work] = await setup(["home", "work"]);
    await home.call("talk", { bot: BOT });
    await rounds(2);
    // each PC ranks its own talkedAt above the other's last published snapshot until they sync again
    await work.call("talk", { bot: BOT });
    const before = pinned(pcs);
    const ran = [await home.call("clean", { bot: BOT, retire: DONE.slice(0, 3) }), await work.call("clean", { bot: BOT, retire: DONE.slice(3, 6) })];
    expect(ran).toEqual([expect.stringMatching(/^mc-/), expect.stringMatching(/^mc-/)]);
    await settle(pcs, before);
  });
});
