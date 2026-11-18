import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, persistPreference } from "@/lib/i18n";
import { LIGHT_SKIN_IDS, SKINS, applySkin, nextSkin, type SkinId } from "@/lib/skins";
import { PRESENCE_EXIT_MS } from "@/lib/use-presence";
import type { SceneModule } from "@/scenes/scene-host";
import { sceneOf } from "./ChatScene";

type Running = { skin: string; events: string[]; frames: number; stopped: boolean };
const { running, broken, chunks, fakeScene } = vi.hoisted(() => {
  const running: Running[] = [];
  const broken = { on: false };
  const chunks: { load?: (scene: string) => Promise<SceneModule> } = {};
  const fakeScene: SceneModule = {
    pauseOnBlur: false,
    create: (api) => {
      const run: Running = { skin: api.skin(), events: [], frames: 0, stopped: false };
      running.push(run);
      return {
        frame: () => ((run.frames += 1), true),
        event: (event) => {
          if (broken.on) throw new Error("no canvas");
          run.events.push(event.name);
          if (event.name === "loop") api.wake();
        },
        dispose: () => void (run.stopped = true),
      };
    },
  };
  return { running, broken, chunks, fakeScene };
});
vi.mock("./ChatScene", async (original) => ({ ...(await original<typeof import("./ChatScene")>()), loadScene: async (scene: string) => chunks.load?.(scene) ?? fakeScene }));

const { SkinPicker } = await import("./SkinPicker");

let root: Root;
const featured = ["Samurai Ink", "Night Rain", "Warp", "Circuit", "Neon Grid", "Lagoon", "Lagoon Night", "Snow", "Snow Night", "Bronze", "Precision", "GitHub Dimmed", "Tokyo Night", "Terminal", "Inkwell", "Graphite", "Merlot", "Dim Sand", "Wink Day", "Notebook"];
const lightStart = 17;
const koScene: Record<string, string> = { "Lagoon Night": "라군 나이트", "Snow Night": "스노우 나이트", "Neon Grid": "네온 그리드", "Samurai Ink": "사무라이 잉크", "Night Rain": "나이트 레인", Warp: "워프", Circuit: "서킷", Lagoon: "라군", Snow: "스노우" };
const scene = ["Lagoon Night", "Snow Night", "Neon Grid", "Samurai Ink", "Night Rain", "Warp", "Circuit", "Lagoon", "Snow"];
const animated = ["circuit", "lagoon", "lagoon-night", "neon-grid", "night-rain", "samurai-ink", "snow", "snow-night", "warp"];
const movingOrder = ["samurai-ink", "night-rain", "warp", "circuit", "neon-grid", "lagoon", "lagoon-night", "snow", "snow-night"];
const taggedOld = () => tagged().filter((name) => !scene.includes(name!));
const sections = () => [...document.querySelectorAll(".grid")].map((grid) => ({
  title: grid.parentElement!.previousElementSibling!.textContent,
  // SAFETY: every tile stamps data-skin-tile from its SkinId.
  skins: [...grid.querySelectorAll<HTMLElement>("[data-skin-tile]")].map((tile) => tile.dataset.skinTile as SkinId),
}));
const kept = ["Wink Violet", "Wink Black", "Pewter", "Precision Dimmed"];
const tiles = () => [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")];
const names = () => tiles().map((button) => button.querySelector(".font-medium")?.textContent);
const tagged = () => tiles().filter((button) => button.querySelector("[data-skin-new]")).map((button) => button.querySelector(".font-medium")?.textContent);
// the extra themes fold away on the shared motion before they unmount
const folded = () => act(async () => { await new Promise((done) => setTimeout(done, PRESENCE_EXIT_MS + 40)); });

async function mount(skin: SkinId = "precision", locale: "en" | "ko" = "en") {
  vi.stubGlobal("localStorage", window.localStorage);
  localStorage.removeItem("omb-skins-tried");
  persistPreference(locale);
  applySkin(skin);
  await render();
}

async function render() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(I18nProvider, null, createElement(SkinPicker))));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  applySkin("precision");
  persistPreference("en");
  running.length = 0;
  broken.on = false;
  chunks.load = undefined;
  document.documentElement.removeAttribute("data-orbit-idle");
  vi.unstubAllGlobals();
});

describe("featured themes", () => {
  it.each(["en", "ko"] as const)("starts folded with twenty featured themes in %s and reveals every offered theme", async (locale) => {
    await mount("precision", locale);
    const shown = locale === "en" ? featured : featured.map((name) => koScene[name] ?? name);
    expect(names()).toEqual(shown);
    const more = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(more).not.toBeNull();
    expect(more.textContent).toContain(locale === "en" ? "More themes" : "더 많은 테마");
    expect(more.textContent).toContain(String(SKINS.length - featured.length));
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(names()).toHaveLength(SKINS.length);
    expect(new Set(names()).size).toBe(SKINS.length);
    for (const name of kept) expect(names()).toContain(name);
    await act(async () => more.click());
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await folded();
    expect(names()).toEqual(shown);
  });

  it("opens with every new theme ahead of every older one in each section", async () => {
    await mount("precision");
    const sections = [...document.querySelectorAll(".grid")].map((grid) => [...grid.querySelectorAll("button[aria-pressed]")].map((button) => !!button.querySelector("[data-skin-new]")));
    expect(sections).toHaveLength(3);
    for (const isNew of sections) expect(isNew).toEqual([...isNew].sort((a, b) => Number(b) - Number(a)));
    expect(names()[0]).toBe("Samurai Ink");
  });

  it("keeps an extra active theme up front, follows external changes and resets the fold on remount", async () => {
    await mount("pewter-night");
    expect(names()).toContain("Pewter Night");
    expect(names()).toHaveLength(featured.length + 1);
    expect(document.querySelector('[aria-pressed="true"]')?.textContent).toBe("Pewter Night");
    await act(async () => applySkin("blueprint-gray"));
    expect(names()).toContain("Blueprint Gray");
    expect(names()).not.toContain("Pewter Night");
    const more = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(more.textContent).toContain(String(SKINS.length - featured.length - 1));
    await act(async () => more.click());
    const servo = [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((button) => button.textContent === "Servo Gray")!;
    expect(servo).toBeTruthy();
    await act(async () => servo.click());
    expect(document.documentElement.dataset.skin).toBe("servo-gray");
    await act(async () => root.unmount());
    await mount("servo-gray");
    expect(names()).toContain("Servo Gray");
    expect(document.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps focus on a theme picked from the open fold and promotes it once folded", async () => {
    await mount("precision");
    const more = document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    await act(async () => more.click());
    const servo = [...document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((button) => button.textContent === "Servo Gray")!;
    servo.focus();
    await act(async () => servo.click());
    expect(servo.isConnected).toBe(true);
    expect(document.activeElement).toBe(servo);
    expect(servo.getAttribute("aria-pressed")).toBe("true");
    await act(async () => more.click());
    await folded();
    expect(names()).toEqual([...featured.slice(0, lightStart), "Servo Gray", ...featured.slice(lightStart)]);
  });

  it("keeps Precision Dimmed under More themes and gives an active extra theme the current-theme slot", async () => {
    await mount("precision");
    expect(names()).not.toContain("Precision Dimmed");
    await act(async () => root.unmount());
    await mount("precision-dimmed");
    expect(names()).toEqual([...featured.slice(0, lightStart), "Precision Dimmed", ...featured.slice(lightStart)]);
    await act(async () => root.unmount());
    await mount("kanagawa");
    expect(names()).toEqual([...featured.slice(0, lightStart), "Kanagawa", ...featured.slice(lightStart)]);
    await act(async () => applySkin("precision"));
    expect(names()).not.toContain("Kanagawa");
    expect(names()).not.toContain("Wink");
  });

  it.each(["wink-violet", "wink-black", "pewter"] as const)("applies %s and shows it up front while on", async (id) => {
    await mount(id);
    expect(document.documentElement.dataset.skin).toBe(id);
    const name = SKINS.find((skin) => skin.id === id)!.name;
    expect(names()).toEqual([...featured.slice(0, lightStart), name, ...featured.slice(lightStart)]);
    expect(document.querySelector('[aria-pressed="true"]')?.querySelector(".font-medium")?.textContent).toBe(name);
  });

  it("cycles all themes in dark then light order including Servo Gray", () => {
    const order = [...SKINS.filter((skin) => !LIGHT_SKIN_IDS.has(skin.id)), ...SKINS.filter((skin) => LIGHT_SKIN_IDS.has(skin.id))];
    expect(order.map((skin) => skin.id)).toContain("servo-gray");
    for (let i = 0; i < order.length; i++) expect(nextSkin(order[i].id)).toBe(order[(i + 1) % order.length].id);
  });
});

describe("Sections", () => {
  it("flags exactly the skins with a motion layer as animated", () => {
    for (const skin of SKINS) expect([skin.id, !!skin.animated]).toEqual([skin.id, !!sceneOf(skin.id)]);
  });

  it.each([
    ["en", ["Animated", "Dark", "Light"]],
    ["ko", ["움직이는 테마", "다크", "라이트"]],
  ] as const)("groups the moving themes under Animated ahead of the still Dark and Light in %s", async (locale, titles) => {
    await mount("precision", locale);
    expect(sections().map((section) => section.title)).toEqual(titles);
    const [moving, dark, light] = sections().map((section) => section.skins);
    expect(moving).toEqual(movingOrder);
    for (const id of [...dark, ...light]) expect(sceneOf(id)).toBeUndefined();
    expect(light.every((id) => LIGHT_SKIN_IDS.has(id))).toBe(true);
    expect(dark.some((id) => LIGHT_SKIN_IDS.has(id))).toBe(false);
    await act(async () => document.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    expect(sections().slice(3).map((section) => section.title)).toEqual(titles.slice(1));
  });
});

describe("Reveal", () => {
  it("scrolls to the first of the asked themes in the grid, once per request", async () => {
    await mount();
    const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {});
    const reveal = (skins: SkinId[] | null) => act(async () => root.render(createElement(I18nProvider, null, createElement(SkinPicker, { reveal: skins }))));
    await reveal(["circuit", "warp", "samurai-ink"]);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(tiles().find((tile) => tile.dataset.skinTile === "samurai-ink"));
    await reveal(null);
    expect(scrolled).toHaveBeenCalledTimes(1);
    scrolled.mockRestore();
  });
});

describe("New tag", () => {
  it.each(["en", "ko"] as const)("marks the new themes until tried in %s", async (locale) => {
    await mount("precision", "en");
    expect(tagged()).toEqual(["Samurai Ink", "Night Rain", "Warp", "Circuit", "Neon Grid", "Lagoon", "Lagoon Night", "Snow", "Snow Night", "Bronze", "Dim Sand"]);
    await act(async () => root.unmount());
    await mount("precision", locale);
    expect(document.querySelector("[data-skin-new]")?.textContent).toBe(locale === "en" ? "New" : "신규");
    await act(async () => document.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
    expect(tagged()).toHaveLength(12);
    expect(tagged().at(-1)).toBe("Precision Dimmed");
  });

  it("drops the tag for good after a picker click", async () => {
    await mount("precision");
    const bronze = tiles().find((button) => button.querySelector(".font-medium")?.textContent === "Bronze")!;
    await act(async () => bronze.click());
    await act(async () => applySkin("precision"));
    expect(taggedOld()).toEqual(["Dim Sand"]);
    await act(async () => root.unmount());
    await render();
    expect(taggedOld()).toEqual(["Dim Sand"]);
  });

  it("drops the tag after the theme hotkey applies it", async () => {
    await mount("precision");
    await act(async () => applySkin(nextSkin("precision-dimmed")));
    await act(async () => applySkin("precision"));
    expect(taggedOld()).toEqual(["Dim Sand"]);
  });

  it("drops the tag for a theme started on", async () => {
    await mount("dim-sand");
    await act(async () => applySkin("precision"));
    expect(taggedOld()).toEqual(["Bronze"]);
  });
});

describe("New tag placement", () => {
  it.each(["en", "ko"] as const)("keeps the tag on the name's line and lets a long name wrap inside its own box in %s", async (locale) => {
    await mount("precision", locale);
    const tags = [...document.querySelectorAll<HTMLElement>("[data-skin-new]")];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      const row = tag.parentElement!;
      expect(row.className.split(" ")).not.toContain("flex-wrap");
      expect(tag.className.split(" ")).toContain("shrink-0");
      expect(row.firstElementChild!.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "break-words"]));
    }
  });
});

describe("Moving tiles", () => {
  let frames: FrameRequestCallback[] = [];
  const flush = (n = 1) => {
    for (let i = 0; i < n; i++) {
      const due = frames;
      frames = [];
      for (const run of due) run(performance.now());
    }
  };
  const open = async (reduce = false) => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => frames.push(run));
    vi.stubGlobal("cancelAnimationFrame", () => (frames = []));
    const media = window.matchMedia.bind(window);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => Object.defineProperty(media(query), "matches", { value: query.includes("reduce") && reduce }));
    await mount("precision");
  };
  // One frame, then the timer queued behind it.
  const painted = async () => {
    flush();
    await act(async () => {
      if (vi.isFakeTimers()) vi.advanceTimersByTime(0);
      else await new Promise((done) => setTimeout(done, 0));
    });
  };
  const tile = (skin: string) => document.querySelector(`button [data-skin="${skin}"]`)!.closest("button")!;
  const point = (skin: string, type: "pointerover" | "pointerout", pointerType: string) =>
    act(async () => void tile(skin).dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, relatedTarget: document.body }), { pointerType })));
  const live = () => running.filter((run) => !run.stopped);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts the tiles only after the picker has painted", async () => {
    await open();
    expect(running).toHaveLength(0);
    await painted();
    expect(running).toHaveLength(animated.length);
  });

  it("starts every tile together once the last scene chunk has arrived", async () => {
    const arrive = new Map<string, () => void>();
    chunks.load = (scene) => new Promise((done) => arrive.set(scene, () => done(fakeScene)));
    await open();
    await painted();
    const scenes = [...arrive.keys()];
    expect(scenes).toHaveLength(7);
    for (const scene of scenes.slice(0, -1)) {
      arrive.get(scene)!();
      await act(async () => {});
      expect(running).toHaveLength(0);
    }
    arrive.get(scenes.at(-1)!)!();
    await act(async () => {});
    expect(running).toHaveLength(animated.length);
    flush(1);
    for (const run of running) expect(run.frames).toBe(1);
  });

  it("starts the other tiles when one scene chunk fails to load", async () => {
    chunks.load = async (scene) => {
      if (scene === "snow") throw new Error("stale chunk");
      return fakeScene;
    };
    await open();
    await painted();
    expect(running).toHaveLength(animated.length - 2);
    expect(document.querySelectorAll("[data-mini-scene][data-live]")).toHaveLength(animated.length - 2);
  });

  it("starts nothing when the picker closes before its first paint", async () => {
    await open();
    await act(async () => root.unmount());
    await painted();
    expect(running).toHaveLength(0);
  });

  it("leaves the still tile when a scene cannot start", async () => {
    broken.on = true;
    await open();
    await painted();
    expect(running).toHaveLength(animated.length);
    expect(running.every((run) => run.stopped)).toBe(true);
    expect(document.querySelectorAll("[data-mini-scene][data-live]")).toHaveLength(0);
  });

  it("plays every animated tile when Themes opens, each in its own skin, and stops them when it closes", async () => {
    await open();
    await painted();
    expect(running.map((run) => run.skin).sort()).toEqual(animated);
    expect(document.querySelectorAll("[data-mini-scene]")).toHaveLength(animated.length);
    for (const run of running) expect(run.events).toEqual(["loop"]);
    flush(5);
    for (const run of running) expect(run.frames).toBe(5);
    await act(async () => root.unmount());
    expect(running.every((run) => run.stopped)).toBe(true);
    flush(5);
    for (const run of running) expect(run.frames).toBe(5);
  });

  it.each(["hidden", "blur"])("rests every tile while the window is idle (%s)", async (idle) => {
    await open();
    await painted();
    expect(running).toHaveLength(animated.length);
    flush(2);
    document.documentElement.setAttribute("data-orbit-idle", idle);
    await Promise.resolve();
    flush(5);
    for (const run of running) expect(run.frames).toBe(2);
    document.documentElement.removeAttribute("data-orbit-idle");
    await Promise.resolve();
    flush(1);
    for (const run of running) expect(run.frames).toBe(3);
  });

  it("keeps every tile looping while Themes stays open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await open();
    await painted();
    await act(async () => void vi.advanceTimersByTime(60_000));
    flush(5);
    expect(live()).toHaveLength(animated.length);
    for (const run of live()) expect(run.frames).toBe(5);
    expect(document.querySelectorAll("[data-mini-scene]")).toHaveLength(animated.length);
  });

  it.each(["mouse", "touch"])("leaves every tile looping, none restarted, while a %s pointer comes and goes", async (pointerType) => {
    await open();
    await painted();
    flush(2);
    for (const skin of ["warp", "precision", "warp"]) {
      await point(skin, "pointerover", pointerType);
      await painted();
      await point(skin, "pointerout", pointerType);
      await painted();
    }
    flush(3);
    expect(running).toHaveLength(animated.length);
    for (const run of running) expect([run.stopped, run.frames]).toEqual([false, 11]);
  });

  it("leaves the still tiles alone under reduced motion", async () => {
    await open(true);
    await painted();
    expect(running).toHaveLength(0);
    flush(3);
    expect(frames).toHaveLength(0);
  });

  it("keeps the Animated section with still tiles under reduced motion", async () => {
    await open(true);
    await painted();
    expect(sections()[0]).toEqual({ title: "Animated", skins: movingOrder });
    expect(running).toHaveLength(0);
  });
});

describe("Scene themes", () => {
  it.each([
    ["en", ["Lagoon Night", "Snow Night"], ["Lagoon", "Snow"]],
    ["ko", ["라군 나이트", "스노우 나이트"], ["라군", "스노우"]],
  ] as const)("puts Lagoon and Snow up front as Day and Night tiles with the New tag in %s", async (locale, night, day) => {
    await mount("precision", locale);
    const shown = names();
    for (const i of [0, 1]) expect(shown.indexOf(night[i])).toBe(shown.indexOf(day[i]) + 1);
    for (const name of [...night, ...day]) {
      expect(shown).toContain(name);
      expect(tagged()).toContain(name);
    }
    const snowNight = tiles().find((button) => button.querySelector(".font-medium")?.textContent === night[1])!;
    await act(async () => snowNight.click());
    expect(document.documentElement.dataset.skin).toBe("snow-night");
    expect(snowNight.getAttribute("aria-pressed")).toBe("true");
  });

  it.each([
    ["en", "neon-grid", "Neon Grid"], ["ko", "neon-grid", "네온 그리드"],
    ["en", "samurai-ink", "Samurai Ink"], ["ko", "samurai-ink", "사무라이 잉크"],
    ["en", "night-rain", "Night Rain"], ["ko", "night-rain", "나이트 레인"],
    ["en", "warp", "Warp"], ["ko", "warp", "워프"],
    ["en", "circuit", "Circuit"], ["ko", "circuit", "서킷"],
  ] as const)("puts the new animated themes first among the animated tiles with the New tag in %s (%s)", async (locale, id, name) => {
    await mount("precision", locale);
    expect(names().indexOf(name)).toBeLessThan(5);
    expect(tagged()).toContain(name);
    const tile = tiles().find((button) => button.querySelector(".font-medium")?.textContent === name)!;
    expect(tile.querySelector(`[data-mini-scene="${id}"]`)).not.toBeNull();
    await act(async () => tile.click());
    expect(document.documentElement.dataset.skin).toBe(id);
    expect(LIGHT_SKIN_IDS.has(id)).toBe(false);
  });
});
