// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFileDrop } from "./use-file-drop";

let host: HTMLDivElement;
let root: Root;

function Drop({ onFiles, disabled = false }: { onFiles: Parameters<typeof useFileDrop>[0]; disabled?: boolean }) {
  const dragging = useFileDrop(onFiles, disabled);
  return createElement("div", null, dragging ? "dragging" : "idle");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const render = (onFiles: Parameters<typeof useFileDrop>[0], disabled = false) => act(async () => root.render(createElement(Drop, { onFiles, disabled })));
async function drag(type: string, files: File[] = []) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
  await act(async () => { window.dispatchEvent(event); });
}

describe("useFileDrop", () => {
  it("keeps listeners through callback changes and drops into the latest intake", async () => {
    const first = vi.fn();
    const latest = vi.fn();
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    await render(first);
    const dragCalls = (calls: typeof add.mock.calls) => calls.filter(([type]) => ["dragenter", "dragleave", "dragover", "drop"].includes(type));
    expect(dragCalls(add.mock.calls)).toHaveLength(4);
    await drag("dragenter");
    await render(latest);
    expect(dragCalls(add.mock.calls)).toHaveLength(4);
    expect(dragCalls(remove.mock.calls)).toHaveLength(0);
    await drag("dragleave");
    expect(host.textContent).toBe("idle");
    const file = new File(["notes"], "notes.txt");
    await drag("drop", [file]);
    expect(first).not.toHaveBeenCalled();
    expect(latest.mock.calls[0][0]).toEqual([file]);
    expect(host.textContent).toBe("idle");
  });

  it("clears the highlight and depth when disabled mid-drag", async () => {
    const onFiles = vi.fn();
    await render(onFiles);
    await drag("dragenter");
    await drag("dragenter");
    await render(onFiles, true);
    expect(host.textContent).toBe("idle");
    await render(onFiles);
    await drag("dragenter");
    await drag("dragleave");
    expect(host.textContent).toBe("idle");
    await render(onFiles, true);
    await drag("drop", [new File(["notes"], "blocked.txt")]);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("invalidates an async intake when its callback changes or it unmounts", async () => {
    let isActive!: () => boolean;
    await render((_files, active) => { isActive = active; });
    await drag("drop");
    expect(isActive()).toBe(true);
    await render(vi.fn());
    expect(isActive()).toBe(false);
    await render((_files, active) => { isActive = active; });
    await drag("drop");
    await act(async () => root.render(null));
    expect(isActive()).toBe(false);
  });
});
