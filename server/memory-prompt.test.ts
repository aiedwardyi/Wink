import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { memoryNotesEnabled } from "./config.ts";
import { ensureWorkspace, loadMemory, memorySystemPrompt, MEMORY_SEED, workspaceDir } from "./workspace.ts";
import { removeTestData } from "./testing/test-home.ts";

const baseline = JSON.parse(readFileSync(new URL("../test/fixtures/memory-prompt-on.json", import.meta.url), "utf8")) as {
  cases: Array<{ kind: string; hashes: string[] }>;
};
const botId = "memory-prompt-test";
const fact = "# Memory\n- Owner: Mina.\n- Budget: 740 dollars.\n- Crate: BLUE-19.\n";
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

function seed(kind: string) {
  const dir = ensureWorkspace(botId);
  const text = kind === "seed" ? MEMORY_SEED : ["near", "truncated"].includes(kind)
    ? Array.from({ length: kind === "near" ? 165 : 220 }, (_, i) => `- Fact ${i}: value ${i}.\n`).join("")
    : ["missing", "parked-only"].includes(kind) ? null : fact;
  if (text !== null) writeFileSync(join(dir, "MEMORY.md"), text);
  if (["conflict", "parked-only"].includes(kind)) writeFileSync(join(dir, "memory/MEMORY.conflict-e059d14f.md"), "# Memory\n- Other PC fact.\n");
  return dir;
}

beforeEach(() => removeTestData(workspaceDir(botId)));

describe("memory notes prompt", () => {
  it.each(baseline.cases)("keeps memory ON byte-identical to the base for $kind", ({ kind, hashes }) => {
    const dir = seed(kind);
    for (const [index, lane] of [false, true].entries()) {
      const prompt = memorySystemPrompt(botId, lane, true);
      expect(prompt).toBe(memorySystemPrompt(botId, lane));
      const normalized = prompt.replaceAll(dir.replaceAll("\\", "\\\\"), "<workspace>").replaceAll(dir, "<workspace>").replaceAll("<workspace>\\\\", "<workspace>/");
      expect(createHash("sha256").update(normalized).digest("hex")).toBe(hashes[index]);
    }
  });

  it.each(baseline.cases)("keeps existing facts without write guidance when OFF for $kind", ({ kind }) => {
    const dir = seed(kind);
    const memory = loadMemory(botId);
    for (const lane of [false, true]) {
      const prompt = memorySystemPrompt(botId, lane, false);
      if (memory) expect(prompt).toContain(memory.text);
      for (const write of ["create it with your file tools", "save the lesson", "update it with your file tools", "Trim it", "Copy back", "delete the copy", "leave memory edits"]) expect(prompt).not.toContain(write);
      expect(prompt).toContain("Never save passwords, keys, tokens or account numbers in memory");
      expect(prompt).toContain("verified with the user or through your own work");
      expect(prompt).toContain("never action approval");
      expect(prompt).toContain(JSON.stringify(join(dir, "MEMORY.md")));
      expect(prompt).toContain(JSON.stringify(join(dir, "memory")));
      if (!lane && (memory || kind === "parked-only")) {
        expect(prompt).toContain("A side file is read only when a line here says when to read it.");
        expect(prompt).toContain("Do not send them to settings to edit it.");
      }
      if (["missing", "seed"].includes(kind)) expect(prompt).not.toContain("Your memory (MEMORY.md):");
      if (lane) {
        expect(prompt).toContain("do not edit memory files or files your 1:1 is editing");
        expect(prompt).not.toContain("MEMORY.conflict-e059d14f.md");
      }
      if (memory?.truncated) expect(prompt).toContain("[MEMORY.md was cut off here.]");
    }
  });

  it.each([
    [{}, {}, true],
    [{ features: { memoryNotes: false } }, {}, false],
    [{ features: { memoryNotes: false } }, { memoryNotes: true }, true],
    [{ features: { memoryNotes: true } }, { memoryNotes: false }, false],
  ] as const)("uses the effective bot setting in solo and room dispatch: %j %j", (cfg, setting, enabled) => {
    seed("populated");
    const solo = source.split("\n").find((line) => line.includes('tracePart("memory", privateWorkspace ?'))!.trim().replace(/\s*\+$/, "");
    const room = source.split("\n").find((line) => line.includes('(workspace ? `\\n${memorySystemPrompt('))!.trim().replace(/\s*\+$/, "");
    const context = { cfg, bot: { id: botId, ...setting }, privateWorkspace: true, workspace: true, lane: false, memoryNotesEnabled, memorySystemPrompt, tracePart: (_kind: string, text: string) => text };
    expect(runInNewContext(solo, context)).toBe(memorySystemPrompt(botId, false, enabled));
    expect(runInNewContext(room, context)).toBe(`\n${memorySystemPrompt(botId, false, enabled).trim()}`);
  });

  it("omits memory repair instructions while notes are OFF", () => {
    const line = source.split("\n").find((line) => line.includes("const memoryNotice = privateWorkspace"))!;
    const take = vi.fn(() => "Edit MEMORY.md to repair its pointer lines.");
    for (const enabled of [false, true]) {
      take.mockClear();
      const notice = runInNewContext(`${line}\nmemoryNotice`, { privateWorkspace: true, memoryHealthCheck: { take }, bot: { id: botId, memoryNotes: enabled }, cfg: {}, threadId: "t1", resume: false, memoryNotesEnabled });
      expect(notice).toBe(enabled ? "Edit MEMORY.md to repair its pointer lines." : "");
      expect(take).toHaveBeenCalledTimes(enabled ? 1 : 0);
    }
  });
});
