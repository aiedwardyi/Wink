import { describe, expect, it } from "vitest";
import { modelDialEnabled } from "../src/lib/feature-flags.ts";
import { loadConfig, parseConfigPatch, saveConfig } from "./config.ts";
import { effectiveModelDial } from "./model-dial-default.ts";

describe("model dial default", () => {
  it("is on for everyone with no setting", () => {
    expect(effectiveModelDial({})).toBe(true);
    expect(effectiveModelDial({ features: {} })).toBe(true);
    expect(modelDialEnabled({ features: { modelDial: effectiveModelDial({}) } })).toBe(true);
  });

  it("keeps an explicit off through later config saves and reloads", () => {
    saveConfig(parseConfigPatch({ features: { modelDial: false } }));
    saveConfig(parseConfigPatch({ features: { showToolCalls: true } }));
    expect(effectiveModelDial(loadConfig())).toBe(false);
    expect(modelDialEnabled({ features: { modelDial: effectiveModelDial(loadConfig()) } })).toBe(false);
  });

  it("keeps an explicit on", () => {
    expect(effectiveModelDial({ features: { modelDial: true } })).toBe(true);
  });
});
