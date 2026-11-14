import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GrokAgentDriver, grokSupport, readGrokModelCatalog, STATIC_GROK_MODELS } from "./grok.ts";

const scratchDirs: string[] = [];

afterEach(() => {
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

  it("leaves a file it cannot read safely alone", () => {
    const home = scratchConfig(`[ui\ntheme = "x"\n`);
    unchanged(home, () => expect(startTurn(home)).toBe("grok-4.6"));
  });

  it.each([
    `[permission]\ndeny = ["MCPTool(agents__*)"]\n`,
    `[permission]\nask = ["mcp__agents"]\n`,
    `[permission]\nrules = [{ action = "deny", tool = "mcp", pattern = "agents__task_ask" }]\n`,
  ])("lets a user rule that denies or asks for Wink's tools win: %s", (user) => {
    const home = scratchConfig(user);
    unchanged(home, () => startTurn(home));
  });

  it("leaves full auto bots alone", () => {
    const home = emptyHome();
    startTurn(home, true);
    expect(() => statSync(configPath(home))).toThrow();
    const configured = scratchConfig(`[ui]\ntheme = "x"\n`);
    unchanged(configured, () => startTurn(configured, true));
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
