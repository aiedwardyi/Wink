import { describe, expect, it } from "vitest";

import { UserTagScanner, unwrapUserTags } from "./user-tags.ts";

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

  it("keeps indented, quoted and multiline code literal", () => {
    const same = (text: string) => expect(unwrapUserTags(text)).toBe(text);
    same("Steps:\n\n    <user1>x</user1>\n    <user2>y</user2>");
    same("> ```xml\n> <user1>x</user1>\n> ```");
    same("see `a\n<user1>b</user1>\nc` then");
    same("~~~xml\n~~~not-a-close\n<user1>x</user1>\n~~~");
    same("A literal \\` then `<user1>x</user1>`.");
    same("- ~~~xml\n  <user1>x</user1>\n  ~~~");
    same("~~~text\n> ~~~\n<user1>x</user1>\n~~~");
    same("~~~text\n    ~~~\n<user1>x</user1>\n~~~");
    same("1. a\n   ```\n   <user1>x</user1>\n   ```");
    expect(unwrapUserTags("- ~~~xml\n  x\n\n<user1>Actual</user1>")).toBe("- ~~~xml\n  x\n\nActual");
    expect(unwrapUserTags("```x``` <user1>y</user1>")).toBe("```x``` y");
    expect(unwrapUserTags("> ~~~xml\n> example\n\n<user1>Actual</user1>")).toBe("> ~~~xml\n> example\n\nActual");
    expect(unwrapUserTags("a \\` <user1>b</user1>")).toBe("a \\` b");
    expect(unwrapUserTags("see `a\nb` <user1>d</user1>\n\n<user2>e</user2>")).toBe("see `a\nb` d\n\ne");
    expect(unwrapUserTags("a\n    <user1>b</user1>")).toBe("a\n    b");
  });

  it("unwraps only the outer pair around a fenced reply", () => {
    expect(unwrapUserTags("<user1>~~~xml\n<user2>x</user2>\n~~~</user1>")).toBe("~~~xml\n<user2>x</user2>\n~~~");
  });

  it("keeps a tag-wrapped marker inside a fence as code", () => {
    const text = "~~~xml\n<user1>~~~</user1>\n<user2>x</user2>\n~~~";
    expect(unwrapUserTags(text)).toBe(text);
  });

  it("reads carriage returns as line endings, even a CRLF split across chunks", () => {
    const text = "Intro\r~~~xml\r<user1>x</user1>\r~~~";
    expect(unwrapUserTags(text)).toBe(text);
    const scanner = new UserTagScanner();
    const split = ["See `a\r", "\n<user1>b</user1>\r\nc` then <user2>d</user2>"];
    expect(split.map((piece) => scanner.push(piece)).join("") + scanner.finish()).toBe("See `a\r\n<user1>b</user1>\r\nc` then d");
  });

  it("does not open a fence from indented code", () => {
    const text = "    ~~~\n\n~~~\n<user1>x</user1>\n~~~";
    expect(unwrapUserTags(text)).toBe(text);
  });

  it("does not let a fence indented four spaces close a block", () => {
    const text = "   ~~~\n    ~~~\n<user1>x</user1>\n~~~";
    expect(unwrapUserTags(text)).toBe(text);
  });

  it("keeps indented code literal right after a fence, heading or rule", () => {
    for (const lead of ["~~~text\nx\n~~~", "# Title", "---"]) {
      const text = lead + "\n    <user1>y</user1>";
      expect(unwrapUserTags(text)).toBe(text);
    }
  });

  it("strips only the closer that matches the opening wrapper", () => {
    const text = "<user1>~~~\n~~~<user2>\n<user3>x</user3>\n~~~</user1>";
    expect(unwrapUserTags(text)).toBe("~~~\n~~~<user2>\n<user3>x</user3>\n~~~");
  });

  it("lets a fence inside a list item close with up to three extra spaces", () => {
    expect(unwrapUserTags("- item\n\n  ~~~\n    ~~~\n  <user1>x</user1>")).toBe("- item\n\n  ~~~\n    ~~~\n  x");
  });

  it("recognizes a tab-indented fence inside a list item", () => {
    const text = "- item\n\n\t~~~xml\n\t<user1>x</user1>\n\t~~~";
    expect(unwrapUserTags(text)).toBe(text);
    expect(unwrapUserTags(text + "\n<user2>y</user2>")).toBe(text + "\ny");
    const mixed = "- item\n\n \t ~~~xml\n  <user1>x</user1>\n  ~~~";
    expect(unwrapUserTags(mixed)).toBe(mixed);
  });

  it("reads a spaced rule as a rule, not a list item", () => {
    const text = "* * *\n    <user1>x</user1>";
    expect(unwrapUserTags(text)).toBe(text);
  });

  it("matches the unsplit result when a rule or CRLF is split across chunks", () => {
    const stream = (chunks: string[]) => {
      const scanner = new UserTagScanner();
      return chunks.map((piece) => scanner.push(piece)).join("") + scanner.finish();
    };
    expect(stream(["_", "__\n    <user1>x</user1>"])).toBe("___\n    <user1>x</user1>");
    expect(stream(["a\r", "", "\n    <user1>x</user1>"])).toBe(unwrapUserTags("a\r\n    <user1>x</user1>"));
  });

  it("keeps indented code inside a list item literal", () => {
    const text = "-     <user1>x</user1>";
    expect(unwrapUserTags(text)).toBe(text);
    const nested = "- item\n\n      <user1>y</user1>";
    expect(unwrapUserTags(nested)).toBe(nested);
  });
});
