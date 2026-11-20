import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { harnessPlaybookPrompt } from "./harness-playbook.ts";
import { asksBlock, type TaskAsk } from "./task-asks.ts";
import { ensureWorkspace, memorySystemParts, memorySystemPrompt } from "./workspace.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("system prompt order", () => {
  it("places stable instructions and playbook before saved keys and memory in both dispatch paths", () => {
    const solo = source.slice(source.indexOf("        const system =\n", source.indexOf("const credentialPrompt")), source.indexOf("        // a rewound, Orbit-compacted"));
    const room = source.slice(source.indexOf("  const roomSystem ="), source.indexOf("  if (handoff) laneHandoffs.open"));
    for (const prompt of [solo, room]) {
      const order = ["memoryParts.guidance", "harnessPlaybookPrompt(", "savedKeysPrompt(", "memoryParts.content"].map((part) => prompt.indexOf(part));
      expect(order.every((index) => index >= 0) && order.every((index, i) => i === 0 || index > order[i - 1]), "Use stable instructions -> playbook -> saved keys -> memory and picks").toBe(true);
      for (const stable of ["accessRules(", "DEFAULT_RULES", ...(prompt === solo ? ["skillInstructions", "packagePlaybooks", "opts?.automationSource", "tagged.length"] : ["renderSkillInstructions(", "installedPlaybookInstructions(", "LANE_HANDOFF_LINE"])]) {
        expect(prompt.indexOf(stable), `Place ${stable} before the playbook, saved keys and memory`).toBeLessThan(prompt.indexOf("harnessPlaybookPrompt("));
      }
      expect(prompt.indexOf("aboutYouPrompt()"), "Place private facts after the playbook and saved keys").toBeGreaterThan(prompt.indexOf("savedKeysPrompt("));
    }
  });

  it.each(["Claude", "Codex", "no playbook", "room"])("preserves blocks and the stable prefix for %s", (kind) => {
    const botId = `prompt-order-${kind.replaceAll(" ", "-")}`;
    const dir = ensureWorkspace(botId);
    const lines = Array.from({ length: 120 }, (_, i) => `- fact ${i}: ${"x".repeat(175)}`);
    const file = join(dir, "MEMORY.md");
    writeFileSync(file, `${lines.join("\n")}\n\n`);
    const parts = memorySystemParts(botId);
    const playbook = harnessPlaybookPrompt(kind !== "no playbook");
    const keys = " Saved keys: Example. Use them without asking.";
    const stable = "PERSONA CREDENTIAL ROUTINE RULES";
    const legacyMemory = memorySystemPrompt(botId);
    const oldOrder = (prompt: string) => {
      const notice = prompt.match(/\n\n\[MEMORY\.md is about [^\n]+\]/)?.[0] ?? "";
      const without = prompt.replace(notice, "");
      const boundary = without.indexOf("\n\n");
      return notice ? without.slice(0, boundary) + notice + without.slice(boundary) : prompt;
    };
    const oldMemory = oldOrder(legacyMemory);
    const solo = source.slice(source.indexOf("        const system =\n", source.indexOf("const credentialPrompt")), source.indexOf("        // a rewound, Orbit-compacted"));
    const room = source.slice(source.indexOf("  const roomSystem ="), source.indexOf("  if (handoff) laneHandoffs.open"));
    const isRoom = kind === "room";
    const scope = {
      persona: "PERSONA", credentialPrompt: " CREDENTIAL", routinePrompt: " ROUTINE", DEFAULT_RULES: " RULES",
      projectFolderPrompt: () => "", projectNotesPrompt: () => "", cwd: "", privateWorkspace: true, notesPath: "", computerKind: "", integrations: {},
      coordinationPrompt: "", taskStatePrompt: "", reactPrompt: "", showImagePrompt: "", canMessage: true, teamReports: { prompt: () => "" },
      detailedRepliesEnabled: () => false, DETAILED_REPLY_INSTRUCTIONS: "", ALWAYS_REPLY_INSTRUCTIONS: "", accessRules: () => "", live: { adapter: {} },
      approval: "ask", readOnly: false, leanStartup: false, opts: {}, keepGoing: { rules: () => "" }, bot: { id: botId, playbooks: [] },
      memoryParts: parts, skillInstructions: "", packagePlaybooks: "", harnessPlaybookPrompt: () => playbook, tagged: [], cfg: {}, savedKeysPrompt: () => keys,
      roomTaskThreads: () => new Set(), threadId: "thread", aboutYouPrompt: () => "", tracePart: (_kind: string, text: string) => text,
      system: "PERSONA CREDENTIAL ROUTINE", workspace: true, selectedSkills: [], renderSkillInstructions: () => "", installedPlaybookInstructions: () => "", text: "", handoff: null,
      instance: { adapter: {} }, access: {}, memberTurnSelection: () => ({}), selection: {}, asked: true,
    };
    const build = (memoryParts: typeof parts, savedKeys = keys) => runInNewContext(`${isRoom ? room : solo}\n${isRoom ? "roomSystem" : "system"}`, { ...scope, memoryParts, savedKeysPrompt: () => savedKeys }) as string;
    const before = isRoom ? `${stable}${keys}\n${oldMemory.trim()}${playbook}` : `PERSONA CREDENTIAL${keys} ROUTINE RULES${oldMemory}${playbook}`;
    const after = build(parts);
    expect(after).toContain("\nSaved keys: Example.");
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    expect(parts.guidance + parts.content).toBe(legacyMemory);
    for (const line of lines) {
      expect(before.split(line).length).toBe(after.split(line).length);
    }
    const edited = lines.slice();
    edited[40] += " changed";
    writeFileSync(file, `${edited.join("\n")}\n\n`);
    const changed = memorySystemParts(botId);
    const next = build(changed);
    let prefix = 0;
    while (prefix < after.length && after[prefix] === next[prefix]) prefix++;
    expect(prefix).toBeGreaterThanOrEqual(after.indexOf(playbook) + playbook.length);
    const oldChangedMemory = oldOrder(memorySystemPrompt(botId));
    const oldChanged = isRoom ? `${stable}${keys}\n${oldChangedMemory.trim()}${playbook}` : `PERSONA CREDENTIAL${keys} ROUTINE RULES${oldChangedMemory}${playbook}`;
    let oldPrefix = 0;
    while (oldPrefix < before.length && before[oldPrefix] === oldChanged[oldPrefix]) oldPrefix++;
    process.stdout.write(`${kind}: bytes ${Buffer.byteLength(before)} -> ${Buffer.byteLength(after)}, memory prefix ${Buffer.byteLength(before.slice(0, oldPrefix))} -> ${Buffer.byteLength(after.slice(0, prefix))}\n`);
    const keyChanged = build(parts, `${keys} Another.`);
    let keyPrefix = 0;
    while (keyPrefix < after.length && after[keyPrefix] === keyChanged[keyPrefix]) keyPrefix++;
    expect(keyPrefix).toBeGreaterThanOrEqual(after.indexOf(playbook) + playbook.length);
  });

  it("keeps every ask in a large task record and handles a new bot without keys or memory", () => {
    const asks: TaskAsk[] = Array.from({ length: 115 }, (_, i) => ({ id: `A${i + 1}`, ask: `unique request ${i + 1}`, status: "open", at: 1, changedAt: 1 }));
    const block = asksBlock(asks, 1);
    for (const ask of asks) expect(block.split("\n").filter((line) => line.endsWith(`: ${ask.ask}`))).toHaveLength(1);
    const id = "prompt-order-new";
    ensureWorkspace(id);
    const parts = memorySystemParts(id);
    expect(parts.guidance + parts.content).toBe(memorySystemPrompt(id));
    expect(parts.content).toBe("");
  });
});
