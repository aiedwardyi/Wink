import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { sendsValue } from "../server/testing/secret-cases.ts";
import { testHome } from "../server/testing/test-home.ts";
import { Ledger, NIGHT_CAP, RESERVE_SEED } from "./dream-ledger.ts";
import { admitted, afterVerdict, fence, itemPrompt, kitSummarySchema, kitToken, night, prepareArm, sweepPractice, winkEngine } from "./dream-practice.ts";

const KIT = fileURLToPath(new URL("./dream-practice.ts", import.meta.url));
const CHECK = fileURLToPath(new URL("./dream-check.ts", import.meta.url));
const STUB = fileURLToPath(new URL("./testing/dream-stub-claude.mjs", import.meta.url));
const FAKE_WINK = fileURLToPath(new URL("./testing/dream-fake-wink.mjs", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./dream-engine-env.cjs", import.meta.url));
const MOVED = ["- The launch runs from the east studio", "- Launch slides live in the team drive"];
const DAY = 86_400_000;

function topicIn(practice, bot = "bot-a", { moved = MOVED, name = "topic-0a1b2c3d" } = {}) {
  const topic = join(practice, bot, name);
  mkdirSync(join(topic, "before"), { recursive: true });
  mkdirSync(join(topic, "after", "memory"), { recursive: true });
  writeFileSync(join(topic, "before", "MEMORY.md"), ["# Memory", "", "- Prefers short replies", ...moved, ""].join("\n"));
  writeFileSync(join(topic, "after", "MEMORY.md"), ["# Memory", "", "- Prefers short replies", "- Launch details: memory/launch.md, read before launch work", ""].join("\n"));
  writeFileSync(join(topic, "after", "memory", "launch.md"), `${moved.join("\n")}\n`);
  return topic;
}

// an in-process engine: every turn answers, every grade passes, unless a test says otherwise
function engineWith({ turn = () => ({}), grade = () => true, cost = () => 30_000 } = {}) {
  const calls = [];
  return {
    calls,
    turns: () => calls.filter(([call]) => call === "turn").map(([, kind, side]) => `${kind}-${side}`),
    async turn(_bot, arm, question) {
      calls.push(["turn", arm.kind, arm.side, question]);
      return { text: "It is in the notes", usage: { fresh: cost(arm), processed: 200_000 }, ...turn(arm, calls) };
    },
    async ask(prompt) {
      if (prompt.startsWith("Write check items")) {
        calls.push(["item", prompt]);
        return { text: JSON.stringify({ blind: { question: "Q blind", rubric: "R" }, cued: { question: "Q cued", rubric: "R" } }), usage: { fresh: 5_000, processed: 5_000 } };
      }
      calls.push(["grade", prompt]);
      return { text: JSON.stringify({ pass: grade(prompt, calls) }), usage: { fresh: 2_000, processed: 2_000 } };
    },
    close: async () => {},
  };
}

const practiceDir = () => mkdtempSync(join(testHome(), "practice-"));
const nightIn = (practice, engine, { build = "9f2983532", date = "2026-11-24", ledger } = {}) =>
  night({ practice, root: mkdtempSync(join(testHome(), "kit-")), engine, ledger: ledger ?? new Ledger(join(practice, "ledger"), date), build, date });
const resultOf = (outcome) => Object.fromEntries(outcome.items.map(({ kind, result }) => [kind, result]));
const pairsOf = (practice, bot = "bot-a") => Object.values(JSON.parse(readFileSync(join(practice, bot, "check", "pairs.json"), "utf8")));

describe("after rule", () => {
  it("admits only a 3 of 3 baseline", () => {
    expect([[true, true, true], [true, true, false], [true, true]].map(admitted)).toEqual([true, false, false]);
  });

  it("passes 3/3, 5/6 and 10/12, fails 0/3, and asks for more in between", () => {
    const runs = (passed, total) => Array.from({ length: total }, (_, at) => at < passed);
    expect([[3, 3], [0, 3], [2, 3], [1, 3], [5, 6], [4, 6], [3, 6], [10, 12], [9, 12]].map(([passed, total]) => afterVerdict(runs(passed, total)))).toEqual(["pass", "fail", "more", "more", "pass", "more", "fail", "pass", "fail"]);
  });
});

describe("practice night", () => {
  it("does not admit a 2 of 3 baseline and counts the blind one in the summary", async () => {
    const practice = practiceDir();
    topicIn(practice);
    let blindGrades = 0;
    const engine = engineWith({ grade: (prompt) => !(prompt.includes("Question: Q blind") && ++blindGrades === 2) });
    const outcome = await nightIn(practice, engine);
    expect(resultOf(outcome)).toEqual({ blind: "not-admitted", cued: "passed" });
    expect(outcome.blindBaselineFails).toBe(1);
    expect(engine.turns()).toEqual([...Array(3).fill("blind-before"), ...Array(3).fill("cued-before"), ...Array(3).fill("cued-after")]);
  });

  it("counts an empty reply, a stop and a cued turn with no index as errors, retried twice, then voids the item, never a miss", async () => {
    const practice = practiceDir();
    topicIn(practice);
    const faults = [{ text: "" }, { stopped: true }, { noIndex: true }];
    let cued = 0;
    const engine = engineWith({ turn: (arm) => (arm.kind === "cued" ? faults[cued++] ?? {} : {}), cost: () => 10_000 });
    const outcome = await nightIn(practice, engine);
    expect(resultOf(outcome)).toEqual({ blind: "passed", cued: "void" });
    expect(outcome.voided).toBe(1);
    expect(engine.calls.filter(([call, prompt]) => call === "grade" && prompt.includes("Q cued"))).toEqual([]);
  });

  it("runs an item's baseline and after on one night and build; a build change voids only the unfinished pair, which reruns its baseline", async () => {
    const practice = practiceDir();
    topicIn(practice);
    // blind turns are cheap, cued turns dear: tonight's cap cuts the cued pair after its baseline and one after run
    const cost = (arm) => (arm.kind === "cued" ? 39_000 : 9_000);
    const first = new Ledger(join(practice, "ledger"), "2026-11-24");
    first.add("tidy", { fresh: 84_000, processed: 84_000 });
    const one = engineWith({ cost });
    expect(resultOf(await nightIn(practice, one, { ledger: first }))).toEqual({ blind: "passed", cued: "unfinished" });
    expect(one.turns().filter((turn) => turn.startsWith("cued"))).toEqual(["cued-before", "cued-before", "cued-before", "cued-after"]);

    const two = engineWith({ cost });
    expect(resultOf(await nightIn(practice, two, { build: "abcdef123", date: "2026-11-25" }))).toEqual({ blind: "passed", cued: "passed" });
    expect(two.turns()).toEqual([...Array(3).fill("cued-before"), ...Array(3).fill("cued-after")]);
    expect(pairsOf(practice).map(({ kind, build, night, result }) => [kind, build, night, result])).toEqual([
      ["blind", "9f2983532", "2026-11-24", "passed"],
      ["cued", "9f2983532", "2026-11-24", "unfinished"],
      ["cued", "abcdef123", "2026-11-25", "passed"],
    ]);
    const rows = readFileSync(join(practice, "bot-a", "check", "rows.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.item);
    expect(rows.every((row) => /^[0-9a-f]{8}$/.test(row.item) && /^[0-9a-f]{8}$/.test(row.copy) && row.build)).toBe(true);
  });

  it("never spends past the night cap and starts no turn without the reserve left", async () => {
    const practice = practiceDir();
    for (const bot of ["bot-a", "bot-b", "bot-c"]) topicIn(practice, bot);
    const ledger = new Ledger(join(practice, "ledger"), "2026-11-24");
    const outcome = await nightIn(practice, engineWith({ cost: () => 40_000 }), { ledger });
    expect(ledger.night.fresh).toBeLessThanOrEqual(NIGHT_CAP);
    // a turn would still fit; no pair can finish, so none starts
    expect([ledger.turnFits(), ledger.pairFits(), ledger.data.reserve]).toEqual([true, false, RESERVE_SEED]);
    expect(outcome.items.some(({ result }) => result === "waiting")).toBe(true);
  });

  it("starts no grade whose bound is not left after its check, so the night never passes the cap", async () => {
    const practice = practiceDir();
    topicIn(practice);
    const ledger = new Ledger(join(practice, "ledger"), "2026-11-24");
    let turns = 0;
    // the twelfth check leaves 1k, less than any grade's prompt and output cap
    const engine = engineWith({ cost: () => (++turns === 12 ? ledger.left() - 1_000 : 10_000) });
    const outcome = await nightIn(practice, engine, { ledger });
    expect(ledger.night.fresh).toBeLessThanOrEqual(NIGHT_CAP);
    expect([engine.calls.filter(([call]) => call === "grade").length, resultOf(outcome)]).toEqual([11, { blind: "passed", cued: "unfinished" }]);
  });

  it("checks a bot's sentinels once, not again for its next topic", async () => {
    const practice = practiceDir();
    topicIn(practice);
    topicIn(practice, "bot-a", { name: "topic-1a2b3c4d", moved: ["- The launch party is on the roof"] });
    mkdirSync(join(practice, "bot-a", "sentinels"), { recursive: true });
    const sentinel = { sha8: "5e5e5e5e", kind: "sentinel", question: "Q sentinel", rubric: "R" };
    writeFileSync(join(practice, "bot-a", "sentinels", "5e5e5e5e.json"), JSON.stringify(sentinel));
    const engine = engineWith({ cost: () => 3_000 });
    await nightIn(practice, engine);
    expect(readdirSync(join(practice, "bot-a")).filter((name) => existsSync(join(practice, "bot-a", name, "done"))).sort()).toEqual(["topic-0a1b2c3d", "topic-1a2b3c4d"]);
    expect(engine.calls.filter(([call, , , question]) => call === "turn" && question === "Q sentinel")).toHaveLength(6);
  });

  it("sets each arm up once a night, so its kit server never loses its folder between items", async () => {
    const practice = practiceDir();
    topicIn(practice);
    mkdirSync(join(practice, "bot-a", "sentinels"), { recursive: true });
    writeFileSync(join(practice, "bot-a", "sentinels", "5e5e5e5e.json"), JSON.stringify({ sha8: "5e5e5e5e", kind: "sentinel", question: "Q sentinel", rubric: "R" }));
    const boots = [];
    // the engine boots a server on an arm's folder the first time it sees it, as winkEngine does
    const engine = engineWith({
      turn: (arm) => {
        if (!existsSync(join(arm.data, "server.pid"))) {
          writeFileSync(join(arm.data, "server.pid"), "");
          boots.push(`${arm.kind}-${arm.side}`);
        }
        return {};
      },
      cost: () => 3_000,
    });
    await nightIn(practice, engine);
    expect(boots.sort()).toEqual(["blind-after", "blind-before", "cued-after", "cued-before"]);
  });

  it("keeps items, rubrics and rows in the bot's practice folder", async () => {
    const practice = practiceDir();
    const topic = topicIn(practice);
    await nightIn(practice, engineWith());
    expect(JSON.parse(readFileSync(join(topic, "items.json"), "utf8")).map(({ kind, rubric }) => [kind, rubric])).toEqual([["blind", "R"], ["cued", "R"]]);
    expect(readFileSync(join(practice, "bot-a", "check", "rows.jsonl"), "utf8")).toContain("It is in the notes");
  });
});

describe("ledger", () => {
  it("seeds the reserve from all 111 rot-check-2 rows and raises it on a larger turn, for the nights after", () => {
    const dir = join(practiceDir(), "ledger");
    const tonight = new Ledger(dir, "2026-11-24");
    expect(tonight.data.reserve).toBe(66_000);
    tonight.turn(70_500);
    expect(new Ledger(dir, "2026-11-25").data.reserve).toBe(70_500);
  });

  it("holds a night to 350k fresh and a week to 2.45M", () => {
    const dir = join(practiceDir(), "ledger");
    const night = new Ledger(dir, "2026-11-18");
    night.add("tidy", { fresh: 290_000, processed: 1_000_000 });
    expect([night.left(), night.turnFits(), night.night]).toEqual([60_000, false, { fresh: 290_000, processed: 1_000_000 }]);
    for (const day of ["19", "20", "21", "22", "23"]) new Ledger(dir, `2026-11-${day}`).add("check", { fresh: 400_000, processed: 400_000 });
    expect(new Ledger(dir, "2026-11-24").left()).toBe(160_000);
  });

  it("admits tonight's pairs on the week's mean turn, so a turn dearer than the seed stops a pair that cannot finish", () => {
    const dir = join(practiceDir(), "ledger");
    const first = new Ledger(dir, "2026-11-24");
    expect(first.pairFits()).toBe(true);
    for (let turn = 0; turn < 5; turn++) first.turn(57_000);
    // 5 x 57k and the 66k reserve is past 350k
    expect(new Ledger(dir, "2026-11-25").pairFits()).toBe(false);
  });

  it("stops on a ledger that fails its schema and leaves it as it was, tonight's or a night before", () => {
    const dir = join(practiceDir(), "ledger");
    mkdirSync(dir, { recursive: true });
    const broken = JSON.stringify({ date: "2026-11-24", kinds: { tidy: { calls: 3, fresh: 290_000, processed: 900_000 } } });
    writeFileSync(join(dir, "2026-11-24.json"), broken);
    expect(() => new Ledger(dir, "2026-11-24")).toThrow(/2026-11-24\.json/);
    expect(readFileSync(join(dir, "2026-11-24.json"), "utf8")).toBe(broken);
    expect(() => new Ledger(dir, "2026-11-25")).toThrow(/2026-11-24\.json/);
  });
});

describe("arms and fence", () => {
  it("gives the blind folder lookup-bots.json = [] before start and the cued folder none", () => {
    const root = practiceDir();
    const topic = topicIn(root);
    const blind = prepareArm(root, "blind", "after", "bot-a", join(topic, "after"));
    const cued = prepareArm(root, "cued", "after", "bot-a", join(topic, "after"));
    expect(readFileSync(join(blind.data, "lookup-bots.json"), "utf8")).toBe("[]\n");
    expect(existsSync(join(cued.data, "lookup-bots.json"))).toBe(false);
    expect(readFileSync(join(cued.workspace, "memory", "launch.md"), "utf8")).toContain("east studio");
  });

  it("allows a read inside the arm only, from the parsed action", () => {
    const arm = join(testHome(), "arms", "blind-after");
    const ask = (tool, action, extra = {}) => fence({ requestType: "permission", tool, action, ...extra }, arm);
    expect(ask("Read", `file_path\n${join(arm, "data", "workspaces", "bot-a", "MEMORY.md")}`)).toBe(true);
    expect(ask("Grep", "pattern\nlaunch")).toBe(true);
    expect(ask("Read", `file_path\n${join(testHome(), "rot-check", "rows.jsonl")}`)).toBe(false);
    expect(ask("Read", `file_path\n${join(arm, "..", "..", "secret.md")}`)).toBe(false);
    expect(ask("Glob", `pattern\n**/*.md\npath\n${join(arm, "..")}`)).toBe(false);
    expect(ask("Read", undefined)).toBe(false);
    expect(ask("Read", `file_path\n${join(arm, "a.md")}`, { actionRefused: "too-large" })).toBe(false);
    expect(ask("Bash", "command\ncat MEMORY.md")).toBe(false);
    expect(fence({ requestType: "question", tool: "Read", action: "file_path\na.md" }, arm)).toBe(false);
  });
});

describe("kit login", () => {
  const liveWith = (main, expiresAt = Date.now() + DAY) => {
    const live = mkdtempSync(join(testHome(), "live-"));
    writeFileSync(join(live, "accounts.json"), JSON.stringify({ defaults: { claude: main } }));
    mkdirSync(join(live, "accounts", main), { recursive: true });
    writeFileSync(join(live, "accounts", main, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `token-${main}`, expiresAt } }));
    return live;
  };

  it("takes the Main Claude account's token from the live account folder", () => {
    expect(kitToken(liveWith("acct_1234abcd-main"))).toBe("token-acct_1234abcd-main");
  });

  it("refuses getwinkdev, a token near expiry, and never falls back to ~/.claude/.credentials.json", () => {
    const blocked = (run) => {
      try {
        run();
      } catch (error) {
        return error.code;
      }
    };
    const home = testHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "home-token", expiresAt: Date.now() + DAY } }));
    expect(blocked(() => kitToken(liveWith("acct_dc417022-dev")))).toBe("getwinkdev");
    expect(blocked(() => kitToken(liveWith("acct_1234abcd-main", Date.now() + 60_000)))).toBe("token-expiry");
    expect(blocked(() => kitToken(mkdtempSync(join(home, "empty-")), Date.now(), home))).toBe("no-account");
  });
});

describe("practice folder", () => {
  it("sweeps files past 14 days but keeps sentinels and open topics, and drops a topic whole 14 days after it is done", () => {
    const practice = practiceDir();
    const [open, done] = [topicIn(practice), topicIn(practice, "bot-a", { name: "topic-1a2b3c4d" })];
    mkdirSync(join(practice, "bot-a", "sentinels"), { recursive: true });
    mkdirSync(join(practice, "bot-a", "check"), { recursive: true });
    const [old, sentinel, fresh, openItems, pairs] = [join(practice, "bot-a", "check", "rows.jsonl"), join(practice, "bot-a", "sentinels", "0a1b2c3d.json"), join(practice, "bot-a", "check", "server-blind-before.log"), join(open, "items.json"), join(practice, "bot-a", "check", "pairs.json")];
    for (const path of [old, sentinel, fresh, openItems, pairs, join(done, "done")]) writeFileSync(path, "[]");
    const stale = new Date(Date.now() - 15 * DAY);
    for (const path of [old, sentinel, openItems, pairs, join(open, "before", "MEMORY.md"), join(done, "before", "MEMORY.md")]) utimesSync(path, stale, stale);
    sweepPractice(practice);
    // pairs.json keeps the sentinels' results with their definitions
    expect([old, sentinel, fresh, openItems, pairs, join(open, "before", "MEMORY.md"), done].map(existsSync)).toEqual([false, true, true, true, true, true, true]);
    utimesSync(join(done, "done"), stale, stale);
    sweepPractice(practice);
    expect([existsSync(done), existsSync(open)]).toEqual([false, true]);
  });

  it("gives the item writer a moved note in any form the filer moves, not just a dash bullet", () => {
    const practice = practiceDir();
    const topic = topicIn(practice, "bot-a", { moved: ["* The launch runs from the east studio", "+ Launch slides live in the team drive", "The launch party is on the roof"] });
    const prompt = itemPrompt(topic, true);
    expect(prompt).toContain("* The launch runs from the east studio");
    expect(prompt).toContain("+ Launch slides live in the team drive");
    expect(prompt).toContain("The launch party is on the roof");
    expect(prompt?.split("Kept:")[1]).not.toContain("# Memory");
  });

  it("keeps a skipped note out of the item writer", () => {
    const practice = practiceDir();
    const topic = topicIn(practice, "bot-a", { moved: [...MOVED, "- Router login for the upstairs box\n  sunflowerfield"] });
    const prompt = itemPrompt(topic, true);
    expect(prompt).toContain("east studio");
    expect(prompt).not.toContain("sunflowerfield");
  });
});

describe("kit script", () => {
  const MARKER = "plumquartzhelix";
  const files = (dir) => new Map(readdirSync(dir, { recursive: true, encoding: "utf8" }).map((name) => join(dir, name)).filter((path) => statSync(path).isFile()).map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
  const world = () => {
    const root = mkdtempSync(join(testHome(), "night-"));
    const dirs = Object.fromEntries(["tmp", "results", "dream-practice", "live", "home", "copy"].map((name) => [name, join(root, name)]));
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    return { root, ...dirs };
  };
  const run = (w, script, args, extra = {}) => {
    const { VITEST: _vitest, ...env } = process.env;
    return spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], { encoding: "utf8", env: { ...env, HOME: w.home, USERPROFILE: w.home, TMP: w.tmp, TEMP: w.tmp, TMPDIR: w.tmp, CLAUDE_CLI: STUB, DREAM_STUB_MARKER: MARKER, ...extra } });
  };

  it("logs the cleaner's fresh and processed spend with check turns off, and runs no check", () => {
    const w = world();
    mkdirSync(join(w.copy, "workspaces", "bot-a"), { recursive: true });
    writeFileSync(join(w.copy, "workspaces", "bot-a", "MEMORY.md"), "# Memory\n\n## Notes\n- Uses pnpm\n- Uses pnpm\n");
    writeFileSync(join(w.copy, "bots.json"), JSON.stringify([{ id: "bot-a", name: "Alpha" }]));
    topicIn(w["dream-practice"]);
    const ledger = join(w["dream-practice"], "ledger");
    expect(run(w, CHECK, [w.copy, "--ledger", ledger, "--date", "2026-11-24", "--json", join(w.results, "summary.json")], { CLAUDE_CONFIG_DIR: join(w.root, "claude") }).status).toBe(0);
    const tidy = JSON.parse(readFileSync(join(ledger, "2026-11-24.json"), "utf8")).kinds.tidy;
    expect(tidy.calls).toBeGreaterThan(0);
    expect([tidy.fresh, tidy.processed]).toEqual([1_300 * tidy.calls, 5_300 * tidy.calls]);

    const result = run(w, KIT, ["--practice", w["dream-practice"], "--date", "2026-11-24", "--json", join(w.results, "kit.json"), "--build", "9f2983532"]);
    expect(result.status).toBe(0);
    const summary = kitSummarySchema.parse(JSON.parse(readFileSync(join(w.results, "kit.json"), "utf8")));
    expect([summary.checkTurns, summary.items, summary.spent.fresh, summary.ledger.kinds.check.calls]).toEqual([false, [], tidy.fresh + JSON.parse(readFileSync(join(ledger, "2026-11-24.json"), "utf8")).kinds.check.fresh, 0]);
    expect(existsSync(join(w["dream-practice"], "bot-a", "topic-0a1b2c3d", "items.json"))).toBe(false);
  });

  it("files the cleaner's and the kit's spend under one night when --date is left out", () => {
    const w = world();
    mkdirSync(join(w.copy, "workspaces", "bot-a"), { recursive: true });
    writeFileSync(join(w.copy, "workspaces", "bot-a", "MEMORY.md"), "# Memory\n\n## Notes\n- Uses pnpm\n");
    // 03:50 in Seoul, still the day before in UTC
    const at = Date.parse("2026-11-23T18:50:00Z");
    const clock = `data:text/javascript,${encodeURIComponent(`const Real = Date; const shift = ${at} - Real.now(); globalThis.Date = class extends Real { constructor(...args) { super(...(args.length ? args : [Real.now() + shift])); } };`)}`;
    const { VITEST: _vitest, ...env } = process.env;
    const start = (script, args) => spawnSync(process.execPath, ["--import", clock, "--experimental-strip-types", script, ...args], { encoding: "utf8", env: { ...env, HOME: w.home, USERPROFILE: w.home, TMP: w.tmp, TEMP: w.tmp, TMPDIR: w.tmp } });
    const ledger = join(w["dream-practice"], "ledger");
    start(CHECK, [w.copy, "--no-model", "--ledger", ledger, "--json", join(w.results, "summary.json")]);
    expect(start(KIT, ["--practice", w["dream-practice"], "--json", join(w.results, "kit.json")]).status).toBe(0);
    const local = new Date(at);
    expect(readdirSync(ledger)).toEqual([`${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}.json`]);
  });

  it("leaves no note text outside dream-practice and no scratch, from an engine that echoes it everywhere", () => {
    const w = world();
    topicIn(w["dream-practice"], "bot-a", { moved: [`- The ${MARKER} launch runs from the east studio`, "- Launch slides live in the team drive"] });
    writeFileSync(join(w.live, "accounts.json"), JSON.stringify({ defaults: { claude: "acct_1234abcd-main" } }));
    mkdirSync(join(w.live, "accounts", "acct_1234abcd-main"), { recursive: true });
    writeFileSync(join(w.live, "accounts", "acct_1234abcd-main", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "token-main", expiresAt: Date.now() + DAY } }));
    const before = files(w.root);
    const result = run(w, KIT, ["--practice", w["dream-practice"], "--date", "2026-11-24", "--json", join(w.results, "kit.json"), "--build", "9f2983532", "--check-turns", "--engine", "cli", "--live", w.live], { CLAUDE_CONFIG_DIR: join(w.live, "accounts", "acct_1234abcd-main") });
    writeFileSync(join(w["dream-practice"], "run.log"), `${result.stdout}${result.stderr}`);
    expect(result.status).toBe(0);
    const summary = kitSummarySchema.parse(JSON.parse(readFileSync(join(w.results, "kit.json"), "utf8")));
    expect(summary.items.map(({ kind, result: outcome }) => [kind, outcome])).toEqual([["sentinel", "established"], ["sentinel", "established"], ["blind", "passed"], ["cued", "passed"]]);
    expect(readFileSync(join(w["dream-practice"], "bot-a", "check", "rows.jsonl"), "utf8")).toContain(MARKER);
    expect(readdirSync(join(w["dream-practice"], "bot-a", "sentinels"))).toHaveLength(2);

    const after = files(w.root);
    const changed = [...after].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => relative(w.root, path).replaceAll("\\", "/"));
    expect(changed.filter((path) => !path.startsWith("dream-practice/"))).toEqual(["results/kit.json"]);
    expect(readdirSync(w.tmp)).toEqual([]);
    const leaks = [...after.keys()].filter((path) => !path.startsWith(w["dream-practice"]) && sendsValue(readFileSync(path, "utf8"), MARKER));
    expect(leaks.map((path) => relative(w.root, path))).toEqual([]);
  });
});

describe("wink engine", () => {
  afterEach(() => {
    delete process.env.FAKE_WINK;
    delete process.env.FAKE_WINK_LOG;
  });
  // a checkout whose server/index.ts is the fake Wink server
  const kitWith = (fault = "") => {
    const root = mkdtempSync(join(testHome(), "wink-kit-"));
    mkdirSync(join(root, "code", "server"), { recursive: true });
    writeFileSync(join(root, "code", "server", "index.ts"), `import ${JSON.stringify(pathToFileURL(FAKE_WINK).href)};\n`);
    const log = join(root, "fake.jsonl");
    Object.assign(process.env, { FAKE_WINK: fault, FAKE_WINK_LOG: log });
    const topic = topicIn(join(root, "practice"));
    return {
      root,
      topic,
      engine: () => winkEngine({ root, code: join(root, "code"), token: "kit-token", logs: () => root }),
      arm: (kind) => prepareArm(join(root, "kit"), kind, "before", "bot-a", join(topic, "before")),
      rows: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    };
  };

  it("asks every run of an arm on a new bot and thread, and restarts a cued arm's server so recall has that bot", async () => {
    const kit = kitWith();
    const engine = kit.engine();
    const [blind, cued] = [kit.arm("blind"), kit.arm("cued")];
    try {
      for (const arm of [blind, blind, cued, cued]) expect((await engine.turn("bot-a", arm, "Where does the launch run?")).error).toBeUndefined();
    } finally {
      await engine.close();
    }
    const turns = kit.rows().filter((row) => row.turn);
    expect(turns.map(({ prior }) => prior)).toEqual([0, 0, 0, 0]);
    expect(new Set(turns.map(({ threadId }) => threadId)).size).toBe(4);
    expect(turns.slice(2).map(({ indexed }) => indexed)).toEqual([true, true]);
  });

  it("starts a new server after one that died before ready", async () => {
    const kit = kitWith("die-first");
    const engine = kit.engine();
    const arm = kit.arm("blind");
    try {
      expect((await engine.turn("bot-a", arm, "Q")).error).toMatch(/exited before ready/);
      expect((await engine.turn("bot-a", arm, "Q")).error).toBeUndefined();
    } finally {
      await engine.close();
    }
  });

  it("boots a checkout given as a relative path", () => {
    const kit = kitWith();
    const arm = join(kit.root, "kit");
    const script = [
      `import { prepareArm, winkEngine } from ${JSON.stringify(pathToFileURL(KIT).href)};`,
      `const engine = winkEngine({ root: ${JSON.stringify(kit.root)}, code: "code", token: "kit-token", logs: () => ${JSON.stringify(kit.root)} });`,
      `const reply = await engine.turn("bot-a", prepareArm(${JSON.stringify(arm)}, "blind", "before", "bot-a", ${JSON.stringify(join(kit.topic, "before"))}), "Q");`,
      "await engine.close();",
      "process.stdout.write(JSON.stringify(reply));",
    ].join("\n");
    const { VITEST: _vitest, ...env } = process.env;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: kit.root, encoding: "utf8", env });
    expect(JSON.parse(result.stdout).error).toBeUndefined();
  });

  it("clears its permission poller when the send fails", async () => {
    const kit = kitWith("send-drop");
    const engine = kit.engine();
    const live = new Set();
    const [set, clear] = [globalThis.setInterval, globalThis.clearInterval];
    globalThis.setInterval = (...args) => {
      const id = set(...args);
      live.add(id);
      return id;
    };
    globalThis.clearInterval = (id) => {
      live.delete(id);
      clear(id);
    };
    let leaked;
    try {
      expect((await engine.turn("bot-a", kit.arm("blind"), "Q")).error).toBeTruthy();
    } finally {
      await engine.close();
      Object.assign(globalThis, { setInterval: set, clearInterval: clear });
      leaked = live.size;
      for (const id of live) clear(id);
    }
    expect(leaked).toBe(0);
  });

  it("keeps a completed turn's usage when reading its answer fails", async () => {
    const kit = kitWith("read-drop");
    const engine = kit.engine();
    try {
      const reply = await engine.turn("bot-a", kit.arm("blind"), "Q");
      expect([Boolean(reply.error), reply.usage]).toEqual([true, { fresh: 1_100, processed: 1_100 }]);
    } finally {
      await engine.close();
    }
  });

  it("puts the kit login only on a claude launch, never on a program that takes claude as an argument", () => {
    const dir = mkdtempSync(join(testHome(), "hook-"));
    const print = "process.stdout.write(process.env.CLAUDE_CODE_OAUTH_TOKEN ?? 'none');\n";
    const [other, shim, npm] = [join(dir, "print.js"), join(dir, "claude.js"), join(dir, "claude-code", "cli.js")];
    for (const path of [other, shim, npm]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, print);
    }
    const script = `const { spawnSync } = require("node:child_process"); const run = (args) => spawnSync(process.execPath, args, { encoding: "utf8" }).stdout; process.stdout.write(JSON.stringify([run([${JSON.stringify(other)}, "claude"]), run([${JSON.stringify(shim)}]), run([${JSON.stringify(npm)}, "-p"])]));`;
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...env } = process.env;
    const result = spawnSync(process.execPath, ["--require", PRELOAD, "-e", script], { encoding: "utf8", env: { ...env, EVAL_CLAUDE_OAUTH: "kit-token", EVAL_CLAUDE_CONFIG: dir } });
    expect(JSON.parse(result.stdout)).toEqual(["none", "kit-token", "kit-token"]);
  });
});
