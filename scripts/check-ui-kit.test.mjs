import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkUiKit, uiKitHits } from "./check-ui-kit.mjs";

const tsx = "src/components/Fixture.tsx";
const css = "src/components/Fixture.css";
const back = 'import { ChevronLeft } from "lucide-react"; export const A = ({ back }) => <button onClick={back}><ChevronLeft />Settings</button>;';

describe("ui kit gate", () => {
  it.each([
    ["motion", ".card { transition: opacity 150ms ease-out; }", css],
    ["motion", ".card { animation: pop 0.2s cubic-bezier(0.2, 0, 0, 1) both; }", css],
    ["motion", 'export const A = () => <div className="transition-opacity duration-200 ease-out" />;', tsx],
    ["motion", 'export const A = () => <div className="animate-[fade-in_180ms_ease-out]" />;', tsx],
    ["motion", 'export const A = () => <div style={{ transition: "transform 240ms ease" }} />;', tsx],
    ["motion", 'el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });', tsx],
    ["back", back, tsx],
    ["back", "export const A = ({ back }) => <button onClick={back}>‹ Forum</button>;", tsx],
    ["menu", 'export const A = () => <div role="menu" className="fixed z-40 rounded-lg bg-panel py-1 shadow-lg" />;', tsx],
    ["menu", 'export const A = () => <div className="animate-pop-in fixed z-40 rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60" />;', tsx],
    ["menu", 'export const A = () => <button role="menuitem" className="flex w-full px-3 py-2 hover:bg-raised">Copy</button>;', tsx],
    ["button", 'export const A = () => <button className="rounded-lg bg-accent px-3 py-2 text-accent-ink hover:brightness-110">Save</button>;', tsx],
    ["switch", 'export const A = ({ on }) => <button role="switch" aria-checked={on} className="h-6 w-11 rounded-full bg-control" />;', tsx],
    ["segmented", 'export const A = () => <div role="radiogroup" className="flex rounded-lg bg-inset p-[3px]"><button role="radio">One</button></div>;', tsx],
    ["button", "export const A = ({ extra }) => <button className={`bg-accent text-accent-ink ${extra}`}>Save</button>;", tsx],
    ["segmented", "export const A = ({ extra }) => <div role=\"radiogroup\" className={`rounded-lg bg-inset p-[3px] ${extra}`} />;", tsx],
    ["menu", 'export const A = () => <div role="menu" className="animate-pop-in fixed z-40 rounded-xl border border-hairline/50 bg-card py-1.5 shadow-2xl shadow-black/60" />;', tsx],
    ["motion", "el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, iterations: untilInfinityMs });", tsx],
    ["press", 'export const A = () => <button className="rounded-md px-2 transition-colors hover:bg-raised">Save</button>;', tsx],
    ["press", 'export const A = () => <button className="rounded-md px-2 hover:bg-raised active:scale-95">Save</button>;', tsx],
    ["press", 'export const A = ({ go }) => <div onClick={go} className="rounded-lg px-3 hover:bg-raised">Open</div>;', tsx],
  ])("rejects a hand-rolled %s: %s", (rule, source, file) => {
    expect(uiKitHits(file, source).map((hit) => hit.rule)).toEqual([rule]);
  });

  it.each([
    [".card { transition: opacity var(--motion-fast) var(--ease-standard); }", css],
    [".card { animation: pop-in var(--motion-moderate) var(--ease-standard, cubic-bezier(.2, 0, .38, .9)) both; }", css],
    [".spinner { animation: spin 1s linear infinite; }", css],
    ['el.animate([{ rotate: "0deg" }, { rotate: "360deg" }], { duration: 1200, iterations: Infinity });', tsx],
    ['export const A = () => <button className="rounded-md px-2 hover:bg-raised">Save</button>;', tsx],
    ['export const A = () => <button className="transition hover:bg-raised motion-reduce:transition-none">Move</button>;', tsx],
    ['export const A = ({ drag }) => <div role="separator" onClick={drag} className="hover:bg-accent/40" />;', tsx],
    ["@media (prefers-reduced-motion: reduce) { * { transition-duration: .01ms !important; } }", css],
    [":root { --motion-fast: 110ms; --ease-standard: cubic-bezier(0.2, 0, 0.38, 0.9); }", "src/motion.css"],
    ['export const A = () => <div className="animate-pop-in transition-opacity duration-(--motion-fast) ease-standard" />;', tsx],
    ['import { EASE_STANDARD, MOTION_LARGE_MS } from "@/lib/motion"; el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION_LARGE_MS, easing: EASE_STANDARD });', tsx],
    ["export const A = ({ ms }) => <div style={{ animation: `drain ${ms}ms linear forwards` }} />;", tsx],
    ['import { BackButton } from "./BackButton"; export const A = ({ back }) => <BackButton label="Settings" ariaLabel="Back" onClick={back} />;', tsx],
    ['import { ChevronLeft, ChevronRight } from "lucide-react"; export const A = ({ go }) => <div><button aria-label="Previous" onClick={() => go(-1)}><ChevronLeft /></button><button aria-label="Next" onClick={() => go(1)}><ChevronRight /></button></div>;', tsx],
    ['import { MENU_ITEM_HOVER } from "@/lib/menu-style"; import { MENU_CLASS } from "./MessageMenu"; const ROW = cn("flex w-full px-3 py-2", MENU_ITEM_HOVER); export const A = () => <div role="menu" className={MENU_CLASS}><button role="menuitem" className={ROW}>Copy</button></div>;', tsx],
    ['import { PRIMARY_BUTTON } from "@/lib/button-style"; export const A = () => <button className={cn("rounded-lg px-3 py-2", PRIMARY_BUTTON)}>Save</button>;', tsx],
    ['import { SwitchRow } from "./BotDetailsRows"; export const A = ({ on, flip }) => <SwitchRow label="Alerts" on={on} onToggle={flip} />;', tsx],
    ['import { SegmentedRow } from "./Segmented"; export const A = ({ value, pick }) => <SegmentedRow label="Style" value={value} options={[{ id: "a", label: "A" }, { id: "b", label: "B" }]} onChange={pick} />;', tsx],
  ])("accepts the shared part: %s", (source, file) => {
    expect(uiKitHits(file, source)).toEqual([]);
  });

  it("fails the gate for a new file and for one more in a listed file, naming the fix", () => {
    expect(checkUiKit([tsx], () => back, {})).toEqual([`${tsx}:1: hand-rolled back button; use <BackButton> from src/components/BackButton.tsx (docs/ui-kit.md#back)`]);
    expect(checkUiKit([tsx], () => back, { back: { [tsx]: 1 } })).toEqual([]);
    const errors = checkUiKit([tsx], () => `${back}\n${back}`, { back: { [tsx]: 1 } });
    expect(errors).toHaveLength(2);
    expect(errors[1]).toContain(`${tsx}:2: hand-rolled back button (one of 2; ui-kit.json allows 1)`);
  });

  it("fails the gate when a listed file has fewer hits than its entry permits, or is gone", () => {
    expect(checkUiKit([tsx], () => "", { menu: { [tsx]: 2 } })).toEqual([`${tsx}: ui-kit.json allows 2 menu hits but the file has 0; run node scripts/check-ui-kit.mjs --lower`]);
    expect(checkUiKit([], () => "", { motion: { "src/gone.css": 1 } })).toEqual(["src/gone.css: ui-kit.json allows 1 motion hits but the file has 0; run node scripts/check-ui-kit.mjs --lower"]);
  });

  it("accepts the repository with only its listed hand-rolled parts", () => {
    expect(checkUiKit()).toEqual([]);
  });

  it("gives every button the shared press and fade", () => {
    const css = readFileSync(new URL("../src/motion.css", import.meta.url), "utf8");
    expect(css).toMatch(/@layer base \{\s*:where\(button[^{]*\{\s*transition-property:[^;]*\bscale;\s*transition-duration: var\(--motion-fast\);\s*transition-timing-function: var\(--ease-standard\);/);
    expect(css).toMatch(/:where\(button, \[role="button"\]\):not\(:disabled\):active \{\s*scale: 0\.97;/);
  });
});
