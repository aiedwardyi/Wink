// Refreshes Design from the public Rams Index edition linked on its board.
import { pathToFileURL } from "node:url";
import { get, readModels, readSnapshot, saveRaw, sortRows, Unverifiable, writeSnapshot } from "./lib.mjs";

export const PAGE_URL = "https://www.rams.ai/index";
const LICENSE = "https://creativecommons.org/licenses/by/4.0/";

export function editionUrl(html) {
  const paths = new Set([...html.matchAll(/href="(\/index\/data\/models-v\d+\.\d+\.\d+\.json)"/g)].map((m) => m[1]));
  if (paths.size !== 1) throw new Unverifiable("Rams board must link one model edition");
  return new URL([...paths][0], PAGE_URL).href;
}

export function parseResponse(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Unverifiable("Rams response is not JSON");
  }
  const date = Date.parse(data?.updated);
  if (data?.name !== "Rams Index" || !/^\d+\.\d+\.\d+$/.test(data?.season) || data.edition !== `models-v${data.season}` || data.url !== PAGE_URL || data.license !== LICENSE || !/^\d{4}-\d{2}-\d{2}$/.test(data.updated) || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== data.updated || !Array.isArray(data.models) || !data.models.length) {
    throw new Unverifiable("Rams edition, date, license or model table changed");
  }
  return data;
}

export function buildSnapshot({ data, models, retrievedAt, previous }) {
  if (data.season !== previous.version) throw new Unverifiable(`Rams is now edition ${data.season}, snapshot is ${previous.version}`);
  const ids = new Map(Object.entries(models).map(([id, meta]) => [meta.label, id]));
  const url = `${PAGE_URL}/data/${data.edition}.json`;
  const rows = [];
  const unmapped = [];
  const landed = new Set();
  for (const row of data.models) {
    const model = ids.get(row.name);
    if (!model) {
      unmapped.push(row.name);
      continue;
    }
    if (landed.has(model)) throw new Unverifiable(`repeated Rams model ${model}`);
    landed.add(model);
    if (![row.index, row.lo, row.hi, row.usdPerPage].every(Number.isFinite) || row.lo < 0 || row.hi > 100 || row.lo > row.index || row.hi < row.index || row.usdPerPage <= 0 || !/^default(?: \([^)]+\))?$/.test(row.effort)) {
      throw new Unverifiable(`${row.name}: Rams score, interval, page cost or default effort changed`);
    }
    rows.push({
      model,
      effort: "default",
      value: row.index,
      interval: { low: row.lo, high: row.hi },
      cost_per_task: row.usdPerPage,
      cost_benchmark: "rams-index",
      cost_source: url,
      source_url: url,
      retrieved_at: retrievedAt,
      kind: "independent",
    });
  }
  if (!rows.length) throw new Unverifiable("no Rams model maps to a Wink model");
  return { snapshot: { ...previous, updated: data.updated, rows: sortRows(rows, models) }, unmapped: unmapped.sort() };
}

export async function fetchSnapshot() {
  const board = await get(PAGE_URL);
  saveRaw("rams-board", board.text, "html");
  const url = editionUrl(board.text);
  const response = await get(url);
  saveRaw("rams-index", response.text, "json");
  const data = parseResponse(response.text);
  if (url !== `${PAGE_URL}/data/${data.edition}.json`) throw new Unverifiable("Rams linked edition disagrees with its data");
  return buildSnapshot({ data, models: readModels(), retrievedAt: response.retrievedAt, previous: readSnapshot("rams-index") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { snapshot, unmapped } = await fetchSnapshot();
    writeSnapshot("rams-index", snapshot);
    console.log(`rams-index: ${snapshot.rows.length} rows, updated ${snapshot.updated}, unmapped ${unmapped.length}`);
  } catch (error) {
    console.error(`rams-index: UNVERIFIABLE - ${error.message}`);
    process.exitCode = 1;
  }
}
