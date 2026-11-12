import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { pinPreview } from "@/lib/pin-preview";

const here = dirname(fileURLToPath(import.meta.url));
const groupView = readFileSync(join(here, "GroupView.tsx"), "utf8");
const memberRoster = readFileSync(join(here, "GroupMemberRoster.tsx"), "utf8");

describe("who answers label", () => {
  it("opens Room details from the faces, with no dashed + in the header", () => {
    expect(groupView).toContain("onOpen={(section) => openRoomDetails(dispatch, section)}");
    expect(groupView).not.toContain("ManageMembersButton");
    expect(memberRoster).not.toContain("border-dashed");
  });

  it("keeps routing out of the header", () => {
    expect(groupView).not.toContain("DefaultResponderSelect");
    expect(groupView).not.toContain("data-who-answers");
    expect(groupView).toContain('aria-label={t("room.defaultResponder")}');
    expect(groupView).toContain('t("room.everyoneResponds")');
    expect(groupView).toContain('t("room.onlyWhenMentioned")');
  });

});

describe("room pin banner", () => {
  it("cleans a bot pin and keeps a user pin literal", () => {
    expect(pinPreview("bot", "**Done**")).toBe("Done");
    expect(pinPreview("user", "**Done**\n  now")).toBe("**Done** now");
  });

  it("uses the shared preview", () => {
    expect(groupView).toContain("pinPreview(");
  });
});
