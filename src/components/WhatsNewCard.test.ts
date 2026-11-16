// @vitest-environment happy-dom
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { applySkin } from "@/lib/skins";
import { WHATS_NEW } from "@/lib/whats-new";
import type { SceneModule } from "@/scenes/scene-host";

type Run = { frames: number; stopped: boolean };
const { runs, scene } = vi.hoisted(() => {
  const runs: Run[] = [];
  const scene: SceneModule = {
    pauseOnBlur: false,
    create: (api) => {
      const run = { frames: 0, stopped: false };
      runs.push(run);
      return {
        frame: () => ((run.frames += 1), true),
        event: (event) => {
          if (event.name === "loop") {
            api.after(60_000, () => (run.frames += 1));
            api.wake();
          }
        },
        dispose: () => void (run.stopped = true),
      };
    },
  };
  return { runs, scene };
});
vi.mock("./ChatScene", async (original) => ({ ...(await original<typeof import("./ChatScene")>()), loadScene: async () => scene }));

const api = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: true }));
const dispatch = vi.fn();
vi.mock("@/state/store", () => ({ api: (...args: unknown[]) => api(...args), useStore: () => ({ dispatch }) }));

let observers: { see: IntersectionObserverCallback; node?: Element }[] = [];
vi.stubGlobal(
  "IntersectionObserver",
  class {
    node?: Element;
    constructor(public see: IntersectionObserverCallback) {
      observers.push(this);
    }
    observe(node: Element) {
      this.node = node;
    }
    disconnect() {}
  },
);

const { default: WhatsNewCard } = await import("./WhatsNewCard");

const RELEASE = Object.keys(WHATS_NEW)[0];

describe("whats new card", () => {
  let host: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  const onClose = vi.fn();

  beforeEach(() => {
    applyLocale("en");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    api.mockClear();
    dispatch.mockClear();
    onClose.mockClear();
    observers = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (release: string) => act(() => root.render(createElement(WhatsNewCard, { release, closing: false, onClose })));
  const scrollIntoView = () =>
    act(() => {
      for (const observer of observers.filter((o) => o.node?.classList.contains("whats-new"))) {
        observer.see([{ isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
      }
    });
  const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === name || b.getAttribute("aria-label") === name)!;

  it("renders nothing and records nothing for a release with no entry", () => {
    render("0.0.1");
    expect(host.innerHTML).toBe("");
    expect(api).not.toHaveBeenCalled();
  });

  it("records nothing when it scrolls into view", () => {
    render(RELEASE);
    expect(host.querySelectorAll(".whats-new-tile")).toHaveLength(2);
    scrollIntoView();
    expect(api).not.toHaveBeenCalled();
  });

  it("closes from Got it, the X and Escape", () => {
    render(RELEASE);
    scrollIntoView();
    act(() => button("Got it").click());
    act(() => button("Close what's new").click());
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("ignores Escape while offscreen", () => {
    render(RELEASE);
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).not.toHaveBeenCalled();
    scrollIntoView();
    act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens Memory from its Show me and stays open, and explains the one that starts on its own", () => {
    render(RELEASE);
    const [memory, verify] = [...host.querySelectorAll<HTMLButtonElement>(".whats-new-show")];
    act(() => verify.click());
    expect(verify.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain((WHATS_NEW[RELEASE].tiles[1]!.show as { en: string }).en);
    expect(onClose).not.toHaveBeenCalled();
    act(() => memory.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleSettings", open: true, memory: { line: "" } });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("plays the light clip on a light skin", () => {
    document.documentElement.dataset.skin = "wink-day";
    render(RELEASE);
    act(() => {
      for (const observer of observers) observer.see([{ isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
    });
    const clips = [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    delete document.documentElement.dataset.skin;
    expect(clips).toEqual(WHATS_NEW[RELEASE].tiles.map((tile) => tile.lightClip ?? tile.clip));
    expect(WHATS_NEW[RELEASE].tiles.some((tile) => tile.lightClip)).toBe(true);
  });

  it("ships every string in Korean", () => {
    applyLocale("ko");
    render(RELEASE);
    expect(button("확인")).toBeTruthy();
    expect(host.textContent).toContain(WHATS_NEW[RELEASE].title.ko);
    for (const entry of Object.values(WHATS_NEW)) {
      for (const copy of [entry.title, entry.more, ...entry.tiles.flatMap((tile) => [tile.title, tile.line, ...(tile.show === "memory" ? [] : [tile.show])])]) {
        expect(copy.ko.trim()).not.toBe("");
      }
    }
  });

  it("shows the Map on the left and Gemini 4 Carbon + Hydrogen on the right in 1.0.263, in English and Korean", () => {
    const entry = WHATS_NEW["1.0.263"];
    expect(entry.tiles).toHaveLength(2);
    for (const locale of ["en", "ko"] as const) {
      applyLocale(locale);
      act(() => root.unmount());
      root = createRoot(host);
      render("1.0.263");
      const tiles = [...host.querySelectorAll(".whats-new-tile")];
      expect(tiles).toHaveLength(2);
      expect(tiles.map((tile) => tile.querySelector(".whats-new-tile-title")?.textContent)).toEqual(entry.tiles.map((tile) => tile.title[locale]));
      for (const [i, tile] of entry.tiles.entries()) {
        expect(tiles[i].textContent).toContain(tile.line[locale]);
        act(() => tiles[i].querySelector<HTMLButtonElement>(".whats-new-show")!.click());
        expect(tiles[i].textContent).toContain((tile.show as Record<typeof locale, string>)[locale]);
      }
    }
    expect(entry.tiles[0].title.en).toContain("Map");
    for (const locale of ["en", "ko"] as const) {
      expect(entry.tiles[1]!.title[locale]).toContain("Gemini 4 Carbon + Hydrogen");
      expect((entry.tiles[1]!.show as Record<typeof locale, string>)[locale]).toMatch(/Carbon.*Hydrogen/);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("shows the four new themes as one tile in 1.0.273, in English and Korean", () => {
    const entry = WHATS_NEW["1.0.273"];
    expect(entry.tiles).toHaveLength(1);
    for (const locale of ["en", "ko"] as const) {
      applyLocale(locale);
      act(() => root.unmount());
      root = createRoot(host);
      render("1.0.273");
      const tiles = [...host.querySelectorAll(".whats-new-tile")];
      expect(tiles).toHaveLength(1);
      expect(tiles[0].querySelector(".whats-new-tile-title")?.textContent).toBe(entry.tiles[0].title[locale]);
      expect(tiles[0].textContent).toContain(entry.tiles[0].line[locale]);
      act(() => tiles[0].querySelector<HTMLButtonElement>(".whats-new-show")!.click());
      expect(tiles[0].textContent).toContain((entry.tiles[0].show as Record<typeof locale, string>)[locale]);
    }
    for (const name of ["Samurai Ink", "Night Rain", "Warp", "Circuit"]) expect(entry.tiles[0].line.en).toContain(name);
    for (const name of ["사무라이 잉크", "나이트 레인", "워프", "서킷"]) expect(entry.tiles[0].line.ko).toContain(name);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "lagoon", "Lagoon moves while your bot works. It costs 0 tokens."],
    ["en", "snow", "Snow moves while your bot works. It costs 0 tokens."],
    ["en", "neon-grid", "Neon Grid moves while your bot works. It costs 0 tokens."],
    ["en", "samurai-ink", "Samurai Ink moves while your bot works. It costs 0 tokens."],
    ["en", "night-rain", "Night Rain moves while your bot works. It costs 0 tokens."],
    ["en", "warp", "Warp moves while your bot works. It costs 0 tokens."],
    ["en", "circuit", "Circuit moves while your bot works. It costs 0 tokens."],
    ["ko", "lagoon", "라군 테마는 봇이 일하는 동안 움직여요. 토큰 사용량은 0이에요."],
    ["ko", "snow", "스노우 테마는 봇이 일하는 동안 움직여요. 토큰 사용량은 0이에요."],
    ["ko", "neon-grid", "네온 그리드 테마는 봇이 일하는 동안 움직여요. 토큰 사용량은 0이에요."],
    ["ko", "samurai-ink", "사무라이 잉크 테마는 봇이 일하는 동안 움직여요. 토큰 사용량은 0이에요."],
    ["ko", "night-rain", "나이트 레인 테마는 봇이 일하는 동안 움직여요. 토큰 사용량은 0이에요."],
    ["ko", "warp", "워프 테마는 봇이 일하는 동안 움직여요. 토큰 사용량은 0이에요."],
    ["ko", "circuit", "서킷 테마는 봇이 일하는 동안 움직여요. 토큰 사용량은 0이에요."],
  ] as const)("shows an animated theme as one row in %s (%s), closed by its X", (locale, theme, line) => {
    applyLocale(locale);
    act(() => root.render(createElement(WhatsNewCard, { theme, closing: false, onClose })));
    const row = host.querySelector(".whats-new-dock > .whats-new")!;
    expect(row.textContent).toBe(line);
    expect(row.getAttribute("aria-label")).toBe(line);
    expect(row.querySelectorAll(".whats-new-tile, .whats-new-foot, .whats-new-done")).toHaveLength(0);
    expect(row.querySelectorAll("button")).toHaveLength(1);
    act(() => row.querySelector<HTMLButtonElement>(".whats-new-x")!.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
  });

  it("starts the theme row with the miniature of the picked theme", () => {
    act(() => applySkin("lagoon-night"));
    act(() => root.render(createElement(WhatsNewCard, { theme: "lagoon", closing: false, onClose })));
    const mini = host.querySelector(".whats-new-head")!.firstElementChild!;
    expect(mini.className).toBe("whats-new-mini");
    expect(mini.nextElementSibling?.tagName).toBe("P");
    expect(mini.querySelector('[data-skin="lagoon-night"][aria-hidden="true"]')).not.toBeNull();
    expect(mini.querySelector("[data-mini-scene]")).toBeNull();
    expect(host.querySelector(".whats-new")!.textContent).toBe("Lagoon moves while your bot works. It costs 0 tokens.");
    act(() => applySkin("precision"));
    expect(mini.querySelector('[data-skin="lagoon"]')).not.toBeNull();
  });

  describe("theme preview", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      runs.length = 0;
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      document.documentElement.removeAttribute("data-orbit-idle");
    });

    const renderTheme = (theme: "lagoon" | "snow", close: () => void = onClose) =>
      act(() => root.render(createElement(WhatsNewCard, { theme, closing: false, onClose: close })));
    const advance = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms));
    const moving = () => host.querySelector("[data-mini-scene]");

    it.each(["lagoon", "snow"] as const)("moves %s for three seconds on screen, then restores the exact still without replay", async (theme) => {
      act(() => applySkin(theme));
      renderTheme(theme);
      const mini = host.querySelector(".whats-new-mini")!;
      const still = mini.innerHTML;
      await advance(5000);
      expect(moving()).toBeNull();
      scrollIntoView();
      expect(moving()).not.toBeNull();
      await advance(100);
      expect(runs).toHaveLength(1);
      expect(runs[0].frames).toBeGreaterThan(0);
      await advance(2899);
      expect(moving()).not.toBeNull();
      await advance(1);
      expect(mini.innerHTML).toBe(still);
      expect(runs[0].stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      const frames = runs[0].frames;
      act(() => mini.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
      scrollIntoView();
      await advance(60_000);
      expect(runs).toHaveLength(1);
      expect(runs[0].frames).toBe(frames);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["X", "chat switch"])("cancels the preview timer and scene on %s inside three seconds", async (action) => {
      renderTheme("lagoon", () => root.render(null));
      scrollIntoView();
      await advance(100);
      expect(runs).toHaveLength(1);
      expect(runs[0].frames).toBeGreaterThan(0);
      act(() => {
        if (action === "X") host.querySelector<HTMLButtonElement>(".whats-new-x")!.click();
        else root.render(null);
      });
      expect(runs[0].stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      const frames = runs[0].frames;
      await advance(60_000);
      expect(runs[0].frames).toBe(frames);
    });

    it.each([0, 16])("cancels a deferred scene start when unmounted at %i ms", async (ms) => {
      renderTheme("lagoon");
      scrollIntoView();
      act(() => vi.advanceTimersByTime(ms));
      act(() => root.render(null));
      expect(vi.getTimerCount()).toBe(0);
      await advance(100);
      expect(runs).toHaveLength(0);
    });

    it("gives a replacement theme its own three seconds", async () => {
      renderTheme("lagoon");
      scrollIntoView();
      await advance(3000);
      expect(moving()).toBeNull();
      renderTheme("snow");
      expect(moving()?.getAttribute("data-mini-scene")).toBe("snow");
      await advance(1000);
      renderTheme("snow");
      await advance(2000);
      expect(moving()).toBeNull();
      expect(runs).toHaveLength(2);
      expect(runs.every((run) => run.stopped)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rests while hidden and never restarts after the original three seconds", async () => {
      renderTheme("snow");
      scrollIntoView();
      await advance(100);
      expect(runs[0].frames).toBeGreaterThan(0);
      await act(async () => document.documentElement.setAttribute("data-orbit-idle", "hidden"));
      const frames = runs[0].frames;
      await advance(1000);
      expect(runs[0].frames).toBe(frames);
      await act(async () => document.documentElement.removeAttribute("data-orbit-idle"));
      await advance(100);
      expect(runs[0].frames).toBeGreaterThan(frames);
      await advance(1800);
      expect(runs[0].stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await act(async () => document.documentElement.removeAttribute("data-orbit-idle"));
      scrollIntoView();
      await advance(5000);
      expect(moving()).toBeNull();
      expect(runs).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the existing still under reduced motion", async () => {
      vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
      );
      renderTheme("snow");
      const mini = host.querySelector(".whats-new-mini")!;
      const still = mini.innerHTML;
      scrollIntoView();
      await advance(5000);
      expect(mini.innerHTML).toBe(still);
      expect(runs).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("holds a still frame while the app is idle or motion is reduced", async () => {
    const seeAll = () =>
      act(() => {
        for (const observer of observers) observer.see([{ isIntersecting: true } as IntersectionObserverEntry], observer as unknown as IntersectionObserver);
      });
    const frames = () => [...host.querySelectorAll(".whats-new-frame")].map((frame) => frame.firstElementChild?.tagName);
    render(RELEASE);
    seeAll();
    expect(frames()).toEqual(["IMG", "IMG"]);
    await act(async () => document.documentElement.setAttribute("data-orbit-idle", "blur"));
    expect(frames()).toEqual(["CANVAS", "CANVAS"]);
    await act(async () => document.documentElement.removeAttribute("data-orbit-idle"));
    expect(frames()).toEqual(["IMG", "IMG"]);

    const reduce = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList,
    );
    act(() => root.unmount());
    root = createRoot(host);
    observers = [];
    render(RELEASE);
    seeAll();
    reduce.mockRestore();
    expect(frames()).toEqual(["CANVAS", "CANVAS"]);
  });

  it("keeps the previews small", () => {
    const dir = "src/assets/whats-new";
    const bytes = readdirSync(dir).reduce((sum, file) => sum + statSync(join(dir, file)).size, 0);
    expect(bytes).toBeLessThan(1.5 * 1024 * 1024);
  });
});
