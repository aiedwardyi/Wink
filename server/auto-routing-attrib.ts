import { baseAutoModel, verifiedChoice, type AutoDimensions, type AutoEngine, type AutoTarget, type AutoTask, type ChoiceContext, type ChoiceProvenance } from "../shared/auto-routing.ts";
import type { AutoRuleOperation, RuleAuthorization } from "./auto-routing-rules.ts";
import type { Message } from "./store.ts";
import { requestText } from "./team-report-intent.ts";
import type { LiveTurn } from "./turn-registry.ts";

const MODELS: [AutoEngine, string, string[]][] = [
  ["claudeAgent", "claude-fable-5-1", ["Claude Fable 5.1", "Fable 5.1", "클로드 페이블 5.1", "페이블 5.1"]],
  ["claudeAgent", "claude-fable-5", ["Claude Fable 5", "Fable 5", "클로드 페이블 5", "페이블 5"]],
  ["claudeAgent", "claude-opus-5-5", ["Claude Opus 5.5", "Opus 5.5", "Opus", "오퍼스", "Claude", "클로드"]],
  ["claudeAgent", "claude-sonnet-5-5", ["Claude Sonnet 5.5", "Claude Sonnet", "Sonnet 5.5", "Sonnet", "클로드 소넷", "소넷"]],
  ["claudeAgent", "claude-haiku-5-5", ["Claude Haiku 5.5", "Claude Haiku", "Haiku 5.5", "Haiku", "클로드 하이쿠", "하이쿠"]],
  ["codex", "gpt-6-astra", ["GPT-6 Astra", "Astra", "아스트라"]],
  ["codex", "gpt-6.1-sol", ["GPT-6.1 Sol", "Sol", "솔", "ChatGPT", "GPT", "챗지피티", "지피티"]],
  ["codex", "gpt-6.1-terra", ["GPT-6.1 Terra", "Terra", "테라"]],
  ["codex", "gpt-6-luna", ["GPT-6 Luna", "Luna", "루나"]],
  ["grokAgent", "grok-4.7", ["Grok 4.7", "Grok", "그록 4.7", "그록"]],
  ["grokAgent", "grok-4.6", ["Grok 4.6", "그록 4.6"]],
  ["antigravityAgent", "gemini-4-argon", ["Gemini 4 Argon", "Argon", "아르곤"]],
  ["antigravityAgent", "gemini-3.8-flash", ["Gemini 3.8 Flash", "Flash", "플래시", "Gemini", "제미나이"]],
  ["museAgent", "muse-spark-1.3", ["Meta Muse 1.3", "Muse 1.3", "Muse", "뮤즈"]],
  ["museAgent", "muse-spark-1.3-contributor", ["Meta Muse 1.3 Contributor", "Muse 1.3 Contributor", "Contributor", "컨트리뷰터"]],
];
const EFFORTS = [
  ["minimal", ["minimal", "최소"]], ["low", ["low", "낮음", "낮게"]], ["medium", ["medium", "중간", "보통"]],
  ["high", ["high", "높음", "높게", "하이"]], ["xhigh", ["xhigh", "엑스하이", "매우 높음"]], ["max", ["max", "최대", "맥스"]],
] as const;
type CurrentTurn = LiveTurn & { turnId: string };
export type AttributionSource = { botId: string; threadId: string; ownerId: string; authorized: boolean; turn?: CurrentTurn; messages: readonly (Message & { imported?: boolean })[] };

export function userWords(source: AttributionSource): string {
  const turn = source.turn;
  if (!source.authorized || !source.ownerId || !turn || turn.botId !== source.botId || turn.threadId !== source.threadId
    || turn.owner !== "user" || turn.depth !== 0 || !turn.userKeys.length) return "";
  return source.messages.filter((line) => turn.userKeys.includes(line.sendId ?? line.id) && line.role === "user" && line.kind === "text"
    && !line.from && !line.comm && !line.origin && !line.imported).map((line) => requestText((line.text ?? "")
      .replace(/<attached-(file|image)\b[^>]*(?<!\/)>[\s\S]*?(?:<\/attached-\1>|$)/gi, "")
      .replace(/~~~[\s\S]*?(?:~~~|$)/g, "").replace(/^(?: {4}|\t).*$/gm, ""))).filter(Boolean).join("\n");
}

function mentions<T>(quote: string, entries: readonly { name: string; value: T }[]): T[] {
  let text = quote.toLowerCase();
  const values: T[] = [];
  for (const entry of [...entries].sort((a, b) => b.name.length - a.name.length)) {
    const name = entry.name.toLowerCase();
    let offset = text.indexOf(name);
    while (offset !== -1) {
      const before = text[offset - 1] ?? "";
      const after = text[offset + name.length] ?? "";
      if ((!/^[a-z0-9]/.test(name) || !/[a-z0-9_-]/.test(before)) && (!/[a-z0-9]$/.test(name) || !/[a-z0-9_.-]/.test(after))) {
        values.push(entry.value);
        text = text.slice(0, offset) + " ".repeat(name.length) + text.slice(offset + name.length);
      }
      offset = text.indexOf(name, offset + name.length);
    }
  }
  return values;
}

export function names(quote: string): AutoDimensions {
  const models = mentions(quote, MODELS.flatMap(([engine, model, aliases]) => [model, ...aliases].map((name) => ({ name, value: { engine, model } }))));
  const distinct = [...new Map(models.map((value) => [value.model, value])).values()];
  const efforts = [...new Set(mentions(quote, EFFORTS.flatMap(([value, aliases]) => aliases.map((name) => ({ name, value })))))];
  const result: AutoDimensions = {};
  if (distinct.length === 1) Object.assign(result, distinct[0]);
  if (efforts.length === 1) result.effort = efforts[0];
  return result;
}

export function choiceContext(source: AttributionSource, target: AutoTarget, taskClass: AutoTask, quote: string, dimensions: AutoDimensions): ChoiceContext {
  const directUserText = userWords(source);
  const attributed = quote.trim() && directUserText.includes(quote) ? names(quote) : {};
  if (dimensions.model && attributed.engine && baseAutoModel(attributed.engine, dimensions.model) === attributed.model) attributed.model = dimensions.model;
  return { authenticatedUserId: source.ownerId, currentActionId: source.turn?.turnId ?? "", authorized: Boolean(directUserText),
    target, taskClass, directUserText, intent: "choice", attributed };
}

export function userChoice(source: AttributionSource, target: AutoTarget, taskClass: AutoTask, quote: string, dimensions: AutoDimensions): { choice: ChoiceProvenance; context: ChoiceContext } | undefined {
  const context = choiceContext(source, target, taskClass, quote, dimensions);
  const choice: ChoiceProvenance = { actorId: source.ownerId, actionId: context.currentActionId, target, taskClass, origin: "chat", dimensions, userQuote: quote };
  return verifiedChoice(choice, context) ? { choice, context } : undefined;
}

export function ruleAuthorization(source: AttributionSource, operation: AutoRuleOperation, quote: string): RuleAuthorization {
  const dimensions = operation.op === "setPreference" ? operation.preference ?? (operation.max === true ? { effort: "max" as const } : {}) : {};
  const context = choiceContext(source, "worker", "unknown", quote, dimensions);
  return { authenticatedUserId: context.authenticatedUserId, actorId: source.ownerId, authorized: context.authorized,
    actionId: context.currentActionId, currentActionId: context.currentActionId, directUserText: context.directUserText ?? "", userQuote: quote,
    origin: "direct-user", attributed: context.attributed };
}
