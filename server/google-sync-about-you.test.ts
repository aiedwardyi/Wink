import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

async function rounds(n: number, among = pcs): Promise<void> {
  for (let i = 0; i < n; i++) for (const pc of among) await pass(pc);
}

async function start(pc: PC): Promise<void> {
  pc.account.setSession(A);
  await pc.sync.read();
  await pc.sync.start();
  await pc.sync.idle();
}

const facts = (view: AboutYouView) => view.sources.flatMap((source) => source.facts).sort();
const memoryFile = (pc: PC) => join(pc.dataDir, "about-you", "MEMORY.md");
const saved = (pc: PC) => readFileSync(memoryFile(pc), "utf8");
// a fact the user typed into the file, with no "(from X, date)" tag
const byHand = (pc: PC, fact: string) => {
  mkdirSync(join(pc.dataDir, "about-you"), { recursive: true });
  appendFileSync(memoryFile(pc), `- ${fact}
`);
};
// the PC whose file was edited last wins a merge
const age = (pc: PC, secondsAgo: number) => {
  const at = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(memoryFile(pc), at, at);
};
const handFacts = (view: AboutYouView) => view.sources.find(({ source }) => !source)?.facts ?? [];
const promptFacts = (view: AboutYouView) => view.prompt.split("\n").filter((line) => line.startsWith("- "));
const many = (source: string, n: number) => paste(source, ...Array.from({ length: n }, (_, i) => `${source} fact number ${i + 1}.`));
// the file every bot reads and this PC's list of what it last synced, with no copy waiting
const ALONE = ["MEMORY.md", "MEMORY.synced"];
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
      expect(facts(view)).toEqual(["Goes by Dana.", "Goes by Dana.", "Lives in Seoul.", "Writes TypeScript."]);
    }
    expect((await b.aboutYou()).sources).toEqual((await a.aboutYou()).sources);

    await a.call("importMemory", { text: paste("Gemini", "Runs at dawn.") });
    await b.call("importMemory", { text: paste("Grok", "Drinks tea.") });
    await rounds(4);
    for (const pc of [a, b]) {
      const view = await pc.aboutYou();
      expect(shown(view).filter((line) => /Gemini|Grok/.test(line))).toEqual(["Gemini · 1", "Grok · 1"]);
      expect(facts(view)).toEqual(["Drinks tea.", "Goes by Dana.", "Goes by Dana.", "Lives in Seoul.", "Runs at dawn.", "Writes TypeScript."]);
      expect(view.files).toEqual(ALONE);
    }
    expect((await b.aboutYou()).sources).toEqual((await a.aboutYou()).sources);
  });

  it("keeps a fact added by hand on every PC whichever PC's file loses the merge", async () => {
    const a = makePC("a");
    const b = makePC("b");
    await a.call("seed", { bots: BOTS });
    await a.call("importMemory", { text: paste("ChatGPT", "Goes by Dana.") });
    await b.call("importMemory", { text: paste("Claude", "Writes TypeScript.") });
    byHand(a, "Allergic to peanuts.");
    byHand(b, "Has a cat named Miso.");
    await start(a);
    await start(b);
    await rounds(4);
    byHand(a, "Plays the cello.");
    byHand(b, "Bikes to work.");
    await rounds(4);
    for (const pc of [a, b]) {
      const view = await pc.aboutYou();
      expect(facts(view)).toEqual(["Allergic to peanuts.", "Bikes to work.", "Goes by Dana.", "Has a cat named Miso.", "Plays the cello.", "Writes TypeScript."]);
      expect(view.prompt).toContain("- Allergic to peanuts.\n");
      expect(view.prompt).toContain("- Bikes to work.\n");
      expect(view.files).toEqual(ALONE);
    }
    expect(saved(b)).toBe(saved(a));
  });

  // two PCs with 150 facts each meet: the Memory page lists all 300, the prompt the newest 200
  async function bigMerge(): Promise<{ a: PC; b: PC; first: string; second: string }> {
    const a = makePC("a");
    const b = makePC("b");
    await a.call("seed", { bots: BOTS });
    await a.call("importMemory", { text: many("ChatGPT", 150) });
    await b.call("importMemory", { text: many("Claude", 150) });
    await start(a);
    await start(b);
    await rounds(4, [a, b]);
    const kept = saved(a);
    expect(saved(b)).toBe(kept);
    const [first, second] = kept.startsWith("- ChatGPT") ? ["ChatGPT", "Claude"] : ["Claude", "ChatGPT"];
    for (const pc of [a, b]) {
      const view = await pc.aboutYou();
      expect(shown(view)).toEqual([`${first} · 150`, `${second} · 150`].sort());
      expect(view.files).toEqual(ALONE);
      const prompt = promptFacts(view);
      expect(prompt).toHaveLength(200);
      expect(prompt.filter((line) => line.startsWith(`- ${second} fact`))).toHaveLength(150);
    }
    return { a, b, first, second };
  }

  it("merges two big files whole, and the prompt takes in the rest once there is room", async () => {
    const { a, b, first, second } = await bigMerge();
    await a.call("forgetMemory", { text: first });
    await rounds(4, [a, b]);
    for (const pc of [a, b]) {
      const view = await pc.aboutYou();
      expect(shown(view)).toEqual([`${second} · 150`]);
      expect(view.files).toEqual(ALONE);
    }
  });

  it("a source removed past the cap does not come back", async () => {
    const { a, b, first, second } = await bigMerge();
    await b.call("forgetMemory", { text: second });
    await rounds(4, [a, b]);
    for (const pc of [a, b]) {
      const view = await pc.aboutYou();
      expect(shown(view)).toEqual([`${first} · 150`]);
      expect(view.files).toEqual(ALONE);
    }
  });

  it("folds nested set-aside copies on three PCs and a quick remove stays removed", async () => {
    const [a, b, c] = [makePC("a"), makePC("b"), makePC("c")];
    await a.call("seed", { bots: BOTS });
    await a.call("importMemory", { text: paste("ChatGPT", "Goes by Dana.") });
    await b.call("importMemory", { text: paste("Claude", "Writes TypeScript.") });
    await c.call("importMemory", { text: paste("Gemini", "Runs at dawn.") });
    byHand(c, "Allergic to peanuts.");
    for (const pc of [a, b, c]) await start(pc);
    await rounds(3);
    for (const [pc, source] of [[a, "Grok"], [b, "Perplexity"], [c, "Copilot"]] as const) await pc.call("importMemory", { text: paste(source, `${source} knows tea.`) });
    // a copy set aside again while PCs changed it: what a slow third PC leaves behind
    const nested = join(c.dataDir, "about-you", "memory", "MEMORY.conflict-0a1b2c3d.conflict-4e5f6a7b.md");
    mkdirSync(join(c.dataDir, "about-you", "memory"), { recursive: true });
    writeFileSync(nested, "<!-- memory sync: a copy of memory/MEMORY.conflict-0a1b2c3d.md set aside when two PCs changed it at once -->\n<!-- memory sync: a copy of MEMORY.md set aside when two PCs changed it at once -->\n- Lives in Seoul. (from ChatGPT, 2026-11-19)\n- Has a cat named Miso.\n");
    await rounds(4);
    const all = ["Allergic to peanuts.", "Copilot knows tea.", "Goes by Dana.", "Grok knows tea.", "Has a cat named Miso.", "Lives in Seoul.", "Perplexity knows tea.", "Runs at dawn.", "Writes TypeScript."];
    for (const pc of [a, b, c]) {
      const view = await pc.aboutYou();
      expect(facts(view)).toEqual(all);
      expect(view.files).toEqual(ALONE);
    }
    expect(drivePaths().filter((path) => path.startsWith("memory-v2/about-you/"))).toHaveLength(3);

    // removed right after the merge, it stays gone on all three
    await b.call("forgetMemory", { text: "ChatGPT" });
    await rounds(3);
    for (const pc of [a, b, c]) expect(facts(await pc.aboutYou())).toEqual(all.filter((fact) => !/Dana|Seoul/.test(fact)));
    await rounds(3);
    for (const pc of [a, b, c]) {
      const view = await pc.aboutYou();
      expect(facts(view)).toEqual(all.filter((fact) => !/Dana|Seoul/.test(fact)));
      expect(view.files).toEqual(ALONE);
    }
    expect(saved(b)).toBe(saved(a));
    expect(saved(c)).toBe(saved(a));
  });

  for (const fullWins of [true, false]) {
    it(`lists every fact on both PCs when a full file meets a small one and ${fullWins ? "wins" : "loses"}; the prompt keeps the hand line`, async () => {
      const a = makePC("a");
      const b = makePC("b");
      await a.call("seed", { bots: BOTS });
      await a.call("importMemory", { text: many("ChatGPT", 150) });
      await a.call("importMemory", { text: many("Gemini", 50) });
      await b.call("importMemory", { text: paste("Claude", "Writes TypeScript.", "Drinks tea.", "Owns a kayak.") });
      byHand(b, "Allergic to peanuts.");
      age(a, fullWins ? 30 : 120);
      age(b, fullWins ? 120 : 30);
      await start(a);
      await start(b);
      await rounds(4);
      for (const pc of [a, b]) {
        const view = await pc.aboutYou();
        expect(shown(view)).toEqual([" · 1", "ChatGPT · 150", "Claude · 3", "Gemini · 50"]);
        expect(view.files).toEqual(ALONE);
        expect(promptFacts(view)).toHaveLength(200);
        expect(view.prompt).toContain("- Allergic to peanuts.\n");
      }
      expect(saved(b)).toBe(saved(a));
    });
  }

  it("lists all 450 facts on three PCs with 150 each", async () => {
    const [a, b, c] = [makePC("a"), makePC("b"), makePC("c")];
    await a.call("seed", { bots: BOTS });
    await a.call("importMemory", { text: many("ChatGPT", 150) });
    await b.call("importMemory", { text: many("Claude", 150) });
    await c.call("importMemory", { text: many("Gemini", 150) });
    byHand(c, "Allergic to peanuts.");
    age(a, 150);
    age(b, 90);
    age(c, 30);
    for (const pc of [a, b, c]) await start(pc);
    await rounds(6);
    for (const pc of [a, b, c]) {
      const view = await pc.aboutYou();
      expect(shown(view)).toEqual([" · 1", "ChatGPT · 150", "Claude · 150", "Gemini · 150"]);
      expect(view.files).toEqual(ALONE);
      expect(promptFacts(view)).toHaveLength(200);
      expect(view.prompt).toContain("- Allergic to peanuts.\n");
    }
    expect(saved(b)).toBe(saved(a));
    expect(saved(c)).toBe(saved(a));
  });

  for (const handPc of ["older", "newer"] as const) {
    it(`keeps a hand line that twins an imported fact when the hand PC's file is ${handPc}, also after the source is removed`, async () => {
      const a = makePC("a");
      const b = makePC("b");
      await a.call("seed", { bots: BOTS });
      await a.call("importMemory", { text: paste("ChatGPT", "Lives in Seoul.") });
      byHand(a, "Goes by Dana.");
      byHand(a, "!!!");
      await b.call("importMemory", { text: paste("Claude", "Goes by Dana.", "Writes TypeScript.") });
      age(a, handPc === "older" ? 120 : 30);
      age(b, handPc === "older" ? 30 : 120);
      await start(a);
      await start(b);
      await rounds(4);
      for (const pc of [a, b]) {
        const view = await pc.aboutYou();
        expect(handFacts(view)).toEqual(["Goes by Dana.", "!!!"]);
        expect(facts(view)).toEqual(["!!!", "Goes by Dana.", "Lives in Seoul.", "Writes TypeScript."]);
      }
      await b.call("forgetMemory", { text: "Claude" });
      await rounds(4);
      for (const pc of [a, b]) {
        const view = await pc.aboutYou();
        expect(facts(view)).toEqual(["!!!", "Goes by Dana.", "Lives in Seoul."]);
        expect(handFacts(view)).toEqual(["Goes by Dana.", "!!!"]);
        expect(view.prompt).toContain("- Goes by Dana.\n");
      }
    });
  }

  for (const other of ["Atlas", ""]) {
    it(`keeps a fact imported from Beacon and ${other ? "from Atlas" : "typed by hand"} on another PC until both are gone`, async () => {
      const a = makePC("a");
      const b = makePC("b");
      await a.call("seed", { bots: BOTS });
      if (other) await a.call("importMemory", { text: paste(other, "Allergic to sesame.", "Keeps a paper diary.") });
      else byHand(a, "Allergic to sesame.");
      await b.call("importMemory", { text: paste("Beacon", "Allergic to sesame.", "Uses a blue pen.") });
      age(a, 20);
      age(b, 120);
      await start(a);
      await start(b);
      await rounds(4);
      for (const pc of [a, b]) {
        const view = await pc.aboutYou();
        expect(view.sources).toEqual(other
          ? [{ source: "Atlas", facts: ["Allergic to sesame.", "Keeps a paper diary."] }, { source: "Beacon", facts: ["Allergic to sesame.", "Uses a blue pen."] }]
          : [{ source: "", facts: ["Allergic to sesame."] }, { source: "Beacon", facts: ["Uses a blue pen."] }]);
        expect(view.prompt.split("Allergic to sesame.")).toHaveLength(2);
      }
      await a.call("forgetMemory", { text: other });
      await rounds(4);
      for (const pc of [a, b]) {
        const view = await pc.aboutYou();
        expect(view.sources).toEqual([{ source: "Beacon", facts: ["Allergic to sesame.", "Uses a blue pen."] }]);
        expect(view.prompt).toContain("- Allergic to sesame. (noted ");
      }
    });
  }

  for (const how of ["import", "hand"] as const) {
    it(`a reinstalled PC that adds back a removed ${how} line keeps it on every PC`, async () => {
      const a = makePC("a");
      let b = makePC("b");
      const addBack = async (pc: PC) => {
        if (how === "hand") byHand(pc, "Allergic to sesame.");
        else await pc.call("importMemory", { text: paste("Atlas", "Allergic to sesame.") });
      };
      await a.call("seed", { bots: BOTS });
      await addBack(a);
      await a.call("importMemory", { text: paste("Control", "Writes in blue ink.") });
      await start(a);
      await start(b);
      await rounds(4);
      await a.call("forgetMemory", { text: how === "hand" ? "" : "Atlas" });
      await rounds(4);
      for (const pc of [a, b]) expect(facts(await pc.aboutYou())).toEqual(["Writes in blue ink."]);

      await b.close();
      pcs = pcs.filter((pc) => pc !== b);
      rmSync(b.dataDir, { recursive: true, force: true });
      b = makePC("b");
      await addBack(b);
      await start(b);
      await rounds(6);
      for (const pc of [a, b]) {
        const view = await pc.aboutYou();
        expect(facts(view)).toEqual(["Allergic to sesame.", "Writes in blue ink."]);
        expect(view.prompt).toContain("- Allergic to sesame.");
        expect(view.files).toEqual(ALONE);
      }
      expect(saved(b)).toBe(saved(a));
    });
  }

  for (const count of [2, 3]) {
    it(`a source removed before ${count} PCs that imported at once have met stays removed`, async () => {
      const all = ["a", "b", "c"].slice(0, count).map((name) => makePC(name));
      await all[0]!.call("seed", { bots: BOTS });
      await all[0]!.call("importMemory", { text: paste("ChatGPT", "Goes by Dana.", "Lives in Seoul.") });
      for (const pc of all) await start(pc);
      await rounds(3);
      for (const [i, pc] of all.entries()) await pc.call("importMemory", { text: paste(["Gemini", "Grok", "Muse"][i]!, `Fact ${i}.`) });
      await all[0]!.call("forgetMemory", { text: "ChatGPT" });
      await rounds(6);
      for (const pc of all) {
        const view = await pc.aboutYou();
        expect(view.sources.map(({ source }) => source).sort()).toEqual(["Gemini", "Grok", "Muse"].slice(0, count));
        expect(view.files).toEqual(ALONE);
      }
    });
  }

  it("two PCs removing different sources at once both stay removed", async () => {
    const a = makePC("a");
    const b = makePC("b");
    await a.call("seed", { bots: BOTS });
    await a.call("importMemory", { text: paste("ChatGPT", "Goes by Dana.") });
    await b.call("importMemory", { text: paste("Claude", "Writes TypeScript.") });
    await start(a);
    await start(b);
    await rounds(4);
    await a.call("importMemory", { text: paste("Gemini", "Runs at dawn.") });
    await a.call("forgetMemory", { text: "ChatGPT" });
    await b.call("forgetMemory", { text: "Claude" });
    await rounds(6);
    for (const pc of [a, b]) expect(facts(await pc.aboutYou())).toEqual(["Runs at dawn."]);
    expect(saved(b)).toBe(saved(a));
  });

  it("a line deleted or changed by hand stays that way while the other PC adds at once", async () => {
    const a = makePC("a");
    const b = makePC("b");
    await a.call("seed", { bots: BOTS });
    await a.call("importMemory", { text: paste("ChatGPT", "Goes by Dana.", "Lives in Seoul.") });
    byHand(a, "Allergic to peanuts.");
    await start(a);
    await start(b);
    await rounds(3);
    writeFileSync(memoryFile(a), saved(a).replace("- Allergic to peanuts.\n", ""));
    await b.call("importMemory", { text: paste("Grok", "Owns a kayak.") });
    await rounds(4);
    writeFileSync(memoryFile(a), saved(a).replace("Lives in Seoul.", "Lives in Busan."));
    byHand(b, "Bikes to work.");
    await rounds(4);
    for (const pc of [a, b]) expect(facts(await pc.aboutYou())).toEqual(["Bikes to work.", "Goes by Dana.", "Lives in Busan.", "Owns a kayak."]);
    expect(saved(b)).toBe(saved(a));

    // brought back by hand, it stays back
    byHand(a, "Allergic to peanuts.");
    await b.call("importMemory", { text: paste("Muse", "Plays cello.") });
    await rounds(4);
    for (const pc of [a, b]) expect(facts(await pc.aboutYou())).toEqual(["Allergic to peanuts.", "Bikes to work.", "Goes by Dana.", "Lives in Busan.", "Owns a kayak.", "Plays cello."]);
  });
});

function drivePaths(): string[] {
  return [...drive.records.values()].filter(({ file }) => file.appProperties?.ph).map(({ file }) => decodeDrivePath(file.name)!);
}

function driveText(): string {
  return [...drive.records.values()].map(({ bytes }) => bytes.toString("utf8")).join("\n");
}
