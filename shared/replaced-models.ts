import { RETIRED_GEMINI_FLASH_IDS } from "./model-selection.ts";

export interface ReplacedModel {
  engine: "claudeAgent" | "codex" | "antigravityAgent";
  from: string;
  to: string;
  /** Picker names, for the one chat line when an old id still turns up. */
  fromLabel?: string;
  toLabel?: string;
  /** The new model cannot continue the old one's native session. */
  resetSession?: true;
}

/** Oldest first. A swap is one new row; chains (6 Sol -> 6.1 Sol -> 6.2 Sol) resolve on their own. */
export const REPLACED_MODELS: readonly ReplacedModel[] = [
  { engine: "claudeAgent", from: "claude-sonnet-5", to: "claude-sonnet-5-5" },
  { engine: "claudeAgent", from: "claude-haiku-4-5", to: "claude-haiku-5-5" },
  { engine: "codex", from: "gpt-6-sol", to: "gpt-6.1-sol", fromLabel: "GPT-6 Sol", toLabel: "GPT-6.1 Sol", resetSession: true },
  { engine: "codex", from: "gpt-5.6-terra", to: "gpt-6.1-terra", fromLabel: "GPT-5.6 Terra", toLabel: "GPT-6.1 Terra", resetSession: true },
  { engine: "codex", from: "gpt-6.1-sol", to: "gpt-6.2-sol", fromLabel: "GPT-6.1 Sol", toLabel: "GPT-6.2 Sol", resetSession: true },
  { engine: "codex", from: "gpt-6-astra", to: "gpt-6.2-astra", fromLabel: "GPT-6 Astra", toLabel: "GPT-6.2 Astra", resetSession: true },
  ...RETIRED_GEMINI_FLASH_IDS.map(([from, to]) => ({ engine: "antigravityAgent" as const, from, to })),
];

const rowOf = (engine: string, model: string) => REPLACED_MODELS.find((row) => row.engine === engine && row.from === model);

/** The model a saved id stands for today; an id nothing replaced comes back unchanged. */
export function currentModel(engine: string, model: string): string {
  let id = model;
  for (let row = rowOf(engine, id); row; row = rowOf(engine, id)) id = row.to;
  return id;
}

/** Older ids of a model, nearest first: the names an older catalog may still list it under. */
export function earlierModels(engine: string, model: string): string[] {
  return REPLACED_MODELS.filter((row) => row.engine === engine && currentModel(engine, row.from) === model).map((row) => row.from).reverse();
}

/** Same-engine rows to apply at start: each old id straight to its final model. */
export function replacedModelMoves(engine: ReplacedModel["engine"]): Array<{ from: string; to: string; resetSession: boolean }> {
  return REPLACED_MODELS.filter((row) => row.engine === engine).map((row) => ({ from: row.from, to: currentModel(engine, row.from), resetSession: row.resetSession === true }));
}

/** Picker name of a model a row knows, current or replaced. */
export function replacedModelLabel(engine: string, model: string): string | undefined {
  return REPLACED_MODELS.find((row) => row.engine === engine && row.to === model && row.toLabel)?.toLabel
    ?? REPLACED_MODELS.find((row) => row.engine === engine && row.from === model && row.fromLabel)?.fromLabel;
}

/** The one chat line for a turn that still carried an old id, or null when the id was never replaced. */
export function replacedModelLine(engine: string, model: string): string | null {
  const first = rowOf(engine, model);
  if (!first) return null;
  const last = REPLACED_MODELS.find((row) => row.engine === engine && row.to === currentModel(engine, model));
  return `${first.fromLabel ?? model} was replaced by ${last?.toLabel ?? currentModel(engine, model)}`;
}
