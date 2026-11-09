const TAG = /<\/?user\d+>/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const RUNS = /`+/g;

function unwrapLine(line: string): string {
  let out = "";
  let at = 0;
  while (at < line.length) {
    const tick = line.indexOf("`", at);
    out += line.slice(at, tick < 0 ? line.length : tick).replace(TAG, "");
    if (tick < 0) break;
    RUNS.lastIndex = tick;
    const size = RUNS.exec(line)![0].length;
    let end = line.length;
    for (let run; (run = RUNS.exec(line)); ) if (run[0].length === size) { end = run.index + size; break; }
    out += line.slice(tick, end);
    at = end;
  }
  return out;
}

/** Drops `<userN>` tags a bot leaves outside a peer reply, keeping the inner text and any code. An unclosed fence or backtick counts as code, so a streamed prefix unwraps like its whole. */
export function unwrapUserTags(text: string): string {
  if (!/<\/?user\d/.test(text)) return text;
  let fence = "";
  let out = "";
  for (const line of text.split(/(?<=\n)/)) {
    const mark = FENCE.exec(line)?.[1];
    if (fence ? mark && mark[0] === fence[0] && mark.length >= fence.length : mark) fence = fence ? "" : mark!;
    else if (!fence) { out += unwrapLine(line); continue; }
    out += line;
  }
  return out;
}
