import { Window } from "happy-dom";
import { expect, it } from "vitest";
import { check, observe } from "./details.mjs";

for (const [width, count] of [[1280, 0], [392, 1]]) it(`checks a 20 px tap target at ${width} px`, async () => {
  const window = new Window({ width });
  try {
    const button = window.document.createElement("button");
    button.getBoundingClientRect = () => ({ x: 0, y: 0, width: 20, height: 20 });
    window.document.body.append(button);
    const data = window.eval(`(${observe.toString()})`)({ all: () => [button], visible: () => true, where: () => "button" });
    expect(data.rows.filter(row => row.rule === "tap size")).toHaveLength(count);
    expect(check(data).details.filter(row => row.rule === "tap size")).toHaveLength(count);
  } finally { await window.happyDOM.close(); }
});
