// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import { closeShow, showMedia, useMediaThread } from "@/lib/show-pane";
import type { MediaSource } from "@/lib/show-media";
import { ShowPane } from "./ShowPane";

vi.mock("./ShowPdf", () => ({ default: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const id = (n: number) => String(n).padStart(24, "f");
const photo = { id: id(3), name: "photo.png", type: "image/png", bytes: 10, at: 3, sender: "Mina" };
const plan = { id: id(2), name: "plan.pdf", type: "application/pdf", bytes: 10, at: 2, sender: "Mina" };

let root: Root;
let host: HTMLElement;
let calls: string[];
let room: { files: unknown[]; error: string | null };

beforeEach(() => {
  calls = [];
  room = { files: [photo, plan], error: null };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "DELETE") {
      room = { ...room, files: room.files.filter((file) => !url.endsWith((file as { id: string }).id)) };
      return Response.json({ ok: true });
    }
    if (url.endsWith("/files")) return Response.json({ ...room, used: 0, capacity: 1 });
    return new Response(null, { status: 206 });
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); act(() => closeShow()); applyLocale("en"); vi.unstubAllGlobals(); });

function Pane({ source }: { source: MediaSource }) {
  return useMediaThread() === source.threadId ? createElement(ShowPane, { media: true, source, hidden: false }) : null;
}

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)); });
const open = async (source: MediaSource) => {
  await act(async () => showMedia(source.threadId));
  await act(async () => root.render(createElement(Pane, { source })));
  await settle();
};
const roomSource: MediaSource = { threadId: "r-thread", roomId: "r1", messages: [] };
const rightClick = (el: Element) => {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 });
  act(() => { el.dispatchEvent(event); });
  return event;
};
const menuItem = () => document.querySelector<HTMLButtonElement>('[role="menu"] [role="menuitem"]');
const confirmButton = () => [...document.querySelectorAll<HTMLButtonElement>('[aria-modal="true"] button')].find((button) => button.textContent === "Delete")!;

it("right-click on a room file deletes it after the same confirm, and Media lists again", async () => {
  await open(roomSource);
  const row = [...host.querySelectorAll("[data-media-file]")].find((each) => each.textContent === "plan.pdf")!;
  row.setAttribute("title", "");
  expect(rightClick(row).defaultPrevented).toBe(true);
  await settle();
  expect(menuItem()!.textContent).toBe("Delete");
  expect(menuItem()!.disabled).toBe(false);
  await act(async () => menuItem()!.click());
  expect(document.body.textContent).toContain("Delete this file for everyone?");
  expect(document.body.textContent).toContain("plan.pdf");
  await act(async () => confirmButton().click());
  await settle();
  expect(calls).toContain(`DELETE /api/rooms/r1/files/${plan.id}`);
  expect([...host.querySelectorAll("[data-media-file]")].map((each) => each.textContent)).toEqual([]);
  expect(host.querySelectorAll("[data-media-grid] button")).toHaveLength(1);
});

it("a hold on a room picture opens the menu, and the lift does not open the picture", async () => {
  await open(roomSource);
  const tile = host.querySelector("[data-media-grid] button")!;
  tile.setAttribute("title", "");
  const touch = { clientX: 30, clientY: 30, identifier: 1, target: tile };
  act(() => { tile.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch] as unknown as Touch[] })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  await settle();
  expect(menuItem()!.textContent).toBe("Delete");
  const lift = new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [] });
  act(() => { tile.dispatchEvent(lift); });
  expect(lift.defaultPrevented).toBe(true);
  expect(document.querySelector("[data-media-viewer]")).toBeNull();
});

it("a read-only room folder can't delete", async () => {
  room.error = "unavailable";
  await open(roomSource);
  rightClick(host.querySelector("[data-media-file]")!);
  await settle();
  expect(menuItem()!.disabled).toBe(true);
});

it("a bot chat's Media keeps the native menu", async () => {
  const reply = { id: "b1", role: "bot" as const, kind: "text" as const, at: 2, text: "Here: [deck.pdf](C:\\w\\deck.pdf)" };
  await open({ threadId: "t1", messages: [reply] });
  expect(rightClick(host.querySelector("[data-media-file]")!).defaultPrevented).toBe(false);
  expect(menuItem()).toBeNull();
});
