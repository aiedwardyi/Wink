// Every engine's prompt says what the turn may do without asking, and it
// matches the flags the engine was actually launched with. Boots the real
// server on each engine's fake CLI, under Auto and Ask, and reads what the
// CLI received.
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { spawnHarness as spawn, harnessFetch as fetch } from "./testing/harness-auth.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(SERVER_DIR, "testing", name);
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;

const ENGINE_NAMES = ["claude", "codex", "gemini", "grok", "muse"] as const;
type Engine = (typeof ENGINE_NAMES)[number];
type Approval = "auto" | "ask";
type Grant = "free" | "auto" | "ask" | "own" | "off";
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Dump = { argv?: string[]; calls?: Array<{ method: string; params: any }> };

const ENGINES = {
  claude: { driver: "claudeAgent", cli: "fake-claude-cli.ts", dump: "FAKE_CLAUDE_DUMP", model: "claude-sonnet-5", env: {}, config: {} },
  codex: { driver: "codex", cli: "fake-codex-app-server.ts", dump: "FAKE_CODEX_DUMP", model: "gpt-5.5", env: {}, config: { fullAuto: false } },
  gemini: { driver: "antigravityAgent", cli: "fake-agy-cli.ts", dump: "FAKE_AGY_DUMP", model: "gemini-3-pro", env: {}, config: {} },
  grok: { driver: "grokAgent", cli: "fake-acp-cli.ts", dump: "FAKE_ACP_DUMP", model: "grok-4.6", env: { FAKE_ACP_MODE: "happy" }, config: { fullAuto: false } },
  muse: { driver: "museAgent", cli: "fake-msp-cli.ts", dump: "FAKE_MSP_DUMP", model: "muse-spark", env: { META_API_KEY: "fixture-meta-key" }, config: { fullAuto: false } },
} as const;

const argAfter = (argv: string[], flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

// What the wire grants, read independently of the driver's own access(): an ask that reaches Wink is the chip's call.
function wireGrants(engine: Engine, approval: Approval, dump: Dump): { edits: Grant; commands: Grant } {
  const routed: Grant = approval;
  const argv = dump.argv ?? [];
  switch (engine) {
    case "claude": {
      const mode = argAfter(argv, "--permission-mode");
      if (mode === "bypassPermissions") return { edits: "free", commands: "free" };
      if (!mode) return { edits: "own", commands: "own" };
      const asked: string[] = JSON.parse(argAfter(argv, "--settings") ?? "{}").permissions?.ask ?? [];
      return { edits: mode === "acceptEdits" && !asked.includes("Edit") ? "free" : routed, commands: routed };
    }
    case "codex": {
      const start = dump.calls?.find((call) => call.method === "thread/start")?.params;
      expect(start).toBeTruthy();
      if (start.approvalPolicy === "never") return { edits: "free", commands: "free" };
      // no Wink override: the user's own codex config decides
      return start.approvalPolicy ? { edits: routed, commands: routed } : { edits: "own", commands: "own" };
    }
    case "gemini":
      if (argv.includes("--dangerously-skip-permissions")) return { edits: "free", commands: "free" };
      return { edits: argv.includes("accept-edits") ? "free" : "off", commands: "off" };
    case "grok":
      if (argAfter(argv, "--permission-mode") === "bypassPermissions") return { edits: "free", commands: "free" };
      // no Wink override: the user's own grok config decides
      return argv.includes("--permission-mode") ? { edits: routed, commands: routed } : { edits: "own", commands: "own" };
    case "muse":
      // fullAuto: false in this config, so every approval reaches Wink
      return { edits: routed, commands: routed };
  }
}

const SAY: Record<Grant, string> = {
  free: "without asking",
  auto: "without asking (Wink asks the user only for risky ones)",
  ask: "once the user approves; just call the tool to ask them",
  own: "as your own sandbox and approval settings allow",
  off: "",
};
const can = (what: string, grant: Grant) => (grant === "off" ? `cannot ${what}` : `can ${what} ${SAY[grant]}`);
function expectedLevel({ edits, commands }: { edits: Grant; commands: Grant }): string {
  if (edits === commands) return edits === "off" ? "Read-only turn: no file edits or commands." : `You can read files; you ${can("edit files and run commands", edits)}.`;
  return `You can read files. You ${can("edit files", edits)}; you ${can("run commands", commands)}.`;
}

describe("every engine states what it may do", () => {
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
  const dumpDir = (engine: Engine) => join(home, "dumps", engine);
  const files = (engine: Engine) => {
    const dir = dumpDir(engine);
    // fake-claude writes dump.json.<pid>.tmp and renames it; a snapshot between the two has the turn's text but no dump.json
    return existsSync(dir) ? readdirSync(dir).filter((file) => !file.endsWith(".tmp")).map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") })) : [];
  };
  const sendAndRead = async (engine: Engine, path: string, text: string) => {
    rmSync(dumpDir(engine), { recursive: true, force: true });
    mkdirSync(dumpDir(engine), { recursive: true });
    expect((await api("POST", path, { text })).status).toBe(202);
    const deadline = Date.now() + 20_000;
    // fake-acp rewrites dump.json on every run, probes included: only the copy holding the prompt has the turn's argv
    const ready = (snap: { file: string; text: string }[]) =>
      snap.some((f) => f.text.includes(text)) && (engine !== "grok" || Boolean(snap.find((f) => f.file === "dump.json")?.text.includes(text)));
    let snap = files(engine);
    while (!ready(snap)) {
      if (Date.now() > deadline) throw new Error(`${engine} never received "${text}". stderr: ${stderr.slice(-2000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      snap = files(engine);
    }
    const main = snap.find((f) => f.file === "dump.json");
    return {
      prompt: snap.map((f) => f.text).join("\n").replaceAll("\\'", "'").replaceAll('\\"', '"'),
      dump: (main ? JSON.parse(main.text) : {}) as Dump,
    };
  };
  const expectBlock = (engine: Engine, approval: Approval, { prompt, dump }: { prompt: string; dump: Dump }) => {
    const grants = wireGrants(engine, approval, dump);
    expect(prompt).toContain("What you can do here:");
    expect(prompt).toContain(expectedLevel(grants));
    if (grants.commands !== "off") expect(prompt).toContain("Commands can also fetch web pages (curl).");
    expect(prompt).toContain("Your tools are exactly your tool list (built-in plus Wink tools for: other bots and tasks");
    return grants;
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "omb-turn-access-"));
    mkdirSync(join(home, ".orbit"), { recursive: true });
    const instances = Object.fromEntries(ENGINE_NAMES.map((engine) => {
      const spec = ENGINES[engine];
      chmodSync(fake(spec.cli), 0o755);
      return [engine, {
        driver: spec.driver,
        environment: { ...spec.env, [spec.dump]: join(dumpDir(engine), "dump.json") },
        config: { cli: fake(spec.cli), ...spec.config },
      }];
    }));
    writeFileSync(join(home, ".orbit", "config.json"), JSON.stringify({ instances }));
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) };
    if (process.env.PATH) env.PATH = process.env.PATH;
    // Without SystemRoot, winsock fails to initialize in the child.
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
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
  }, 30_000);

  afterAll(async () => {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(home);
  });

  it.each(ENGINE_NAMES)("%s under Auto and Ask, in a 1:1 and a room", async (engine) => {
    const seen: Partial<Record<Approval, { edits: Grant; commands: Grant }>> = {};
    for (const approval of ["auto", "ask"] as const) {
      const bot = (await api("POST", "/api/bots")).body.bot;
      let room: { id: string } | undefined;
      try {
        expect((await api("PATCH", `/api/bots/${bot.id}`, {
          autoApprove: approval === "auto",
          modelSelection: { instanceId: engine, model: ENGINES[engine].model },
        })).status).toBe(200);
        seen[approval] = expectBlock(engine, approval, await sendAndRead(engine, `/api/bots/${bot.id}/messages`, `what can you do on ${engine} ${approval}`));
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);

        room = (await api("POST", "/api/groups", {
          name: `Access room ${engine} ${approval}`,
          memberIds: [bot.id],
          setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } },
        })).body.group;
        expectBlock(engine, approval, await sendAndRead(engine, `/api/groups/${room!.id}/messages`, `what can you do in the room on ${engine} ${approval}`));
      } finally {
        if (room) {
          await api("POST", `/api/groups/${room.id}/interrupt`, {}).catch(() => undefined);
          await api("DELETE", `/api/groups/${room.id}`).catch(() => undefined);
        }
        await api("POST", `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
        await api("DELETE", `/api/bots/${bot.id}`).catch(() => undefined);
      }
    }
    // gemini's print mode never asks, so the chip changes nothing there; everywhere else it does
    if (engine === "gemini") expect(seen.auto).toEqual(seen.ask);
    else expect(seen.auto).not.toEqual(seen.ask);
  }, 90_000);
});
