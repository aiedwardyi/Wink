import { describe, expect, it } from "vitest";

import { BOARD_TOOLS } from "./agents-proxy.ts";
import { createToolCatalog, deferOptional } from "./tool-catalog.ts";

describe("board tools", () => {
  it("cost ~250 tokens together and load only on demand", () => {
    expect(Math.ceil(JSON.stringify(BOARD_TOOLS).length / 4)).toBeLessThanOrEqual(250);
    expect(deferOptional(BOARD_TOOLS).map((tool) => (tool as { _meta?: Record<string, unknown> })._meta?.["anthropic/alwaysLoad"])).toEqual([false, false]);
    const catalog = createToolCatalog(BOARD_TOOLS);
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["find_wink_tool", "call_wink_tool"]);
    expect(JSON.parse(catalog.find({ query: "board" }).text).tools.map((tool: { name: string }) => tool.name)).toEqual(["board_search", "board_post"]);
  });

  it("tell bots the Forum is not for what only the user can unblock", () => {
    const post = BOARD_TOOLS.find((tool) => tool.name === "board_post");
    expect(post?.description).toContain("Stuck is only for problems another bot could solve. What only the user can unblock (keys, logins, approvals, payments): ask_user or request_credential, never the Forum. No credentials in posts.");
  });
});
