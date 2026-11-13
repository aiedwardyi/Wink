import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const host_ = vi.hoisted(() => ({ platform: "win32", dictation: false }));

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
  return { ...actual, useDesktopCapabilities: () => ({ capabilities: { host: { platform: host_.platform }, dictation: { available: host_.dictation } }, ready: true }) };
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

const mic = () => host!.querySelector('button[aria-label="Dictate"], button[aria-label="Start dictation"]');

describe("composer dictate button", () => {
  it("shows no mic on Windows", async () => {
    Object.assign(host_, { platform: "win32", dictation: false });
    await mount();
    expect(mic()).toBeNull();
  });

  it("shows the mic where native dictation is available", async () => {
    Object.assign(host_, { platform: "darwin", dictation: true });
    await mount();
    expect(mic()).not.toBeNull();
  });
});
