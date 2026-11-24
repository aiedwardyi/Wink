// An import's lines past the prompt's cut are looked up from the very first turn after it lands:
// the bot's own import file and Import Memory both, through the real send path to the provider.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { harnessFetch as fetch, spawnHarness as spawn } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const HOOK = join(SERVER_DIR, "testing", "golden-hook.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
let child: ChildProcess;
let home: string;
let log: string;
let stderr = "";

const PLACES = "Daejeon Busan Seoul Jeju Incheon Gwangju Osaka Kyoto Lisbon Porto Oslo Bergen Tallinn Riga Graz Ghent Lyon Bilbao Turin Kraków".split(" ");
const JOBS = "nurse welder baker pilot florist surveyor luthier barista archivist plumber sommelier ranger tailor cobbler glazier".split(" ");
const THINGS = "kettle tripod blender anvil easel loom lathe kayak scooter drone tent piano".split(" ");
const ASKED = [
  [201, "who's my dentist again?", "The user's dentist is Dr. Hwang at Maple Dental on Dunsan-ro."],
  [400, "am I allergic to shellfish?", "The user is allergic to shellfish, especially shrimp."],
] as const;
const LAST = ["who is my lighthouse caretaker?", "The user's lighthouse caretaker is Elspeth at Gull Point."] as const;
const paste = (count: number) => Array.from({ length: count }, (_, at) => {
  const line = at + 1;
  const asked = ASKED.find(([where]) => where === line);
  if (asked) return asked[2];
  if (line === count) return LAST[1];
  return line % 2
    ? `The user's contact ${PLACES[line % 20]}son works as a ${JOBS[line % 15]} in ${PLACES[(line * 3) % 20]} (entry ${line}).`
    : `The user owns a ${THINGS[line % 12]} bought in ${2000 + (line % 26)} from a shop in ${PLACES[(line * 13) % 20]}, item tag ${line}.`;
}).map((fact) => `- ${fact}`).join("\n") + "\nSource: ChatGPT";

type Body = { text: string } | { modelSelection: { instanceId: string; model: string } };
const api = async (method: string, path: string, body?: Body): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const sent = (): string[] => existsSync(log)
  ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.kind === "sendTurn").map((entry) => String(entry.input.text))
  : [];

async function newBot(): Promise<string> {
  const bot = (await api("POST", "/api/bots")).body.bot;
  await api("PATCH", `/api/bots/${bot.id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } });
  return bot.id;
}

// the provider's copy of the turn's text, once the turn is done
async function firstTurn(botId: string, text: string): Promise<string> {
  const from = sent().length;
  expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const bot = (await api("GET", "/api/bots?messages=0")).body.bots.find((row: any) => row.id === botId);
    if (!bot.busy && sent().length > from) return sent()[from]!;
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`timed out on a turn. stderr: ${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  home = createFixtureHome("omb-import-recall-");
  mkdirSync(join(home, ".orbit"), { recursive: true });
  log = join(home, "golden.ndjson");
  const instance = { driver: "claudeAgent", config: { cli: `"${process.execPath}" "${FAKE_CLAUDE}"`, permissionMode: "bypassPermissions" } };
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances: { claude: instance } }));
  child = spawn(process.execPath, ["--import", pathToFileURL(HOOK).href, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP"]
        .flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      OMB_PORT: String(PORT),
      GOLDEN_LOG: log,
    },
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await globalThis.fetch(`${BASE}/api/health`).catch(() => null))?.ok) break;
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server start: ${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}, 40_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
  });
  removeTestData(home);
});

it.each([412, 2400])("recalls #201, #400 and the last line of a %s-line Only this bot import on the first turn after it", async (count) => {
  for (const [, question, fact] of [...ASKED, [count, ...LAST] as const]) {
    const botId = await newBot();
    expect((await api("POST", `/api/bots/${botId}/memory/import`, { text: paste(count) })).body.added).toBe(count);
    expect(await firstTurn(botId, question), question).toContain(fact);
  }
}, 120_000);

it("recalls #400 of an All my bots import on the first turn after it", async () => {
  const botId = await newBot();
  expect((await api("POST", "/api/about-you", { text: paste(412) })).status).toBe(200);
  expect(await firstTurn(botId, ASKED[1][1])).toContain(ASKED[1][2]);
}, 60_000);
