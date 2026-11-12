import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { nextBulletin } from "./room-bulletin";

const here = dirname(fileURLToPath(import.meta.url));
const groupView = readFileSync(join(here, "../components/GroupView.tsx"), "utf8");
const roomDetails = readFileSync(join(here, "../components/RoomDetailsPanel.tsx"), "utf8");

describe("nextBulletin", () => {
  it("skips an unchanged draft", () => {
    expect(nextBulletin("ship it", "ship it")).toBeNull();
    expect(nextBulletin("", "")).toBeNull();
  });

  it("commits an emptied draft", () => {
    expect(nextBulletin("ship it", "")).toBe("");
  });

  it("commits an edited draft verbatim", () => {
    expect(nextBulletin("ship it", "  ship it later\n")).toBe("  ship it later\n");
  });
});

describe("channel bulletin editor", () => {
  it("lives in Room details and shows Bot details' Saved cue", () => {
    expect(groupView).not.toContain("saveBulletin");
    expect(roomDetails).toContain("<SaveStatus id={group.id} />");
  });

  it("opens from a bot-to-bot channel's name too", () => {
    expect(groupView).not.toContain('group.dm ? <span');
  });
});
