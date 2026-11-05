import { termVerb } from "../shared/tool-verb.ts";

import type { Message } from "./store.ts";
import { redactToolMessage } from "./tool-redact.ts";

// Same header and detail block the terminal row draws. Search must not outrun it.
const INPUT_HEADERS = new Set(["Bash", "Update", "Write"]);

type ToolBody = NonNullable<Message["tool"]>;
type ToolDetail = NonNullable<ToolBody["detail"]>;

function shownArgs(verb: string, summary: string | undefined, detail: ToolDetail | undefined, fallback?: string): string | undefined {
  return (INPUT_HEADERS.has(verb) ? detail?.input ?? summary : summary ?? detail?.input) ?? fallback;
}

/** Detail text the terminal row draws: header input, then the visible output or diff lines. */
function shownDetailLines(tool: ToolBody): string[] {
  const detail = tool.detail;
  const lines: string[] = [];
  const args = shownArgs(termVerb(tool.verb ?? tool.name), tool.summary, detail, tool.verb ? tool.name : undefined);
  if (args && (args === detail?.input || args === tool.summary)) lines.push(args);
  if (!detail || detail.outputHidden) return lines;
  const diff = tool.ok !== false && detail.diff?.length ? detail.diff : undefined;
  const body = diff ?? detail.output;
  if (!body?.length) return lines;
  if (!detail.more && diff && detail.input && !lines.includes(detail.input)) lines.push(detail.input);
  for (const line of body) {
    lines.push(diff && (line[0] === "+" || line[0] === "-") ? `${line[0]} ${line.slice(1)}` : line);
  }
  return lines;
}

/** Text a find hit may quote. Activity rows include only detail the terminal row draws; `chips` rows draw the name and summary. */
export function searchHaystack(message: Pick<Message, "kind" | "text" | "tool" | "comm">, chips = false): string {
  if (message.kind !== "activity") return message.text ?? "";
  const tool = message.tool;
  if (!tool?.name) return "";
  const lines = chips ? (tool.summary ? [tool.summary] : []) : shownDetailLines(tool);
  // a comm chip draws its message body under the label
  const detail = message.comm && message.text ? [...lines, message.text] : lines;
  return detail.length ? `${tool.name}\n${detail.join("\n")}` : tool.name;
}

/** Visible detail text for one activity hit, from the tool object SQLite extracted. `body` is a comm chip's text. */
export function activityHaystack(toolJson: string | null, body: string | null, chips: boolean): string {
  if (!toolJson) return "";
  // SAFETY: tool_json is the $.tool object from a stored Message envelope.
  const tool = redactToolMessage({ tool: JSON.parse(toolJson) as ToolBody }).tool;
  const shown = searchHaystack({ kind: "activity", tool }, chips);
  return shown && body ? `${shown}\n${body}` : shown;
}

type SearchMessage = Pick<Message, "kind" | "tool" | "comm"> & { text?: string | null; summarized?: boolean | number };

export function searchText(message: SearchMessage, chips = false): string | null {
  if (message.kind === "text") return message.text == null || message.summarized === true || message.summarized === 1 ? null : message.text;
  if (message.kind !== "activity") return null;
  if (!message.tool?.name && (message.comm == null || message.text == null)) return null;
  return searchHaystack(redactToolMessage({ ...message, text: message.text ?? undefined }), chips);
}

const encodedPoints = (text: string) => Array.from(text.toLowerCase(), (char) => char.codePointAt(0)!.toString(16).padStart(6, "0"));

export function searchGrams(text: string): string[] {
  const points = encodedPoints(text);
  const grams = new Set<string>();
  for (let size = 1; size <= 3; size++) {
    for (let start = 0; start + size <= points.length; start++) grams.add(`g${points.slice(start, start + size).join("")}`);
  }
  return [...grams];
}

export function messageSearchGrams(message: SearchMessage): string[] {
  const full = searchText(message);
  if (full === null) return [];
  const grams = new Set(searchGrams(full));
  if (message.kind === "activity") for (const gram of searchGrams(searchText(message, true)!)) grams.add(gram);
  return [...grams, message.kind === "text" ? "kindtext" : "kindactivity"];
}

export function needleGrams(query: string): string[] {
  const points = encodedPoints(query.trim());
  const size = Math.min(3, points.length);
  if (!size) return [];
  const grams = new Set<string>();
  for (let start = 0; start + size <= points.length; start++) grams.add(`g${points.slice(start, start + size).join("")}`);
  return [...grams];
}
