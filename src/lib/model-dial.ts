import type { ModelSelection } from "@/state/store";
import { MODEL_INDEX_ENTRIES, MODEL_INDEX_SOURCES } from "../../shared/model-index-data.ts";
import { movePicker, pickerEfforts, pickerModels, selectPickerEffort, type PickerRow } from "./cross-model-picker";
import { blendedPrice, modelIndexToday, priceOn } from "./model-index";

export type DialStat = "intelligence" | "coding";

const tierOf = (model: string) => model.match(/^gemini-.+-(high|medium|low)$/)?.[1];
const indexId = (model: string) => model.replace(/^(gemini-.+)-(high|medium|low)$/, "$1");

const dialEntry = (model: string, effort: string | undefined, index: DialStat) => {
  const id = indexId(model);
  const level = tierOf(model) ?? effort;
  return MODEL_INDEX_ENTRIES.find((entry) => entry.index === index && entry.model === id && (entry.effort === "all" || entry.effort === level));
};

export const dialScore = (model: string, effort: string | undefined, index: DialStat) => dialEntry(model, effort, index)?.score;

/** USD per task from the Intelligence Index run at this effort. */
export function dialRunCost(model: string, effort: string | undefined): number | undefined {
  const cost = dialEntry(model, effort, "intelligence")?.cost;
  return cost !== undefined && cost >= 0.005 ? cost : undefined;
}

export function dialPrice(model: string, today = modelIndexToday()) {
  const price = MODEL_INDEX_ENTRIES.find((entry) => entry.index === "cost" && entry.model === indexId(model))?.price;
  if (!price) return undefined;
  const now = priceOn(price, today);
  return { input: now.input, output: now.output, blend: blendedPrice(now) };
}

export const dialTier = (blend: number) => blend < 0.1 ? "$" : blend < 1 ? "$$" : blend < 5 ? "$$$" : "$$$$";

export const dialSource = (index: DialStat) => Object.values(MODEL_INDEX_SOURCES)
  .find((source) => source.index === index)!.label.replace(/^Artificial Analysis /, "").replace(/\s*\(.*\)$/, "");

const intDigits = (values: number[]) => Math.max(1, ...values.map((value) => String(Math.floor(value)).length));
export const DIAL_DIGITS: Record<DialStat | "cost", number> = {
  intelligence: intDigits(MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "intelligence").map((entry) => entry.score)),
  coding: intDigits(MODEL_INDEX_ENTRIES.filter((entry) => entry.index === "coding").map((entry) => entry.score)),
  cost: intDigits(MODEL_INDEX_ENTRIES.flatMap((entry) => entry.index === "cost" ? [entry.score] : entry.index === "intelligence" && entry.cost ? [entry.cost] : [])),
};

export function dialStep(rows: PickerRow[], current: ModelSelection, dir: number): ModelSelection {
  return movePicker(rows, current, dir < 0 ? "ArrowUp" : "ArrowDown");
}

const WHEEL_PX = 16;
const WHEEL_IDLE_MS = 200;

/** True once per wheel or trackpad burst, momentum tail included; a 200 ms pause or a reversal starts the next. */
export function dialWheel(burst: { at: number; dir: number; sum: number }, event: WheelEvent): boolean {
  const now = performance.now();
  const dir = Math.sign(event.deltaY);
  const before = now - burst.at < WHEEL_IDLE_MS && dir === burst.dir ? burst.sum : 0;
  Object.assign(burst, { at: now, dir, sum: before + Math.abs(event.deltaY) * [1, 16, window.innerHeight][event.deltaMode]! });
  return before < WHEEL_PX && burst.sum >= WHEEL_PX;
}

/** Effort stops at either end; the list picker wraps. */
export function dialShift(rows: PickerRow[], current: ModelSelection, dir: number): ModelSelection {
  const item = pickerModels(rows).find((model) => model.instance.instanceId === current.instanceId && model.cell.options.some((option) => option.id === current.model));
  if (!item) return current;
  const options = pickerEfforts(item, item.cell);
  const selected = options.findIndex((option) => option.model ? option.model === current.model : option.effort === current.effort);
  const target = options[selected < 0 ? (dir > 0 ? 0 : -1) : selected + dir];
  return target ? selectPickerEffort(current, target) : current;
}

/** First model with a word starting with the typed text, in picker order. */
export function dialFind(names: readonly string[], text: string): number {
  return names.findIndex((name) => name.toLowerCase().split(/[\s-]+/).some((word) => word.startsWith(text)));
}
