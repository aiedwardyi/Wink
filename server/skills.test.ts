import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { skillsSystemPrompt } from "./skills.ts";
import { workspaceDir } from "./workspace.ts";

function seedSkills(botId: string, skills: Record<string, { description: string; enabled: boolean }>) {
  const dir = join(workspaceDir(botId), "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "skills.json"), JSON.stringify(skills));
}

describe("imported skills prompt", () => {
  it("leaves missing and disabled skills out of the prompt", () => {
    expect(skillsSystemPrompt("missing-skills")).toBe("");
    seedSkills("disabled-skills", { review: { description: "Review a change", enabled: false } });
    expect(skillsSystemPrompt("disabled-skills")).toBe("");
  });

  it("keeps existing enabled skills discoverable in name order", () => {
    seedSkills("enabled-skills", {
      review: { description: "Review a change", enabled: true },
      hidden: { description: "Disabled skill", enabled: false },
      build: { description: "Build a project", enabled: true },
    });
    const prompt = skillsSystemPrompt("enabled-skills");
    expect(prompt).toContain("- build: Build a project\n- review: Review a change");
    expect(prompt).not.toContain("Disabled skill");
    expect(prompt).toContain("read that skill's SKILL.md");
    expect(prompt).toContain("never override");
  });

  it("bounds the skill count and index bytes", () => {
    seedSkills("many-skills", Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`skill-${String(i).padStart(2, "0")}`, { description: "Do a task", enabled: true }]),
    ));
    expect(skillsSystemPrompt("many-skills").match(/^- skill-/gm)).toHaveLength(15);
    seedSkills("large-skills", {
      first: { description: "x".repeat(3_900), enabled: true },
      second: { description: "y".repeat(200), enabled: true },
    });
    expect(skillsSystemPrompt("large-skills")).toContain("- first:");
    expect(skillsSystemPrompt("large-skills")).not.toContain("- second:");
  });
});
