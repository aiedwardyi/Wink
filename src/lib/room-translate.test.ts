import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const modulePath = "./room-translate";
const translate = existsSync(join(import.meta.dirname, "room-translate.ts")) ? await import(modulePath) : null;

afterEach(() => vi.unstubAllGlobals());

describe("room translation", () => {
  it.each([
    ["출시 준비 끝났어요.", "en", false],
    ["출시 준비 끝났어요.", "ko", true],
    ["Launch is ready", "en", true],
    ["Launch is ready", "ko", false],
    ["PR #1304 머지했어요", "en", false],
    ["PR #1304 머지했어요", "ko", true],
    ["abc 가나다", "ko", true],
    ["abcd 가나다", "ko", false],
    ["123 👍", "ko", true],
  ])("checks %s for %s", (text, lang, expected) => {
    expect(translate?.alreadyInLanguage(text, lang)).toBe(expected);
  });

  it("sends only the language to the local line route", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ text: "Ready" })));
    vi.stubGlobal("fetch", fetch);
    expect(await translate?.translateLine("/api/joined/rooms/r1", "e1", "en")).toEqual({ text: "Ready" });
    expect(fetch).toHaveBeenCalledWith("/api/joined/rooms/r1/entries/e1/translate", expect.objectContaining({ method: "POST", body: '{"lang":"en"}' }));
  });
});
