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
import { VerifyDocWatchFrame } from "./VerifyDocWatch";

afterEach(() => { applyLocale("en"); document.body.innerHTML = ""; });

const spelling: VerifyDocFinding = { kind: "spelling", line: 50, page: 2, quote: "되요", fix: "돼요", note: "맞춤법" };
const missing: VerifyDocFinding = { kind: "numbering", line: 80, page: 3, quote: "제7조", fix: "", note: "no 제7조 in this document" };
const card = (patch: Partial<VerifyCardData> = {}, doc: Partial<NonNullable<VerifyCardData["doc"]>> = {}): VerifyCardData => ({
  v: 1, runId: "run-123456", owner: "bot", site: "script.md", status: "completed", mode: "auto", decisionNonce: "nonce", offeredAt: 1000, startedAt: 1000, endedAt: 42_000,
  doc: { pages: 10, lines: 300, chunks: [3, 3], by: { spelling: 1, numbering: 1 }, findings: [spelling, missing], findingTotal: 2, ...doc }, ...patch,
});
const render = (data: VerifyCardData, threadId = "thread") => renderToStaticMarkup(createElement(VerifyCard, { card: data, threadId }));

it("renders running rows and progress, then findings, in both languages", () => {
  for (const locale of ["en", "ko"] as const) {
    applyLocale(locale);
    const running = render(card({ status: "running", startedAt: Date.now(), endedAt: undefined, live: true }, { chunks: [1, 4], page: 3, beat: Date.now(), findings: undefined, by: { spelling: 2 } }));
    for (const label of locale === "en" ? ["Spelling", "Grammar", "Translation", "Names and dates", "Numbering", "Checking page 3 of 10"] : ["맞춤법", "문법", "번역 짝", "이름·날짜", "번호·참조", "10쪽 중 3쪽 확인 중"]) expect(running).toContain(label);
    const done = render(card());
    expect(done).toContain(locale === "en" ? "2 problems · 10 pages · 41 s" : "문제 2개 · 10쪽 · 41초");
    expect(done).toContain(locale === "en" ? "p.2 · line 50" : "2쪽 · 50줄");
    expect(done).toContain("돼요");
    expect(done).not.toContain(locale === "en" ? "Fix these" : "수정 요청");
    expect(done).not.toContain(locale === "en" ? "bot is fixing" : "봇이 수정 중");
    expect(render(card({}, { fixing: true }))).toContain(locale === "en" ? "2 problems · bot is fixing · 10 pages · 41 s" : "문제 2개 · 봇이 수정 중 · 10쪽 · 41초");
    const clean = render(card({ fixed: 2 }, { findings: [], findingTotal: 0, by: {}, fixedFindings: [spelling, missing] }));
    expect(clean).toContain(locale === "en" ? "Fixed 2 problems · 10 pages · 41 s" : "문제 2개 해결 · 10쪽 · 41초");
    const left = render(card({ fixed: 1 }, { findings: [missing], findingTotal: 1, fixedFindings: [spelling] }));
    expect(left).toContain(locale === "en" ? "Fixed 1 problem · 1 left · 10 pages · 41 s" : "문제 1개 해결 · 1개 남음 · 10쪽 · 41초");
    expect(left).not.toContain("돼요");
    expect(render(card({ fixed: 1 }, { findings: [missing], findingTotal: 1, fixedFindings: [spelling], fixing: true }))).toContain(locale === "en" ? "Fixed 1 problem · 1 left · bot is fixing · 10 pages" : "문제 1개 해결 · 1개 남음 · 봇이 수정 중 · 10쪽");
    expect(left).toContain(locale === "en" ? "Show details" : "자세히 보기");
  }
});

it("shows what the fix changed and what it left one tap away", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(VerifyCard, { card: card({ fixed: 1 }, { findings: [missing], findingTotal: 1, fixedFindings: [spelling] }), threadId: "thread" })));
  expect(host.textContent).not.toContain("돼요");
  const button = [...host.querySelectorAll("button")].find(node => node.textContent === "Show details")!;
  await act(async () => button.click());
  expect(host.textContent).toContain("Fixed");
  expect(host.textContent).toContain("돼요");
  expect(host.textContent).toContain("Left");
  expect(host.textContent).toContain("no 제7조 in this document");
  expect(host.textContent).not.toContain("Fix these");
  await act(async () => root.unmount());
});

it("shows a names and dates comparison that failed as not checked", () => {
  for (const locale of ["en", "ko"] as const) {
    applyLocale(locale);
    expect(render(card({}, { uncompared: true })).replace(/<!-- -->/g, "")).toContain(locale === "en" ? "Not checked: names and dates" : "확인하지 못함: 이름·날짜");
  }
});

it("offers Live on a running card loaded before its next live patch", () => {
  const loaded = card({ status: "running", startedAt: Date.now(), endedAt: undefined }, { chunks: [1, 4], page: 3, beat: Date.now(), findings: undefined });
  expect(render(loaded)).toContain('data-verify-watch="live"');
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

it("shows a check that could not finish as not checked in the watch, live and replayed", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  for (const live of [true, false]) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob([
      chunk(0, { runId: "run-123456", site: "script.md", page: "" }),
      chunk(2, { ms: 0, kind: "doc-text", lines: ["첫 줄", "둘째 줄"], pageStarts: [] }),
      chunk(3, { status: "blocked", ms: 9_000, issues: [], notChecked: ["1"] }),
    ] as BlobPart[]).stream())));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(VerifyDocWatchFrame, { card: card({ status: "blocked", replay: ["run-123456"] }, { findings: [], findingTotal: 0, by: {} }), threadId: "thread", live, hidden: false, onClose() {} })));
    await act(async () => { await new Promise(done => setTimeout(done, 300)); });
    expect(host.querySelector("[data-current]")?.textContent).toBe("Could not check this document");
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
