// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { MemoryMap } from "./MemoryMap";
import { smoothGlow } from "./MemoryMapGlow";
import { disc, ramp, render, stops } from "./MemoryMapGlowPaint";

vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "MemoryMap.css"), "utf8");
const rule = (selector: string) => css.match(new RegExp(`^${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
const bot = { id: "b", threadId: "t", messages: [], tasks: [] } as unknown as Bot;
const text = "- Uses VS Code (noted 2026-10-29)\n- Freshman in CS (noted 2026-10-25)\n- Has ADHD (noted 2026-10-17)\n- Has Linux available (noted 2026-10-17)\n- Feedback style: lead with \"not quite\" (noted 2026-10-30)";
const topics = [{ name: "reps-content-preferences.md", bytes: 1135 }, { name: "interview-direction.md", bytes: 842 }];
const sleep = { sleptAt: new Date(2026, 10, 7, 3, 12), kept: 24, merged: 1, forgot: 1, learned: 3, onUndo: vi.fn() };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
async function mount(props: Partial<Parameters<typeof MemoryMap>[0]> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(MemoryMap, { bot, text, topics, active: true, ...props })));
}
afterEach(async () => {
  await act(async () => root?.unmount()); host?.remove();
  applyLocale("en");
});

describe("MemoryMap", () => {
  it("names each kind with its hint and count", async () => {
    await mount();
    const panel = (kind: string) => host.querySelector(`[data-kind="${kind}"]`)!.textContent;
    expect(panel("long")).toContain("Long-Term Memory");
    expect(panel("long")).toContain("Facts it keeps about you");
    expect(panel("long")).toContain("2facts");
    expect(panel("knowledge")).toContain("2files");
    expect(panel("muscle")).toContain("1lesson");
    expect(host.querySelector(".mm-live")!.textContent).toContain("Uses VS Code");
  });

  it("opens Muscle Memory to its lessons on a tap", async () => {
    await mount();
    const muscle = host.querySelector<HTMLButtonElement>('button.mm-panel[data-kind="muscle"]')!;
    await act(async () => muscle.click());
    expect(muscle.getAttribute("aria-expanded")).toBe("true");
    expect(muscle.parentElement!.querySelector(".mm-list")!.textContent).toContain("Feedback style");
  });

  it.each([
    ["lights done steps from the left whatever their order", ["pending", "done", "active", "done"], "++*-"],
    ["scales 19 steps to 12 segments", [...Array(9).fill("done"), "active", ...Array(9).fill("pending")], "++++++*-----"],
    ["lights every segment with no glow once all are done", ["done", "done", "done"], "+++"],
    ["glows the first segment before any step is done", ["active", "pending", "pending"], "*--"],
  ] as const)("%s", async (_, statuses, bar) => {
    const plan = statuses.map((status, index) => ({ step: String(index), status }));
    await mount({ bot: { ...bot, tasks: [{ threadId: "t", taskState: { goal: "Ship", plan, nextAction: "", blockers: [], completed: [], evidence: [], artifacts: [] } }] } as unknown as Bot });
    expect([...host.querySelectorAll(".mm-steps i")].map((each) => each.hasAttribute("data-now") ? "*" : each.hasAttribute("data-done") ? "+" : "-").join("")).toBe(bar);
    expect(host.querySelector(".mm-task-meta")!.textContent).toBe(`${statuses.filter((each) => each === "done").length} of ${statuses.length} steps done`);
  });

  it("draws the rings as soft glows behind the badge, never a line", () => {
    const ring = rule(".mm-orbit");
    expect(ring).toContain("z-index: -1");
    expect(ring).not.toMatch(/gradient|border:/);
    expect(ring).toMatch(/box-shadow: 0 0 \d+px/);
    const grown = Math.max(...[...css.split("\n").find((line) => line.startsWith("@keyframes mm-ring"))!.matchAll(/scale: ([\d.]+)/g)].map((each) => Number(each[1])));
    const badge = Number(rule(".mm-brain").match(/width: (\d+)px/)![1]);
    for (const size of [".mm-orbit-near", ".mm-orbit-far"]) expect(Number(rule(size).match(/width: (\d+)px/)![1]) * grown).toBeLessThanOrEqual(badge);
  });

  it("hides the Sleep line until Sleep has run", async () => {
    await mount();
    expect(host.querySelector(".mm-sleep")).toBeNull();
    expect(host.textContent).not.toContain("Slept");
  });

  it.each(["en", "ko"] as const)("shows last night's Sleep with Undo in %s", async (locale) => {
    applyLocale(locale);
    await mount({ sleep });
    const line = host.querySelector(".mm-sleep")!;
    expect(line.textContent).toContain(locale === "en" ? "Slept at 3:12" : "수면");
    expect(line.textContent).toContain(locale === "en" ? "kept24" : "유지24");
    await act(async () => line.querySelector("button")!.click());
    expect(sleep.onUndo).toHaveBeenCalled();
  });
});

describe("smooth glow", () => {
  const aura = "radial-gradient(closest-side at 50% 22%, rgba(221, 214, 254, 0.11), rgba(96, 165, 250, 0.05) 34%, rgba(221, 214, 254, 0.03) 60%, rgba(0, 0, 0, 0) 85%)";

  it("reads a computed gradient's stops", () => {
    expect(stops(aura).map((each) => each.at)).toEqual([0, 0.34, 0.6, 0.85]);
    expect(stops(aura)[0].c).toEqual([221 / 255, 214 / 255, 254 / 255, 0.11]);
    expect(stops("radial-gradient(rgb(0, 0, 0), rgb(9, 9, 9), rgb(0, 0, 0))").map((each) => each.at)).toEqual([0, 0.5, 1]);
  });

  it("keeps the fade in float, premultiplied, where 8 bits would step", () => {
    const lut = ramp(stops(aura));
    expect(lut[3]).toBeCloseTo(0.11);
    expect(lut[0]).toBeCloseTo((221 / 255) * 0.11);
    const alpha = Array.from({ length: 128 }, (_, i) => lut[i * 4 + 3]);
    expect(new Set(alpha.slice(0, 108).map((each) => Math.round(each * 255))).size).toBeLessThan(30);
    expect(new Set(alpha.slice(0, 108)).size).toBeGreaterThan(100);
    expect(alpha[127]).toBe(0);
  });

  it("fades a blurred disc from nearly full at its centre to nothing at its reach", () => {
    const { lut, reach } = disc(30, 11, [1, 1, 1, 1]);
    const cover = Array.from({ length: 128 }, (_, i) => lut[i * 4 + 3]);
    expect(reach).toBe(63);
    expect(cover[0]).toBeCloseTo(1 - Math.exp(-(30 * 30) / (2 * 11 * 11)), 2);
    expect(cover.every((each, i) => i === 0 || each <= cover[i - 1])).toBe(true);
    expect(cover[127]).toBeLessThan(0.005);
  });

  it("paints no layer without WebGL2", () => {
    vi.stubGlobal("OffscreenCanvas", class { getContext() { return null; } });
    const shadow = "rgba(129, 140, 248, 0.28) 0px 0px 22px 0px";
    expect(render({ dpr: 1, size: [980, 808], back: [0, 0, 0], aura: [aura, 0, 0, 980, 760], lift: 0.7, ray: null, halo: [aura, 18], badge: [460, 60, 60], shadow, veil: [aura, 1], swell: shadow, orbits: [44, 48], live: null })).toEqual({ layers: null });
  });

  it("answers with no layers when the painter throws", async () => {
    const sent = vi.fn(), page = self, warned = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("self", { postMessage: sent, close() {} });
    await import("./MemoryMapGlow.worker");
    await (self as unknown as { onmessage(message: { data: unknown }): Promise<void> }).onmessage({ data: null });
    expect(sent).toHaveBeenCalledWith({ layers: null }, []);
    expect(warned).toHaveBeenCalledTimes(1);
    warned.mockRestore(); vi.stubGlobal("self", page);
  });

  it("holds the painted glow still for reduced motion", () => {
    const still = css.lastIndexOf("@media (prefers-reduced-motion: reduce)");
    expect(css.slice(still)).toMatch(/\.mm-smooth-breath \{ animation: none; \}/);
    expect(still).toBeGreaterThan(css.lastIndexOf("animation: mm-smooth-breath"));
  });

  // a browser that reports a map `wide` device pixels across and answers the painter with `reply`
  function browser(reply: unknown, wide: number) {
    const seen: (() => void)[] = [];
    vi.stubGlobal("ResizeObserver", class { constructor(private report: (entries: unknown[]) => void) {} observe(target: Element) { seen.push(() => this.report([{ target, devicePixelContentBoxSize: [{ inlineSize: wide, blockSize: 808 }] }])); } disconnect() {} });
    vi.stubGlobal("Worker", class { onmessage?: (reply: { data: unknown }) => void; postMessage() { queueMicrotask(() => this.onmessage?.({ data: reply })); } });
    vi.stubGlobal("getComputedStyle", () => ({ backgroundImage: aura, maskImage: aura, backgroundColor: "rgb(13, 14, 22)", boxShadow: "rgba(129, 140, 248, 0.28) 0px 0px 22px 0px", display: "none", top: "-18px", opacity: "1", getPropertyValue: () => "0.7" }));
    const box = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: wide, height: 808 } as DOMRect);
    return { box, report: () => act(async () => { seen.splice(0).forEach((each) => each()); await new Promise((done) => setTimeout(done)); }) };
  }

  it("paints a second map its own canvases", async () => {
    const { box, report } = browser({ layers: Array.from({ length: 7 }, () => ({ width: 4, height: 4 })) }, 900);
    const draws = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ transferFromImageBitmap() {} } as never);
    await mount();
    await report();
    const first = host, held = root, mine = [...first.querySelectorAll(".mm-smooth canvas")];
    await mount();
    await report();
    expect(mine).toHaveLength(4);
    expect([...first.querySelectorAll(".mm-smooth canvas")]).toEqual(mine);
    expect(host.querySelectorAll(".mm-smooth canvas")).toHaveLength(4);
    await act(async () => held.unmount()); first.remove();
    draws.mockRestore(); box.mockRestore();
  });

  it("keeps the CSS glow where the browser cannot paint", async () => {
    const { box, report } = browser({ layers: null }, 980);
    await mount();
    const map = host.querySelector(".mm")!;
    expect(map.hasAttribute("data-smooth")).toBe(true);
    expect(map.querySelector(".mm-smooth")).not.toBeNull();
    await report();
    expect(map.hasAttribute("data-smooth")).toBe(false);
    expect(map.querySelector(".mm-smooth, canvas")).toBeNull();
    expect(map.querySelector(".mm-glow")).not.toBeNull();
    expect(rule(".mm-glow") + rule(".mm-ray") + rule(".mm-brain::after") + rule(".mm::after")).not.toContain("visibility");
    box.mockRestore();
  });

  // a map's bare markup, for smoothGlow on its own
  function bare() {
    const mm = document.createElement("div");
    mm.innerHTML = '<div class="mm-smooth"></div><div class="mm-glow"></div><div class="mm-ray"></div><div class="mm-brain"></div><span class="mm-orbit"></span><span class="mm-orbit"></span><div><div class="mm-smooth-live"></div><section class="mm-live"></section></div>';
    return document.body.appendChild(mm);
  }
  const layers = (count: number, width = 4) => Array.from({ length: count }, () => ({ width, height: 4, close: vi.fn() }));
  const repaint = () => act(() => new Promise((done) => setTimeout(done, 200)));

  it("hands the CSS glow back and frees the painter when a worker cannot start", async () => {
    const { box, report } = browser({ layers: layers(6) }, 940), Painter = Worker, fail = vi.fn();
    const draws = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ transferFromImageBitmap() {} } as never);
    vi.stubGlobal("Worker", class { constructor() { throw new DOMException("blocked", "SecurityError"); } });
    const blocked = bare(), stop = smoothGlow(blocked, fail);
    await report();
    expect(fail).toHaveBeenCalledTimes(1);
    vi.stubGlobal("Worker", Painter);
    const next = bare(), again = smoothGlow(next, vi.fn());
    await report();
    expect(next.querySelectorAll(".mm-smooth canvas")).toHaveLength(4);
    stop(); again(); blocked.remove(); next.remove();
    draws.mockRestore(); box.mockRestore();
  });

  it("closes a late paint instead of drawing into canvases handed to the next map", async () => {
    const { box, report } = browser(null, 960), late = layers(7, 9), queue = [layers(6), late], answers: (() => void)[] = [];
    const draws = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ transferFromImageBitmap() {} } as never);
    vi.stubGlobal("Worker", class { onmessage?: (reply: { data: unknown }) => void; postMessage() { const data = { layers: queue.shift() }; answers.push(() => this.onmessage?.({ data })); } });
    const left = bare(), stop = smoothGlow(left, vi.fn());
    await report();
    await act(async () => answers.shift()!());
    const handed = [...left.querySelectorAll("canvas")];
    await repaint();
    stop();
    const next = bare(), keep = smoothGlow(next, vi.fn());
    await act(async () => answers.shift()!());
    expect(handed).toHaveLength(6);
    expect(handed.every((each) => each.width === 4)).toBe(true);
    expect(late.every((each) => each.close.mock.calls.length === 1)).toBe(true);
    keep(); left.remove(); next.remove();
    draws.mockRestore(); box.mockRestore();
  });

  it("takes its canvases out of the rings and the Live card when a repaint falls back", async () => {
    const { box, report } = browser(null, 1000), queue = [layers(6), layers(7), null], fail = vi.fn(), dpr = devicePixelRatio;
    const draws = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ transferFromImageBitmap() {} } as never);
    vi.stubGlobal("Worker", class { onmessage?: (reply: { data: unknown }) => void; postMessage() { const data = { layers: queue.shift() }; queueMicrotask(() => this.onmessage?.({ data })); } });
    const mm = bare(), stop = smoothGlow(mm, fail);
    await report();
    await repaint();
    expect(mm.querySelectorAll(".mm-orbit canvas, .mm-smooth-live canvas")).toHaveLength(3);
    vi.stubGlobal("devicePixelRatio", dpr + 1);
    document.documentElement.setAttribute("data-skin", "repaint");
    await repaint();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(mm.querySelectorAll(".mm-orbit canvas, .mm-smooth-live canvas")).toHaveLength(0);
    stop(); mm.remove(); document.documentElement.removeAttribute("data-skin"); vi.stubGlobal("devicePixelRatio", dpr);
    draws.mockRestore(); box.mockRestore();
  });
});
