// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { RoomLine } from "@/lib/team-rooms";

import { RoomLineTranslation, RoomTranslateButton, RoomTranslationText, TeamRoomTranscript } from "./TeamRoomRow";

const readiness = vi.hoisted(() => ({ instances: [] as unknown[], config: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: readiness }),
}));

const lines: RoomLine[] = [
  { id: "mirror-1", entryId: "e1", at: 1, author: { kind: "person", id: "mina", name: "Mina Park" }, text: "자료를 정리했어요.\n함께 확인해 주세요.", files: [] },
  { id: "mirror-2", entryId: "e2", at: 2, author: { kind: "person", id: "daniel", name: "Daniel Cho" }, text: "The checklist is ready.", files: [] },
  { id: "mirror-3", entryId: "e3", at: 3, author: { kind: "host", id: "host", name: "Edward" }, text: "고마워요!", files: [] },
];
let host: HTMLDivElement;
let root: Root;
let available = true;
let generate: () => Promise<Response>;
const fetch = vi.fn((path: string) => path.includes("/entries/") && path.endsWith("/translate")
  ? generate() : Promise.resolve(new Response(JSON.stringify({ available }))));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetch);
  fetch.mockClear();
  available = true;
  generate = async () => new Response(JSON.stringify({ text: "The materials are ready.\nPlease review them together." }));
  applyLocale("en");
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  applyLocale("en");
  vi.unstubAllGlobals();
});

async function render(shown = lines, base = "/api/rooms/r1") {
  await act(async () => root.render(createElement(TeamRoomTranscript, { onReply: () => {}, lines: shown, mine: (line) => line.author.kind === "host", base, label: "Launch week" })));
}

const button = () => host.querySelector<HTMLButtonElement>('button[data-room-translate]');

describe("teammate translation", () => {
  it("drops a local bubble's translation when its source text changes", async () => {
    const props = { base: "/api/rooms/r1", entryId: "m-b1", canTranslate: true, children: (translation: Parameters<typeof RoomTranslationText>[0]["translation"] | null) => translation && [
      createElement(RoomTranslateButton, { key: "button", translation }),
      createElement(RoomTranslationText, { key: "text", translation }),
    ] };
    await act(async () => root.render(createElement(RoomLineTranslation, { ...props, text: "준비됐어요." })));
    await act(async () => button()!.click());
    expect(host.querySelector("[data-room-translation]")).not.toBeNull();
    await act(async () => root.render(createElement(RoomLineTranslation, { ...props, text: "내용을 수정했어요." })));
    expect(host.querySelector("[data-room-translation]")).toBeNull();
    await act(async () => button()!.click());
    expect(fetch.mock.calls.filter(([path]) => path.includes("/entries/"))).toHaveLength(2);
  });

  it.each([undefined, "me", "mina"])("translates a bot with owner %s on the joined side", async (owner) => {
    const bot: RoomLine = { id: "mirror-bot", entryId: "bot-entry", at: 1, author: { kind: "bot", id: "b1", name: "Rando", ...(owner ? { owner } : {}) }, text: "출시 준비를 모두 마쳤어요. (For Eddie: ready)", files: [] };
    await render([bot, { ...bot, id: "english", entryId: "english-entry", text: "The checklist is ready." }], "/api/joined/rooms/r1");
    expect(host.querySelectorAll("[data-room-translate]")).toHaveLength(1);
    await act(async () => button()!.click());
    expect(host.querySelector("[data-room-translation]")?.textContent).toContain("The materials are ready.");
    expect(fetch).toHaveBeenCalledWith("/api/joined/rooms/r1/entries/bot-entry/translate", expect.objectContaining({ body: '{"lang":"en"}' }));
    expect(host.textContent).toContain(bot.text);
  });

  it.each(["instances", "config"] as const)("refreshes availability after %s changes without focus", async (field) => {
    available = false;
    await render();
    expect(button()).toBeNull();
    available = true;
    if (field === "instances") readiness.instances = [{ ready: true }];
    else readiness.config = { gemini: { configured: true } };
    await render();
    expect(button()).not.toBeNull();
    available = false;
    if (field === "instances") readiness.instances = [];
    else readiness.config = { gemini: { configured: false } };
    await render();
    expect(button()).toBeNull();
  });

  it("shows only the other-language button and keeps the original through show and hide", async () => {
    await render();
    expect(host.querySelectorAll("button[data-room-translate]")).toHaveLength(1);
    expect([...button()!.closest("[data-message-hover-actions]")!.querySelectorAll("button")].map((item) => item.getAttribute("aria-label"))).toEqual(["Copy message", "Reply to message", "Translate"]);
    expect(host.querySelector("[data-team-room-content] button")).toBeNull();
    expect(button()?.getAttribute("aria-label")).toBe("Translate");
    await act(async () => button()!.click());
    expect(host.textContent).toContain("The materials are ready.");
    expect(host.textContent).toContain(lines[0]!.text);
    expect(button()?.getAttribute("aria-label")).toBe("Show original");
    expect(fetch).toHaveBeenCalledWith("/api/rooms/r1/entries/e1/translate", expect.objectContaining({ body: '{"lang":"en"}' }));
    await act(async () => button()!.click());
    expect(host.textContent).not.toContain("The materials are ready.");
    expect(host.textContent).toContain(lines[0]!.text);
    await act(async () => button()!.click());
    expect(fetch.mock.calls.filter(([path]) => path.includes("/entries/"))).toHaveLength(1);
  });

  it("shows translating, permits hiding while pending, and renders output as plain text", async () => {
    let release!: (response: Response) => void;
    generate = () => new Promise((resolve) => { release = resolve; });
    await render();
    await act(async () => button()!.click());
    expect(host.textContent).toContain("Translating…");
    await act(async () => button()!.click());
    await act(async () => release(new Response(JSON.stringify({ text: '<img src=x onerror="alert(1)">Ready' }))));
    expect(host.textContent).not.toContain("<img");
    await act(async () => button()!.click());
    expect(host.textContent).toContain('<img src=x onerror="alert(1)">Ready');
    expect(host.querySelector("img")).toBeNull();
  });

  it("switches target language and offers retry text in Korean", async () => {
    await render();
    await act(async () => button()!.click());
    applyLocale("ko");
    await render();
    expect(host.textContent).not.toContain("The materials are ready.");
    expect(host.querySelectorAll("button[data-room-translate]")).toHaveLength(1);
    expect(button()?.getAttribute("aria-label")).toBe("번역");
    generate = async () => new Response('{}', { status: 502 });
    await act(async () => button()!.click());
    expect(host.textContent).toContain("번역하지 못했어요. 탭해서 다시 시도하세요.");
    generate = async () => new Response(JSON.stringify({ text: "체크리스트가 준비됐어요." }));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-room-translation] button')!.click());
    expect(host.textContent).toContain("체크리스트가 준비됐어요.");
  });

  it("has no translate button without an engine", async () => {
    available = false;
    await render();
    expect(button()).toBeNull();
    expect(host.querySelector("[data-room-translate-gutter]")).toBeNull();
  });
});
