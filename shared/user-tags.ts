const TAG = /<\/?user\d+>/g;
const QUOTE = /^(?: {0,3}>[ \t]?)+/;
const FENCE = /^( *(?:(?:[-*+]|\d{1,9}[.)]) +)*)(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_END = /^ *(`{3,}|~{3,})\s*$/;
const INDENT = /^(?: {4}|\t)/;
const RUNS = /`+/g;

function openTick(line: string, from: number): number {
  for (let at = line.indexOf("`", from); at >= 0; at = line.indexOf("`", at + 1)) {
    let slashes = 0;
    while (line[at - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 0) return at;
  }
  return -1;
}

/** Drops `<userN>` tags a bot leaves outside a peer reply, keeping the inner text and any code. An unclosed fence or span counts as code, so a streamed prefix unwraps like its whole. */
export function unwrapUserTags(text: string): string {
  if (!/<\/?user\d/.test(text)) return text;
  let fence = "";
  let fenceDepth = 0;
  let fenceColumn = 0;
  let span = 0;
  let indented = false;
  let blank = true;
  const scan = (line: string): string => {
    let out = "";
    let at = 0;
    while (at < line.length) {
      const tick = span ? at : openTick(line, at);
      if (!span) out += line.slice(at, tick < 0 ? line.length : tick).replace(TAG, "");
      if (tick < 0) break;
      RUNS.lastIndex = tick;
      let end = line.length;
      if (span) {
        for (let run; (run = RUNS.exec(line)); ) if (run[0].length === span) { end = run.index + span; span = 0; break; }
      } else {
        span = RUNS.exec(line)![0].length;
        end = tick + span;
      }
      out += line.slice(tick, end);
      at = end;
    }
    return out;
  };
  let out = "";
  for (const line of text.split(/(?<=\n)/)) {
    const body = line.replace(QUOTE, "");
    const open = FENCE.exec(body);
    const mark = open?.[2];
    const depth = line.slice(0, line.length - body.length).split(">").length - 1;
    const indent = body.length - body.trimStart().length;
    if (fence && (depth < fenceDepth || (fenceColumn && body.trim() && indent < fenceColumn))) fence = "";
    if (fence) {
      const end = FENCE_END.exec(body)?.[1];
      if (end && end[0] === fence[0] && end.length >= fence.length) fence = "";
      out += line;
    } else if (mark || !body.trim()) {
      fence = mark ?? "";
      fenceDepth = depth;
      fenceColumn = /[^ ]/.test(open?.[1] ?? "") ? open![1].length : 0;
      span = 0;
      indented = false;
      blank = !mark;
      out += line;
    } else {
      indented = INDENT.test(body) && (blank || indented);
      blank = false;
      out += indented ? line : scan(line);
    }
  }
  return out;
}
