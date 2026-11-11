import { describe, expect, it } from "vitest";

import { cleanFiles, sleepInput, validateChangeList, type CleanInput } from "./memory-clean.ts";
import { appendBlock } from "./memory-clean-format.ts";
import { rememberCovered } from "./memory-clean-validate.ts";
import { sleepEngines } from "./testing/sleep-verdicts.ts";

const now = Date.UTC(2026, 10, 12);
const syllables = ["ka", "lo", "mi", "ne", "ru", "so", "ti", "va", "be", "du"];
const word = (n: number) => [n % 10, Math.floor(n / 10) % 10, Math.floor(n / 100) % 10].map((i) => syllables[i]).join("") + "x";
const fact = (i: number) => `- ${word(i)} stores the ${word(i + 300)} ledger near ${word(i + 600)} harbor with ${word(i + 900)} lanterns (noted 2026-09-01)`;
const memory = (count: number) => `${Array.from({ length: count }, (_, i) => fact(i)).join("\n")}\n`;
const remember = (n: number, extra = "") => ({ text: `Remember that ${word(n)} lives beside the ${word(n + 1)} pier with ${word(n + 2)} boats.${extra}`, at: now - 3_600_000 + n, kind: "remember" as const });
const filed = (header: { counts?: { filed: number } } | object) => "counts" in header ? header.counts!.filed : 0;
const night = (text: string, input: Partial<CleanInput> = {}, changes?: () => unknown[]) => cleanFiles({ memory: text, history: null, typed: new Set(), now, ...sleepEngines(changes), ...input });

describe("memory cleanup latent walls", () => {
  it("reads remember requests from the whole week past the input cap", () => {
    const paragraph = "The morning meeting covered the garden route. ".repeat(6);
    const rows = [...Array.from({ length: 100 }, (_, i) => paragraph + i), "Remember Mina lives in Seoul"].map((text, i) => ({ id: String(i), role: "user", kind: "text", text, at: now - 86_400_000 + i }));
    expect(sleepInput(rows as never, null, now).user.map((line) => line.text)).toContain("Remember Mina lives in Seoul");
  });

  it("lands a night whose remembers pass the growth cap and writes the rest the next night", async () => {
    const user = Array.from({ length: 5 }, (_, i) => remember(i * 10, " ".padEnd(160, "z")));
    const first = await night("- kept\n", { user });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    const waiting = user.filter((line) => !rememberCovered(line.text, first.memory));
    expect(waiting.length).toBeGreaterThan(0);
    expect(user.at(-1)!.text).not.toBe(waiting.at(-1)?.text);
    const second = await night(first.memory, { history: appendBlock("", first.block), user });
    expect(second).toMatchObject({ ok: true });
    if (!second.ok) return;
    expect(user.filter((line) => !rememberCovered(line.text, second.memory))).toHaveLength(Math.max(0, waiting.length - 2));
  });

  it("writes a remember over 300 bytes as bullets of at most 300 bytes", async () => {
    const long = remember(1, ` Then ${word(7)} sails at dawn to the ${word(8)} reef for ${word(9)} nets.`.repeat(4));
    expect(Buffer.byteLength(long.text)).toBeGreaterThan(300);
    const result = await night("- kept\n", { user: [long] });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(rememberCovered(long.text, result.memory)).toBe(true);
    expect(result.memory.split("\n").every((line) => Buffer.byteLength(line) <= 300)).toBe(true);
  });

  it("drops a model file op that grows its topic past 1,000 bytes and lands the plan", async () => {
    const result = await night(memory(140), {}, () => [{ op: "file", ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], topic: "ledgers", reason: "Detail" }]);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const grown = result.topics.map((topic) => Buffer.byteLength(topic.text));
    expect(Math.max(...grown)).toBeLessThanOrEqual(1000);
    expect(Buffer.byteLength(result.memory) - Buffer.byteLength(memory(140)) + grown.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
  });

  it("files at least 3 lines over 140 lines with no new user lines", async () => {
    const result = await night(memory(150), { user: [] });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(filed(result.header)).toBeGreaterThanOrEqual(3);
  });

  it("extends a topic's pointer row instead of adding another", () => {
    const text = `${fact(1)}\n${fact(2)}\n- memory/ledgers.md: ${word(500)} ledger\n`;
    const result = validateChangeList({ file: "MEMORY.md", text: memory(140) + text, typed: new Set(), list: { version: 1, file: "MEMORY.md", changes: [{ op: "file", ids: [141], topic: "ledgers", reason: "Detail" }] } });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    const rows = result.text.split("\n").filter((line) => line.startsWith("- memory/ledgers.md: "));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`${word(500)} ledger; `);
  });

  it("shrinks a file over 24 KB by up to 24 lines a night", async () => {
    const text = memory(260);
    expect(Buffer.byteLength(text)).toBeGreaterThan(24_000);
    const result = await night(text, { user: [] });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(filed(result.header)).toBeGreaterThan(3);
    expect(filed(result.header)).toBeLessThanOrEqual(24);
    expect(Buffer.byteLength(result.memory)).toBeLessThan(Buffer.byteLength(text) - 1000);
  });
});
