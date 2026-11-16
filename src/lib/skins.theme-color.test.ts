// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applySkin } from "./skins";

describe("phone status bar", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    document.head.innerHTML = `<meta name="theme-color" content="#121316" /><style>:root { --color-app: #121316; } [data-skin="wink-day"] { --color-app: #eeebf7; }</style>`;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.head.innerHTML = "";
    delete document.documentElement.dataset.skin;
    localStorage.clear();
  });

  it("takes the active theme's app colour, and goes back with the theme", () => {
    const bar = () => document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content;
    applySkin("wink-day");
    expect(bar()).toBe("#eeebf7");
    applySkin("precision");
    expect(bar()).toBe("#121316");
  });
});
