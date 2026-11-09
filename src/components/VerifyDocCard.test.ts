// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import type { VerifyCardData } from "../../shared/live-verify";
import type { VerifyDocFinding } from "../../shared/verify-doc";
import { chunk } from "../../electron/verify-replay.mjs";
import { VerifyCard } from "./VerifyCard";
import { fixTheseText } from "./VerifyDocCard";
import { VerifyDocWatchFrame } from "./VerifyDocWatch";

const store = vi.hoisted(() => ({ dispatch: vi.fn(), messages: [] as { id: string; verify?: unknown }[] }));
vi.mock("@/state/store", () => ({
  useStore: () => ({
    state: { bots: [{ id: "bot", name: "Atlas", threadId: "thread", messages: store.messages }], groups: [{ id: "room", threadId: "room-thread", name: "Team", memberIds: ["bot"], messages: [] }] },
    dispatch: store.dispatch,
  }),
}));
afterEach(() => { applyLocale("en"); store.dispatch.mockClear(); store.messages.length = 0; document.body.innerHTML = ""; });

const spelling: VerifyDocFinding = { kind: "spelling", line: 50, page: 2, quote: "되요", fix: "돼요", note: "맞춤법" };
const missing: VerifyDocFinding = { kind: "numbering", line: 80, page: 3, quote: "제7조", fix: "", note: "no 제7조 in this document" };
const card = (patch: Partial<VerifyCardData> = {}, doc: Partial<NonNullable<VerifyCardData["doc"]>> = {}): VerifyCardData => ({
  v: 1, runId: "run-123456", owner: "bot", site: "script.md", status: "completed", mode: "auto", decisionNonce: "nonce", offeredAt: 1000, startedAt: 1000, endedAt: 42_000,
  doc: { pages: 10, lines: 300, chunks: [3, 3], by: { spelling: 1, numbering: 1 }, findings: [spelling, missing], findingTotal: 2, ...doc }, ...patch,
});
const render = (data: VerifyCardData, threadId = "thread") => renderToStaticMarkup(createElement(VerifyCard, { card: data, threadId }));

it("builds the Fix these message in English and Korean", () => {
  expect(fixTheseText(card(), "en")).toBe([
    "Please fix these problems Live Verify found in script.md:",
    `1. Page 2, line 50 (spelling): "되요" → "돼요" (맞춤법)`,
    `2. Page 3, line 80 (numbering): "제7조" - no 제7조 in this document`,
  ].join("\n"));
  expect(fixTheseText(card(), "ko", "Atlas")).toBe([
    "@Atlas Live Verify가 script.md에서 찾은 문제를 고쳐 주세요:",
    `1. 2쪽 50줄 (맞춤법): "되요" → "돼요" (맞춤법)`,
    `2. 3쪽 80줄 (번호·참조): "제7조" - no 제7조 in this document`,
  ].join("\n"));
});

it("caps a long Fix these message and counts the rest", () => {
  const findings = Array.from({ length: 60 }, (_, i) => ({ ...spelling, line: i + 1, quote: `${"긴 문장 ".repeat(12)}${i}` }));
  const en = fixTheseText(card({}, { findings, findingTotal: 75 }), "en");
  expect(en.length).toBeLessThanOrEqual(4_000);
  expect(en).toMatch(/\n…and \d+ more$/);
  const listed = en.split("\n").filter(line => /^\d+\. /.test(line)).length;
  expect(en.endsWith(`and ${75 - listed} more`)).toBe(true);
  expect(fixTheseText(card({}, { findings, findingTotal: 75 }), "ko")).toMatch(/\n…외 \d+개$/);
});

it("renders running rows and progress, then findings, in both languages", () => {
  for (const locale of ["en", "ko"] as const) {
    applyLocale(locale);
    const running = render(card({ status: "running", startedAt: Date.now(), endedAt: undefined, live: true }, { chunks: [1, 4], page: 3, beat: Date.now(), findings: undefined, by: { spelling: 2 } }));
    for (const label of locale === "en" ? ["Spelling", "Grammar", "Translation", "Names and dates", "Numbering", "Checking page 3 of 10"] : ["맞춤법", "문법", "번역 짝", "이름·날짜", "번호·참조", "10쪽 중 3쪽 확인 중"]) expect(running).toContain(label);
    const done = render(card());
    expect(done).toContain(locale === "en" ? "2 problems · 10 pages · 41 s" : "문제 2개 · 10쪽 · 41초");
    expect(done).toContain(locale === "en" ? "p.2 · line 50" : "2쪽 · 50줄");
    expect(done).toContain("돼요");
    expect(done).toContain(locale === "en" ? "Fix these" : "수정 요청");
    const clean = render(card({ fixed: 2 }, { findings: [], findingTotal: 0, by: {} }));
    expect(clean).toContain(locale === "en" ? "Fixed 2 problems" : "문제 2개 해결");
    expect(clean).not.toContain(locale === "en" ? "Fix these" : "수정 요청");
  }
});

it("offers Live on a running card loaded before its next live patch", () => {
  const loaded = card({ status: "running", startedAt: Date.now(), endedAt: undefined }, { chunks: [1, 4], page: 3, beat: Date.now(), findings: undefined });
  expect(render(loaded)).toContain('data-verify-watch="live"');
});

it("drops Fix these from a card a newer check of the same document replaced", () => {
  const older = card(), newer = card({ runId: "run-654321", offeredAt: 60_000, startedAt: 60_000, endedAt: 70_000, fixed: 2 }, { findings: [], findingTotal: 0, by: {} });
  store.messages.push({ id: "m1", verify: older }, { id: "m2", verify: newer });
  expect(render(older)).not.toContain("Fix these");
  expect(render(card({ site: "other.md" }))).toContain("Fix these");
});

it("sends Fix these to the bot as a normal message, with a mention in a room", async () => {
  for (const [threadId, expected] of [["thread", { type: "send", botId: "bot", threadId: "thread" }], ["room-thread", { type: "sendGroup", groupId: "room", threadId: "room-thread" }]] as const) {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(VerifyCard, { card: card(), threadId })));
    const button = [...host.querySelectorAll("button")].find(node => node.textContent === "Fix these")!;
    await act(async () => button.click());
    expect(store.dispatch).toHaveBeenLastCalledWith({ ...expected, text: fixTheseText(card(), "en", threadId === "room-thread" ? "Atlas" : undefined) });
    expect(host.textContent).toContain("Sent to the bot");
    await act(async () => root.unmount());
  }
});

it("ends the live watch on the check's own time, not the last mark's", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const finding = { kind: "spelling", line: 2, page: 1, quote: "되요", fix: "돼요" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob([
    chunk(0, { runId: "run-123456", site: "script.md", page: "" }),
    chunk(2, { ms: 1_000, kind: "doc-text", lines: ["첫 줄", "그렇게 되요"], pageStarts: [] }),
    chunk(2, { ms: 40_000, kind: "doc-finding", finding }),
    chunk(3, { status: "completed", ms: 47_000, issues: [], notChecked: [] }),
  ] as BlobPart[]).stream())));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(VerifyDocWatchFrame, { card: card({ status: "running", live: true }), threadId: "thread", live: true, hidden: false, onClose() {} })));
  await act(async () => { await new Promise(done => setTimeout(done, 50)); });
  expect(host.querySelector("[data-current]")?.textContent).toBe("1 problem");
  expect(host.querySelector(".verify-watch-seconds")?.textContent).toBe("47 s");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
