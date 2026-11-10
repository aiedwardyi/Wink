// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { persistPreference } from "@/lib/i18n";
import type { Message } from "@/state/store";
import { CallCard } from "./CallCard";

const id = "c-0123456789ab";
const at = new Date(2026, 10, 10, 20, 17).getTime();
const rows = (tag: Partial<NonNullable<Message["call"]>> = {}): Message[] => [
  { id: "l1", role: "bot", kind: "text", text: "Good evening. What do you need?", at, call: { id, voice: true, ...tag } },
  { id: "l2", role: "user", kind: "text", text: "Can you fix the login page bug?", at: at + 6_000, call: { id } },
  { id: "l3", role: "bot", kind: "text", text: "Fix the login page bug. Shall I send that?", at: at + 12_000, call: { id, voice: true } },
];

describe("CallCard", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    persistPreference("en");
  });
  const render = async (props: { rows: Message[]; live: boolean; forceOpen?: boolean }) => {
    await act(async () => root.render(createElement(CallCard, { ...props, botName: "Atlas" })));
  };
  const mount = async (props: { rows: Message[]; live: boolean; forceOpen?: boolean }) => {
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    await render(props);
  };

  it("shows only the call line while you talk, then the card in its place", async () => {
    await mount({ rows: rows(), live: true });
    expect(host.textContent).toContain("Call · 8:17");
    expect(host.querySelector("[data-call-card]")).toBeNull();
    expect(host.textContent).not.toContain("Can you fix the login page bug?");
    await render({ rows: rows({ ms: 151_000, summary: "You asked Atlas to fix the login page bug. Atlas sent the job." }), live: false });
    const card = host.querySelector("[data-call-card]")!;
    expect(card.textContent).toContain("Call · 2:31");
    expect(card.textContent).toContain("You asked Atlas to fix the login page bug. Atlas sent the job.");
    expect(card.querySelectorAll("[data-call-stripe] > span")).toHaveLength(48);
    expect(card.querySelector("[data-call-stripe]")!.textContent).toBe("");
  });

  it("keeps your first words when there is no summary and unfolds every line", async () => {
    await mount({ rows: rows(), live: false });
    const card = host.querySelector("[data-call-card]")!;
    expect(card.querySelector("p")!.textContent).toBe("Can you fix the login page bug?");
    expect(card.textContent).not.toContain("Good evening");
    const toggle = card.querySelector("button")!;
    expect(toggle.textContent).toBe("Show transcript");
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(card.querySelector("ol")!.textContent).toBe("AtlasGood evening. What do you need?YouCan you fix the login page bug?AtlasFix the login page bug. Shall I send that?");
  });

  it("opens the transcript when search lands on one of its lines", async () => {
    await mount({ rows: rows({ ms: 151_000 }), live: false });
    expect(host.querySelector('[data-mid="l3"]')).toBeNull();
    await render({ rows: rows({ ms: 151_000 }), live: false, forceOpen: true });
    expect(host.querySelector("[data-call-card] button")!.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('ol [data-mid="l3"]')!.textContent).toBe("AtlasFix the login page bug. Shall I send that?");
  });

  it("speaks Korean", async () => {
    persistPreference("ko");
    await mount({ rows: rows({ ms: 151_000 }), live: false });
    expect(host.textContent).toContain("통화 · 2:31");
    expect(host.textContent).toContain("대화 내용 보기");
  });
});
