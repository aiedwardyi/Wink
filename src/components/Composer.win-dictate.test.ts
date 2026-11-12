import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const host_ = vi.hoisted(() => ({ platform: "win32" }));

vi.mock("@/state/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/state/store")>();
  return {
    ...actual,
    api: vi.fn(async () => ({})),
    useStore: () => ({
      state: { acceptedSends: {}, bots: [], composerFocusBotId: "", instances: [], pendingQueued: {} },
      dispatch: vi.fn(),
    }),
  };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./DesktopCapabilities")>();
  return { ...actual, useDesktopCapabilities: () => ({ capabilities: { host: { platform: host_.platform }, dictation: { available: false } }, ready: true }) };
});

import { Composer } from "./Composer";

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Composer, { replyTo: null, focusBlocked: false, locked: false })));
}

const mic = () => host!.querySelector('button[aria-label="Dictate"]') as HTMLButtonElement | null;

describe("composer Windows dictate hint", () => {
  it("shows the mic on Windows, focuses the box and shows the tip on tap", async () => {
    host_.platform = "win32";
    await mount();
    expect(host!.textContent).not.toContain("Press ⊞ + H to talk");
    await act(async () => mic()!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(document.activeElement).toBe(host!.querySelector("[data-orbit-composer]"));
    expect(host!.textContent).toContain("Press ⊞ + H to talk");
  });

  it("shows no mic off Windows", async () => {
    host_.platform = "other";
    await mount();
    expect(mic()).toBeNull();
  });
});
