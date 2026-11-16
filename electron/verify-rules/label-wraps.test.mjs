import { expect, it } from "vitest";
import { check } from "./label-wraps.mjs";

const row = (text, fields) => ({ where: "div#row", text, length: text.length, words: text.split(" ").length, lines: 2, control: false, split: "", box: [85, 233, 62, 54], ...fields });

it("reports a short label on two lines and an email split mid-word (E-1105-01)", () => {
  const { problems } = check({ rows: [row("jordan.lee@gmail.com", { split: "jordan.lee@" }), row("Sign Out", { where: "button#out", control: true }), row("Sign in on a computer")] });
  expect(problems).toEqual([
    expect.objectContaining({ where: "div#row", measured: expect.stringContaining('"jordan.lee@gmail.com" breaks inside "jordan.lee@"'), box: [85, 233, 62, 54], value: 2 }),
    expect.objectContaining({ where: "button#out", measured: '"Sign Out" on 2 lines; keep the label on one line' }),
  ]);
});

it("leaves prose, long links and short text that wraps between words alone", () => {
  const prose = row("초거대 언어모델 연구 권위자. AI 윤리와 차세대 추론 모델을 연구합니다.", { split: "차세대" });
  const headline = row("기준금리 연내 3%대 진입 전망…주택담보대출 최고 금리 8% 임박", { control: true, split: "전망…주택담보대출" });
  expect(check({ rows: [prose, headline, row("10:00 — 10:20"), row("More info")] }).problems).toEqual([]);
});

it("reports each wrapped label once, even when two share a truncated path", () => {
  const label = row("Sign Out", { control: true });
  expect(check({ rows: [label, label, { ...label, box: [283, 299, 48, 44] }] }).problems).toHaveLength(2);
});
