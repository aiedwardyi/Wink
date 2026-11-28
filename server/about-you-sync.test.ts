import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it, vi } from "vitest";

import { ABOUT_YOU_SYNC_ID, aboutYouPrompt, aboutYouSources, addToAboutYou, removeAboutYouSource, syncAboutYou } from "./about-you.ts";
import { loadMemorySyncLedger, memorySyncDir, saveMemorySyncLedger, type MemorySyncLedger } from "./memory-sync.ts";

const pc = vi.hoisted(() => ({ dir: "" }));
vi.mock("./config.ts", async (original) => ({
  ...await original<typeof import("./config.ts")>(),
  get DATA_DIR() { return pc.dir; },
}));
// each: decides every write of a pass, numbered from 1, by landing it or failing it
const writes = vi.hoisted(() => ({ n: 0, hit: false, each: (_n: number, land: () => void, _path: string) => land() }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- fails or stops real writes, as a held file, a full disk or an exit does.
vi.mock("./atomic.ts", async (original) => {
  const real = await original<typeof import("./atomic.ts")>();
  const { writeFileSync } = await import("node:fs");
  // a plain write lands the same bytes; the temp file and rename only slow thousands of passes
  const land = (...[path, data, options]: Parameters<typeof real.writeFileAtomic>) => (options?.keep ? real.writeFileAtomic(path, data, options) : writeFileSync(path, data, { mode: options?.mode }));
  return {
    ...real,
    writeFileAtomic: (...args: Parameters<typeof real.writeFileAtomic>) => writes.each(++writes.n, () => land(...args), args[0]),
  };
});
const lands = (_n: number, land: () => void) => land();
const fail = () => {
  writes.hit = true;
  throw Object.assign(new Error("EPERM: held open"), { code: "EPERM" });
};

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

it("keeps another PC's import when an editor saves the copy it opened before that import, on both PCs", () => {
  const root = mkdtempSync(join(tmpdir(), "orbit-about-you-stale-"));
  try {
    const w = retypeWorld(root);
    const opened = readFileSync(file(w.a), "utf8");
    pc.dir = w.b;
    addToAboutYou("- Peer fact one.\n- Peer fact two.\nSource: Beacon", "2026-11-21");
    w.pass(w.b);
    w.pass(w.a);
    writeFileSync(file(w.a), `${opened}- Typed in the old copy.\n`);
    for (let round = 0; round < 4; round++) {
      w.pass(w.a);
      w.pass(w.b);
    }
    for (const data of [w.a, w.b]) {
      pc.dir = data;
      expect(aboutYouSources().flatMap(({ facts }) => facts).sort()).toEqual(["Control stays here.", "Peer fact one.", "Peer fact two.", "Typed in the old copy.", typed].sort());
      expect(aboutYouPrompt()).toContain("- Peer fact one. (noted 2026-11-21)");
    }
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

const faultSteps = ["addA", "addB", "syncA", "syncB", "fail"] as const;

// A imports its line and B types its own
function faultWorld(dir: string) {
  const [a, b, shared] = ["a", "b", "shared"].map((name) => join(dir, name));
  // a failed pass still saves its ledger, as index.ts does; the host is a name so a copied world keeps its PCs
  const pass = (data: string, each: typeof writes.each = lands) => {
    pc.dir = data;
    const ledger = loadMemorySyncLedger(data);
    Object.assign(writes, { n: 0, hit: false, each });
    const tolerate = (write: () => void) => {
      try {
        write();
      } catch (error) {
        if (!writes.hit) throw error;
      }
    };
    tolerate(() => syncAboutYou(shared, ledger, { host: basename(data) }));
    const reached = writes.n;
    tolerate(() => saveMemorySyncLedger(data, ledger));
    writes.each = lands;
    return reached;
  };
  const view = (data: string) => {
    pc.dir = data;
    const listed = aboutYouSources().flatMap(({ facts }) => facts).sort();
    const lines = existsSync(file(data)) ? readFileSync(file(data), "utf8") : "";
    const prompt = aboutYouPrompt();
    return listed.map((fact) => `${fact} ${lines.includes(`- ${fact}`) && prompt.includes(`- ${fact}`)}`).join(", ");
  };
  const step = (name: typeof faultSteps[number]) => {
    if (name === "addA") {
      pc.dir = a;
      addToAboutYou("- Alpha line.\nSource: Alpha", "2026-11-20");
    } else if (name === "addB") appendFileSync(file(b), "- Bravo line.\n");
    else if (name === "syncA") pass(a);
    else if (name === "syncB") pass(b);
  };
  return { a, b, pass, step, view };
}

it("keeps an import on one PC and a hand line on the other when a pass fails or exits at any write, in all 120 orders", () => {
  const root = mkdtempSync(join(tmpdir(), "orbit-about-you-fault-"));
  const copy = (from: string, to: string) => cpSync(from, to, { recursive: true, preserveTimestamps: true });
  // each file with its time and size, so points of a pass that leave the disk alike run once
  const disk = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
    const path = join(entry.parentPath, entry.name);
    if (!entry.isFile()) return path;
    const { mtimeMs, size } = statSync(path);
    return `${path} ${mtimeMs} ${size}`;
  }).sort().join("\n");
  const want = "Alpha line. true, Bravo line. true, Control stays here. true";
  const failures: string[] = [];
  const cases = { "full disk": 0, exit: 0 };
  try {
    // A and B both hold Control
    const seeded = join(root, "seed");
    const seed = faultWorld(seeded);
    pc.dir = seed.a;
    addToAboutYou("- Control stays here.\nSource: Control", "2026-11-20");
    seed.pass(seed.a);
    seed.pass(seed.b);
    for (const [i, order] of orders([...faultSteps]).entries()) {
      const at = order.indexOf("fail");
      const prefix = join(root, String(i));
      copy(seeded, prefix);
      const before = faultWorld(prefix);
      for (const name of order.slice(0, at)) before.step(name);
      const finish = (dir: string, cut: string) => {
        const w = faultWorld(dir);
        for (const name of order.slice(at + 1)) w.step(name);
        for (let round = 0; round < 2; round++) {
          w.pass(w.a);
          w.pass(w.b);
        }
        const got = [w.view(w.a), w.view(w.b)];
        if (got.some((view) => view !== want)) failures.push(`${order.join(" → ")}, ${cut}: got ${got.join(" / ")}`);
        rmSync(dir, { recursive: true, force: true });
      };
      for (const failing of ["a", "b"] as const) {
        // an exit runs nothing after the write it stops at, so the next start reads the disk as it was just before or just after that write
        const run = join(root, `${i}-${failing}`);
        copy(prefix, run);
        const start = disk(run);
        const exits = new Map<string, [cut: string, dir: string]>();
        const keep = (cut: string) => {
          const state = disk(run);
          if (state === start || exits.has(state)) return;
          const dir = `${run}-${exits.size}`;
          copy(run, dir);
          exits.set(state, [`${failing} ${cut}`, dir]);
        };
        const w = faultWorld(run);
        const reached = w.pass(w[failing], (n, land) => {
          keep(`exits before write ${n} lands`);
          land();
          keep(`exits once write ${n} lands`);
        });
        // the pass that ran to its end is no exit
        const done = disk(run);
        for (const [state, [cut, dir]] of exits) {
          if (state === done) continue;
          cases.exit++;
          finish(dir, cut);
        }
        for (let write = 1; write <= reached; write++) {
          const dir = `${run}-full-${write}`;
          copy(prefix, dir);
          const full = faultWorld(dir);
          full.pass(full[failing], (n, land) => (n < write ? land() : fail()));
          cases["full disk"]++;
          finish(dir, `${failing} write ${write} fails and every write after it`);
        }
      }
    }
    for (const count of Object.values(cases)) expect(count).toBeGreaterThan(240);
    expect(failures).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 600_000);

it("keeps what an editor saves while a pass fails: a new line, a line typed back and a deleted line, on both PCs", () => {
  const root = mkdtempSync(join(tmpdir(), "orbit-about-you-editor-"));
  try {
    const w = faultWorld(root);
    pc.dir = w.a;
    addToAboutYou("- Control stays here.\nSource: Control", "2026-11-20");
    appendFileSync(file(w.a), "- Former hand line.\n- Retype during retry.\n");
    w.pass(w.a);
    w.pass(w.b);
    // an import saves the erase, so the line typed back later is a new add
    writeFileSync(file(w.a), readFileSync(file(w.a), "utf8").replace("- Retype during retry.\n", ""));
    pc.dir = w.a;
    addToAboutYou("- Stage line.\nSource: Stage", "2026-11-20");
    let failed = "";
    const editor = (n: number, land: () => void, path: string) => {
      if (n > 1) return land();
      failed = path;
      writeFileSync(file(w.a), readFileSync(file(w.a), "utf8").replace("- Former hand line.\n", "- New handwritten fact.\n- Retype during retry.\n"));
      fail();
    };
    w.pass(w.a, editor);
    expect(failed).toContain(memorySyncDir(join(root, "shared"), ABOUT_YOU_SYNC_ID));
    for (let round = 0; round < 3; round++) {
      w.pass(w.a);
      w.pass(w.b);
    }
    const want = "Control stays here. true, New handwritten fact. true, Retype during retry. true, Stage line. true";
    expect([w.view(w.a), w.view(w.b)]).toEqual([want, want]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
