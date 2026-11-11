import "@/components/ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useSpinUntilTurnEnds } from "./use-spin-until-turn-ends";

let host: HTMLDivElement;
let root: Root;

function Icon({ active }: { active: boolean }) {
  const { spinning, onAnimationIteration } = useSpinUntilTurnEnds(active);
  return createElement("svg", { className: spinning ? "spin" : "", onAnimationIteration });
}

const show = (active: boolean) => act(async () => root.render(createElement(Icon, { active })));
const turn = () => act(async () => { host.querySelector("svg")!.dispatchEvent(new Event("animationiteration", { bubbles: true })); });
const spinning = () => host.querySelector("svg")!.classList.contains("spin");

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("useSpinUntilTurnEnds", () => {
  it("keeps spinning after an instant refresh until the turn ends", async () => {
    await show(false);
    expect(spinning()).toBe(false);
    await show(true);
    await show(false);
    expect(spinning()).toBe(true);
    await turn();
    expect(spinning()).toBe(false);
  });

  it("keeps spinning through turns while still active", async () => {
    await show(true);
    await turn();
    expect(spinning()).toBe(true);
    await show(false);
    await turn();
    expect(spinning()).toBe(false);
  });

  it("spins on mount when already active", async () => {
    await show(true);
    expect(spinning()).toBe(true);
  });
});
