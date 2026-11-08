import { expect, it } from "vitest";
import { redactVerifyCard, verifyReplyText } from "./verify-message.ts";
import type { VerifyResult } from "../shared/live-verify.ts";

it("caps bot feedback and excludes design details from defects", () => {
  const issues = Array.from({ length: 40 }, (_, i) => ({ checker: "LINKS" as const, tile: "phone" as const, rule: "missing target", where: `a#link-${i}`, measured: "#missing has no target" }));
  const result: VerifyResult = { v: 1, runId: "run-123456", site: "index.html", counts: { planned: 40, completed: 40, passed: 0, failed: 40, blocked: 0, notRun: 0 }, issues, issueTotal: 40, durationMs: 12000, notChecked: ["form delivery"], details: [{ ...issues[0]!, checker: "CONTRAST", rule: "contrast", measured: "3.1:1" }] };
  const text = verifyReplyText("completed", result.site, { result });
  expect(text.length).toBeLessThanOrEqual(1200);
  expect(text).toContain("Not checked: form delivery");
  expect(text).toContain("phone");
  expect(text).toContain("392");
  expect(text).not.toMatch(/contrast|checks|3.1:1/);
});

it.each(["unchecked-link-", "확인하지않은링크-"])("keeps the first problem and recheck instruction with long %s coverage", prefix => {
  const result: VerifyResult = { v: 1, runId: "run-123456", site: "index.html", counts: { planned: 1, completed: 1, passed: 0, failed: 1, blocked: 0, notRun: 0 }, issues: [{ checker: "LINKS", tile: "phone", rule: "missing target", where: "a#register", measured: "#missing has no target" }], issueTotal: 1, durationMs: 12000, notChecked: Array.from({ length: 20 }, (_, i) => `${prefix}${i}-${"x".repeat(70)}`) };
  const text = verifyReplyText("completed", result.site, { result });
  expect(text).toContain("Phone 392 px: missing target at a#register");
  expect(text).toContain("Fix these in this turn; call verify_site again, at most twice.");
  expect(text).toMatch(/and \d+ more not checked/);
  expect(text.length).toBeLessThanOrEqual(1200);
  expect([...text].reduce((n, c) => n + (c.charCodeAt(0) < 128 ? 1 / 3 : 2), 0)).toBeLessThanOrEqual(400);
});

it("keeps long Korean problem text within the feedback budget", () => {
  const result: VerifyResult = { v: 1, runId: "run-123456", site: "index.html", counts: { planned: 1, completed: 1, passed: 0, failed: 1, blocked: 0, notRun: 0 }, issues: [{ checker: "LINKS", tile: "phone", rule: "missing target", where: `a#가입${"가".repeat(120)}`, measured: "대상이없습니다".repeat(30) }], issueTotal: 1, durationMs: 12000, notChecked: ["form delivery", ...Array.from({ length: 19 }, () => "확인하지않음".repeat(20))] };
  const text = verifyReplyText("completed", result.site, { result });
  expect(text).toContain("missing target at a#가입");
  expect(text).toContain("Fix these in this turn; call verify_site again, at most twice.");
  expect(text).toMatch(/20 items|\d+ more not checked/);
  expect(text.length).toBeLessThanOrEqual(1200);
  expect([...text].reduce((n, c) => n + (c.charCodeAt(0) < 128 ? 1 / 3 : 2), 0)).toBeLessThanOrEqual(400);
});

it("keeps valid per-checker tallies on a card and drops malformed ones", () => {
  const counts = { planned: 5, completed: 3, passed: 3, failed: 0, blocked: 0, notRun: 2 };
  const card = { v: 1, runId: "run-123456", owner: "bot", site: "index.html", status: "running", mode: "auto", decisionNonce: "nonce", offeredAt: 1, counts };
  expect(redactVerifyCard({ ...card, counts: { ...counts, by: { LINKS: { desktop: [3, 5], tablet: [1, 1] }, NOPE: { desktop: [1, 1] }, FIT: { phone: [4, 2] } } } })?.counts).toEqual({ ...counts, by: { LINKS: { desktop: [3, 5] } } });
  expect(redactVerifyCard(card)?.counts).toEqual(counts);
});
