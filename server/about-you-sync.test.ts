import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { ABOUT_YOU_SYNC_ID, aboutYouPrompt, aboutYouSources, addToAboutYou, removeAboutYouSource, syncAboutYou } from "./about-you.ts";
import { loadMemorySyncLedger, memorySyncDir, saveMemorySyncLedger, type MemorySyncLedger } from "./memory-sync.ts";

const pc = vi.hoisted(() => ({ dir: "" }));
vi.mock("./config.ts", async (original) => ({
  ...await original<typeof import("./config.ts")>(),
  get DATA_DIR() { return pc.dir; },
}));

function orders<T>(steps: T[]): T[][] {
  if (!steps.length) return [[]];
  return steps.flatMap((step) => orders(steps.filter((other) => other !== step)).map((rest) => [step, ...rest]));
}

const steps = ["remove", "syncA", "addB", "firstPass", "join"] as const;
const fact = "Allergic to sesame.";
const dated = "- Allergic to sesame. (from Atlas, 2026-11-19)\n";
const file = (dir: string) => join(dir, "about-you", "MEMORY.md");
const hasFact = () => aboutYouSources().some(({ facts }) => facts.includes(fact));

it.each(["import", "hand", "stale", "legacy"] as const)("converges in all 120 sync and edit orders for %s", (mode) => {
  const root = mkdtempSync(join(tmpdir(), "orbit-about-you-order-"));
  const failures: string[] = [];
  try {
    for (const [i, order] of orders([...steps]).entries()) {
      const dir = join(root, String(i));
      const [a, b, shared, privateMirror] = ["a", "b", "shared", "private"].map((name) => join(dir, name));
      const aLedger: MemorySyncLedger = { bots: {} };
      const bLedger: MemorySyncLedger = { bots: {} };
      const pass = (data: string, mirror: string, ledger: MemorySyncLedger) => {
        pc.dir = data;
        syncAboutYou(mirror, ledger, { host: data });
      };
      const write = (data: string, text: string) => {
        mkdirSync(join(data, "about-you"), { recursive: true });
        writeFileSync(file(data), text);
      };
      const add = (data: string) => {
        pc.dir = data;
        if (mode === "hand") {
          mkdirSync(join(data, "about-you"), { recursive: true });
          appendFileSync(file(data), `- ${fact}\n`);
        } else if (mode === "legacy") write(data, dated);
        else addToAboutYou(`- ${fact}\nSource: Atlas`, "2026-11-19");
      };
      add(a);
      // The backup contains A's original add, with no copy uploaded for B.
      if (mode === "stale" || mode === "legacy") pass(a, join(dir, "backup"), aLedger);
      const backup = mode === "legacy" ? dated : mode === "stale" ? readFileSync(file(a), "utf8") : "";
      const before = (left: typeof steps[number], right: typeof steps[number]) => order.indexOf(left) < order.indexOf(right);
      const seesOriginal = before("join", "firstPass") && before("syncA", "firstPass") && before("firstPass", "addB") && before("syncA", "remove");
      const removeSeesAdd = before("addB", "firstPass") && before("firstPass", "syncA") && before("join", "syncA") && before("syncA", "remove");
      const keepsFact = (mode === "import" || mode === "hand") && !seesOriginal && !removeSeesAdd;

      let joined = false;
      for (const step of order) {
        switch (step) {
          case "remove":
            pc.dir = a;
            removeAboutYouSource(mode === "hand" ? "" : "Atlas");
            break;
          case "syncA":
            pass(a, shared, aLedger);
            break;
          case "addB":
            if (backup) write(b, backup);
            else if (!seesOriginal) add(b);
            break;
          case "firstPass":
            pass(b, joined ? shared : privateMirror, bLedger);
            break;
          case "join": {
            joined = true;
            const unpublished = memorySyncDir(privateMirror, ABOUT_YOU_SYNC_ID);
            if (existsSync(unpublished)) cpSync(unpublished, memorySyncDir(shared, ABOUT_YOU_SYNC_ID), { recursive: true });
            break;
          }
        }
      }
      for (let round = 0; round < 4; round++) {
        pass(a, shared, aLedger);
        pass(b, shared, bLedger);
      }
      const onB = hasFact();
      pc.dir = a;
      const onA = hasFact();
      if (onA !== keepsFact || onB !== keepsFact) failures.push(`${order.join(" → ")}: expected ${keepsFact}, got ${onA}/${onB}`);
    }
    expect(failures).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);

const typed = "Writes notes by hand.";
const retypeSteps = ["erase", "import", "remove", "retype", "syncA", "syncB"] as const;

// A typed a line and imported a fact, and B has both.
function retypeWorld(dir: string) {
  const [a, b, shared] = ["a", "b", "shared"].map((name) => join(dir, name));
  // each pass reloads its ledger from disk, as after a restart
  const pass = (data: string) => {
    pc.dir = data;
    const ledger = loadMemorySyncLedger(data);
    syncAboutYou(shared, ledger, { host: data });
    saveMemorySyncLedger(data, ledger);
  };
  const type = () => appendFileSync(file(a), `- ${typed}\n`);
  const erase = () => writeFileSync(file(a), readFileSync(file(a), "utf8").split("\n").filter((line) => line !== `- ${typed}`).join("\n"));
  const importBeacon = () => {
    pc.dir = a;
    addToAboutYou("- Plays the flute.\nSource: Beacon", "2026-11-20");
  };
  const view = (data: string) => {
    pc.dir = data;
    const listed = aboutYouSources().flatMap(({ source, facts }) => facts.map((fact) => `${source || "hand"}: ${fact}`)).sort();
    const lines = existsSync(file(data)) ? readFileSync(file(data), "utf8").split("\n") : [];
    return `${listed.join(", ")} | prompt ${aboutYouPrompt().includes(`- ${typed}\n`)} | file ${lines.includes(`- ${typed}`)}`;
  };
  const shown = (kept: boolean) => `${["Beacon: Plays the flute.", "Control: Control stays here.", ...(kept ? [`hand: ${typed}`] : [])].join(", ")} | prompt ${kept} | file ${kept}`;
  mkdirSync(join(a, "about-you"), { recursive: true });
  type();
  pc.dir = a;
  addToAboutYou("- Control stays here.\nSource: Control", "2026-11-20");
  pass(a);
  pass(b);
  return { a, b, pass, type, erase, importBeacon, view, shown };
}

it("keeps a line typed back after an import saved its erase, on both PCs", () => {
  const root = mkdtempSync(join(tmpdir(), "orbit-about-you-retype-"));
  try {
    const w = retypeWorld(root);
    w.erase();
    w.importBeacon();
    w.type();
    expect(w.view(w.a)).toBe(w.shown(true));
    for (let round = 0; round < 6; round++) {
      w.pass(w.a);
      w.pass(w.b);
    }
    expect([w.view(w.a), w.view(w.b)]).toEqual([w.shown(true), w.shown(true)]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a line typed back unless a later hand Remove took it, in all 360 orders of erase, import, Remove, retype and syncs", () => {
  const root = mkdtempSync(join(tmpdir(), "orbit-about-you-retype-order-"));
  const failures: string[] = [];
  try {
    const all = orders([...retypeSteps]).filter((order) => order.indexOf("erase") < order.indexOf("retype"));
    for (const [i, order] of all.entries()) {
      const w = retypeWorld(join(root, String(i)));
      for (const step of order) {
        switch (step) {
          case "erase":
            w.erase();
            break;
          case "import":
            w.importBeacon();
            break;
          case "remove":
            pc.dir = w.a;
            removeAboutYouSource("");
            break;
          case "retype":
            w.type();
            break;
          case "syncA":
            w.pass(w.a);
            break;
          case "syncB":
            w.pass(w.b);
            break;
        }
      }
      for (let round = 0; round < 4; round++) {
        w.pass(w.a);
        w.pass(w.b);
      }
      const want = w.shown(order.indexOf("remove") < order.indexOf("retype"));
      const got = [w.view(w.a), w.view(w.b)];
      if (got.some((view) => view !== want)) failures.push(`${order.join(" → ")}: expected ${want}, got ${got.join(" / ")}`);
    }
    expect(all).toHaveLength(360);
    expect(failures).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
