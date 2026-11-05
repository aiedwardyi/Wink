import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ bots: [] as Bot[], dispatch: vi.fn() }));

vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({})),
  useStore: () => ({
    state: { bots: h.bots, acceptedSends: {}, instances: [], pendingQueued: {} },
    dispatch: h.dispatch,
  }),
}));

import { type Bot, type Group } from "@/state/store";
import { BotAvatar } from "./Avatar";
import { Composer } from "./Composer";

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  window.localStorage.clear();
  vi.clearAllMocks();
});

const bot = (id: string, picture: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "",
  notifications: false, color: "blue", unread: false, messages: [],
  modelSelection: { instanceId: "grok", model: "grok" }, ...picture,
});

describe.each(["chat", "group"])("%s mention avatars", (context) => {
  it.each([
    { mascotStyle: "icon-01", avatarCrop: "mascot" },
    { avatarUrl: "/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp", avatarCrop: "rounded" },
    { mascotStyle: "teal", avatarCrop: "mascot" },
    {},
  ] satisfies Partial<Bot>[])("matches the bot list for %j", async (picture) => {
    const active = bot("Active");
    const peer = bot("Scout", picture);
    h.bots = [active, peer];
    const group: Group = {
      id: "room", threadId: "room-thread", name: "Room", memberIds: [peer.id], messages: [],
      defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0,
    };
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await act(async () => root!.render(createElement("div", null,
      createElement("div", { "data-reference": "" }, createElement(BotAvatar, { bot: peer, size: 24, state: "happy" })),
      createElement(Composer, context === "chat" ? { bot: active } : { group, members: [peer] }),
    )));
    const input = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "@");
      input.setSelectionRange(1, 1);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const options = [...host.querySelectorAll('[role="option"]')];
    const row = options.find((option) => option.textContent?.includes(peer.name))!;
    expect(row).toBeDefined();
    const reference = host.querySelector("[data-reference]")!;
    const image = row.querySelector("img");
    if (reference.querySelector("img")) {
      expect(image?.outerHTML).toBe(reference.querySelector("img")!.outerHTML);
      expect(row.querySelector(".mascot-avatar")).toBeNull();
    } else {
      expect(image).toBeNull();
      expect(row.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(peer.name);
      expect([...row.querySelectorAll("path")].map((path) => path.getAttribute("d")))
        .toEqual([...reference.querySelectorAll("path")].map((path) => path.getAttribute("d")));
      expect((row.querySelector(".mascot-avatar") as HTMLElement).style.width).toBe("24px");
    }
    if (context === "group") {
      expect(options[0].textContent).toContain("everyone");
      expect(options[0].querySelector("svg.lucide-users")).not.toBeNull();
      expect(options[0].querySelector("img, .mascot-avatar")).toBeNull();
    }
  });
});
