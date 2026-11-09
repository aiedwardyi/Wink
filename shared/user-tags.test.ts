import { describe, expect, it } from "vitest";

import { unwrapUserTags } from "./user-tags.ts";

describe("unwrapUserTags", () => {
  it("keeps the inner text and drops the tags", () => {
    expect(unwrapUserTags("<user1>Got it</user1>")).toBe("Got it");
    expect(unwrapUserTags("a <user12>b</user12> c</user3>")).toBe("a b c");
  });

  it("leaves other tags and plain text alone", () => {
    for (const text of ["<users>x</users>", "<user>x</user>", "<userx1>", "a < b", "plain"]) expect(unwrapUserTags(text)).toBe(text);
  });

  it("keeps fenced and inline code literal", () => {
    const fenced = "```xml\n<user1>x</user1>\n```\n<user2>y</user2>";
    expect(unwrapUserTags(fenced)).toBe("```xml\n<user1>x</user1>\n```\ny");
    expect(unwrapUserTags("~~~\n<user1>\n~~~")).toBe("~~~\n<user1>\n~~~");
    expect(unwrapUserTags("use `<user1>` or ``<user2>`` then <user3>z")).toBe("use `<user1>` or ``<user2>`` then z");
    expect(unwrapUserTags("```\n<user1>open")).toBe("```\n<user1>open");
    expect(unwrapUserTags("`<user1>open")).toBe("`<user1>open");
  });
});
