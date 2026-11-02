import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadUserSkills, mergeSkills, parseSkillManifest, renderSkillInstructions, skillInstructionsFor, type BundledSkill } from "./skill-library.ts";
import { workspaceDir } from "./workspace.ts";

const phone: BundledSkill = {
  directory: "/skills/phone-harness",
  instructions: "---\nname: phone-harness\ndescription: test\n---\nUse phone tools.",
  manifest: {
    id: "phone-harness",
    name: "Phone Harness",
    version: "0.1.0",
    description: "Control a phone",
    defaultEnabled: true,
    triggerTerms: ["android", "phone"],
    requiredCapabilities: ["phoneMcp"],
  },
};

describe("bundled skill library", () => {
  it("selects a skill only when both its trigger and capability are present", () => {
    const rendered = skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone]);
    expect(rendered).toContain("Use phone tools");
    expect(rendered).not.toContain('root="/skills/phone-harness"');
    expect(skillInstructionsFor("Open Uber on my Android", ["phoneMcp"], [phone], { includeRoot: true }))
      .toContain('root="/skills/phone-harness"');
    expect(skillInstructionsFor("Open Uber on my Android", [], [phone])).toBe("");
    expect(skillInstructionsFor("Write a poem", ["phoneMcp"], [phone])).toBe("");
  });

  it("requires the manifest id to match its isolated folder", () => {
    expect(() => parseSkillManifest({
      ...phone.manifest,
      id: "other-skill",
    }, "/skills/phone-harness")).toThrow(/invalid id/);
  });

  it("loads a recorded skill without letting a broken sibling disable it", () => {
    const root = mkdtempSync(join(tmpdir(), "openmausbot-skills-"));
    const valid = join(root, "file-expense");
    mkdirSync(valid);
    writeFileSync(join(valid, "manifest.json"), JSON.stringify({
      id: "file-expense", name: "File expense", version: "1.0.0", description: "File expenses",
      defaultEnabled: true, triggerTerms: ["expense"], requiredCapabilities: [],
    }));
    writeFileSync(join(valid, "SKILL.md"), "---\nname: file-expense\ndescription: File expenses\n---\nDo it safely.\n");
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "manifest.json"), "not json");
    writeFileSync(join(broken, "SKILL.md"), "broken");

    expect(loadUserSkills(root).map((skill) => skill.manifest.id)).toEqual(["file-expense"]);
  });

  it("does not let a user skill shadow a bundled skill id", () => {
    expect(mergeSkills([phone], [{ ...phone, instructions: "user replacement" }])).toEqual([phone]);
  });

  it("treats a non-directory user skill root as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "openmausbot-skills-root-"));
    const file = join(root, "not-a-directory");
    writeFileSync(file, "nope");
    expect(loadUserSkills(file)).toEqual([]);
  });
});

describe("imported workspace skills", () => {
  function seed(botId: string, skills: Record<string, { description: string; enabled: boolean }>) {
    const workspace = workspaceDir(botId);
    mkdirSync(join(workspace, "skills"), { recursive: true });
    writeFileSync(join(workspace, "skills", "skills.json"), JSON.stringify(skills));
    return workspace;
  }

  it("keeps old imports discoverable alongside bundled skills without loading their bodies", () => {
    const workspace = seed("imported", {
      review: { description: "Review a change", enabled: true },
      hidden: { description: "Disabled skill", enabled: false },
      build: { description: "Build a project", enabled: true },
    });
    mkdirSync(join(workspace, "skills", "review"));
    writeFileSync(join(workspace, "skills", "review", "SKILL.md"), "Private review instructions");

    const prompt = renderSkillInstructions([phone], { workspace, includeRoot: true });
    expect(prompt).toContain(`Imported skills (in ${JSON.stringify(join(workspace, "skills"))}):`);
    expect(prompt).toContain("- build: Build a project\n- review: Review a change");
    expect(prompt).toContain("read that skill's SKILL.md");
    expect(prompt).toContain("never override");
    expect(prompt).toContain("Use phone tools.");
    expect(prompt).not.toContain("Disabled skill");
    expect(prompt).not.toContain("Private review instructions");
  });

  it("keeps imports scoped to their bot even when no bundled skill matches", () => {
    const workspace = seed("owner", { review: { description: "Review a change", enabled: true } });
    expect(renderSkillInstructions([], { workspace })).toContain("- review: Review a change");
    expect(renderSkillInstructions([], { workspace: workspaceDir("other") })).toBe("");
    expect(renderSkillInstructions([])).toBe("");
  });

  it("leaves disabled, absent and malformed manifests out of the prompt", () => {
    const workspace = seed("disabled", { review: { description: "Review a change", enabled: false } });
    expect(renderSkillInstructions([], { workspace })).toBe("");
    for (const raw of ["not json", "[]", "null"]) {
      writeFileSync(join(workspace, "skills", "skills.json"), raw);
      expect(renderSkillInstructions([], { workspace })).toBe("");
    }
  });

  it("preserves the imported index count and byte budgets", () => {
    const workspace = seed("many", Object.fromEntries(Array.from({ length: 20 }, (_, i) => [
      `skill-${String(i).padStart(2, "0")}`, { description: "Do a task", enabled: true },
    ])));
    expect(renderSkillInstructions([], { workspace }).match(/^- skill-/gm)).toHaveLength(15);
    const large = seed("large", {
      first: { description: "x".repeat(3_900), enabled: true },
      second: { description: "y".repeat(200), enabled: true },
    });
    expect(renderSkillInstructions([], { workspace: large })).toContain("- first:");
    expect(renderSkillInstructions([], { workspace: large })).not.toContain("- second:");
  });
});
