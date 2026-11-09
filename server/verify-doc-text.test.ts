import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { chunkDoc, dateClashes, docText, docxText, findingAt, nameTwins, numberingHits, parseChunkReply, parseMergeReply, readDoc, type DocText } from "./verify-doc-text.ts";
import { createTempDirs } from "./testing/cleanup.ts";
import { docxFixture, zipFixture } from "./testing/docx-fixture.ts";

const temps = createTempDirs();
afterEach(() => temps.remove());

const WORDS = ["오늘", "정말", "우리가", "그때", "다시", "약속을", "지켜야", "해요", "알겠어", "괜찮아", "회사에서", "연락이", "왔어요", "어디로", "가는", "거야", "모르겠어요", "생각보다", "늦었네", "빨리"];
const NAMES = ["민지", "준호", "서연", "도윤"];

function script(scenes: number): string[] {
  let seed = 7;
  const next = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
  const say = (n: number) => Array.from({ length: n }, () => WORDS[next(WORDS.length)]).join(" ");
  const lines: string[] = [];
  for (let scene = 1; scene <= scenes; scene++) {
    lines.push(`S#${scene}. ${["거실", "사무실", "카페", "골목"][next(4)]} - ${next(2) ? "낮" : "밤"}`, say(10));
    for (let i = 0; i < 8; i++) lines.push(`${NAMES[next(4)]}: ${say(6 + next(9))}`);
    lines.push("");
  }
  return lines;
}

const texts = (doc: DocText) => chunkDoc(doc).map(chunk => doc.text.slice(chunk.start, chunk.end));
const hits = (lines: string[]) => numberingHits(docText(lines.join("\n"))).map(hit => [hit.quote, hit.fix]);

it("chunks a 100-page script into bounded pieces that cover it exactly at line ends", () => {
  const doc = docText(script(400).join("\n"));
  expect(doc.pageCount).toBeGreaterThanOrEqual(100);
  const chunks = chunkDoc(doc);
  expect(chunks[0]!.start).toBe(0);
  expect(chunks.at(-1)!.end).toBe(doc.text.length);
  for (const [i, chunk] of chunks.entries()) {
    if (i) expect(chunk.start).toBe(chunks[i - 1]!.end);
    expect(chunk.end - chunk.start).toBeLessThanOrEqual(18_000);
    if (i < chunks.length - 1) {
      expect(chunk.end - chunk.start).toBeGreaterThanOrEqual(6_000);
      expect(doc.text[chunk.end - 1]).toBe("\n");
    }
  }
  expect(chunks.length).toBeGreaterThanOrEqual(6);
  expect(chunks.length).toBeLessThanOrEqual(30);
});

it("re-sends only the chunks around a one-line edit", () => {
  const lines = script(400);
  const before = texts(docText(lines.join("\n")));
  const resent = Array.from({ length: 40 }, (_, i) => {
    const edited = [...lines];
    edited[i * 100 + 50] += " 수정했어요";
    return texts(docText(edited.join("\n"))).filter(text => !before.includes(text)).length;
  });
  expect(Math.max(...resent)).toBeLessThanOrEqual(3);
  expect(resent.filter(n => n === 1).length).toBeGreaterThanOrEqual(30);
});

it("splits a line longer than a chunk at a space", () => {
  const doc = docText("word ".repeat(5_000));
  const chunks = chunkDoc(doc);
  expect(chunks.length).toBeGreaterThan(1);
  for (const chunk of chunks.slice(0, -1)) {
    expect(chunk.end - chunk.start).toBeLessThanOrEqual(18_000);
    expect(doc.text[chunk.end - 1]).toBe(" ");
  }
});

it("numbers pages from rendered breaks, else from breaks plus printed-page size", () => {
  expect(docText("one\n\ftwo\nmore\n\fthree", true).pages).toEqual([1, 2, 2, 3]);
  const long = docText(Array.from({ length: 100 }, () => "x".repeat(80)).join("\n"));
  expect(long.pageCount).toBe(3);
  expect(long.pages[44]).toBe(1);
  expect(long.pages[45]).toBe(2);
  const korean = docText(Array.from({ length: 50 }, () => "가".repeat(40)).join("\n"));
  expect(korean.pageCount).toBe(2);
  expect(docText("\fcover\n\fbody").pages).toEqual([1, 2]);
});

it("turns the page where text after a break starts, inside a paragraph too", () => {
  expect(docText("Start page one. \fStart page two.\nNext", true)).toMatchObject({ pages: [1, 2], pageCount: 2 });
  expect(docText("one\ntwo \fthree\nfour\nfive\f\nsix", true).pages).toEqual([1, 1, 2, 2, 3]);
});

it("reads paragraphs, tabs, entities and page breaks from a .docx", () => {
  expect(docxText(docxFixture(["Hello\tworld", "A & B < C", "\fPage two"]))).toEqual({ raw: "Hello\tworld\nA & B < C\n\fPage two", rendered: false });
  expect(docxText(docxFixture(["갑: 주식회사 대성물산", "\f제2조"], true)).rendered).toBe(true);
  expect(() => docxText(Buffer.from("not a zip"))).toThrow();
});

it("counts an explicit page break that no rendered mark follows", () => {
  const body = `<w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:lastRenderedPageBreak/><w:t>two</w:t><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:lastRenderedPageBreak/><w:t>three</w:t></w:r></w:p><w:p><w:r><w:t>four</w:t><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>five</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>six</w:t></w:r></w:p>`;
  const { raw, rendered } = docxText(zipFixture({ "word/document.xml": `<w:document><w:body>${body}</w:body></w:document>` }));
  expect(docText(raw, rendered).pages).toEqual([1, 2, 3, 3, 4, 5]);
});

it("reads a hostile .docx in linear time", () => {
  const started = performance.now();
  docxText(zipFixture({ "word/document.xml": `<w:document><w:body>${"<w:t <w:br ".repeat(18_000)}</w:body></w:document>` }));
  expect(performance.now() - started).toBeLessThan(1_000);
});

it("reads UTF-8, UTF-16 and CP949 text, and refuses what is not text", async () => {
  const dir = temps.make(join(tmpdir(), "wink-doc-text-")), text = "계약서를 보냈습니다.";
  const read = async (bytes: Buffer) => { await writeFile(join(dir, "a.txt"), bytes); return readDoc(join(dir, "a.txt")); };
  const utf16 = Buffer.from(text, "utf16le");
  for (const bytes of [Buffer.from(`﻿${text}`), Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]), Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()]), Buffer.from("b0e8bee0bcadb8a620bab8b3c2bdc0b4cfb4d92e", "hex")]) {
    expect(docText((await read(bytes)).raw).text).toBe(text);
  }
  await expect(read(Buffer.from("PK\u0003\u0004\u0000\u0000 binary"))).rejects.toThrow();
  await expect(read(Buffer.from([0xff, 0xff, 0xff, 0xfe, 0x41]))).rejects.toThrow();
});

it("numbers 30,000 Markdown headings in linear time", () => {
  const doc = docText(Array.from({ length: 30_000 }, (_, i) => `# ${i % 9 + 1}. x`).join("\n"));
  const started = performance.now();
  numberingHits(doc);
  expect(performance.now() - started).toBeLessThan(1_000);
});

it("reads a line that opens with a cited article as a citation, not a heading", () => {
  expect(hits(["제750조에 따른 손해배상 책임이 있다.", "제763조에 의하여 준용되는 제393조에 따라 배상한다."])).toEqual([]);
  expect(hits(["## 제1조 목적", "## 제2조 정의", "## 제4조 기간"])).toEqual([["제4조", "제3조"]]);
  expect(hits(["**제1조** 목적", "**제2조** 정의", "**제4조** 기간"])).toEqual([["제4조", "제3조"]]);
  expect(hits(["제1조", "제2조 (정의)", "제4조【기간】"])).toEqual([["제4조", "제3조"]]);
});

it("flags gaps, repeats and missing references in articles, scenes, lists and appendices", () => {
  expect(hits(["제1조(목적)", "본문", "제2조(정의)", "제4조(기간)", "제4조(해지)"])).toEqual([["제4조", "제3조"], ["제4조", "제5조"]]);
  expect(hits(["제1조(목적)", "제2조(기간)", "제3조(해지) 제5조에 따라 해지한다."])).toEqual([["제5조", ""]]);
  expect(hits(["S#12. 거실", "대사", "S#14. 골목"])).toEqual([["S#14", "S#13"]]);
  expect(hits(["1. Scope", "2. Terms", "4. Fees"])).toEqual([["4.", "3."]]);
  expect(hits(["# Report", "See Appendix C for the data.", "Appendix A", "Appendix B"])).toEqual([["Appendix C", ""]]);
});

it("follows section numbers across paragraphs and in Markdown headings", () => {
  const body = ["원고는 계약을 체결하였습니다.", "", "피고는 대금을 지급하지 않았습니다.", "", "그 결과 손해가 발생하였습니다."];
  expect(hits(["1. 당사자", ...body, "2. 계약", ...body, "4. 미지급", ...body, "1. 갑 제1호증", "2. 갑 제2호증"])).toEqual([["4.", "3."]]);
  expect(hits(["# Report", "## 1. Introduction", "Text.", "## 2. Method", "1. one", "2. two", "## 3. Results", "## 5. Discussion"])).toEqual([["5.", "4."]]);
});

it("does not flag restarts, same-number lists, law citations or separate lists", () => {
  expect(hits(["제1조(목적)", "제2조(기간) 민법 제750조 및 같은 법 제390조에 따른다.", "부칙", "제1조(시행일)"])).toEqual([]);
  expect(hits(["1. one", "1. two", "1. three"])).toEqual([]);
  expect(hits(["1. one", "2. two", "", "Some text.", "More text.", "", "4. later"])).toEqual([]);
  expect(hits(["1. one", "2. two", "1. again", "2. again"])).toEqual([]);
  expect(hits(["제1조", "이 계약은 제3조를 따른다"])).toEqual([]);
});

it("keeps only findings whose quote is in the chunk and places them by position", () => {
  const doc = docText(["첫 줄", "둘째 줄", "그렇게 하면 되요.", "넷째 줄"].join("\n"));
  const [chunk] = chunkDoc(doc);
  const reply = "```json\n" + JSON.stringify({
    findings: [
      { kind: "spelling", quote: "되요", fix: "돼요", note: "맞춤법", line: 99 },
      { kind: "spelling", quote: "없는 문장", fix: "x" },
      { kind: "grammar", quote: "첫 줄", fix: "첫 줄" },
      { kind: "style", quote: "둘째", fix: "두번째" },
    ],
    names: ["김민수"], dates: [{ date: "3월 15일", what: "계약" }],
  }) + "\n```";
  const parsed = parseChunkReply(reply, doc, chunk!);
  expect(parsed.hits.map(hit => findingAt(doc, hit))).toEqual([{ kind: "spelling", line: 3, page: 1, quote: "되요", fix: "돼요", note: "맞춤법" }]);
  expect(parsed.names).toEqual(["김민수"]);
  expect(parsed.dates).toEqual(["3월 15일 (계약)"]);
  expect(parseChunkReply("I could not read it.", doc, chunk!).hits).toEqual([]);
  const many = { findings: Array.from({ length: 20 }, () => ({ kind: "spelling", quote: "줄", fix: "선" })) };
  expect(parseChunkReply(JSON.stringify(many), doc, chunk!).hits.length).toBeLessThanOrEqual(12);
});

it("flags one event given two dates, from the dates the model listed", () => {
  const doc = docText(["계약은 2024. 3. 15. 체결되었다.", "독촉은 2024. 6. 10. 하였다.", "2024. 3. 25. 체결된 계약에 따라 지급하라."].join("\n"));
  const dates = ["2024. 3. 15. (supply contract signed)", "2024. 6. 10. (reminder sent)", "2024. 3. 25. (supply contract signed)", "2024. 6. 11. (payment)", "2024. 6. 10. (payment)"];
  expect(dateClashes(doc, dates).map(hit => [hit.quote, hit.fix, hit.note])).toEqual([["2024. 3. 25.", "2024. 3. 15.", "같은 일, 다른 날짜"]]);
  const report = docText("The survey closed on March 14, 2025.\nThe survey, which closed on March 21, 2025, ran early.");
  expect(dateClashes(report, ["March 14, 2025 (survey closed (Introduction))", "March 21, 2025 (survey closed (Discussion))"]).map(hit => [hit.quote, hit.fix])).toEqual([["March 21, 2025", "March 14, 2025"]]);
});

it("compares whole dates, named months included", () => {
  const doc = docText(["The deal was signed on March 15, 2024.", "The deal signed May 15, 2024 stands.", "Paid 2024-03-15.", "Paid 2024-03-03 too.", "Filed 2024. 3. 15. and 2024년 3월 15일."].join("\n"));
  const dates = ["March 15, 2024 (deal signed)", "May 15, 2024 (deal signed)", "2024-03-15 (invoice paid)", "2024-03-03 (invoice paid)", "2024. 3. 15. (claim filed)", "2024년 3월 15일 (claim filed)"];
  expect(dateClashes(doc, dates).map(hit => [hit.quote, hit.fix])).toEqual([["May 15, 2024", "March 15, 2024"], ["2024-03-03", "2024-03-15"]]);
});

it("flags a rare listed name one letter off a far more common one", () => {
  const doc = docText([...Array(6).fill("준호: 가자."), "준오: 나중에 하자.", ...Array(3).fill("서연아, 잠깐만."), "서연: 응.", "민지: 민재 씨 왔어?", "민지: 응."].join("\n"));
  expect(nameTwins(doc, ["준호", "준오", "서연", "서연아", "민지", "민재"]).map(hit => [hit.quote, hit.fix, findingAt(doc, hit).line])).toEqual([["준오", "준호", 7]]);
  const report = docText(["Dr. Sarah Kim led it.", "Sarah Kim wrote it.", "Thanks, Sarah Kim.", "Dr. Sara Kim noted it."].join("\n"));
  expect(nameTwins(report, ["Sarah Kim", "Sara Kim"]).map(hit => [hit.quote, hit.fix, hit.note])).toEqual([["Sara Kim", "Sarah Kim", "elsewhere Sarah Kim (3 times)"]]);
});

it("places merge findings at the first use of the variant", () => {
  const doc = docText(["원고 김민수는", "피고에게", "김민서는 계약을 해지했다.", "김민수"].join("\n"));
  const merged = parseMergeReply(JSON.stringify({ findings: [{ kind: "names", quote: "김민서", fix: "김민수", note: "elsewhere 2 times" }, { kind: "names", quote: "박영희", fix: "김민수" }] }), doc);
  expect(merged.ok).toBe(true);
  expect(merged.hits.map(hit => findingAt(doc, hit))).toEqual([{ kind: "names", line: 3, page: 1, quote: "김민서", fix: "김민수", note: "elsewhere 2 times" }]);
  expect(parseMergeReply("I could not compare these.", doc)).toEqual({ ok: false, hits: [] });
});
