import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GrokAgentDriver, grokSupport, readGrokModelCatalog, STATIC_GROK_MODELS } from "./grok.ts";

const scratchDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchConfig(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-grok-catalog-"));
  scratchDirs.push(dir);
  mkdirSync(join(dir, ".grok"), { recursive: true });
  writeFileSync(join(dir, ".grok", "config.toml"), toml);
  return dir;
}

describe("readGrokModelCatalog", () => {
  it("returns the static cloud pair when there is no config", () => {
    expect(readGrokModelCatalog({ HOME: join(tmpdir(), "omb-grok-missing-home") })).toEqual(STATIC_GROK_MODELS);
  });

  it("carries a context window on every cloud model", () => {
    for (const option of STATIC_GROK_MODELS.options) {
      expect(option.contextWindow, option.id).toBeGreaterThanOrEqual(128_000);
    }
  });

  it("appends local slugs from config.toml and prefers their display names", () => {
    const home = scratchConfig(`
[models]
default = "ollama-ornith-35b-bf16"

[model."grok-4.6"]
name = "should not replace the cloud label"

[model."ollama-ornith-35b-bf16"]
model = "ornith:35b-bf16"
name = "ornith:35b-bf16 (Ollama)"
api_key = "must-not-leak"

[model.omlx-minimax-m3]
name = "MiniMax M3 4bit (oMLX)"
`);

    expect(readGrokModelCatalog({ HOME: home })).toEqual({
      default: "ollama-ornith-35b-bf16",
      options: [
        { id: "grok-4.7", label: "Grok 4.7", contextWindow: 500_000 },
        { id: "grok-4.6", label: "Grok 4.6", contextWindow: 500_000 },
        { id: "ollama-ornith-35b-bf16", label: "ornith:35b-bf16 (Ollama)", custom: true },
        { id: "omlx-minimax-m3", label: "MiniMax M3 4bit (oMLX)", custom: true },
      ],
    });
  });

  it("ignores invalid slugs and a default that is not in the catalog", () => {
    const home = scratchConfig(`
[models]
default = "not-installed"

[model."bad slug"]
name = "nope"

[model.ok-model]
name = "OK"
`);
    const catalog = readGrokModelCatalog({ HOME: home });
    expect(catalog.default).toBe("grok-4.6");
    expect(catalog.options.map((o) => o.id)).toEqual(["grok-4.7", "grok-4.6", "ok-model"]);
  });

  it("honors GROK_HOME over HOME", () => {
    const ignored = scratchConfig(`[model.ignored]\nname = "Ignored"\n`);
    const grokHomeParent = mkdtempSync(join(tmpdir(), "omb-grok-home-"));
    const grokHome = join(grokHomeParent, "grok");
    scratchDirs.push(grokHomeParent);
    mkdirSync(grokHome, { recursive: true });
    writeFileSync(join(grokHome, "config.toml"), `[model.from-grok-home]\nname = "From GROK_HOME"\n`);
    const catalog = readGrokModelCatalog({ HOME: ignored, GROK_HOME: grokHome });
    expect(catalog.options.map((o) => o.id)).toContain("from-grok-home");
    expect(catalog.options.map((o) => o.id)).not.toContain("ignored");
  });

  it("ignores default keys outside the [models] table", () => {
    const home = scratchConfig(`
[cli]
default = "grok-4.5"

[model.ok-model]
name = "OK"
`);
    expect(readGrokModelCatalog({ HOME: home }).default).toBe("grok-4.6");
  });
});

describe("GrokAgentDriver catalog", () => {
  it("loads the config catalog when the instance is created", async () => {
    const home = scratchConfig(`[model.local-glm]\nname = "GLM local"\n`);
    const instance = await GrokAgentDriver.create({
      instanceId: "grok-catalog",
      displayName: "Grok",
      environment: { HOME: home },
      enabled: true,
      config: GrokAgentDriver.defaultConfig(),
    });
    try {
      expect(instance.models.options.some((o) => o.id === "local-glm" && o.label === "GLM local")).toBe(true);
      expect(instance.refreshModels).toEqual(expect.any(Function));
    } finally {
      await instance.dispose();
    }
  });
});

describe("Grok allow rule for Wink's own tools", () => {
  const RULE = `allow = ["MCPTool(agents__*)"]`;
  const startTurn = (home: string, fullAuto = false) =>
    grokSupport.resolveTurnModel?.("grok-4.6", { HOME: home }, { cli: "grok", fullAuto });
  const configPath = (home: string) => join(home, ".grok", "config.toml");
  const read = (home: string) => readFileSync(configPath(home), "utf8");
  const emptyHome = () => {
    const home = mkdtempSync(join(tmpdir(), "omb-grok-allow-"));
    scratchDirs.push(home);
    mkdirSync(join(home, ".grok"));
    return home;
  };
  const unchanged = (home: string, run: () => void) => {
    const old = new Date("2020-01-01T00:00:00Z");
    utimesSync(configPath(home), old, old);
    const before = readFileSync(configPath(home));
    run();
    expect(readFileSync(configPath(home)).equals(before)).toBe(true);
    expect(statSync(configPath(home)).mtimeMs).toBe(old.getTime());
  };

  it("writes the rule when there is no config yet", () => {
    const home = emptyHome();
    startTurn(home);
    expect(read(home)).toBe(`[permission]\n${RULE}\n`);
  });

  it("adds a [permission] table after the user's other tables", () => {
    const user = `# mine\nauto_update = false\n\n[models]\ndefault = "grok-4.7"\n\n[[marketplace.sources]]\nname = "xAI Official"\n`;
    const home = scratchConfig(user);
    startTurn(home);
    expect(read(home)).toBe(`${user}\n[permission]\n${RULE}\n`);
  });

  it("adds one entry to an existing allow array and keeps every other rule in order", () => {
    const user = `[ui]\ntheme = "x"\n\n[permission]\ndeny = ["Bash(rm -rf *)"]\nallow = [\n  "Bash(git *)", # git ok\n  "MCPTool(github__*)"\n]\nask = ["Edit"]\n\n[cli]\nshow_tips = true\n`;
    const home = scratchConfig(user);
    startTurn(home);
    expect(read(home)).toBe(user.replace(`"MCPTool(github__*)"\n]`, `"MCPTool(github__*)",\n  "MCPTool(agents__*)"\n]`));
  });

  it("adds the allow key under a [permission] table that has none", () => {
    const home = scratchConfig(`[permission]\ndeny = ["Bash(rm -rf *)"]\n`);
    startTurn(home);
    expect(read(home)).toBe(`[permission]\n${RULE}\ndeny = ["Bash(rm -rf *)"]\n`);
  });

  it("does not rewrite a file that already holds the rule", () => {
    const home = scratchConfig(`[permission]\nallow = ["Bash(git *)", "MCPTool(agents__*)"]\n`);
    unchanged(home, () => startTurn(home));
  });

  it("keeps a CRLF file CRLF", () => {
    const home = scratchConfig(`[ui]\r\ntheme = "x"\r\n\r\n[permission]\r\nallow = [\r\n  "Read",\r\n]\r\n`);
    startTurn(home);
    expect(read(home)).toBe(`[ui]\r\ntheme = "x"\r\n\r\n[permission]\r\nallow = [\r\n  "Read",\r\n  "MCPTool(agents__*)",\r\n]\r\n`);
  });

  it("fills an empty allow array", () => {
    const home = scratchConfig(`[permission]\nallow = []\n`);
    startTurn(home);
    expect(read(home)).toBe(`[permission]\n${RULE}\n`);
  });

  it("keeps a removed rule removed after a restart", async () => {
    const home = scratchConfig(`[ui]\ntheme = "x"\n`);
    startTurn(home);
    expect(read(home)).toContain(RULE);
    const user = `[ui]\ntheme = "changed"\n`;
    writeFileSync(configPath(home), user);
    startTurn(home);
    expect(read(home)).toBe(user);
    vi.resetModules();
    const restarted = await import("./grok.ts");
    restarted.grokSupport.resolveTurnModel?.("grok-4.6", { HOME: home }, { cli: "grok", fullAuto: false });
    expect(read(home)).toBe(user);
  });

  it.skipIf(process.platform !== "win32")("tries a read-only config once per file state", async () => {
    const home = scratchConfig(`[ui]\ntheme = "x"\n`);
    chmodSync(configPath(home), 0o444);
    const waits = vi.spyOn(Atomics, "wait");
    try {
      const first = performance.now();
      startTurn(home);
      const firstMs = performance.now() - first;
      expect(waits).toHaveBeenCalledTimes(5);
      waits.mockClear();
      const later = performance.now();
      startTurn(home);
      startTurn(home);
      const laterMs = (performance.now() - later) / 2;
      expect(waits).not.toHaveBeenCalled();
      console.info(`read-only config ms first/later: ${firstMs.toFixed(3)}/${laterMs.toFixed(3)}`);
      vi.resetModules();
      const restarted = await import("./grok.ts");
      restarted.grokSupport.resolveTurnModel?.("grok-4.6", { HOME: home }, { cli: "grok", fullAuto: false });
      expect(waits).not.toHaveBeenCalled();
    } finally {
      chmodSync(configPath(home), 0o600);
    }
    writeFileSync(configPath(home), `[ui]\ntheme = "changed"\n`);
    startTurn(home);
    expect(read(home)).toContain(RULE);
  });

  it("keeps separate config paths independent", () => {
    const first = emptyHome();
    const second = emptyHome();
    startTurn(first);
    rmSync(configPath(first));
    startTurn(first);
    expect(() => statSync(configPath(first))).toThrow();
    startTurn(second);
    expect(read(second)).toContain(RULE);
  });

  it("leaves non-UTF-8 bytes alone", () => {
    const home = emptyHome();
    const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x00]);
    writeFileSync(configPath(home), bytes);
    startTurn(home);
    expect(readFileSync(configPath(home))).toEqual(bytes);
  });

  it.each([`[ui\ntheme = "x"\n`, `[permission]\n"all\\u006fw" = ["Read"]\n`])("leaves a file it cannot read safely alone: %s", (user) => {
    const home = scratchConfig(user);
    unchanged(home, () => expect(startTurn(home)).toBe("grok-4.6"));
  });

  it("leaves a symlinked config alone", (ctx) => {
    const target = scratchConfig(`[ui]\ntheme = "x"\n`);
    const home = emptyHome();
    try {
      symlinkSync(configPath(target), configPath(home), "file");
    } catch {
      return ctx.skip();
    }
    startTurn(home);
    expect(lstatSync(configPath(home)).isSymbolicLink()).toBe(true);
    expect(read(target)).toBe(`[ui]\ntheme = "x"\n`);
  });

  it.each([
    `[permission]\ndeny = ["MCPTool(agents__*)"]\n`,
    `[permission]\nask = ["mcp__agents"]\n`,
    `[permission]\nrules = [{ action = "deny", tool = "mcp", pattern = "agents__task_ask" }]\n`,
    `[permission]\ndeny = ["MCPTool( agents__* )"]\n`,
    `[permission]\nask = ["MCPTool( agents__* )"]\n`,
  ])("lets a user rule that denies or asks for Wink's tools win: %s", (user) => {
    const home = scratchConfig(user);
    unchanged(home, () => startTurn(home));
  });

  it.each([
    `[permission]\ndeny = ["mcptool(agents__*)"]\n`,
    `[permission]\ndeny = ["MCPTool({agents,x}__*)"]\n`,
    `[permission]\ndeny = ["use_tool"]\n`,
    `[permissions]\ndeny = ["MCPTool(agents__*)"]\n`,
  ])("keeps spellings ignored by Grok from blocking the allow: %s", (user) => {
    const home = scratchConfig(user);
    startTurn(home);
    expect(read(home)).toContain(user.split("\n")[1]);
    expect(read(home)).toContain(RULE);
  });

  it("leaves full auto bots alone", () => {
    const home = emptyHome();
    startTurn(home, true);
    expect(() => statSync(configPath(home))).toThrow();
    const configured = scratchConfig(`[ui]\ntheme = "x"\n`);
    unchanged(configured, () => startTurn(configured, true));
  });

  it("writes the config a real signed-in Grok honored, and Grok's own rewrite keeps it", () => {
    const { withoutRule, withRule } = JSON.parse(readFileSync("test/fixtures/recorded/grok/agents-allow-rule.json", "utf8")).reply;
    expect(withoutRule.clientPermissionRequests).toEqual(["agents__ping"]);
    expect(withRule.clientPermissionRequests).toEqual([]);
    const useTool = withRule.events.find((e: { type: string; tool_name: string }) => e.type === "permission_resolved" && e.tool_name === "use_tool");
    expect(useTool.wait_ms).toBeLessThan(100);

    const home = scratchConfig(withoutRule.configAtStart);
    startTurn(home);
    expect(read(home)).toBe(withRule.configAtStart);
    const rewritten = scratchConfig(withRule.configAfterGrok);
    unchanged(rewritten, () => startTurn(rewritten));
  });

  it("honors GROK_HOME", () => {
    const home = emptyHome();
    const grokHome = join(home, "elsewhere");
    mkdirSync(grokHome);
    grokSupport.resolveTurnModel?.("grok-4.6", { HOME: home, GROK_HOME: grokHome }, { cli: "grok", fullAuto: false });
    expect(readFileSync(join(grokHome, "config.toml"), "utf8")).toBe(`[permission]\n${RULE}\n`);
    expect(() => statSync(configPath(home))).toThrow();
  });
});
