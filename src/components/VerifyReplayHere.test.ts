// @vitest-environment happy-dom
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import type { VerifyCardData } from "../../shared/live-verify";
import type { Message } from "@/state/store";
import { VerifyCard, VerifyWatchIcon } from "./VerifyCard";

afterEach(() => { applyLocale("en"); vi.unstubAllGlobals(); });
const card = (patch: Partial<VerifyCardData> = {}): VerifyCardData => ({ v: 1, runId: "run-123456", owner: "bot", site: "index.html", status: "completed", mode: "auto", decisionNonce: "nonce", offeredAt: 1000, startedAt: 1000, endedAt: 13000, replay: ["run-elsewhere"], ...patch });
const doc = { pages: 1, lines: 4, chunks: [1, 1] as [number, number], by: {}, findings: [], findingTotal: 0 };
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "", json: async () => body });
const kept = (...runs: string[]) => vi.stubGlobal("fetch", vi.fn(async (path: string) => String(path).endsWith("/replays") ? reply({ runs }) : reply({}, 404)));
const asked = () => (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([path]) => String(path).endsWith("/replays")).length;
const mount = async (...nodes: ReturnType<typeof createElement>[]) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  await act(async () => root.render(createElement("div", null, ...nodes)));
  await act(async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); });
  return { host, close: async () => { await act(async () => root.unmount()); host.remove(); } };
};

it.each(["en", "ko"] as const)("offers no Watch for a site check whose replay ran on another PC in %s", async locale => {
  applyLocale(locale);
  kept();
  const messages = [{ id: "m", kind: "note", verify: card() }] as unknown as Message[];
  const view = await mount(createElement(VerifyCard, { card: card(), threadId: `thread-site-${locale}` }), createElement(VerifyWatchIcon, { messages, threadId: `thread-site-${locale}` }));
  expect(view.host.querySelector('[data-verify-watch="watch"]')).toBeNull();
  expect(view.host.querySelector("[data-verify-watch-icon]")).toBeNull();
  await view.close();
});

it("offers no Watch for a document check whose replay ran on another PC", async () => {
  kept();
  const view = await mount(createElement(VerifyCard, { card: card({ doc }), threadId: "thread-doc" }));
  expect(view.host.querySelector("[data-verify-watch]")).toBeNull();
  await view.close();
});

it("keeps the icon and Watch for a replay that is on this PC", async () => {
  kept("run-here01");
  const own = card({ replay: ["run-here01"] });
  const messages = [{ id: "m", kind: "note", verify: own }] as unknown as Message[];
  const view = await mount(createElement(VerifyCard, { card: own, threadId: "thread-here" }), createElement(VerifyCard, { card: card({ doc, replay: ["run-here01"] }), threadId: "thread-here" }), createElement(VerifyWatchIcon, { messages, threadId: "thread-here" }));
  expect(view.host.querySelectorAll('[data-verify-watch="watch"]')).toHaveLength(2);
  expect(view.host.querySelector("[data-verify-watch-icon]")).not.toBeNull();
  await view.close();
});

it("offers Watch on the local check of a chat and not on the one from another PC", async () => {
  kept("run-here02");
  const view = await mount(createElement(VerifyCard, { card: card({ replay: ["run-here02"] }), threadId: "thread-mixed" }), createElement(VerifyCard, { card: card({ runId: "run-654321", replay: ["run-elsewhere"] }), threadId: "thread-mixed" }));
  const cards = view.host.querySelectorAll("[data-verify-card]");
  expect(cards[0]!.querySelector('[data-verify-watch="watch"]')).not.toBeNull();
  expect(cards[1]!.querySelector('[data-verify-watch="watch"]')).toBeNull();
  await view.close();
});

it("keeps Watch when this PC could not say which replays it has", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
  const view = await mount(createElement(VerifyCard, { card: card(), threadId: "thread-offline" }));
  expect(view.host.querySelector('[data-verify-watch="watch"]')).not.toBeNull();
  await view.close();
});

it("asks once per chat for every card it shows", async () => {
  kept("run-here03");
  const view = await mount(...["a", "b", "c"].map(runId => createElement(VerifyCard, { card: card({ runId: `run-${runId}00000`, replay: ["run-here03"] }), threadId: "thread-batch" })));
  expect(asked()).toBe(1);
  await view.close();
});
