import { expect, it } from "vitest";
import { check } from "./leftovers.mjs";

it("finds unfinished copy and reserved contact domains outside code examples", () => {
  const result = check({ texts: [{ where: "footer", text: "Contact forum@example.com" }, { where: "main", text: "Lorem ipsum TODO: fix undefined NaN" }, { where: "code", text: "undefined TODO:", example: true }, { where: "p", text: "Todos are tasks. banana undefinedValue NaNa" }] });
  expect(result.problems.map(x => x.rule)).toEqual(["placeholder contact", "lorem", "TODO", "undefined", "NaN"]);
});

it("reads link destinations and ignores a to-do title", () => {
  const result = check({ texts: [{ where: "a#register", text: "Sign up", href: "mailto:x@example.com?subject=hi" }, { where: "h1", text: "My TODO list" }, { where: "a#real", text: "Mail", href: "mailto:hello@getwink.dev" }, { where: "a#site", text: "Docs", href: "https://example.org.evil.dev/" }] });
  expect(result.problems).toEqual([expect.objectContaining({ rule: "placeholder contact", where: "a#register", measured: expect.stringContaining("mailto:x@example.com") })]);
  for (const href of ["https://www.example.net/about", "tel:+1@example.com", "http://example.com"]) expect(check({ texts: [{ where: "a", text: "", href }] }).problems).toHaveLength(1);
});
