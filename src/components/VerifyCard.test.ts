// @vitest-environment happy-dom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { applyLocale } from "@/lib/i18n";
import type { VerifyCardData } from "../../shared/live-verify";
import { VerifyCard } from "./VerifyCard";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("../../shared/live-verify", async importOriginal => ({ ...await importOriginal<typeof import("../../shared/live-verify")>(), get LIVE_VERIFY_V0() { return flag.on; } }));
afterEach(() => { flag.on = true; applyLocale("en"); vi.unstubAllGlobals(); });
const card = (patch: Partial<VerifyCardData> = {}): VerifyCardData => ({ v: 1, runId: "run-123456", owner: "bot", site: "index.html", status: "completed", mode: "auto", decisionNonce: "nonce", offeredAt: 1000, startedAt: 1000, endedAt: 13000, ...patch });
const render = (data: VerifyCardData) => renderToStaticMarkup(createElement(VerifyCard, { card: data, threadId: "thread" }));

it("hides the receipt when the build flag is off", () => {
  flag.on = false;
  expect(render(card())).toBe("");
});

it("renders running, clean, problems and coverage in both languages without check totals", () => {
  for (const locale of ["en", "ko"] as const) {
    applyLocale(locale);
    const running = render(card({ status: "running", offeredAt: Date.now(), startedAt: Date.now() }));
    expect(running).toContain(locale === "en" ? "Checking in a real browser" : "실제 브라우저에서 확인 중");
    expect(running).toContain(locale === "en" ? "Loads" : "페이지 로드");
    const clean = render(card({ notChecked: ["form delivery"] }));
    expect(clean).toContain(locale === "en" ? "no problems" : "문제 없음");
    expect(clean).toContain(locale === "en" ? "Not checked: form delivery" : "확인하지 못함: 폼 전송");
    expect(clean).toContain(locale === "en" ? "Rerun" : "다시 확인");
    const problems = render(card({ issues: [{ checker: "LINKS", tile: "phone", rule: "missing target", where: "a#missing", measured: "#missing has no target" }] }));
    expect(problems).toContain(locale === "en" ? "bot is fixing" : "봇이 수정 중");
    expect(problems).toContain("a#missing");
    expect(problems).not.toMatch(/checks|passed|blocked|not run/);
  }
});

it("says in Korean which blocked code left scripts or phone layout unchecked", () => {
  applyLocale("ko");
  const html = render(card({ notChecked: ["phone layout (styles from cdn.tailwindcss.com are blocked in the check)", "scripts (requests to api.site.dev are blocked in the check)"] }));
  expect(html).toContain("확인하지 못함: 휴대폰 레이아웃 (cdn.tailwindcss.com의 스타일이 확인 중 차단됨)");
  expect(html).toContain("확인하지 못함: 스크립트 (api.site.dev로 가는 요청이 확인 중 차단됨)");
});

it("shows one button: Watch live while streaming, Watch with kept replays, else Rerun", () => {
  const live = render(card({ status: "running", live: true, offeredAt: Date.now(), startedAt: Date.now() }));
  expect(live).toContain("Watch live");
  expect(live).not.toContain("Rerun");
  const watch = render(card({ replay: ["a"] }));
  expect(watch).toContain(">Watch<");
  expect(watch).not.toContain("Rerun");
  expect(render(card())).toContain("Rerun");
  expect(render(card({ status: "waiting", offeredAt: Date.now(), startedAt: Date.now() }))).not.toMatch(/Rerun|Watch/);
});

it("never offers Watch live on a phone", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
  expect(render(card({ status: "running", live: true, offeredAt: Date.now(), startedAt: Date.now() }))).not.toContain("Watch");
  expect(render(card({ replay: ["a"] }))).toContain(">Watch<");
});

it("says waiting, counts checks and says fixed after a same-turn recheck, in both languages", () => {
  const counts = { planned: 312, completed: 312, passed: 298, failed: 0, blocked: 14, notRun: 0 };
  for (const locale of ["en", "ko"] as const) {
    applyLocale(locale);
    expect(render(card({ status: "waiting", offeredAt: Date.now(), startedAt: Date.now() }))).toContain(locale === "en" ? "Waiting for another check" : "다른 확인을 기다리는 중");
    expect(render(card({ fixed: 2 }))).toContain(locale === "en" ? "Fixed 2 problems · desktop and phone clean · 12 s" : "문제 2개 해결 · 데스크톱과 휴대폰 문제 없음 · 12초");
    expect(render(card({ fixed: 2, counts }))).toContain(locale === "en" ? "Fixed 2 problems · 298 checks clean · 12 s" : "문제 2개 해결 · 확인 298개 통과 · 12초");
    expect(render(card({ counts }))).toContain(locale === "en" ? "312 checks · desktop + phone · no problems · 12 s" : "확인 312개 · 데스크톱 + 휴대폰 · 문제 없음 · 12초");
    expect(render(card({ counts, details: [{ checker: "FIT", tile: "phone", rule: "tap size", where: "a.small", measured: "30 px" }] }))).toContain(locale === "en" ? "1 detail" : "참고 1개");
  }
});
