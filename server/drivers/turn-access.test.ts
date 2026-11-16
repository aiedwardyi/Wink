import { describe, expect, it } from "vitest";

import { antigravityAccess, buildAntigravityTurnArgv } from "./antigravity.ts";
import { claudeAccess } from "./claude.ts";
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

  it("codex Auto without a Wink override defers to the user's own settings", () => {
    expect(accessRules({ edits: "own", commands: "own" }, undefined)).toContain("You can read files; you can edit files and run commands as your own sandbox and approval settings allow.");
  });

  it("gemini reads its grants off its own argv", () => {
    expect(antigravityAccess(buildAntigravityTurnArgv({ fullAuto: true, cwd: "" }))).toEqual(FREE_ACCESS);
    expect(antigravityAccess(buildAntigravityTurnArgv({ fullAuto: false, cwd: "" }))).toEqual({ edits: "free", commands: "off" });
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
});
