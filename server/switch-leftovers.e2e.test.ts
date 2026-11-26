// An engine switch carries what the last turn left open: its unkept "I'll" lines and the
// questions a steer talked over, filed in the asks list the next engine already reads.
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";

import { ASKS_LIST } from "./task-asks.ts";
import { readTaskResumePacket } from "./task-state.ts";
import { harnessFetch as fetch, spawnHarness as spawn } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(SERVER_DIR, "testing", "fake-codex-app-server.ts");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const ANSWER = "I'll answer the model-switch question from how Wink actually stores chats and tasks.";
const PICKER = "I'll keep the picker changes moving.";
const EXPORT = "I'll run the data export in the background.";
let child: ChildProcess;
let home: string;
let prompts: string;
let stderr = "";

type Body = { text: string } | { modelSelection: { instanceId: string; model: string } };
const api = async (method: string, path: string, body?: Body): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const getBot = async (id: string) => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === id);
const waitFor = async (predicate: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`timed out waiting for ${what}. stderr: ${stderr.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const sent = () => existsSync(prompts) ? readFileSync(prompts, "utf8").split("\n").filter(Boolean).map((line) => z.object({ text: z.string() }).parse(JSON.parse(line)).text) : [];
const asks = (threadId: string) => readTaskResumePacket(threadId, { dir: join(home, ".orbit", "task-state") })?.asks ?? [];

async function bot(instanceId: string, model: string): Promise<{ id: string; threadId: string }> {
  const created = (await api("POST", "/api/bots")).body.bot;
  await api("PATCH", `/api/bots/${created.id}`, { modelSelection: { instanceId, model } });
  return created;
}
async function turn(id: string, text: string): Promise<void> {
  expect((await api("POST", `/api/bots/${id}/messages`, { text })).status).toBe(202);
  await waitFor(async () => (await getBot(id)).busy === false && (await getBot(id)).messages.some((row: any) => row.text === text), "the turn to settle");
}
/** The text fake Claude was sent for this turn. */
async function claudeTurn(id: string, text: string): Promise<string> {
  const from = sent().length;
  await turn(id, text);
  const input = sent().slice(from).find((prompt) => prompt.includes(text));
  if (!input) throw new Error(`Claude never got "${text}"`);
  return input;
}
/** Switches the bot to fake Claude and returns the text its first turn was sent. */
async function switched(id: string, text: string): Promise<string> {
  await api("PATCH", `/api/bots/${id}`, { modelSelection: { instanceId: "claude", model: "claude-fake" } });
  return claudeTurn(id, text);
}

beforeAll(async () => {
  home = createFixtureHome("omb-switch-leftovers-");
  mkdirSync(join(home, ".orbit", "about-you"), { recursive: true });
  // the user already said no to importing memory, so no turn carries an import offer
  writeFileSync(join(home, ".orbit", "about-you", "declined"), "");
  prompts = join(home, "claude-prompts.ndjson");
  const leave = join(home, "claude-leave.json");
  const result = (id: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: "notes" }] }] } });
  // a promise, a call, then a last line that finished nothing
  const fixture = (path: string, promise: string, last: string) => writeFileSync(path, JSON.stringify([
    { type: "assistant", message: { id: "msg-1", stop_reason: "tool_use", content: [{ type: "text", text: promise }, { type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "notes.md" } }] } },
    result("tu-1"),
    { type: "assistant", message: { id: "msg-2", stop_reason: "end_turn", content: [{ type: "text", text: last }] } },
    { type: "result", subtype: "success", is_error: false, result: last, total_cost_usd: 0 },
  ]));
  fixture(leave, "I'll update the picker labels.", "Back soon.");
  fixture(join(home, "claude-export.json"), EXPORT, "Back soon.");
  fixture(join(home, "claude-running.json"), EXPORT, "Export running as PID 4128, leave it alone.");
  const claude = (environment: Record<string, string>) => ({ driver: "claudeAgent", environment: { FAKE_CLAUDE_PROMPT_LOG: prompts, ...environment }, config: { cli: `"${process.execPath}" "${FAKE_CLAUDE}"`, permissionMode: "bypassPermissions" } });
  const codex = (environment: Record<string, string>) => ({ driver: "codex", environment, config: { cli: `"${process.execPath}" "${FAKE_CODEX}"` } });
  writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({
    instances: {
      // two promises in commentary, then a steered color question the final answers alone
      codex: codex({ FAKE_CODEX_MODE: "steer", FAKE_CODEX_COMMENTARY: JSON.stringify([{ text: ANSWER, phase: "commentary" }, { text: PICKER, phase: "commentary" }]), FAKE_CODEX_MESSAGES: JSON.stringify([{ text: "Blue.", phase: "final_answer" }]) }),
      codexLogs: codex({ FAKE_CODEX_MESSAGES: JSON.stringify([{ text: "I'll check the logs first.", phase: "commentary" }, { text: "Logs are clean.", phase: "final_answer" }]) }),
      // a promise in hidden notes and a question a steer talked over, then another engine that answers and finishes both
      codexLeave: codex({ FAKE_CODEX_MODE: "steer", FAKE_CODEX_COMMENTARY: JSON.stringify([{ text: "I'll update the picker labels.", phase: "commentary" }]), FAKE_CODEX_MESSAGES: JSON.stringify([{ text: "Blue.", phase: "final_answer" }]) }),
      codexDone: codex({ FAKE_CODEX_MESSAGES: JSON.stringify([{ text: "The keyboard shortcuts are in GUIDE.md. I updated the picker labels.", phase: "final_answer" }]) }),
      claude: claude({}),
      claudeLeave: claude({ FAKE_CLAUDE_REPLY_FIXTURE: leave }),
      claudeExport: claude({ FAKE_CLAUDE_REPLY_FIXTURE: join(home, "claude-export.json") }),
      claudeRunning: claude({ FAKE_CLAUDE_REPLY_FIXTURE: join(home, "claude-running.json") }),
    },
  }));
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      ...Object.fromEntries(["PATH", "PATHEXT", "SystemRoot", "SystemDrive", "windir", "ComSpec", "TEMP", "TMP"]
        .flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      OMB_PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));
  await waitFor(async () => Boolean((await globalThis.fetch(`${BASE}/api/health`).catch(() => null))?.ok), "the server");
  await waitFor(async () => {
    const instances = (await api("GET", "/api/instances")).body.instances;
    return ["codex", "codexLogs", "codexLeave", "codexDone", "claude", "claudeLeave", "claudeExport", "claudeRunning"].every((id) => instances.find((row: any) => row.instanceId === id)?.snapshot.state === "available");
  }, "the engines");
}, 60_000);

afterAll(async () => {
  child?.kill();
  await new Promise<void>((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.on("close", () => resolve());
  });
  removeTestData(home);
});

it("carries Codex's two unkept promises to Claude's first turn after a steered question took the reply", async () => {
  const { id, threadId } = await bot("codex", "gpt-fake-default");
  const first = "How does Wink keep my work when I switch models? Also keep the picker changes moving: 60 fps clips, font, label numbers.";
  expect((await api("POST", `/api/bots/${id}/messages`, { text: first })).status).toBe(202);
  await waitFor(async () => (await getBot(id)).messages.some((row: any) => row.text === PICKER), "Codex's promises");
  const steer = await api("POST", `/api/bots/${id}/messages`, { text: "What color should the ramp be?" });
  expect(steer.body).toMatchObject({ steered: true });
  await waitFor(async () => (await getBot(id)).busy === false, "the Codex turn to settle");
  expect((await getBot(id)).messages.some((row: any) => row.text === "Blue.")).toBe(true);

  const input = await switched(id, "ok");
  const list = input.slice(input.indexOf(ASKS_LIST)).split("\n");
  expect(input).toContain(ASKS_LIST);
  expect(list).toEqual(expect.arrayContaining([
    expect.stringMatching(/^- A\d+ open promise \d\d-\d\d: I'll answer the model-switch question/),
    expect.stringMatching(/^- A\d+ open promise \d\d-\d\d: I'll keep the picker changes moving\.$/),
  ]));
  // the switch question is the answer promise, never a second item
  expect(asks(threadId).filter((ask) => ask.status === "open")).toHaveLength(2);

  // the next turns file nothing again
  await turn(id, "thanks");
  expect(asks(threadId).filter((ask) => ask.status === "open")).toHaveLength(2);
}, 90_000);

it("files nothing when the turn did what it said, and the next engine gets no asks list", async () => {
  const { id, threadId } = await bot("codexLogs", "gpt-fake-default");
  await turn(id, "Check the logs please");
  expect(asks(threadId)).toEqual([]);
  const input = await switched(id, "thanks");
  expect(input).not.toContain(ASKS_LIST);
  if (process.env.LEFTOVERS_PROMPT_OUT) writeFileSync(process.env.LEFTOVERS_PROMPT_OUT, input);
}, 90_000);

it("closes what the next engine answered and finished, so switching back carries nothing", async () => {
  const { id, threadId } = await bot("codexLeave", "gpt-fake-default");
  expect((await api("POST", `/api/bots/${id}/messages`, { text: "Where are the keyboard shortcuts documented?" })).status).toBe(202);
  await waitFor(async () => (await getBot(id)).messages.some((row: any) => row.text === "I'll update the picker labels."), "Codex's promise");
  expect((await api("POST", `/api/bots/${id}/messages`, { text: "What color should the ramp be?" })).body).toMatchObject({ steered: true });
  await waitFor(async () => (await getBot(id)).busy === false, "the Codex turn to settle");
  expect(asks(threadId).map((ask) => [ask.ask, ask.status])).toEqual([["I'll update the picker labels.", "open"], ["Where are the keyboard shortcuts documented?", "open"]]);

  await api("PATCH", `/api/bots/${id}`, { modelSelection: { instanceId: "codexDone", model: "gpt-fake-default" } });
  await turn(id, "go on");
  const input = await switched(id, "ok");
  expect(input).not.toContain(ASKS_LIST);
  expect(asks(threadId).map((ask) => ask.status)).toEqual(["done", "done"]);
  await turn(id, "thanks");
  expect(asks(threadId).map((ask) => ask.status)).toEqual(["done", "done"]);
}, 90_000);

it("gives a resumed session what its last turn left open, once", async () => {
  const { id, threadId } = await bot("claudeLeave", "claude-fake");
  await turn(id, "Keep going on the picker");
  expect(asks(threadId)).toMatchObject([{ id: "A1", ask: "I'll update the picker labels.", status: "open", kind: "promise" }]);
  const next = await claudeTurn(id, "ok");
  expect(next).toMatch(/^- A1 open promise \d\d-\d\d: I'll update the picker labels\.$/m);
  expect(await claudeTurn(id, "thanks")).not.toContain("I'll update the picker labels.");
  expect(asks(threadId)).toHaveLength(1);
}, 90_000);

it("tells the next engine a filed job a later turn started is running, never to start it", async () => {
  const { id, threadId } = await bot("claudeExport", "claude-fake");
  await turn(id, "Export the data");
  expect(asks(threadId)).toMatchObject([{ id: "A1", ask: EXPORT, status: "open", kind: "promise" }]);
  await api("PATCH", `/api/bots/${id}`, { modelSelection: { instanceId: "claudeRunning", model: "claude-fake" } });
  await turn(id, "go on");
  expect(asks(threadId)).toMatchObject([{ id: "A1", status: "building", ref: "Export running as PID 4128" }]);
  const input = await switched(id, "ok");
  expect(input).toMatch(/^- A1 building promise \d\d-\d\d: I'll run the data export in the background\. \(Export running as PID 4128\)$/m);
  expect(input).toContain("never start it again");
}, 90_000);
