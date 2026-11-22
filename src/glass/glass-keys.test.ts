import { readFileSync } from "node:fs";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { neighborId } from "@/lib/phone-swipe";
import { glassKey, linesAbove, replyMove, spokenDigits, type GlassAction } from "./glass-keys";

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
    expect(glassKey("chat", "header", "ArrowRight")).toEqual({ type: "chat", step: 1 });
  });

  it("ArrowUp and ArrowDown move through the reply, never to the model chip", () => {
    expect(glassKey("chat", "speak", "ArrowUp")).toEqual({ type: "reply", dir: -1 });
    expect(glassKey("chat", "speak", "ArrowDown")).toEqual({ type: "reply", dir: 1 });
  });

  it("Enter on the model chip opens the model list; ArrowDown goes back to the messages", () => {
    expect(glassKey("chat", "header", "Enter")).toEqual({ type: "models" });
    expect(glassKey("chat", "header", "ArrowDown")).toEqual({ type: "messages" });
    expect(glassKey("chat", "header", "ArrowUp")).toBeNull();
  });

  it("Read aloud sits under the newest reply: Enter reads it, ArrowUp returns to Speak", () => {
    expect(glassKey("chat", "listen", "Enter")).toEqual({ type: "listen" });
    expect(glassKey("chat", "listen", "ArrowUp")).toEqual({ type: "messages" });
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
      for (const focus of ["speak", "header", "listen", "send", "again", "other"] as const) {
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

  it("ArrowUp past the top of a reply steps to older messages, then to the header", () => {
    expect(replyMove({ index: 2, count: 3, atTop: false, atBottom: true }, -1)).toEqual({ type: "scroll", dir: -1 });
    expect(replyMove({ index: 2, count: 3, atTop: true, atBottom: false }, -1)).toEqual({ type: "message", index: 1, edge: "bottom" });
    expect(replyMove({ index: 1, count: 3, atTop: true, atBottom: true }, -1)).toEqual({ type: "message", index: 0, edge: "bottom" });
    expect(replyMove({ index: 0, count: 3, atTop: true, atBottom: false }, -1)).toEqual({ type: "header" });
    expect(replyMove({ index: 0, count: 0, atTop: true, atBottom: true }, -1)).toEqual({ type: "header" });
  });

  it("ArrowDown returns toward the newest message and stops there", () => {
    expect(replyMove({ index: 0, count: 3, atTop: true, atBottom: false }, 1)).toEqual({ type: "scroll", dir: 1 });
    expect(replyMove({ index: 0, count: 3, atTop: false, atBottom: true }, 1)).toEqual({ type: "message", index: 1, edge: "top" });
    expect(replyMove({ index: 2, count: 3, atTop: false, atBottom: true }, 1)).toEqual({ type: "none" });
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
    const read = vm.runInNewContext(`(${pairDigits})`) as (text: string) => string;
    for (const [said, digits] of SPOKEN) expect(read(said), said).toBe(digits);
  });
});
