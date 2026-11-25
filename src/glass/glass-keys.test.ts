import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { neighborId } from "@/lib/phone-swipe";
import { choiceMove, glassKey, linesAbove, olderWindow, replyMove, spokenDigits, type GlassAction } from "./glass-keys";

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;
const KEYS = [...ARROWS, "Enter"] as const;

const pairSource = readFileSync(new URL("../../public/pair.html", import.meta.url), "utf8");
const pairDigits = /const spokenDigits = (\(text\) => \{[\s\S]*?\n {8}\});/.exec(pairSource)?.[1];

const SPOKEN: [string, string][] = [
  ["482917", "482917"],
  ["4 8 2 9 1 7", "482917"],
  ["four eight two nine one seven", "482917"],
  ["Four, eight, two. Nine one seven.", "482917"],
  ["for ate to nine won seven", "482917"],
  ["zero oh 1 too three", "00123"],
  ["the code is 48 29 17", "482917"],
  ["constructor toString 4", "4"],
  ["", ""],
];

describe("glasses keys", () => {
  it("both glasses pages ask the device to route D-pad and wrist input to them", () => {
    const indexSource = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    for (const page of [indexSource, pairSource]) expect(page).toContain('<meta name="mrbd-web-app-capable" content="yes" />');
  });

  it.each(["../../public/pair.html", "./glass.css"])("%s draws every text field, since the lens never opens dictation on an opacity 0 one", (path) => {
    const unseen = [...readFileSync(new URL(path, import.meta.url), "utf8").matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, selector, body]) => /\binput\b/.test(selector!) && /opacity:\s*0(?![.\d])/.test(body!))
      .map(([, selector]) => selector!.trim());
    expect(unseen, "draw it with color: transparent and padding-left: 100% (see .glass-pill input) instead of opacity: 0").toEqual([]);
  });

  it("a question under the newest reply: ArrowUp and ArrowDown walk it and its choices, Enter answers", () => {
    expect(glassKey("chat", "ask", "ArrowDown")).toEqual({ type: "ask", dir: 1 });
    expect(glassKey("chat", "ask", "Enter")).toBeNull();
    expect(glassKey("chat", "choice", "ArrowUp")).toEqual({ type: "choice", dir: -1 });
    expect(glassKey("chat", "choice", "Enter")).toEqual({ type: "answer" });
    expect(glassKey("chat", "choice", "ArrowRight")).toEqual({ type: "chat", step: 1 });
    expect(replyMove({ index: 0, count: 1, atTop: true, atBottom: true, older: false, ask: true }, 1)).toEqual({ type: "ask" });
    expect([choiceMove(0, 2, -1), choiceMove(0, 2, 1), choiceMove(1, 2, 1)]).toEqual([{ type: "ask" }, { type: "choice", index: 1 }, { type: "bar" }]);
  });

  it("an open question takes the newest reply's first ArrowDown, however long the reply", () => {
    const at = { index: 1, count: 2, atTop: true, atBottom: false, older: false, ask: true };
    expect(replyMove({ ...at, askFirst: true }, 1)).toEqual({ type: "ask" });
    expect(replyMove(at, 1)).toEqual({ type: "scroll", dir: 1 });
    expect(replyMove({ ...at, index: 0, askFirst: true }, 1)).toEqual({ type: "scroll", dir: 1 });
  });

  it("a focused 200-character choice fits its card: five lines, the reply steps aside", () => {
    const css = readFileSync(new URL("./glass.css", import.meta.url), "utf8");
    const rule = (selector: string) => new RegExp(selector.replace(/[.()]/g, "\\$&") + " \\{([^}]*)\\}").exec(css)?.[1] ?? "";
    const px = (body: string, prop: string) => Number(new RegExp("(?:^|[;\\s])" + prop + ":\\s*([\\d.]+)").exec(body)?.[1]);
    const choice = rule(".glass-choice");
    // .glass button's font: inherit outranks .glass-choice, so its line-height needs !important like its font-size
    expect(choice).toMatch(/line-height:\s*[\d.]+ !important/);
    const line = px(choice, "font-size") * px(choice, "line-height");
    const fivelines = 5 * line + 2 * 9 + 2 * 2.5 + 2 * px(rule(".glass-choices"), "padding");
    expect(px(rule(".glass-choices:focus-within"), "min-height")).toBeGreaterThanOrEqual(Math.floor(fivelines));
    expect(rule(".glass-stream:has(.glass-choice:focus) .glass-bot")).toMatch(/display:\s*none/);
  });

  it("ArrowLeft and ArrowRight step chats in the phone's order and stop at both ends", () => {
    const ids = ["juno", "atlas", "orion", "vega"];
    const step = (current: string, key: string) => {
      const action = glassKey("chat", "speak", key);
      return action?.type === "chat" ? neighborId(ids, current, action.step) : undefined;
    };
    expect(step("atlas", "ArrowRight")).toBe("orion");
    expect(step("atlas", "ArrowLeft")).toBe("juno");
    expect(step("vega", "ArrowRight")).toBeNull();
    expect(step("juno", "ArrowLeft")).toBeNull();
    expect(glassKey("chat", "bar", "ArrowRight")).toEqual({ type: "chat", step: 1 });
    expect(glassKey("chat", "older", "ArrowLeft")).toEqual({ type: "chat", step: -1 });
  });

  it("ArrowUp and ArrowDown move through the replies from Speak", () => {
    expect(glassKey("chat", "speak", "ArrowUp")).toEqual({ type: "reply", dir: -1 });
    expect(glassKey("chat", "speak", "ArrowDown")).toEqual({ type: "reply", dir: 1 });
  });

  it("the model bar under the newest reply: Enter opens the model list, ArrowUp returns to the reply, ArrowDown to Read aloud", () => {
    expect(glassKey("chat", "bar", "Enter")).toEqual({ type: "models" });
    expect(glassKey("chat", "bar", "ArrowUp")).toEqual({ type: "messages" });
    expect(glassKey("chat", "bar", "ArrowDown")).toEqual({ type: "toListen" });
  });

  it("See more: Enter loads older replies, ArrowDown returns to the oldest shown, ArrowUp stays", () => {
    expect(glassKey("chat", "older", "Enter")).toEqual({ type: "older" });
    expect(glassKey("chat", "older", "ArrowDown")).toEqual({ type: "messages" });
    expect(glassKey("chat", "older", "ArrowUp")).toBeNull();
  });

  it("Read aloud sits under the model bar: Enter reads the reply, ArrowUp returns to the bar", () => {
    expect(glassKey("chat", "listen", "Enter")).toEqual({ type: "listen" });
    expect(glassKey("chat", "listen", "ArrowUp")).toEqual({ type: "toBar" });
    expect(glassKey("chat", "listen", "ArrowDown")).toBeNull();
    expect(glassKey("chat", "listen", "ArrowLeft")).toEqual({ type: "chat", step: -1 });
  });

  it("Enter on an empty Speak leaves the field to open the system composer; with text it goes to Check", () => {
    expect(glassKey("chat", "speak", "Enter")).toEqual({ type: "composer" });
    expect(glassKey("chat", "speak", "Enter", true)).toEqual({ type: "check" });
  });

  it("only Enter on Send in Check sends", () => {
    const sends: string[] = [];
    for (const screen of ["chat", "check", "models"] as const) {
      for (const focus of ["speak", "bar", "older", "listen", "send", "again", "other"] as const) {
        for (const key of KEYS) {
          for (const text of [false, true]) {
            const action: GlassAction = glassKey(screen, focus, key, text);
            if (action?.type === "send") sends.push(`${screen}/${focus}/${key}`);
          }
        }
      }
    }
    expect([...new Set(sends)]).toEqual(["check/send/Enter"]);
  });

  it("Check: Redo sits left of Send, a new draft replaces the old one", () => {
    expect(glassKey("check", "send", "ArrowLeft")).toEqual({ type: "again" });
    expect(glassKey("check", "again", "ArrowRight")).toEqual({ type: "toSend" });
    expect(glassKey("check", "send", "ArrowDown")).toEqual({ type: "again" });
    expect(glassKey("check", "again", "ArrowUp")).toEqual({ type: "toSend" });
    expect(glassKey("check", "again", "Enter")).toEqual({ type: "composer" });
    expect(glassKey("check", "again", "Enter", true)).toEqual({ type: "check" });
  });

  it("the model list moves with ArrowUp and ArrowDown and picks with Enter", () => {
    expect(glassKey("models", "other", "ArrowUp")).toEqual({ type: "model", dir: -1 });
    expect(glassKey("models", "other", "ArrowDown")).toEqual({ type: "model", dir: 1 });
    expect(glassKey("models", "other", "Enter")).toEqual({ type: "pick" });
    expect(glassKey("models", "other", "ArrowLeft")).toBeNull();
  });

  it("ArrowUp scrolls a long reply to its start, then steps to older replies, then to See more", () => {
    const at = { index: 2, count: 3, atTop: true, atBottom: true, older: true };
    expect(replyMove({ ...at, atTop: false }, -1)).toEqual({ type: "scroll", dir: -1 });
    expect(replyMove(at, -1)).toEqual({ type: "message", index: 1 });
    expect(replyMove({ ...at, index: 1 }, -1)).toEqual({ type: "message", index: 0 });
    expect(replyMove({ ...at, index: 0 }, -1)).toEqual({ type: "older" });
    expect(replyMove({ ...at, index: 0, older: false }, -1)).toEqual({ type: "none" });
    expect(replyMove({ ...at, index: 0, count: 0, older: false }, -1)).toEqual({ type: "none" });
  });

  it("ArrowDown scrolls a long reply to its end, then steps to newer replies, then to the model bar", () => {
    const at = { index: 0, count: 3, atTop: true, atBottom: true, older: false };
    expect(replyMove({ ...at, atBottom: false }, 1)).toEqual({ type: "scroll", dir: 1 });
    expect(replyMove(at, 1)).toEqual({ type: "message", index: 1 });
    expect(replyMove({ ...at, index: 2 }, 1)).toEqual({ type: "bar" });
  });

  it("Up reaches the 10 newest replies; See more shows while older ones are loaded or on the server", () => {
    expect(olderWindow(4, 10, false)).toEqual({ first: 0, older: false });
    expect(olderWindow(4, 10, true)).toEqual({ first: 0, older: true });
    expect(olderWindow(25, 10, false)).toEqual({ first: 15, older: true });
    expect(olderWindow(25, 20, false)).toEqual({ first: 5, older: true });
    expect(olderWindow(25, 30, false)).toEqual({ first: 0, older: false });
  });

  it("counts the lines above the panel's cue, the hidden line under it included", () => {
    expect(linesAbove(0, 40)).toBe(0);
    expect(linesAbove(40, 40)).toBe(2);
    expect(linesAbove(120, 40)).toBe(4);
  });

  it.each(SPOKEN)("turns spoken digits %j into %j", (said, digits) => {
    expect(spokenDigits(said)).toBe(digits);
  });

  it("pair.html reads spoken digits the same way", () => {
    expect(pairDigits, "spokenDigits not found in pair.html").toBeTruthy();
    // SAFETY: the matched source is pair.html's arrow from said text to digits.
    const read = vm.runInNewContext(`(${pairDigits})`) as (text: string) => string;
    for (const [said, digits] of SPOKEN) expect(read(said), said).toBe(digits);
  });
});
