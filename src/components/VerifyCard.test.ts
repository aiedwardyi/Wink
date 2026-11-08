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
    expect(running).toContain(locale === "en" ? "Reads text, headings and links" : "글, 제목, 링크를 읽어요");
    const clean = render(card({ notChecked: ["form delivery"] }));
    expect(clean).toContain(locale === "en" ? "no problems" : "문제 없음");
    expect(clean).toContain(locale === "en" ? "Not checked: form delivery" : "확인하지 못함: 폼 전송");
    expect(clean).toContain(locale === "en" ? "Rerun" : "다시 확인");
    const problems = render(card({ issues: [{ checker: "LINKS", tile: "phone", rule: "missing target", where: "a#missing", measured: "#missing has no target" }] }));
    expect(problems).toContain(locale === "en" ? "1 problem" : "문제 1개");
    expect(problems).not.toContain(locale === "en" ? "bot is fixing" : "봇이 수정 중");
    expect(problems).toContain("a#missing");
    expect(problems).not.toMatch(/checks|passed|blocked|not run/);
  }
});

it.each(["en", "ko"] as const)("reports problems without claiming a fix in %s", locale => {
  applyLocale(locale);
  const issue = { checker: "LINKS" as const, tile: "phone" as const, rule: "missing target", where: "a#missing", measured: "No target" };
  const html = render(card({ issues: [issue, issue] }));
  expect(html).toContain(locale === "en" ? "2 problems" : "문제 2개");
  expect(html).not.toContain(locale === "en" ? "bot is fixing" : "봇이 수정 중");
  const fixing = renderToStaticMarkup(createElement(VerifyCard, { card: card({ issues: [issue] }), threadId: "thread", fixerRunning: true }));
  expect(fixing).toContain(locale === "en" ? "bot is fixing" : "봇이 수정 중");
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
  const host = document.createElement("div");
  const measured = () => Array.from({ length: Math.ceil(issues.length / 5) }, (_, i) => {
    host.innerHTML = render(card({ issues: issues.slice(i * 5, i * 5 + 5) }));
    return [...host.querySelectorAll(".verify-card-measure")].map(row => row.textContent);
  }).flat();
  applyLocale("ko");
  const lines = measured();
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
  expect(measured()).toEqual(issues.map(issue => issue.measured));
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

it("shows one button: Watch while streaming, Watch with kept replays, else Rerun", () => {
  const live = render(card({ status: "running", live: true, offeredAt: Date.now(), startedAt: Date.now() }));
  expect(live).toContain('data-verify-watch="live"');
  expect(live).not.toContain("Rerun");
  const watch = render(card({ replay: ["a"] }));
  expect(watch).toContain(">Watch<");
  expect(watch).not.toContain("Rerun");
  expect(render(card())).toContain("Rerun");
  expect(render(card({ status: "waiting", offeredAt: Date.now(), startedAt: Date.now() }))).not.toMatch(/Rerun|Watch/);
});

it("never offers Watch live on a phone, pointing at the computer instead", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width"), addEventListener() {}, removeEventListener() {} }));
  const live = render(card({ status: "running", live: true, offeredAt: Date.now(), startedAt: Date.now() }));
  expect(live).not.toContain("data-verify-watch");
  expect(live).toContain("Watch on your computer");
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

const running = (patch: Partial<VerifyCardData> = {}) => card({ status: "running", offeredAt: Date.now(), startedAt: Date.now(), ...patch });
const dom = (data: VerifyCardData) => Object.assign(document.createElement("div"), { innerHTML: render(data) });
const counts = (by?: NonNullable<VerifyCardData["counts"]>["by"]) => ({ planned: 9, completed: 9, passed: 9, failed: 0, blocked: 0, notRun: 0, ...(by ? { by } : {}) });

it.each(["en", "ko"] as const)("heads every state with Live Verify and the site, with the desktop and phone note in %s", locale => {
  applyLocale(locale);
  for (const data of [running(), card({ status: "waiting", offeredAt: Date.now(), startedAt: Date.now() }), card(), card({ status: "blocked", errorCode: "timeout" })]) {
    expect(dom(data).querySelector(".verify-card-title")?.textContent).toBe("Live Verify · index.html");
  }
  expect(dom(card()).querySelector(".verify-card-side")?.textContent).toBe(locale === "en" ? "Desktop 1280 · phone 392" : "데스크톱 1280 · 휴대폰 392");
  expect(dom(running({ counts: counts() })).querySelector(".verify-card-side")?.textContent).toBe(locale === "en" ? "9 checks" : "확인 9개");
});

it.each(["en", "ko"] as const)("counts passed, issues, blocked and not run, leaving out zeros, in %s", locale => {
  applyLocale(locale);
  const issue = { checker: "FIT" as const, tile: "phone" as const, rule: "sideways scroll", where: "div.glow", measured: "542 px page at 392 px" };
  const strip = (data: VerifyCardData) => dom(data).querySelector(".verify-card-strip")?.textContent;
  expect(strip(card({ counts: { planned: 223, completed: 221, passed: 214, failed: 6, blocked: 1, notRun: 2 }, issues: Array(6).fill(issue) }))).toBe(locale === "en" ? "214 passed6 issues1 blocked2 not run" : "214 통과6 문제1 막힘2 실행 안 됨");
  expect(strip(card({ counts: counts() }))).toBe(locale === "en" ? "9 passed" : "9 통과");
  expect(dom(card({ counts: counts() })).querySelector(".verify-card-problems")).toBeNull();
  expect(strip(card({ fixed: 2, counts: counts() }))).toBe(locale === "en" ? "Fixed 2 problems9 passed" : "문제 2개 해결9 통과");
});

it("lights plan rows and checker lanes from per-checker counts", () => {
  const html = dom(running({ counts: counts({ TEXT_A: { desktop: [4, 4] }, LINKS: { desktop: [3, 10] }, PAGE_ERRORS: { desktop: [2, 2], phone: [2, 2] } }) }));
  expect([...html.querySelectorAll(".verify-card-plan li")].map(row => row.getAttribute("data-state"))).toEqual(["running", "waiting", "waiting"]);
  const lanes = [...html.querySelectorAll(".verify-card-lanes > div")];
  expect(lanes.map(lane => lane.textContent)).toEqual(["TEXT", "LINKS", "ERRORS", "MENU", "FIT"]);
  expect(lanes.map(lane => lane.hasAttribute("data-on"))).toEqual([false, true, false, false, false]);
  const lit = (lane: Element) => [...lane.querySelectorAll(".verify-card-seg i")].map(seg => Number((seg as HTMLElement).style.getPropertyValue("--k")));
  expect(lit(lanes[0]!)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  expect(lit(lanes[1]!).map(k => Math.round(k * 10) / 10)).toEqual([1, 0.5, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(lit(lanes[2]!).every(k => k === 1)).toBe(true);
  expect(lanes[1]!.querySelectorAll("[data-lead]")).toHaveLength(1);
  const done = dom(running({ counts: counts({ TEXT_A: { desktop: [4, 4] }, NAV: { desktop: [2, 2] } }) }));
  expect([...done.querySelectorAll(".verify-card-plan li")].map(row => row.getAttribute("data-state"))).toEqual(["done", "done", "waiting"]);
  expect(done.querySelector("[data-lead]")).toBeNull();
});

it("falls back to totals when the runner sends no per-checker counts", () => {
  const old = dom(running({ counts: counts() }));
  expect([...old.querySelectorAll(".verify-card-plan li")].map(row => row.hasAttribute("data-state"))).toEqual([false, false, false]);
  expect(old.querySelector(".verify-card-lanes")).toBeNull();
  const fresh = dom(running());
  expect([...fresh.querySelectorAll(".verify-card-plan li")].map(row => row.getAttribute("data-state"))).toEqual(["waiting", "waiting", "waiting"]);
  expect(fresh.querySelectorAll(".verify-card-lanes > div")).toHaveLength(5);
});

it("lays out each problem in fixed columns, five rows then Show all, measured under the place on phones", () => {
  const issues: NonNullable<VerifyCardData["issues"]> = Array.from({ length: 6 }, (_, i) => ({ checker: i % 2 ? "NAV" : "LINKS", tile: i % 2 ? "phone" : "desktop", rule: "missing target", where: `a#link-${i}`, measured: `#link-${i} has no target` }));
  const html = dom(card({ issues }));
  const rows = [...html.querySelectorAll(".verify-card-problems li")];
  expect(rows).toHaveLength(5);
  expect([...rows[1]!.children].map(cell => cell.className)).toEqual(["verify-card-tag", "verify-card-tile", "verify-card-where", "verify-card-measure"]);
  expect([...rows[1]!.children].map(cell => cell.textContent)).toEqual(["MENU", "Phone", "Phone · a#link-1", "#link-1 has no target"]);
  expect(html.querySelector(".verify-card-more")?.textContent).toBe("Show all 6");
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(readFileSync("src/components/VerifyCard.css", "utf8"));
  const value = (width: number, el: Element, prop: string) => {
    let out = "";
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) { const max = /max-width:\s*(\d+)px/.exec(rule.conditionText); if (max && width <= Number(max[1])) visit(rule.cssRules); }
        else if (rule instanceof CSSStyleRule && el.matches(rule.selectorText) && rule.style.getPropertyValue(prop)) out = rule.style.getPropertyValue(prop);
      }
    };
    visit(sheet.cssRules);
    return out;
  };
  document.body.append(html);
  expect(value(1280, rows[0]!, "grid-template-columns").split(/ (?![^(]*\))/)).toHaveLength(4);
  expect(value(392, rows[0]!, "grid-template-columns").split(/ (?![^(]*\))/)).toHaveLength(2);
  expect(value(392, rows[0]!.querySelector(".verify-card-measure")!, "grid-column")).toBe("2");
  expect(value(392, rows[0]!.querySelector(".verify-card-tile")!, "display")).toBe("none");
  html.remove();
});
