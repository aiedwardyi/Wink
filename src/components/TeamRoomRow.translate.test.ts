// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyLocale } from "@/lib/i18n";
import type { RoomLine } from "@/lib/team-rooms";

import { TeamRoomTranscript } from "./TeamRoomRow";

const lines: RoomLine[] = [
  { id: "mirror-1", entryId: "e1", at: 1, author: { kind: "person", id: "mina", name: "Mina Park" }, text: "자료를 정리했어요.\n함께 확인해 주세요.", files: [] },
  { id: "mirror-2", entryId: "e2", at: 2, author: { kind: "person", id: "daniel", name: "Daniel Cho" }, text: "The checklist is ready.", files: [] },
  { id: "mirror-3", entryId: "e3", at: 3, author: { kind: "host", id: "host", name: "Edward" }, text: "고마워요!", files: [] },
];
let host: HTMLDivElement;
let root: Root;
let available = true;
let generate: () => Promise<Response>;
const fetch = vi.fn((path: string) => path.endsWith("/entries/e1/translate") || path.endsWith("/entries/e2/translate")
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

async function render() {
  await act(async () => root.render(createElement(TeamRoomTranscript, { lines, mine: (line) => line.author.kind === "host", base: "/api/rooms/r1", label: "Launch week" })));
}

const button = () => host.querySelector<HTMLButtonElement>('button[data-room-translate]');

describe("teammate translation", () => {
  it("shows only the other-language button and keeps the original through show and hide", async () => {
    await render();
    expect(host.querySelectorAll("button[data-room-translate]")).toHaveLength(1);
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
    expect(host.querySelectorAll("[data-room-translate-gutter]")).toHaveLength(2);
  });
});
