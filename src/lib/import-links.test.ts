import { describe, expect, it } from "vitest";

import { catalogs } from "./i18n-catalog";
import { IMPORT_OFFER, importOfferFence, importOfferId } from "./import-links";

const fence = (locale: "en" | "ko") => `\`\`\`text\n${catalogs[locale]["aboutYou.prompt"]}\n\`\`\``;
const offer = (locale: "en" | "ko") => `Hi!\n\n${IMPORT_OFFER[locale].join("\n")}\n\n${fence(locale)}`;

describe("importOfferFence", () => {
  it.each(["en", "ko"] as const)("finds the %s offer's own box, past a quote of the prompt", (locale) => {
    const text = `Your sample:\n\n${fence(locale)}\n\n${offer(locale)}\n\nAgain:\n\n${fence(locale)}`;
    expect(importOfferFence(text)).toBe(text.indexOf(fence(locale), text.indexOf(IMPORT_OFFER[locale][3])));
  });

  it("finds nothing without the offer right above the box, or with the other language's prompt", () => {
    expect(importOfferFence(fence("en"))).toBe(-1);
    expect(importOfferFence(`${IMPORT_OFFER.en.join("\n")}\n\nSee below.\n\n${fence("en")}`)).toBe(-1);
    expect(importOfferFence(`${IMPORT_OFFER.en.join("\n")}\n\n${fence("ko")}`)).toBe(-1);
    expect(importOfferFence(`${IMPORT_OFFER.ko.join("\n")}\n\n${catalogs.ko["aboutYou.prompt"]}`)).toBe(-1);
  });
});

describe("importOfferId", () => {
  type Row = Parameters<typeof importOfferId>[0][number];
  const user = (id: string, parentId: string | null, extra: Partial<Row> = {}): Row => ({ id, role: "user", kind: "text", text: "hi", parentId, ...extra });
  const bot = (id: string, parentId: string, text: string, importOffer?: true): Row => ({ id, role: "bot", kind: "text", text, parentId, ...(importOffer ? { importOffer } : {}) });

  it("is the stamped reply to the chat's first typed message", () => {
    expect(importOfferId([user("u1", null), bot("b1", "u1", "Sure."), bot("b2", "b1", offer("ko"), true)])).toBe("b2");
  });

  it("lets a steered or quick ask inside the first turn through", () => {
    expect(importOfferId([user("u1", null), user("s", "u1", { steered: true }), user("q", "s", { quick: { state: "asked" } }), bot("b1", "q", offer("en"), true)])).toBe("b1");
  });

  it("ignores a stamp on a later turn, on a reply without the offer, or on a path that does not start at the root", () => {
    expect(importOfferId([user("u1", null), bot("b1", "u1", "Sure."), user("u2", "b1"), bot("b2", "u2", offer("en"), true)])).toBeUndefined();
    expect(importOfferId([user("u1", null), bot("b1", "u1", fence("en"), true)])).toBeUndefined();
    expect(importOfferId([user("u1", "older"), bot("b1", "u1", offer("en"), true)])).toBeUndefined();
    expect(importOfferId([user("u1", null), bot("b1", "u1", offer("en"))])).toBeUndefined();
  });
});
