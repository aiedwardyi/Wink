import { describe, expect, it } from "vitest";

import { memoryNotesEnabled, showToolCallsEnabled } from "./feature-flags";

describe("experimental feature flags", () => {

  it("hides tool-call chips by default", () => {
    expect(showToolCallsEnabled(null)).toBe(false);
    expect(showToolCallsEnabled({})).toBe(false);
    expect(showToolCallsEnabled({ features: { showToolCalls: false } })).toBe(false);
    expect(showToolCallsEnabled({ features: {} })).toBe(false);
  });

  it("shows tool-call chips only after explicit opt-in", () => {
    expect(showToolCallsEnabled({ features: { showToolCalls: true } })).toBe(true);
  });

  it("keeps auto notes on until switched off", () => {
    expect(memoryNotesEnabled(null)).toBe(true);
    expect(memoryNotesEnabled({ features: {} })).toBe(true);
    expect(memoryNotesEnabled({ features: { memoryNotes: true } })).toBe(true);
    expect(memoryNotesEnabled({ features: { memoryNotes: false } })).toBe(false);
  });

  it("lets a bot's own auto notes switch beat the global one", () => {
    expect(memoryNotesEnabled({ features: { memoryNotes: false } }, {})).toBe(false);
    expect(memoryNotesEnabled({ features: { memoryNotes: false } }, { memoryNotes: true })).toBe(true);
    expect(memoryNotesEnabled({ features: {} }, { memoryNotes: false })).toBe(false);
  });
});
