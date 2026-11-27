// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeBoxes } from "./CodeBoxes";

let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function mount(onDone = vi.fn(), onOther = vi.fn()) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  function Host() {
    const [value, setValue] = useState("");
    return createElement(CodeBoxes, { value, onChange: setValue, onDone, onOther, label: "Code" });
  }
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(createElement(Host)));
  return { boxes: [...document.querySelectorAll("input")], onDone, onOther };
}

const value = (boxes: HTMLInputElement[]) => boxes.map((box) => box.value).join("");

async function type(box: HTMLInputElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function paste(box: HTMLInputElement, text: string) {
  await act(async () => {
    const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    event.clipboardData = { getData: () => text };
    box.dispatchEvent(event);
  });
}

async function key(box: HTMLInputElement, name: string) {
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

describe("8-box code input", () => {
  it("renders eight boxes with a phone-friendly keyboard", async () => {
    const { boxes } = await mount();
    expect(boxes).toHaveLength(8);
    for (const box of boxes) {
      expect(box.getAttribute("autocapitalize")).toBe("characters");
      expect(box.getAttribute("inputmode")).toBe("text");
      expect(box.getAttribute("autocomplete")).toBe("one-time-code");
    }
  });

  it("uppercases, drops ambiguous characters and moves to the next box", async () => {
    const { boxes } = await mount();
    await type(boxes[0]!, "a");
    expect(boxes[0]!.value).toBe("A");
    expect(document.activeElement).toBe(boxes[1]);
    await type(boxes[1]!, "0");
    await type(boxes[1]!, "O");
    expect(boxes[1]!.value).toBe("");
    expect(document.activeElement).toBe(boxes[1]);
  });

  it("fills every box from one paste and finishes", async () => {
    const { boxes, onDone } = await mount();
    await paste(boxes[3]!, " abcd-efgh ");
    expect(value(boxes)).toBe("ABCDEFGH");
    expect(onDone).toHaveBeenCalledExactlyOnceWith("ABCDEFGH");
  });

  it("finishes on a pasted 6-character code minted before", async () => {
    const { boxes, onDone } = await mount();
    await paste(boxes[0]!, " abc-def ");
    expect(value(boxes)).toBe("ABCDEF");
    expect(onDone).toHaveBeenCalledWith("ABCDEF");
  });

  it("waits on a typed 6-character code until Enter", async () => {
    const { boxes, onDone } = await mount();
    for (const [i, ch] of [..."GHJKLM"].entries()) await type(boxes[i]!, ch);
    expect(onDone).not.toHaveBeenCalled();
    await key(boxes[6]!, "Enter");
    expect(onDone).toHaveBeenCalledExactlyOnceWith("GHJKLM");
  });

  it("hands a long code or other text over whole instead of filling the boxes", async () => {
    const { boxes, onOther, onDone } = await mount();
    const long = `wkr1:abcdefghijklmnop.wink.test:inv1.wki_${"s".repeat(43)}`;
    await paste(boxes[2]!, long);
    await paste(boxes[0]!, "hello there");
    expect(onOther.mock.calls).toEqual([[long], ["hello there"]]);
    expect(value(boxes)).toBe("");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("goes back a box on backspace from an empty one", async () => {
    const { boxes } = await mount();
    await type(boxes[0]!, "A");
    await type(boxes[1]!, "B");
    await key(boxes[2]!, "Backspace");
    expect(value(boxes)).toBe("A");
    expect(document.activeElement).toBe(boxes[1]);
  });

  it("clears only the box Backspace is on in a full code, and finishes once it is typed again", async () => {
    const { boxes, onDone } = await mount();
    for (const [i, ch] of [..."GHJKLMNP"].entries()) await type(boxes[i]!, ch);
    onDone.mockClear();
    await key(boxes[2]!, "Backspace");
    expect(boxes.map((box) => box.value)).toEqual(["G", "H", "", "K", "L", "M", "N", "P"]);
    expect(document.activeElement).toBe(boxes[2]);
    await type(boxes[2]!, "X");
    expect(value(boxes)).toBe("GHXKLMNP");
    expect(onDone).toHaveBeenCalledExactlyOnceWith("GHXKLMNP");
  });

  it("finishes once the last box is typed", async () => {
    const { boxes, onDone } = await mount();
    for (const [i, ch] of [..."GHJKLMNP"].entries()) await type(boxes[i]!, ch);
    expect(onDone).toHaveBeenCalledWith("GHJKLMNP");
  });

  it("fixes one wrong letter mid-code without wiping the boxes after it", async () => {
    const { boxes, onDone } = await mount();
    await paste(boxes[0]!, "ABXDEFGH");
    onDone.mockClear();
    await type(boxes[2]!, "C");
    expect(value(boxes)).toBe("ABCDEFGH");
    expect(document.activeElement).toBe(boxes[3]);
    expect(onDone).toHaveBeenCalledWith("ABCDEFGH");
  });

  it("reads Korean keyboard letters as the keys they sit on", async () => {
    const { boxes, onDone } = await mount();
    for (const [i, ch] of [..."ㅁㅠㅊ2ㄸ"].entries()) await type(boxes[i]!, ch);
    expect(value(boxes)).toBe("ABC2E");
    await type(boxes[5]!, "ㄹ");
    await type(boxes[6]!, "ㅎ");
    await type(boxes[7]!, "ㅗ");
    expect(onDone).toHaveBeenCalledWith("ABC2EFGH");
  });

  it("splits a composed Hangul syllable into its keys", async () => {
    const { boxes } = await mount();
    await type(boxes[0]!, "닭");
    expect(value(boxes)).toBe("EKFR");
    expect(document.activeElement).toBe(boxes[4]);
  });
});
