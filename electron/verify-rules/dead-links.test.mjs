import { expect, it } from "vitest";
import { check } from "./dead-links.mjs";

it("finds missing fragments, local 404s and self sign-ups without blaming real destinations", () => {
  const link = { where: "a#apply", href: "#apply", registration: true, self: true, collects: false, action: false };
  const result = check({ links: [link, { ...link, where: "a#missing", href: "#absent", missing: true, self: false }, { ...link, where: "a#404", href: "/lost.html", self: false, status: 404 }, { ...link, where: "a#form", collects: true }, { ...link, where: "a#menu", action: true }, { ...link, where: "a#top", registration: false }] });
  expect(result.problems.map(x => x.where)).toEqual(["a#apply", "a#missing", "a#404"]);
});

it("treats # as the top of the page except on a sign-up", () => {
  const result = check({ links: [{ where: "footer a:nth-child(1)", href: "#", nowhere: true, registration: false }, { where: "footer a:nth-child(2)", href: "", nowhere: true, registration: false }, { where: "a#join", href: "#", nowhere: true, registration: true, action: false }] });
  expect(result.problems).toEqual([expect.objectContaining({ rule: "self sign-up", where: "a#join" })]);
  expect(result.details).toEqual([expect.objectContaining({ measured: "2 links go nowhere" })]);
});
