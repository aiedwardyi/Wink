import { expect, it } from "vitest";
import { check } from "./phone-menu.mjs";

it("requires two lost destinations and recognizes native, checkbox and CSS menus", () => {
  const desktop = { links: [{ href: "#speakers" }, { href: "#program" }, { href: "#faq" }] };
  expect(check({ links: [], menu: false }, desktop).problems).toHaveLength(1);
  for (const kind of ["button", "summary", "checkbox", "css"]) expect(check({ links: [], menu: kind }, desktop).problems).toEqual([]);
  expect(check({ links: desktop.links.slice(0, 2), menu: false }, desktop).problems).toEqual([]);
});

it("accepts a fixed bottom bar that links the hidden destinations, compared by destination", () => {
  const base = "http://127.0.0.1:1234/index.html";
  const desktop = { links: ["#speakers", "#program", "#faq"].map(href => ({ href, url: base + href })) };
  const bars = ["index.html#speakers", "./index.html#program"].map(href => ({ href, url: base + href.replace(/^.*#/, "#") }));
  expect(check({ links: [], bars, menu: false }, desktop).problems).toEqual([]);
  expect(check({ links: [], bars: bars.slice(0, 1), menu: false }, desktop).problems).toHaveLength(1);
});
