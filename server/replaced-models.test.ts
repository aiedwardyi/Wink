import { describe, expect, it } from "vitest";

import { currentModel, earlierModels, REPLACED_MODELS, replacedModelLine, type ReplacedModel } from "../shared/replaced-models.ts";
import { workerCommand } from "./worker-launch.ts";

describe("replaced models", () => {
  it.each([
    ["gpt-6-sol", "gpt-6.2-sol"],
    ["gpt-6.1-sol", "gpt-6.2-sol"],
    ["gpt-6-astra", "gpt-6.2-astra"],
    ["gpt-5.6-terra", "gpt-6.1-terra"],
    ["gpt-6.2-sol", "gpt-6.2-sol"],
    ["gpt-6-luna", "gpt-6-luna"],
  ])("resolves %s to %s", (from, to) => {
    expect(currentModel("codex", from)).toBe(to);
  });

  it("keeps an id other engines use", () => {
    expect(currentModel("grokAgent", "gpt-6.1-sol")).toBe("gpt-6.1-sol");
  });

  it("names the old ids of a model, nearest first", () => {
    expect(earlierModels("codex", "gpt-6.2-sol")).toEqual(["gpt-6.1-sol", "gpt-6-sol"]);
  });

  it("says plainly what replaced what", () => {
    expect(replacedModelLine("codex", "gpt-6.1-sol")).toBe("GPT-6.1 Sol was replaced by GPT-6.2 Sol");
    expect(replacedModelLine("codex", "gpt-6-astra")).toBe("GPT-6 Astra was replaced by GPT-6.2 Astra");
    expect(replacedModelLine("codex", "gpt-6-sol")).toBe("GPT-6 Sol was replaced by GPT-6.2 Sol");
    expect(replacedModelLine("codex", "gpt-6.2-sol")).toBeNull();
  });

  it.each([
    ["codex --model gpt-6.1-sol -c model_reasoning_effort=high 'go'", ["--model", "gpt-6.2-sol"]],
    ["codex -m gpt-6-astra 'go'", ["-m", "gpt-6.2-astra"]],
    ["codex --model=gpt-6-sol 'go'", ["--model=gpt-6.2-sol"]],
  ])("starts a worker pane typed with an old id on the new one: %s", (command, expected) => {
    const launch = workerCommand(command);
    expect(launch.kind).toBe("managed");
    expect(launch.kind === "managed" && launch.args.join(" ")).toContain(expected.join(" "));
  });

  it("a new row also moves a launch, with no other code change", () => {
    const rows = REPLACED_MODELS as ReplacedModel[];
    rows.push({ engine: "codex", from: "old-x", to: "new-x" });
    try {
      const launch = workerCommand("codex --model old-x 'go'");
      expect(launch.kind === "managed" && launch.args).toEqual(["--model", "new-x", "go"]);
    } finally {
      rows.pop();
    }
  });
});
