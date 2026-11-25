// An update that only moves prompt blocks keeps the pinned Claude session or Codex thread, and later edits still reach it.
// Boots the real server on the fake CLIs, keeping the profile across restarts.
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";
import { createFixtureHome, removeTestData } from "./testing/test-home.ts";
import { CREDENTIAL_PROMPT } from "./wink-guide.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const UPDATE = "[Wink instructions update";
const REPLAY = "fresh provider session because your instructions changed";

const ENGINES = {
  claude: { driver: "claudeAgent", cli: "fake-claude-cli.ts", model: "claude-sonnet-5" },
  codex: { driver: "codex", cli: "fake-codex-app-server.ts", model: "gpt-5.5" },
} as const;
const ENGINE_NAMES = ["claude", "codex"] as const;
type Engine = (typeof ENGINE_NAMES)[number];
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// The layout before the cache reorder: saved keys rode the credential rule, About You and
// the notes sat by the memory guidance, and the playbook came after them.
const olderOrder = (system: string) => {
  const start = system.indexOf("\n<harness_playbook>");
  const end = system.indexOf("</harness_playbook>") + "</harness_playbook>".length;
  const tail = system.slice(end);
  const keys = /^\nSaved keys: [^\n]*/.exec(tail)?.[0] ?? "";
  const personal = tail.slice(keys.length);
  const notesAt = personal.indexOf("\n\nYour memory (MEMORY.md):");
  const guidanceStart = system.indexOf(" Your private long-term memory file is");
  const guidanceEnd = system.indexOf("never action approval.", guidanceStart) + "never action approval.".length;
  const rest = system.slice(0, guidanceStart) + personal.slice(0, notesAt) + system.slice(guidanceStart, guidanceEnd)
    + personal.slice(notesAt) + system.slice(guidanceEnd, start);
  return rest.replace(CREDENTIAL_PROMPT, CREDENTIAL_PROMPT + keys.replace("\n", " ")) + system.slice(start, end);
};

describe("pinned session across a prompt reorder", () => {
  let child: ChildProcess;
  let home: string;
  let stderr = "";

  const api = async (method: string, path: string, body?: Json): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const writeConfig = (keys: Record<string, Json>) => {
    const instances = Object.fromEntries(Object.entries(ENGINES).map(([engine, spec]) => {
      chmodSync(fake(spec.cli), 0o755);
      return [engine, {
        driver: spec.driver,
        environment: engine === "claude"
          ? { FAKE_CLAUDE_MODE: "bench-quiet", FAKE_CLAUDE_PROMPT_LOG: join(home, "claude-prompts.jsonl") }
          : { FAKE_CODEX_MODE: "resume", FAKE_CODEX_DUMP: join(home, "codex", "dump.json") },
        config: { cli: fake(spec.cli), fullAuto: true },
      }];
    }));
    writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances, ...keys }));
  };
  const boot = async () => {
    const env: NodeJS.ProcessEnv = {
      HOME: home, USERPROFILE: home, OMB_PORT: String(PORT),
      OMB_TERMINAL_URL: "http://127.0.0.1:1", OMB_TERMINAL_TOKEN: "fixture-bridge-token",
    };
    if (process.env.PATH) env.PATH = process.env.PATH;
    // Without SystemRoot, winsock fails to initialize in the child.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    mkdirSync(join(home, "codex"), { recursive: true });
    stderr = "";
    child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr!.on("data", (chunk) => (stderr += chunk));
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        if ((await fetch(`${BASE}/api/health`)).ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error(`server never came up. stderr:\n${stderr}`);
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}. stderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  const restart = async (between?: () => void) => {
    await waitForExit(child, { signal: "SIGTERM" });
    between?.();
    removeTestData(join(home, "codex"));
    await boot();
  };
  const sessionFiles = () => {
    const dir = join(home, ".orbit", "session-system");
    return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
  };

  /** What the engine read for this send, once the turn settled. */
  const send = async (engine: Engine, botId: string, text: string) => {
    expect((await api("POST", `/api/bots/${botId}/messages`, { text })).status).toBe(202);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const busy = (await api("GET", "/api/bots?messages=30")).body.bots.find((bot: any) => bot.id === botId)?.busy;
      if (engine === "claude") {
        const log = join(home, "claude-prompts.jsonl");
        const entry = existsSync(log)
          ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.text?.includes(text))
          : undefined;
        if (entry && !busy) return { resumed: Boolean(entry.argv.includes("--resume")), input: String(entry.text), startup: String(entry.systemPrompt ?? "") };
      } else {
        let calls: Array<{ method: string; params: any }> = [];
        try { calls = JSON.parse(readFileSync(join(home, "codex", "dump.json"), "utf8")).calls; } catch { /* not written yet */ }
        const started = calls.find((call) => call.method === "turn/start" && JSON.stringify(call.params).includes(text));
        if (started && !busy) {
          const injected = calls.filter((call) => call.method === "thread/inject_items")
            .flatMap((call) => call.params.items.flatMap((item: any) => item.content.map((block: any) => block.text ?? "")));
          const turn = started.params.input.map((item: any) => item.text ?? "");
          const startup = String(calls.find((call) => call.method === "thread/start")?.params?.developerInstructions ?? "");
          return { resumed: calls.some((call) => call.method === "thread/resume") && !calls.some((call) => call.method === "thread/start"), input: [...injected, ...turn].join("\n"), startup };
        }
      }
      if (Date.now() > deadline) throw new Error(`${engine} never settled "${text}". stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  beforeAll(async () => {
    home = createFixtureHome("omb-prompt-order-upgrade-");
    mkdirSync(join(home, ".orbit", "about-you"), { recursive: true });
    writeFileSync(join(home, ".orbit", "about-you", "MEMORY.md"), "- Prints notes on ivory paper.\n");
    writeConfig({ tts: { key: "fixture-tts" } });
    await boot();
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    removeTestData(home);
  });

  it.each(ENGINE_NAMES)("keeps the %s session, then still delivers memory and key edits", async (engine) => {
    await restart(() => writeConfig({ tts: { key: "fixture-tts" } }));
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: engine, model: ENGINES[engine].model },
    })).status).toBe(200);
    const memory = join(home, ".orbit", "workspaces", bot.id, "MEMORY.md");
    const notes = (marker: string) => Array.from({ length: 40 }, (_, i) => `- Note ${i}: ${i === 7 ? marker : "linen maple clay"}`).join("\n") + "\n";
    mkdirSync(dirname(memory), { recursive: true });
    writeFileSync(memory, notes("linen maple clay"));

    expect((await send(engine, bot.id, `first on ${engine}`)).resumed).toBe(false);
    const before = new Set(sessionFiles());
    expect(before.size).toBeGreaterThan(0);
    await restart(() => {
      for (const path of before) {
        const system = readFileSync(path, "utf8");
        if (!system.includes("<harness_playbook>")) continue;
        expect(olderOrder(system)).not.toBe(system);
        expect(olderOrder(system)).toContain(`${CREDENTIAL_PROMPT} Saved keys: `);
        writeFileSync(path, olderOrder(system));
      }
    });

    const text = `after the update on ${engine}`;
    const upgraded = await send(engine, bot.id, text);
    expect(upgraded.resumed).toBe(true);
    expect(upgraded.input).toBe(text);

    writeFileSync(memory, notes("the user moved to Busan"));
    await restart();
    const edited = await send(engine, bot.id, `after the memory edit on ${engine}`);
    expect(edited.resumed).toBe(true);
    expect(edited.input).not.toContain(REPLAY);
    expect(edited.input).toContain(UPDATE);
    expect(edited.input).toContain("- Note 7: the user moved to Busan");

    await restart(() => writeConfig({ tts: { key: "fixture-tts" }, xai: { key: "fixture-xai" } }));
    const keyed = await send(engine, bot.id, `after the key edit on ${engine}`);
    expect(keyed.resumed).toBe(true);
    expect(keyed.input).not.toContain(REPLAY);
    expect(keyed.input).toContain("xAI API Key");

    await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
  }, 120_000);

  const LABELS = { markdown: (name: string) => `## ${name}`, plain: (name: string) => `${name}:` };
  it.each(ENGINE_NAMES.flatMap((engine) => (["markdown", "plain"] as const).map((labels) => [labels, engine] as const)))("delivers values that traded places under %s labels to the open %s chat and after a restart", async (labels, engine) => {
    const label = LABELS[labels];
    await restart(() => writeConfig({ tts: { key: "fixture-tts" } }));
    const bot = (await api("POST", "/api/bots")).body.bot;
    expect((await api("PATCH", `/api/bots/${bot.id}`, {
      modelSelection: { instanceId: engine, model: ENGINES[engine].model },
    })).status).toBe(200);
    const path = `/api/bots/${bot.id}/memory`;
    const notes = (a: string, b: string) => [
      "# Project notes", "", label("Project A"), "Owner: Alex.", "", `Budget: ${a} dollars.`, "",
      label("Project B"), "Owner: Billie.", "", `Budget: ${b} dollars.`, "", label("Status"), "Both active.", "",
    ].join("\n");
    const save = async (a: string, b: string) => {
      const { revision } = (await api("GET", path)).body;
      expect((await api("PUT", path, { text: notes(a, b), baseRevision: revision })).status).toBe(200);
    };
    const knows = (got: { input: string; startup: string }, a: string, b: string) => {
      if (!got.input.includes(UPDATE)) return got.startup.includes(notes(a, b).trim());
      const added = got.input.slice(got.input.indexOf("[Added:]"));
      return added.includes(`${label("Project A")}\nOwner: Alex.\nBudget: ${a} dollars.`) && added.includes(`${label("Project B")}\nOwner: Billie.\nBudget: ${b} dollars.`);
    };

    await save("500", "740");
    expect(knows(await send(engine, bot.id, `read the ${labels} notes on ${engine}`), "500", "740")).toBe(true);
    await save("740", "500");
    const warm = await send(engine, bot.id, `the ${labels} Project A budget on ${engine}`);
    expect(warm.input).not.toContain(REPLAY);
    expect(knows(warm, "740", "500")).toBe(true);

    await save("500", "740");
    await restart();
    const restarted = await send(engine, bot.id, `the ${labels} Project A budget after a restart on ${engine}`);
    expect(restarted.resumed).toBe(true);
    expect(knows(restarted, "500", "740")).toBe(true);

    await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
  }, 120_000);
});
