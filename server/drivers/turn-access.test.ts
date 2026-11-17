import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { antigravityAccess, buildAntigravityTurnArgv } from "./antigravity.ts";
import { claudeAccess } from "./claude.ts";
import { grokSupport } from "./acp/grok.ts";
import { accessRules, FREE_ACCESS, routedAccess } from "./turn-access.ts";

const agents = { command: "node", args: [], env: {} };

describe("turn access", () => {
  it("a read-only turn can approve nothing, whatever the chip", () => {
    expect(routedAccess({ approval: "auto", readOnly: true })).toEqual({ edits: "off", commands: "off" });
    expect(claudeAccess({ permissionMode: "bypassPermissions" }, { approval: "auto", readOnly: true })).toEqual({ edits: "off", commands: "off" });
  });

  it("claude Auto edits freely and sends commands to Wink", () => {
    expect(claudeAccess({ permissionMode: "acceptEdits" }, { approval: "auto" })).toEqual({ edits: "free", commands: "auto" });
    expect(claudeAccess({ permissionMode: "acceptEdits" }, { approval: "ask" })).toEqual({ edits: "ask", commands: "ask" });
    expect(claudeAccess({ permissionMode: "bypassPermissions" }, { approval: "ask" })).toEqual(FREE_ACCESS);
  });

  it("claude cannot do what its configured tool set leaves out", () => {
    expect(claudeAccess({ permissionMode: "acceptEdits", tools: [] }, { approval: "auto" })).toEqual({ edits: "off", commands: "off" });
    expect(claudeAccess({ permissionMode: "bypassPermissions", tools: ["Read", "WebFetch"] }, { approval: "auto" })).toEqual({ edits: "off", commands: "off" });
    expect(claudeAccess({ permissionMode: "acceptEdits", disallowedTools: ["Bash", "PowerShell"] }, { approval: "auto" })).toEqual({ edits: "free", commands: "off" });
  });

  it("grok and claude Auto follow the user's own config when Wink sets no mode", () => {
    expect(grokSupport.grants!({ cli: "grok", fullAuto: false }, { approval: "auto" })).toEqual({ edits: "own", commands: "own" });
    expect(grokSupport.grants!({ cli: "grok", fullAuto: false }, { approval: "ask" })).toEqual({ edits: "ask", commands: "ask" });
    expect(grokSupport.grants!({ cli: "grok", fullAuto: true }, { approval: "ask" })).toEqual(FREE_ACCESS);
    expect(claudeAccess({ permissionMode: "acceptEdits" }, { approval: "auto" }, true)).toEqual({ edits: "own", commands: "own" });
  });

  it("codex Auto without a Wink override defers to the user's own settings", () => {
    expect(accessRules({ edits: "own", commands: "own" }, undefined)).toContain("You can read files; you can edit files and run commands as your own sandbox and approval settings allow.");
  });

  it("gemini reads its grants off its own argv", () => {
    expect(antigravityAccess(buildAntigravityTurnArgv({ fullAuto: true, cwd: "" }))).toEqual(FREE_ACCESS);
    expect(antigravityAccess(buildAntigravityTurnArgv({ fullAuto: false, cwd: "" }))).toEqual({ edits: "free", commands: "off" });
  });

  it("runs a read-only turn in each engine's own read-only mode, never a full-permission one", () => {
    const agy = buildAntigravityTurnArgv({ fullAuto: true, cwd: "", readOnly: true });
    expect(agy).toEqual(expect.arrayContaining(["--mode", "plan"]));
    expect(agy).not.toContain("--dangerously-skip-permissions");
    expect(antigravityAccess(agy)).toEqual({ edits: "off", commands: "off" });
    const grok = grokSupport.spawnArgs({ cli: "grok", fullAuto: true }, { threadId: "", text: "", approval: "auto", readOnly: true });
    expect(grok.slice(0, 2)).toEqual(["--permission-mode", "plan"]);
    expect(grokSupport.grants!({ cli: "grok", fullAuto: true }, { approval: "auto", readOnly: true })).toEqual({ edits: "off", commands: "off" });
  });

  it("says each grant in plain words and names only the Wink tools mounted", () => {
    const text = accessRules({ edits: "free", commands: "off" }, { agents, terminal: agents });
    expect(text).toContain("You can read files. You can edit files without asking; you cannot run commands.");
    expect(text).not.toContain("curl");
    expect(text).toContain("(built-in plus Wink tools for: other bots and tasks; terminals).");
    expect(accessRules(routedAccess({ approval: "ask", readOnly: true }), undefined)).toContain("Read-only turn: no file edits or commands.");
    expect(accessRules(FREE_ACCESS, undefined)).toContain("You can read files; you can edit files and run commands without asking. Commands can also fetch web pages (curl). Your tools are exactly your tool list (built-in).");
    for (const word of ["worker", "pane", "card"]) expect(accessRules(routedAccess({ approval: "ask" }), { agents, terminal: agents, computer: { boxId: "", token: "" } })).not.toMatch(new RegExp(`\\b${word}`, "i"));
  });

  it("every driver that starts turns says what they may do", () => {
    const server = join(dirname(fileURLToPath(import.meta.url)), "..");
    const sources = ["drivers", "testing"].flatMap((dir) => (readdirSync(join(server, dir), { recursive: true }) as string[]).map((file) => join(server, dir, file)))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    const starters = sources.filter((file) => /^\s+sendTurn[,:]/m.test(readFileSync(file, "utf8"))).map((file) => relative(server, file).replaceAll("\\", "/"));
    expect(starters.length).toBeGreaterThan(5);
    // the box agent's own box never asks, so accessRules' FREE_ACCESS default is its grant
    const missing = starters.filter((file) => file !== "drivers/boxagent.ts" && !/^\s+access[:(]/m.test(readFileSync(join(server, file), "utf8")));
    expect(missing, "add access(turn) to the adapter, read off the values its sendTurn launches with").toEqual([]);
  });

  it("every engine runs a read-only turn, so a teammate without Can make bots work still gets an answer", () => {
    const drivers = dirname(fileURLToPath(import.meta.url));
    // SAFETY: readdirSync without withFileTypes lists names as strings
    const starters = (readdirSync(drivers, { recursive: true }) as string[])
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && /^\s+sendTurn[,:]/m.test(readFileSync(join(drivers, file), "utf8")))
      .map((file) => file.replaceAll("\\", "/"));
    expect(starters.length).toBeGreaterThan(4);
    // the box agent is a full agent on the bot's cloud computer with no read-only mode: it keeps the can't-work line
    const missing = starters.filter((file) => file !== "boxagent.ts" && !/^\s+readOnlyTurns: true,/m.test(readFileSync(join(drivers, file), "utf8")));
    expect(missing, "set capabilities.readOnlyTurns: true and make sendTurn honour turn.readOnly with the engine's own read-only mode (sandbox, plan mode, or tools off), never a full-permission turn").toEqual([]);
  });
});
