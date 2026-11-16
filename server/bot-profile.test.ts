// The profile patch parser is the boundary that keeps paired clients from
// writing anything but identity fields. The strict half is the one that
// matters: a privileged bot field arriving here must be refused by NAME,
// so a future field cannot silently become remotely writable.
import { describe, expect, it } from "vitest";

import { parseBotProfilePatch } from "./bot-profile.ts";

describe("parseBotProfilePatch (strict — the paired boundary)", () => {
  it("refuses every privilege-bearing bot field by name", () => {
    for (const field of ["autoApprove", "autoReview", "alwaysAllow", "computer", "cwd", "lastProjectCwd", "composio", "chiefOfStaff", "acknowledgeLocalAuto"]) {
      const result = parseBotProfilePatch({ name: "Mira", [field]: true } as never, true);
      expect(result.ok, field).toBe(false);
      if (!result.ok) expect(result.error).toContain(field);
    }
  });

  it("refuses unknown cosmetic keys too — strict means the allowlist IS the contract", () => {
    expect(parseBotProfilePatch({ color: "red" } as never, true)).toEqual({
      ok: false,
      error: "unsupported profile field: color",
    });
    expect(parseBotProfilePatch({ mascotStyle: "peach" } as never, true)).toEqual({
      ok: false,
      error: "unsupported profile field: mascotStyle",
    });
  });

  it("accepts the full identity surface", () => {
    const result = parseBotProfilePatch(
      { name: "Mira", title: "Lead", description: "plans", notifications: true, voice: "vx", speakReplies: false },
      true,
    );
    expect(result).toEqual({
      ok: true,
      patch: { name: "Mira", title: "Lead", description: "plans", notifications: true, voice: "vx", speakReplies: false },
    });
  });
});

describe("parseBotProfilePatch (both modes)", () => {
  it("lenient mode drops unknown keys instead of failing — the desktop PATCH mixes fields", () => {
    const result = parseBotProfilePatch({ name: "Mira", color: "red" } as never, false);
    expect(result).toEqual({ ok: true, patch: { name: "Mira" } });
  });

  it("takes a bot's call picks and refuses ones the call cannot play", () => {
    const call = { voice: "Sulafat", speed: 0.8, style: "calm", language: "ko" } as const;
    expect(parseBotProfilePatch({ call }, true)).toEqual({ ok: true, patch: { call } });
    for (const bad of [{ voice: "Nova" }, { speed: 2 }, { style: "loud" }, { language: "fr" }, { volume: 0.5 }]) {
      expect(parseBotProfilePatch({ call: bad } as never).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("keeps instructions of any length", () => {
    const description = "Follow this rule. ".repeat(2_000);
    expect(parseBotProfilePatch({ description }, true)).toEqual({ ok: true, patch: { description } });
  });

  it("rejects a blank or oversized name", () => {
    expect(parseBotProfilePatch({ name: "   " }, true).ok).toBe(false);
    expect(parseBotProfilePatch({ name: "x".repeat(101) }, true).ok).toBe(false);
  });

  it("only stored-attachment avatar URLs pass; clears normalize to undefined", () => {
    for (const bad of ["https://example.com/a.png", "data:image/png;base64,AAAA", "/api/attachments/../config.json", "/api/attachments/a.svg"]) {
      expect(parseBotProfilePatch({ avatarUrl: bad } as never, true).ok, bad).toBe(false);
    }
    const cleared = parseBotProfilePatch({ avatarUrl: "" }, true);
    expect(cleared).toEqual({ ok: true, patch: { avatarUrl: undefined } });
    const nulled = parseBotProfilePatch({ avatarUrl: null }, true);
    expect(nulled).toEqual({ ok: true, patch: { avatarUrl: undefined } });
  });

  it("maps an avatarCrop issue to the readable message", () => {
    expect(parseBotProfilePatch({ avatarCrop: "hexagon" } as never, true)).toEqual({
      ok: false,
      error: "avatarCrop must be mascot, circle, rounded, or square",
    });
  });
});
