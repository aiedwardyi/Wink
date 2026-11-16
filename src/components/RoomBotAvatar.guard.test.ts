// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { botAvatarAssetPath } from "../../shared/bot-avatar";

const here = dirname(fileURLToPath(import.meta.url));

const ROOM_VIEWS = [
  "Composer.tsx",
  "GroupView.tsx",
  "JoinedRoomView.tsx",
  "RoomDetailsBots.tsx",
  "RoomDetailsRows.tsx",
  "RoomTeamBots.tsx",
  "TeamRoomRow.tsx",
  "TeamRoomView.tsx",
];

describe("room bot faces", () => {
  it.each(ROOM_VIEWS)("%s draws a room bot only through RoomBotAvatar", (file) => {
    const source = readFileSync(join(here, file), "utf8");
    expect(source, "draw a room bot with RoomBotAvatar, not lucide's Bot icon").not.toMatch(/import \{[^}]*\bBot\b[^}]*\} from "lucide-react"/);
    const bare = [...source.matchAll(/<BotAvatar\b[\s\S]*?\/>/g)].map((tag) => tag[0]).filter((tag) => /bot=\{[^/]*\{\s*name\b/.test(tag));
    expect(bare, "a room record ({ name, color, mascotStyle }) goes through RoomBotAvatar").toEqual([]);
  });

  it("draws a teammate's pick, and one default for a record without one", async () => {
    const { RoomBotAvatar } = await import("./Avatar");
    const face = (bot: { name: string; color?: string; mascotStyle?: string }) => renderToStaticMarkup(createElement(RoomBotAvatar, { bot, size: 24 }));
    expect(face({ name: "포키", color: "", mascotStyle: "icon-11" })).toContain(botAvatarAssetPath("icon-11"));
    expect(face({ name: "포키", color: "" })).toBe(face({ name: "포키" }));
    expect(face({ name: "포키" })).toBe(face({ name: "포키", color: "white" }));
  });
});
