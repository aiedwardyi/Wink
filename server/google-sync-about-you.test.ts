import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decodeDrivePath } from "./drive-mirror.ts";
import { GoogleAccount, type GoogleSession } from "./google-account.ts";
import { createGoogleSync, type GoogleSync } from "./google-sync.ts";
import { loadOrCreateSyncWorkspace, loadProfileSyncSettings, saveProfileSyncSettings, syncedInFolder } from "./profile-sync.ts";
import { FakeDrive } from "./testing/fake-drive.ts";
import type { AboutYouView, BotSpec, TestArgs, TestResult } from "./testing/google-sync-pc.ts";

const CLIENT = { id: "client-id-test", secret: "client-secret-test" };
const A: GoogleSession = { refreshToken: "refresh-a", sub: "account-a", email: "a@example.com" };
const tokenFetch: typeof fetch = async () => new Response(JSON.stringify({ access_token: "access", expires_in: 3600 }));
const BOTS: BotSpec[] = [{ name: "Atlas", chats: [{ title: "Plans", rows: 2 }] }];
const paste = (source: string, ...facts: string[]) => [...facts.map((fact) => `- ${fact}`), "- My password is hunter2-very-secret", "", `Source: ${source}`].join("\n");

interface PC {
  dataDir: string; account: GoogleAccount; sync: GoogleSync;
  call(method: string, args?: TestArgs): Promise<TestResult>;
  aboutYou(): Promise<AboutYouView>;
  close(): Promise<void>;
}
type Booting = Omit<PC, "sync"> & { sync?: GoogleSync };

let root: string;
let drive: FakeDrive;
let pcs: PC[];

function boot(pc: Booting): GoogleSync {
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
    pull: (threadId) => { void pc.call("pull", { thread: threadId }); },
    fetch: (input, init) => drive.fetch(input, init),
    log: () => {},
  });
}

function makePC(name: string): PC {
  const dataDir = join(root, name);
  const worker = new Worker(new URL("./testing/google-sync-pc.ts", import.meta.url), {
    workerData: { dataDir }, env: { ...process.env, OMB_DATA_DIR: dataDir, OMB_THREAD_SYNC_V2: "1" }, execArgv: ["--experimental-strip-types"],
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: TestResult): void; reject(error: Error): void }>();
  worker.on("message", ({ id, value, error }: { id: number; value: TestResult; error?: string }) => {
    const request = pending.get(id);
    pending.delete(id);
    if (error) request?.reject(new Error(error));
    else request?.resolve(value);
  });
  const exited = new Promise<void>((resolve) => worker.on("exit", () => resolve()));
  const base: Booting = {
    dataDir,
    account: new GoogleAccount(CLIENT, null, { fetch: tokenFetch, log: () => {} }),
    call: (method, args = {}) => new Promise<TestResult>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    }),
    // SAFETY: the fixture's aboutYou method answers AboutYouView.
    aboutYou: async () => await base.call("aboutYou") as AboutYouView,
    async close() {
      base.sync?.stop();
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

async function rounds(n: number): Promise<void> {
  for (let i = 0; i < n; i++) for (const pc of pcs) await pass(pc);
}

async function start(pc: PC): Promise<void> {
  pc.account.setSession(A);
  await pc.sync.read();
  await pc.sync.start();
  await pc.sync.idle();
}

const facts = (view: AboutYouView) => view.sources.flatMap((source) => source.facts).sort();
const shown = (view: AboutYouView) => view.sources.map(({ source, facts }) => `${source} · ${facts.length}`).sort();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-google-about-you-"));
  drive = new FakeDrive();
  drive.pageSize = 1000;
  pcs = [];
});

afterEach(async () => {
  for (const pc of pcs) await pc.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Import Memory between Google PCs", { timeout: 180_000 }, () => {
  it("facts imported on A reach every bot on B and its Memory page", async () => {
    const a = makePC("a");
    await a.call("seed", { bots: BOTS });
    await start(a);
    const b = makePC("b");
    await start(b);
    await rounds(2);
    expect((await b.aboutYou()).prompt).toBe("");

    await a.call("importMemory", { text: paste("ChatGPT", "Goes by Dana.", "Lives in Seoul.") });
    await rounds(3);
    const there = await b.aboutYou();
    expect(there.prompt).toContain("- Goes by Dana. (noted 2026-11-19)");
    expect(there.prompt).toContain("- Lives in Seoul. (noted 2026-11-19)");
    expect(there.prompt).not.toContain("hunter2");
    expect(shown(there)).toEqual(["ChatGPT · 2"]);
    expect(there.sources).toEqual((await a.aboutYou()).sources);
    expect(drivePaths().filter((path) => path.startsWith("memory-v2/about-you/"))).toHaveLength(2);
    expect(driveText()).not.toContain("hunter2");

    await b.call("forgetMemory", { text: "ChatGPT" });
    await rounds(3);
    expect(await a.aboutYou()).toMatchObject({ prompt: "", sources: [] });
  });

  it("keeps both PCs' facts when each imports before they meet, and again when both edit at once", async () => {
    const a = makePC("a");
    const b = makePC("b");
    await a.call("seed", { bots: BOTS });
    await a.call("importMemory", { text: paste("ChatGPT", "Goes by Dana.", "Lives in Seoul.") });
    await b.call("importMemory", { text: paste("Claude", "Writes TypeScript.", "Goes by Dana.") });
    await start(a);
    await start(b);
    await rounds(4);
    for (const pc of [a, b]) {
      const view = await pc.aboutYou();
      expect(view.sources.map(({ source }) => source).sort()).toEqual(["ChatGPT", "Claude"]);
      expect(facts(view)).toEqual(["Goes by Dana.", "Lives in Seoul.", "Writes TypeScript."]);
    }
    expect((await b.aboutYou()).sources).toEqual((await a.aboutYou()).sources);

    await a.call("importMemory", { text: paste("Gemini", "Runs at dawn.") });
    await b.call("importMemory", { text: paste("Grok", "Drinks tea.") });
    await rounds(4);
    for (const pc of [a, b]) {
      const view = await pc.aboutYou();
      expect(shown(view).filter((line) => /Gemini|Grok/.test(line))).toEqual(["Gemini · 1", "Grok · 1"]);
      expect(facts(view)).toEqual(["Drinks tea.", "Goes by Dana.", "Lives in Seoul.", "Runs at dawn.", "Writes TypeScript."]);
      expect(view.files).toEqual(["MEMORY.md"]);
    }
    expect((await b.aboutYou()).sources).toEqual((await a.aboutYou()).sources);
  });
});

function drivePaths(): string[] {
  return [...drive.records.values()].filter(({ file }) => file.appProperties?.ph).map(({ file }) => decodeDrivePath(file.name)!);
}

function driveText(): string {
  return [...drive.records.values()].map(({ bytes }) => bytes.toString("utf8")).join("\n");
}
