// @vitest-environment happy-dom
import { createElement } from "react";
import { readFileSync } from "node:fs";
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

it("explains failed checks in both languages without exposing error codes", () => {
  const codes = ["needs-approval", "denied", "desktop-required", "outside-folders", "not-a-site", "busy", "page-failed", "timeout", "cancelled", "site-changed", "resource-limit", "isolation-failed", "internal", "unknown-error"];
  for (const locale of ["en", "ko"] as const) {
    applyLocale(locale);
    for (const code of codes) {
      const html = render(card({ status: "blocked", errorCode: code as VerifyCardData["errorCode"] }));
      expect(html).not.toContain(`: ${code}<`);
      expect(html).toContain(locale === "en" ? "Not checked: " : "확인하지 못함: ");
    }
    expect(render(card({ status: "blocked", errorCode: "page-failed" }))).toContain(locale === "en" ? "page could not load" : "페이지를 불러오지 못했어요");
    expect(render(card({ status: "blocked", errorCode: "timeout" }))).toContain(locale === "en" ? "check took too long" : "확인 시간이 초과됐어요");
    expect(render(card({ status: "blocked" }))).toBe(render(card({ status: "blocked", errorCode: "timeout" })));
    expect(render(card({ status: "blocked", errorCode: "unknown-error" as VerifyCardData["errorCode"] }))).toBe(render(card({ status: "blocked", errorCode: "internal" })));
  }
});

it("localizes Korean problem lines by rule while retaining destinations and measurements", () => {
  const issues: NonNullable<VerifyCardData["issues"]> = [
    { checker: "LINKS", tile: "desktop", rule: "missing target", where: "a#pricing", measured: "#pricing has no target; click the link" },
    { checker: "LINKS", tile: "desktop", rule: "local 404", where: "a#about", measured: "/about.html returns 404; click the link" },
    { checker: "LINKS", tile: "desktop", rule: "self sign-up", where: "a#signup", measured: "Sign-up link \"#\" goes nowhere; click the link" },
    { checker: "LINKS", tile: "desktop", rule: "self sign-up", where: "a#signup", measured: "#signup points at its own sign-up control or section without a collection destination; click the link" },
    { checker: "FIT", tile: "phone", rule: "sideways scroll", where: "div.hero-grid", measured: "468 px page at 392 px; scroll sideways on the phone" },
    { checker: "PAGE_ERRORS", tile: "desktop", rule: "broken image", where: "img#logo", measured: "Image did not load; reload the page" },
    { checker: "PAGE_ERRORS", tile: "desktop", rule: "page error", where: "/app.js", measured: "HTTP 404; reload the page" },
    { checker: "PAGE_ERRORS", tile: "desktop", rule: "page error", where: "app.js:7", measured: "Uncaught TypeError; reload the page" },
    { checker: "NAV", tile: "phone", rule: "phone menu gone", where: "header nav", measured: "#pricing, #faq disappear at 392 px with no menu control; narrow the page" },
    ...["placeholder contact", "lorem", "TODO", "undefined", "NaN"].map(rule => ({ checker: "TEXT_A" as const, tile: "desktop" as const, rule, where: "footer", measured: `Unfinished copy \"${rule}\"; read this text on the page` })),
    { checker: "TEXT_A", tile: "desktop", rule: "placeholder contact", where: "a#contact", measured: "Link goes to placeholder \"mailto:hello@example.com\"; open the link" },
    { checker: "FIT", tile: "phone", rule: "future rule", where: "main", measured: "Future English explanation" },
  ];
  applyLocale("ko");
  const host = document.createElement("div");
  host.innerHTML = render(card({ issues }));
  const lines = [...host.querySelectorAll(".verify-card-problems li > div:nth-child(2)")].map(row => row.textContent);
  expect(lines).toHaveLength(issues.length);
  for (const line of lines) expect(line).toMatch(/[가-힣]+.*요/);
  expect(lines[0]).toContain("#pricing");
  expect(lines[1]).toContain("/about.html");
  expect(lines[1]).toContain("404");
  expect(lines[3]).toContain("#signup");
  expect(lines[4]).toContain("468 px");
  expect(lines[4]).toContain("392 px");
  expect(lines[6]).toContain("HTTP 404");
  expect(lines[7]).toContain("Uncaught TypeError");
  expect(lines[8]).toContain("#pricing, #faq");
  expect(lines[14]).toContain("mailto:hello@example.com");
  applyLocale("en");
  host.innerHTML = render(card({ issues }));
  expect([...host.querySelectorAll(".verify-card-problems li > div:nth-child(2)")].map(row => row.textContent)).toEqual(issues.map(issue => issue.measured));
});

it("keeps the phone Rerun and Watch targets at least 44 px without enlarging desktop", () => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(readFileSync("src/components/VerifyCard.css", "utf8"));
  const host = document.createElement("div");
  const height = (width: number, data: VerifyCardData) => {
    host.innerHTML = render(data);
    const button = host.querySelector("button")!;
    let minHeight = 0;
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          const max = /max-width:\s*(\d+)px/.exec(rule.conditionText);
          if (max && width <= Number(max[1])) visit(rule.cssRules);
        } else if (rule instanceof CSSStyleRule && button.matches(rule.selectorText) && rule.style.minHeight) minHeight = parseFloat(rule.style.minHeight);
      }
    };
    visit(sheet.cssRules);
    return minHeight;
  };
  expect(height(360, card())).toBeGreaterThanOrEqual(44);
  expect(height(392, card())).toBeGreaterThanOrEqual(44);
  expect(height(1280, card())).toBe(32);
  expect(height(360, card({ replay: ["a"] }))).toBeGreaterThanOrEqual(44);
  expect(height(1280, card({ replay: ["a"] }))).toBe(32);
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
