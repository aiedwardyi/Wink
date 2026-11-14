// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applySkin, type SkinId } from "@/lib/skins";
import type { SceneEvent, SceneModule } from "@/scenes/scene-host";

const { seen, fake, offerThemeRow, scenePlayed } = vi.hoisted(() => {
  const seen: SceneEvent[] = [];
  const fake: SceneModule = {
    pauseOnBlur: false,
    create: (api) => ({
      frame: () => false,
      event: (event) => {
        seen.push(event);
        if (event.name !== "skin" && event.name !== "motion") api.wake();
      },
      dispose: () => undefined,
    }),
  };
  return { seen, fake, offerThemeRow: vi.fn(), scenePlayed: vi.fn() };
});
vi.mock("@/scenes/lagoon", () => ({ default: fake }));
vi.mock("@/scenes/snow", () => ({ default: fake }));
vi.mock("./WhatsNew", () => ({ offerThemeRow, scenePlayed }));

const { ChatScene, sceneOf } = await import("./ChatScene");

let host: HTMLElement;
let root: Root;
let reduce = false;
const sendRef: { current: (() => void) | null } = { current: null };
const names = () => seen.map((event) => event.name);
const at = (event: SceneEvent) => ("at" in event ? event.at : undefined);

type Chat = { skin: SkinId; hidden?: boolean; working?: boolean; empty?: boolean };
const chat = ({ skin, hidden = false, working = false, empty = false }: Chat) => {
  const scene = sceneOf(skin);
  return createElement(
    "main",
    null,
    scene && createElement(ChatScene, { scene, skin, working, threadId: "t1", hidden, sendRef }),
    !empty && createElement("div", { "data-orbit-message": "bot" }, createElement("div", { "data-orbit-message-content": "", id: "bubble" })),
    createElement("div", { "data-orbit-composer-frame": "", id: "frame" }),
  );
};
const render = (props: Chat) =>
  act(async () => {
    root.render(chat(props));
    await vi.dynamicImportSettled();
  });
const pick = (skin: SkinId, props: Omit<Chat, "skin"> = {}) => {
  act(() => applySkin(skin));
  return render({ skin, ...props });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") && reduce, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  reduce = false;
  act(() => applySkin("precision"));
  seen.length = 0;
  offerThemeRow.mockClear();
  scenePlayed.mockClear();
  vi.unstubAllGlobals();
});

// Before any other apply: the page has no skin yet, as at startup.
it("chat scene stays still for the theme the app starts on", async () => {
  expect(document.documentElement.dataset.skin).toBeUndefined();
  await pick("snow-night");
  expect(names()).toEqual([]);
  expect(offerThemeRow).not.toHaveBeenCalled();
  expect(scenePlayed).not.toHaveBeenCalled();
});

describe("chat scene on a theme pick", () => {
  beforeEach(() => act(() => applySkin("precision")));

  it("plays the reply burst once from the last reply and offers the theme's row", async () => {
    await pick("lagoon");
    expect(names()).toEqual(["reply"]);
    expect(at(seen[0])).toBe(document.getElementById("bubble"));
    expect(offerThemeRow.mock.calls).toEqual([["lagoon"]]);
    expect(scenePlayed.mock.calls).toEqual([["lagoon"]]);
    await render({ skin: "lagoon", hidden: true });
    await render({ skin: "lagoon" });
    expect(names()).toEqual(["reply"]);
  });

  it("waits for the chat to be visible", async () => {
    await pick("snow", { hidden: true });
    expect(names()).toEqual([]);
    expect(scenePlayed).not.toHaveBeenCalled();
    expect(offerThemeRow.mock.calls).toEqual([["snow"]]);
    await render({ skin: "snow" });
    expect(names()).toEqual(["reply"]);
    expect(scenePlayed.mock.calls).toEqual([["snow"]]);
  });

  it("plays again when the other tile of the same scene is picked", async () => {
    await pick("lagoon");
    seen.length = 0;
    await pick("lagoon-night");
    expect(names()).toEqual(["skin", "reply"]);
    expect(offerThemeRow.mock.calls).toEqual([["lagoon"], ["lagoon"]]);
  });

  it("plays from the chat box in an empty chat, and as a send while the bot works", async () => {
    await pick("lagoon", { empty: true });
    expect(names()).toEqual(["reply"]);
    expect(at(seen[0])).toBe(document.getElementById("frame"));
    act(() => applySkin("precision"));
    await render({ skin: "precision" });
    seen.length = 0;
    await pick("snow", { working: true });
    expect(names()).toEqual(["busy", "send", "busy"]);
    expect(at(seen[1])).toBe(document.getElementById("frame"));
  });

  it("wakes a scene that went still mid-turn when its other tile is picked", async () => {
    await pick("snow", { working: true });
    seen.length = 0;
    scenePlayed.mockClear();
    await pick("snow-night", { working: true });
    expect(names()).toEqual(["skin", "send", "busy"]);
    expect(scenePlayed.mock.calls).toEqual([["snow"]]);
  });

  it("counts a turn's own burst as the scene having played", async () => {
    await pick("snow", { hidden: true });
    await render({ skin: "snow", hidden: true, working: true });
    expect(scenePlayed).not.toHaveBeenCalled();
    act(() => applySkin("precision"));
    await render({ skin: "precision" });
    await pick("snow");
    scenePlayed.mockClear();
    await render({ skin: "snow", working: true });
    expect(names().at(-1)).toBe("busy");
    expect(scenePlayed.mock.calls).toEqual([["snow"]]);
  });

  it("offers no row under reduced motion", async () => {
    reduce = true;
    await pick("snow");
    expect(offerThemeRow.mock.calls).toEqual([[null]]);
    expect(scenePlayed).not.toHaveBeenCalled();
  });

  it("takes the row back when a theme that does not move is picked", async () => {
    await pick("lagoon");
    await pick("graphite");
    expect(offerThemeRow.mock.calls).toEqual([["lagoon"], [null]]);
  });
});
