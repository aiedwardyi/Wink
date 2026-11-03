import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { buildSnapshot, editionUrl, fetchSnapshot, PAGE_URL, parseResponse } from "./fetch-rams.mjs";
import { beginRun, readModels, readSnapshot, Unverifiable } from "./lib.mjs";

const { describe, it } = process.env.NODE_TEST_CONTEXT ? await import("node:test") : await import("vitest");
const fixture = () => parseResponse(readFileSync(new URL("./fixtures/rams-index.json", import.meta.url), "utf8"));
const previous = () => readSnapshot("rams-index");
const build = (data = fixture()) => buildSnapshot({ data, models: readModels(), retrievedAt: "2026-11-03T12:00:00Z", previous: previous() });
const board = '<a href="/index/data/models-v0.6.1.json">Download</a>';

describe("Rams Index", () => {
  it("discovers one published edition without constructing a latest-data path", () => {
    expect(editionUrl(board)).toBe(`${PAGE_URL}/data/models-v0.6.1.json`);
    expect(() => editionUrl("<html>")).toThrow(Unverifiable);
    expect(() => editionUrl(board + board.replace("0.6.1", "0.6.2"))).toThrow(Unverifiable);
  });

  it("retains source precision, default effort and each page's published cost and interval", () => {
    const { snapshot, unmapped } = build();
    expect(snapshot.rows).toHaveLength(12);
    expect(snapshot.updated).toBe("2026-10-29");
    expect(snapshot.rows.find((row) => row.model === "gpt-6.1-sol")).toMatchObject({ effort: "default", value: 92, cost_per_task: 0.15, interval: { low: 90.3, high: 93.8 }, cost_benchmark: "rams-index" });
    expect(snapshot.rows.find((row) => row.model === "gpt-6-luna")?.cost_per_task).toBe(0.005);
    expect(snapshot.rows.every((row) => row.source_url === row.cost_source && row.source_url.endsWith("models-v0.6.1.json"))).toBe(true);
    expect(snapshot.rows.some((row) => row.model.startsWith("muse-spark"))).toBe(false);
    expect(unmapped).toContain("Muse Spark Open");
  });

  it("rejects malformed data, changed editions, missing page costs and invalid intervals", () => {
    expect(() => parseResponse("<html>")).toThrow(Unverifiable);
    for (const change of [{ name: "Other" }, { updated: "2026-02-30" }, { license: null }, { models: [] }]) {
      expect(() => parseResponse(JSON.stringify({ ...fixture(), ...change }))).toThrow(Unverifiable);
    }
    expect(() => build({ ...fixture(), season: "0.6.2" })).toThrow(/edition/);
    for (const change of [{ usdPerPage: null }, { usdPerPage: 0 }, { index: 101 }, { lo: 99 }, { hi: 80 }, { effort: "high" }]) {
      const data = fixture();
      Object.assign(data.models[0], change);
      expect(() => build(data)).toThrow(Unverifiable);
    }
    const data = fixture();
    data.models.push(data.models[0]);
    expect(() => build(data)).toThrow(/repeated/);
    expect(() => build({ ...fixture(), models: [{ name: "Unknown" }] })).toThrow(/no Rams model/);
  });

  it("fetches the linked JSON and refuses mismatched edition data", async () => {
    const original = globalThis.fetch;
    const calls = [];
    let data = fixture();
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { status: 200, text: async () => url === PAGE_URL ? board : JSON.stringify(data) };
    };
    try {
      beginRun();
      expect((await fetchSnapshot()).snapshot.rows).toHaveLength(12);
      expect(calls).toEqual([PAGE_URL, `${PAGE_URL}/data/models-v0.6.1.json`]);
      beginRun();
      data = { ...fixture(), season: "0.6.2", edition: "models-v0.6.2" };
      await expect(fetchSnapshot()).rejects.toThrow(/disagrees/);
    } finally {
      globalThis.fetch = original;
      beginRun();
    }
  });
});
