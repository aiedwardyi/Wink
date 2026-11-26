// Every engine's read-only turn, launched for real against its fake CLI on its most permissive
// instance (full auto / bypass): the restriction must show in the launch itself, not just a flag.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testHome } from "../testing/test-home.ts";

import { DATA_DIR, ensureDirs } from "../config.ts";
import * as procs from "../procs.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents } from "../testing/events.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import * as auth from "./antigravity-auth.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver, READ_ONLY_FEATURES_OFF } from "./codex.ts";
import { MspMuseAgentDriver } from "./msp/muse.ts";
import { lineWords } from "../replies.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fake = (name: string) => join(here, "..", "testing", name);
const WRITE_TOOLS = ["Bash", "PowerShell", "Edit", "Write", "MultiEdit", "NotebookEdit"];
const EXEMPT: Record<string, string> = { boxAgent: "a cloud box has no read-only mode, so Wink keeps the can't-work line for it" };
const agents = { command: process.execPath, args: ["-e", ""], env: {} };
const composio = { command: process.execPath, args: ["-e", "", "composio"], env: {} };

// the CLI's absolute rule form
const rule = (dir: string) => `Read(${/^[A-Za-z]:/.test(dir) ? `//${dir[0]!.toLowerCase()}/${dir.slice(3).replace(/\\/g, "/")}` : `/${dir}`}/**)`;

const createSignIn = auth.antigravitySignIn;
let scratch: string;
const live: ProviderInstance[] = [];
const envBefore = new Map<string, string | undefined>();
const setEnv = (name: string, value: string) => {
  if (!envBefore.has(name)) envBefore.set(name, process.env[name]);
  process.env[name] = value;
};
beforeEach(() => {
  ensureDirs();
  vi.spyOn(auth, "antigravitySignIn").mockImplementation(() => createSignIn(async () => true));
  scratch = mkdtempSync(join(tmpdir(), "omb-read-only-launch-"));
});
afterEach(async () => {
  for (const instance of live.splice(0)) await instance.dispose();
  for (const [name, value] of envBefore) value === undefined ? delete process.env[name] : (process.env[name] = value);
  envBefore.clear();
  vi.restoreAllMocks();
  await removeTempDir(scratch);
});

const run = async (instance: ProviderInstance, threadId: string, extra: Partial<SendTurnInput> = {}) => {
  const recorder = recordEvents(instance.adapter);
  await instance.adapter.sendTurn({ threadId, text: "edit notes.txt, then run echo ran", cwd: scratch, approval: "auto", ...extra });
  const done = await recorder.until((e) => e.type === "turn.completed" && e.threadId === threadId);
  expect(done, JSON.stringify(recorder.events.filter((e) => e.type === "runtime.error"))).toMatchObject({ ok: true });
};
const dumped = (name: string) => JSON.parse(readFileSync(join(scratch, name), "utf8"));
const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
// Paths, ids and the node binary differ per machine; the launch shape must not.
const escaped = (path: string) => [JSON.stringify(JSON.stringify(path).slice(1, -1)).slice(1, -1), JSON.stringify(path).slice(1, -1), path];
const clean = (text: string) => {
  let out = text;
  for (const [path, label] of [[scratch, "<scratch>"], [join(here, "..", ".."), "<repo>"], [process.execPath, "<node>"], [tmpdir(), "<tmp>"]] as const) {
    for (const form of escaped(path)) out = out.replaceAll(form, label);
  }
  return out
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/omb-mcp-[^\\/"]+/g, "omb-mcp-<id>")
    .replace(/\\+/g, "/");
};
const normalized = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(normalized)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalized(inner)]))
  : typeof value === "string" ? clean(value) : value;

type Engine = { launch(readOnly: boolean): Promise<unknown>; restricted(launch: unknown): void };
const ENGINES: Record<string, Engine> = {
  claudeAgent: {
    async launch(readOnly) {
      const instance = await ClaudeDriver.create({ instanceId: "ro-claude", displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-claude-cli.ts"), permissionMode: "bypassPermissions" } });
      live.push(instance);
      setEnv("FAKE_CLAUDE_DUMP", join(scratch, "claude.json"));
      await run(instance, "t-claude", { integrations: { agents, composio }, ...(readOnly && { readOnly }) });
      const { argv, mcpConfig } = dumped("claude.json");
      return { argv, mcpServers: Object.keys(mcpConfig?.mcpServers ?? {}).sort() };
    },
    restricted({ argv, mcpServers }: { argv: string[]; mcpServers: string[] }) {
      expect(after(argv, "--permission-mode")).toBe("default");
      expect(after(argv, "--disallowedTools").split(",")).toEqual(expect.arrayContaining(WRITE_TOOLS));
      expect(argv).toEqual(expect.arrayContaining(["--strict-mcp-config", "--no-chrome"]));
      expect(argv).not.toContain("--plugin-dir");
      expect(mcpServers).toEqual(["agents", "ogb"]);
      expect(after(argv, "--allowedTools").split(",").sort()).toEqual(["mcp__agents", "mcp__ogb"]);
      const deny = JSON.parse(after(argv, "--settings")).permissions.deny as string[];
      for (const dir of [join(testHome(), ".ssh"), join(testHome(), ".codex"), join(testHome(), ".claude"), DATA_DIR, join(DATA_DIR, "accounts")]) expect(deny).toContain(rule(dir));
    },
  },
  codex: {
    async launch(readOnly) {
      setEnv("FAKE_CODEX_MODE", "resume");
      setEnv("FAKE_CODEX_CONFIG", JSON.stringify({ mcp_servers: { github: { url: "https://example.invalid/mcp" }, agents: {} }, plugins: { "unified-computer-use@openai-bundled": { enabled: true } } }));
      const instance = await CodexDriver.create({ instanceId: "ro-codex", displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-codex-app-server.ts"), fullAuto: true } });
      live.push(instance);
      const params: Record<string, unknown> = {};
      // a read-only turn resumes only a thread it started read-only (the fake's first thread)
      for (const [method, cursor] of [["thread/start", undefined], ["thread/resume", readOnly ? "codex-thread-1" : "codex-thread-9"]] as const) {
        const file = `codex-${method.replace("/", "-")}.json`;
        setEnv("FAKE_CODEX_DUMP", join(scratch, file));
        await run(instance, `t-codex-${method}`, { integrations: { agents }, ...(cursor && { resumeCursor: cursor }), ...(readOnly && { readOnly }) });
        const { argv, calls } = dumped(file);
        params[method] = { argv, params: calls.find((call: { method: string }) => call.method === method).params };
      }
      return params;
    },
    restricted(launch: Record<string, { params: { sandbox: string; approvalPolicy: string; config: Record<string, unknown> } }>) {
      for (const method of ["thread/start", "thread/resume"]) {
        const { sandbox, approvalPolicy, config } = launch[method]!.params;
        expect({ method, sandbox, approvalPolicy }).toEqual({ method, sandbox: "read-only", approvalPolicy: "untrusted" });
        expect(config).toMatchObject({ "mcp_servers.github.enabled": false, "plugins.unified-computer-use@openai-bundled.enabled": false, "features.apps": false, "features.remote_plugin": false, "features.hooks": false });
        expect(config).not.toHaveProperty("mcp_servers.agents.enabled");
        expect(config).toMatchObject({ "features.shell_tool": false, "features.unified_exec": false, "features.view_image": false, "features.multi_agent": false, "features.multi_agent_v2": false });
        for (const name of READ_ONLY_FEATURES_OFF) expect(config).toHaveProperty([`features.${name}`], false);
      }
    },
  },
  antigravityAgent: {
    async launch(readOnly) {
      // vitest's setup points HOME at a throwaway dir, so agy's MCP mount never reaches the real ~/.gemini
      setEnv("FAKE_AGY_DUMP", join(scratch, "agy.json"));
      const instance = await AntigravityDriver.create({ instanceId: "ro-agy", displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-agy-cli.ts"), fullAuto: true } });
      live.push(instance);
      await run(instance, "t-agy", readOnly ? { readOnly } : {});
      return { argv: dumped("agy.json").argv };
    },
    restricted({ argv }: { argv: string[] }) {
      expect(after(argv, "--mode")).toBe("plan");
      expect(JSON.parse(after(argv, "--settings"))).toEqual({ allowNonWorkspaceAccess: false, permissions: { deny: ["read_file(*)"] } });
      expect(argv).not.toContain("--dangerously-skip-permissions");
    },
  },
  grokAgent: {
    async launch(readOnly) {
      const instance = await GrokAgentDriver.create({ instanceId: "ro-grok", displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-acp-cli.ts"), fullAuto: true } });
      live.push(instance);
      setEnv("FAKE_ACP_DUMP", join(scratch, "grok.json"));
      await run(instance, "t-grok", readOnly ? { readOnly } : {});
      return { argv: dumped("grok.json").argv };
    },
    restricted({ argv }: { argv: string[] }) {
      expect(after(argv, "--permission-mode")).toBe("plan");
      expect(argv).not.toContain("bypassPermissions");
    },
  },
  museAgent: {
    async launch(readOnly) {
      setEnv("META_API_KEY", "meta-key");
      const instance = await MspMuseAgentDriver.create({ instanceId: "ro-muse", displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-msp-cli.ts"), fullAuto: true } });
      live.push(instance);
      setEnv("FAKE_MSP_DUMP", join(scratch, "muse.json"));
      await run(instance, "t-muse", readOnly ? { readOnly } : {});
      return { argv: dumped("muse.json").argv };
    },
    restricted({ argv }: { argv: string[] }) {
      expect(argv).toEqual(expect.arrayContaining(["--disable-write", "--disable-shell"]));
    },
  },
};

// The owner's own command hooks, from every settings file and an enabled plugin, each writing a marker.
const HOOK_SOURCES = ["user", "project", "local", "installed-plugin", "plugin-dir"];
const hookFixture = (marks: string) => {
  const config = join(scratch, "config");
  const project = join(scratch, "project");
  const base = join(scratch, "base");
  const hooks = (tag: string) => Object.fromEntries(["SessionStart", "UserPromptSubmit"].map((event) => [event, [{ hooks: [{
    type: "command",
    command: [process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], '')", join(marks, `${tag}-${event}`)].map((part) => `"${part.replaceAll("\\", "/")}"`).join(" "),
  }] }]]));
  const plugin = (dir: string, tag: string) => {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: tag }));
    writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: hooks(tag) }));
  };
  for (const dir of [marks, join(config, "plugins"), join(project, ".claude"), join(base, "plugins")]) mkdirSync(dir, { recursive: true });
  const installed = join(config, "plugins", "cache", "mkt", "hooky", "1.0.0");
  plugin(installed, "installed-plugin");
  writeFileSync(join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "hooky@mkt": [{ scope: "user", installPath: installed, version: "1.0.0" }] } }));
  writeFileSync(join(config, "settings.json"), JSON.stringify({ hooks: hooks("user"), enabledPlugins: { "hooky@mkt": true } }));
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: hooks("project") }));
  writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ hooks: hooks("local") }));
  // the account path loads the base home's enabled plugins with --plugin-dir
  const kit = join(base, "plugins", "cache", "mkt", "kit", "1.0.0");
  plugin(kit, "plugin-dir");
  writeFileSync(join(base, "settings.json"), JSON.stringify({ enabledPlugins: { "kit@mkt": true } }));
  writeFileSync(join(base, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "kit@mkt": [{ scope: "user", installPath: kit, version: "1.0.0" }] } }));
  const fired = () => readdirSync(marks).map((name) => name.replace(/-(SessionStart|UserPromptSubmit)$/, "")).filter((tag, i, all) => all.indexOf(tag) === i).sort();
  return { config, project, base, fired };
};

describe("Claude read-only turns run none of the owner's hooks", () => {
  const launch = async (account: boolean) => {
    const marks = join(scratch, "marks");
    const fixture = hookFixture(marks);
    setEnv("FAKE_CLAUDE_HOOKS", "1");
    if (account) {
      const exec = procs.execCli;
      vi.spyOn(procs, "execCli").mockImplementation((cli, args, opts, cb) =>
        args[0] === "auth" ? cb(null, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", configDirectory: fixture.config })) : exec(cli, args, opts, cb));
    }
    const instance = await ClaudeDriver.create({
      instanceId: account ? "hooks-claude-account" : "hooks-claude",
      displayName: undefined,
      environment: { CLAUDE_CONFIG_DIR: account ? fixture.base : fixture.config },
      enabled: true,
      ...(account && { account: { id: "acct-hooks", of: "claude-hooks", home: fixture.config, generation: 1 } }),
      config: { cli: fake("fake-claude-cli.ts"), permissionMode: "bypassPermissions" },
    });
    live.push(instance);
    const turn = async (threadId: string, extra: Partial<SendTurnInput>) => {
      await run(instance, threadId, { cwd: fixture.project, integrations: { agents }, ...extra });
      const fired = fixture.fired();
      await removeTempDir(marks);
      mkdirSync(marks);
      return fired;
    };
    return turn;
  };

  it.each([["non-account", false], ["account", true]] as const)("%s: an owner turn runs them, a read-only turn fresh or resumed runs none", async (_path, account) => {
    const turn = await launch(account);
    const owned = account ? HOOK_SOURCES : HOOK_SOURCES.filter((source) => source !== "plugin-dir");
    expect(await turn("t-owner", {})).toEqual([...owned].sort());
    expect(await turn("t-owner-resumed", { resumeCursor: "s-owner" })).toEqual([...owned].sort());
    expect(await turn("t-read-only", { readOnly: true })).toEqual([]);
    expect(await turn("t-read-only-resumed", { readOnly: true, resumeCursor: "s-owner" })).toEqual([]);
  });
});

// GROUP-JOIN-REAL row 9: a joiner asked the host's Claude bot to read notes.txt in its project and it posted the file.
// The access each turn gets is what index.ts gives a room turn (multiplayer.test.ts pins those shapes).
describe("a room guest's read-only turn reads no host file", () => {
  const CANARY = "host-only file: canary GJR-7731";
  const GUEST_ASK: Partial<SendTurnInput> = { approval: "ask", readOnly: true };
  const OWNER_LANE: Partial<SendTurnInput> = { approval: "auto", readOnly: true, ownerText: true };
  const OWNER_TURN: Partial<SendTurnInput> = { approval: "ask" };

  const claudeRead = async (threadId: string, access: Partial<SendTurnInput>) => {
    const project = join(scratch, "proj");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "notes.txt"), CANARY);
    const out = join(scratch, "read-out.txt");
    rmSync(out, { force: true });
    setEnv("FAKE_CLAUDE_MODE", "read");
    setEnv("FAKE_CLAUDE_READ_OUT", out);
    const instance = await ClaudeDriver.create({ instanceId: `read-${threadId}`, displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-claude-cli.ts"), permissionMode: "acceptEdits" } });
    live.push(instance);
    await run(instance, threadId, { cwd: project, integrations: { agents }, ...access });
    return existsSync(out) ? readFileSync(out, "utf8") : null;
  };

  it.each([["fresh", undefined], ["resumed", "s-host"]] as const)("Claude: a guest's ask can't read the host's project file (%s)", async (_how, cursor) => {
    expect(await claudeRead("t-guest", { ...GUEST_ASK, ...(cursor && { resumeCursor: cursor }) })).toBeNull();
  });

  it("Claude: the owner's own read-only lane and owner turns still read it", async () => {
    expect(await claudeRead("t-owner-lane", OWNER_LANE)).toBe(CANARY);
    expect(await claudeRead("t-owner", OWNER_TURN)).toBe(CANARY);
  });

  it("Claude: LSP reads like Read: an owner turn keeps it, a guest's ask can't", async () => {
    setEnv("FAKE_CLAUDE_READ_TOOL", "LSP");
    expect(await claudeRead("t-owner-lsp", OWNER_TURN)).toBe(CANARY);
    expect(await claudeRead("t-guest-lsp", GUEST_ASK)).toBeNull();
  });

  const hostProject = () => {
    const project = join(scratch, "proj");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "notes.txt"), CANARY);
    return project;
  };
  const reader = (instance: ProviderInstance, cwd: string, out: string) => async (threadId: string, access: Partial<SendTurnInput>) => {
    rmSync(out, { force: true });
    await run(instance, threadId, { cwd, integrations: { agents }, ...access });
    return existsSync(out) ? readFileSync(out, "utf8") : null;
  };

  it("Grok: over agent stdio plan mode and --disallowed-tools hold nothing, so a guest's ask gets no read tool or shell; the owner's lane and turns keep them", async () => {
    const out = join(scratch, "grok-read.txt");
    setEnv("FAKE_ACP_MODE", "read");
    setEnv("FAKE_ACP_READ_OUT", out);
    const instance = await GrokAgentDriver.create({ instanceId: "read-grok", displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-acp-cli.ts"), fullAuto: true } });
    live.push(instance);
    const read = reader(instance, hostProject(), out);
    expect(await read("t-grok-guest", GUEST_ASK)).toBeNull();
    expect(await read("t-grok-guest-resumed", { ...GUEST_ASK, resumeCursor: "s-host" })).toBeNull();
    expect(await read("t-grok-lane", OWNER_LANE)).toBe(CANARY);
    expect(await read("t-grok-owner", OWNER_TURN)).toBe(CANARY);
    // the guest's tools come from its launch, not the saved session: the owner's next turn has them all
    expect(await read("t-grok-guest", { ...OWNER_TURN, resumeCursor: "fake-acp-session" })).toBe(CANARY);
  });

  // GATE-REVIEW-2239C: grok inlines an @path with no tool, so a guest's words must reach it with every @ broken
  it("Grok: a guest's @path inlines no file in any form grok expands; the owner's own @path still does", async () => {
    const out = join(scratch, "grok-at.txt");
    setEnv("FAKE_ACP_MODE", "read");
    setEnv("FAKE_ACP_READ_OUT", out);
    const instance = await GrokAgentDriver.create({ instanceId: "at-grok", displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-acp-cli.ts"), fullAuto: true } });
    live.push(instance);
    const elsewhere = join(scratch, "elsewhere.txt");
    writeFileSync(elsewhere, "outside canary");
    const read = reader(instance, hostProject(), out);
    const ask = ["", "\u200B", ":", ",", "-", "/", "=", "\\"].map((before) => `${before}@notes.txt and ${before}@${elsewhere}`).join(", ");
    const mina = { author: { kind: "person", id: "p1", name: "Mina" } };
    expect(await read("t-grok-at-guest", { ...GUEST_ASK, text: lineWords(mina, ask, true) })).toBeNull();
    expect(await read("t-grok-at-owner", { ...OWNER_TURN, text: lineWords({ author: { kind: "host" } }, ask, true) })).toContain("outside canary");
  });

  it("Muse: a guest's ask works in an empty folder and never resumes a session rooted in the host's project", async () => {
    const out = join(scratch, "muse-read.txt");
    setEnv("META_API_KEY", "meta-key");
    setEnv("FAKE_MSP_MODE", "read");
    setEnv("FAKE_MSP_READ_OUT", out);
    const instance = await MspMuseAgentDriver.create({ instanceId: "read-muse", displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-msp-cli.ts"), fullAuto: true } });
    live.push(instance);
    const read = reader(instance, hostProject(), out);
    expect(await read("t-muse-lane", OWNER_LANE)).toBe(CANARY);
    expect(await read("t-muse-guest", GUEST_ASK)).toBeNull();
    // the session that ask started sits in its empty folder: the owner's next turn resumes it in the project
    expect(await read("t-muse-guest", { ...OWNER_TURN, resumeCursor: "fake-msp-session" })).toBe(CANARY);
    // the owner's session, rooted in the project, is the one a guest's ask would resume
    expect(await read("t-muse-owner", OWNER_TURN)).toBe(CANARY);
    expect(await read("t-muse-guest-resumed", { ...GUEST_ASK, resumeCursor: "fake-msp-session" })).toBeNull();
  });

  it("agy: a guest's ask denies every file read; the owner's lane keeps its workspace", async () => {
    setEnv("FAKE_AGY_DUMP", join(scratch, "agy.json"));
    const instance = await AntigravityDriver.create({ instanceId: "read-agy", displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-agy-cli.ts"), fullAuto: true } });
    live.push(instance);
    const settings = async (threadId: string, access: Partial<SendTurnInput>) => {
      await run(instance, threadId, access);
      return JSON.parse(after(dumped("agy.json").argv, "--settings"));
    };
    expect(await settings("t-agy-guest", GUEST_ASK)).toEqual({ allowNonWorkspaceAccess: false, permissions: { deny: ["read_file(*)"] } });
    expect(await settings("t-agy-lane", OWNER_LANE)).toEqual({ allowNonWorkspaceAccess: false });
  });
});

describe("Codex web_read reader turn, which mounts no Wink agents", () => {
  const INHERITED = { mcp_servers: { github: { url: "https://example.invalid/mcp" }, agents: { command: "inert-user-agents" } } };
  const codex = async () => {
    setEnv("FAKE_CODEX_MODE", "resume");
    setEnv("FAKE_CODEX_CONFIG", JSON.stringify(INHERITED));
    const instance = await CodexDriver.create({ instanceId: "reader-codex", displayName: undefined, environment: {}, enabled: true, config: { cli: fake("fake-codex-app-server.ts"), fullAuto: true } });
    live.push(instance);
    return instance;
  };
  const sent = (file: string, method: string) => dumped(file).calls.find((call: { method: string }) => call.method === method)?.params;

  it("turns off every inherited MCP server, one named agents included, fresh and resumed", async () => {
    const instance = await codex();
    for (const [method, cursor] of [["thread/start", undefined], ["thread/resume", "codex-thread-1"]] as const) {
      const file = `reader-${method.replace("/", "-")}.json`;
      setEnv("FAKE_CODEX_DUMP", join(scratch, file));
      await run(instance, `t-reader-${method}`, { readOnly: true, ...(cursor && { resumeCursor: cursor }) });
      const { argv } = dumped(file);
      expect(argv.join(" ")).not.toContain("mcp_servers.agents.command");
      expect(sent(file, method)).toMatchObject({ sandbox: "read-only", approvalPolicy: "untrusted", config: { "mcp_servers.github.enabled": false, "mcp_servers.agents.enabled": false } });
    }
  });

  it("keeps Wink's own agents server on a read-only turn that mounts it", async () => {
    const instance = await codex();
    setEnv("FAKE_CODEX_DUMP", join(scratch, "room.json"));
    await run(instance, "t-room", { readOnly: true, integrations: { agents } });
    expect(dumped("room.json").argv.join(" ")).toContain("mcp_servers.agents.command");
    const config = sent("room.json", "thread/start").config;
    expect(config).toMatchObject({ "mcp_servers.github.enabled": false });
    expect(config).not.toHaveProperty("mcp_servers.agents.enabled");
  });

});

describe("read-only launch contract", () => {
  it("runs with a throwaway HOME", () => {
    expect(testHome().startsWith(tmpdir())).toBe(true);
  });

  it("covers every registered engine", () => {
    const missing = BUILT_IN_DRIVERS.map((driver) => driver.driverKind).filter((kind) => !(kind in ENGINES) && !(kind in EXEMPT));
    if (missing.length) {
      throw new Error(`${missing.join(", ")}: add an entry to ENGINES in read-only-launch.test.ts that launches a read-only turn and asserts the engine's own read-only mode (sandbox, plan mode, or tools off), never a full-permission turn`);
    }
  });

  it.each(Object.keys(ENGINES))("%s launches a read-only turn restricted, even on its most permissive instance", async (kind) => {
    ENGINES[kind]!.restricted(await ENGINES[kind]!.launch(true));
  });

  it.each(Object.keys(ENGINES))("%s launches a normal turn exactly as before", async (kind) => {
    expect(normalized(await ENGINES[kind]!.launch(false))).toMatchSnapshot();
  });
});
