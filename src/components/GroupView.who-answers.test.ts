import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { translate, type Translate } from "@/lib/i18n";
import { pinPreview } from "@/lib/pin-preview";

const here = dirname(fileURLToPath(import.meta.url));
const groupView = readFileSync(join(here, "GroupView.tsx"), "utf8");
const memberRoster = readFileSync(join(here, "GroupMemberRoster.tsx"), "utf8");

const koT: Translate = (key, vars) => translate("ko", key, vars);

describe("who answers label", () => {
  it("names member management in Korean for one or several bots", () => {
    expect(koT("room.manageMembersCountOne")).toBe("구성원 관리 · 이 그룹에 봇 1개");
    expect(koT("room.manageMembersCount", { count: 2 })).toBe("구성원 관리 · 이 그룹에 봇 2개");
    expect(groupView).toContain("<ManageMembersButton ref={membersTriggerRef} count={members.length} />");
    expect(memberRoster).toContain('aria-label={count === 1 ? t("room.manageMembersCountOne") : t("room.manageMembersCount", { count })}');
  });

  it("keeps routing in Manage members and removes the header control", () => {
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
