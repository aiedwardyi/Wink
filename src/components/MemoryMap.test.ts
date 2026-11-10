// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import { LIGHT_SKIN_IDS, SKINS } from "@/lib/skins";
import type { Bot } from "@/state/store";
import { MemoryMap } from "./MemoryMap";

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

  it("gives Muscle Memory its own hue on the icon and the count", () => {
    const muscle = (part: string) => css.match(new RegExp(`^\\[data-kind="muscle"\\] ${part} \\{([^}]*)\\}`, "m"))?.[1] ?? "";
    expect(rule(".mm")).toContain("--mm-fuchsia: 232 121 249;");
    expect(muscle(".mm-icon")).toContain("color: rgb(var(--mm-fuchsia));");
    expect(muscle(".mm-count b")).toContain("rgb(var(--mm-fuchsia))");
    expect(rule(".mm-bottom .mm-count b")).not.toContain("color:");
  });

  it("keeps Live now at 4.5:1 on its panel in every skin, in the same cyan hue", () => {
    const skins = ["../styles.css", "../skins/fresh-dark.css"].map((file) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8")).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const rootCard = skins.match(/(?:@theme|:root)\s*\{[^}]*--color-card:\s*(#[0-9a-f]{6})/i)![1];
    const card = (id: string) => [...skins.matchAll(/([^{}]*)\{[^{}]*--color-card:\s*(#[0-9a-f]{6})[^{}]*\}/gi)].filter(([, selector]) => selector.includes(`[data-skin="${id}"]`)).at(-1)?.[2] ?? rootCard;
    const hex = (value: string) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
    const lum = (rgb: number[]) => rgb.map((c) => c / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const hue = ([r, g, b]: number[]) => { const max = Math.max(r, g, b), d = max - Math.min(r, g, b); return 60 * (max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d); };
    const triplet = (name: string, body: string) => body.match(new RegExp(`--mm-${name}: (\\d+ \\d+ \\d+);`))![1].split(" ").map(Number);
    const light = css.slice(css.indexOf(":is([data-skin="));
    const [cyan, indigo, lightInk] = [triplet("cyan", rule(".mm")), triplet("indigo", rule(".mm")), triplet("live-ink", light)];
    expect(rule(".mm")).toContain("--mm-live-ink: var(--mm-cyan);");
    expect(rule(".mm-live-tag")).toContain("color: rgb(var(--mm-live-ink));");
    expect(Math.abs(hue(lightInk) - hue(cyan))).toBeLessThan(1);
    for (const { id } of SKINS) {
      expect(light.slice(0, light.indexOf(" .mm {")).includes(`[data-skin="${id}"]`), id).toBe(LIGHT_SKIN_IDS.has(id));
      const panel = hex(card(id)).map((c, i) => c * 0.92 + indigo[i] * 0.08);
      const [hi, lo] = [lum(LIGHT_SKIN_IDS.has(id) ? lightInk : cyan), lum(panel)].sort((a, b) => b - a);
      expect((hi + 0.05) / (lo + 0.05), id).toBeGreaterThanOrEqual(4.5);
    }
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
