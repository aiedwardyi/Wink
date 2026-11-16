import "./ProfileFields.test-dom.ts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import { I18nProvider } from "@/lib/i18n";
import { BotProfileAvatarCard } from "./BotProfileAvatarCard";

// SAFETY: the card reads only the avatar fields of Bot.
const uploaded = {
  id: "bot-1",
  name: "Friend",
  color: "green",
  mascotStyle: "icon-33",
  avatarUrl: "/api/attachments/abc-123.png",
  avatarCrop: "circle",
} as Bot;

afterEach(() => {
  document.body.replaceChildren();
});

async function renderCard(bot: Bot, onPatch = vi.fn()) {
  HTMLElement.prototype.scrollIntoView = () => {};
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(BotProfileAvatarCard, {
      bot,
      activeState: "idle",
      mascotMotion: null,
      onPatch,
    })));
  });
  return { host, root, onPatch };
}

describe("BotProfileAvatarCard", () => {
  it("keeps the preset grid open with an uploaded image, and a pick replaces it", async () => {
    const { host, root, onPatch } = await renderCard(uploaded);
    try {
      const presets = host.querySelectorAll<HTMLButtonElement>("button[aria-pressed]");
      expect(presets.length).toBeGreaterThan(0);
      expect([...presets].some((button) => button.getAttribute("aria-pressed") === "true")).toBe(false);
      const geometric = host.querySelector<HTMLButtonElement>('button[title="Wink geometric"]');
      expect(geometric).not.toBeNull();
      await act(async () => geometric!.click());
      expect(onPatch).toHaveBeenCalledWith({ mascotStyle: "icon-50", avatarCrop: "mascot" });
    } finally {
      await act(async () => root.unmount());
    }
  });
});
