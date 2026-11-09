const TAG = /<\/?user\d+>/g;
const EDGE_HEAD = /^( *)(?:<\/?user\d+>)+/;
const EDGE_TAIL = /(?:<\/?user\d+>)+(\s*)$/;
const PARTIAL_TAG = /<\/?(?:u(?:s(?:e(?:r\d*)?)?)?)?$/;
const HOLD = /(?:<\/?(?:u(?:s(?:e(?:r\d*)?)?)?)?|[\\`]+)$/;
const UNSETTLED = /^[\s>*+\-\d.)`~_#]*$/;
const OPENER = /^ *<user(\d+)>/;
const CLOSER = /<\/user(\d+)>(\s*)$/;
const QUOTE = /^(?: {0,3}>[ \t]?)+/;
const FENCE = /^( *(?:(?:[-*+]|\d{1,9}[.)]) +)*)(`{3,}(?=[^`]*$)|~{3,})/;
const FENCE_END = /^[ \t]*(`{3,}|~{3,})\s*$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])( +)(?=\S)/;
const BREAK = /^ {0,3}(?:#{1,6}(?:\s|$)|([-*_])(?:[ \t]*\1){2,}\s*$)/;
const RUNS = /`+/g;
const EOL = /[\r\n]/g;

function openTick(text: string, from: number): number {
  for (let at = text.indexOf("`", from); at >= 0; at = text.indexOf("`", at + 1)) {
    let slashes = 0;
    while (text[at - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 0) return at;
  }
  return -1;
}

/** Drops `<userN>` tags a bot leaves outside a peer reply, keeping the inner text and any code. Fed text in pieces, it costs only the new piece; a tag, backtick run or line start still undecided at the end of a piece is held for the next. */
export class UserTagScanner {
  private fence = "";
  private fenceDepth = 0;
  private fenceColumn = 0;
  private listColumn = 0;
  private span = 0;
  private indented = false;
  private blank = true;
  private wrapped = "";
  private kind?: "code" | "text";
  private buf = "";
  private held = "";
  private afterCR = false;

  push(chunk: string): string {
    if (!chunk) return "";
    let out = "";
    let at = 0;
    // the "\n" of a CRLF split across chunks belongs to the line already ended
    if (this.afterCR && chunk[0] === "\n") { out = "\n"; at = 1; }
    this.afterCR = false;
    while (at < chunk.length) {
      EOL.lastIndex = at;
      const eol = EOL.exec(chunk);
      let end = eol ? eol.index + 1 : chunk.length;
      if (eol && chunk[eol.index] === "\r") {
        if (chunk[end] === "\n") end++;
        else if (end === chunk.length) this.afterCR = true;
      }
      out += this.feed(chunk.slice(at, end), Boolean(eol), false);
      at = end;
    }
    return out;
  }

  finish(): string {
    return this.kind || this.buf ? this.feed("", false, true) : "";
  }

  private feed(piece: string, last: boolean, flush: boolean): string {
    const final = last || flush;
    let out: string;
    if (this.kind) out = this.kind === "code" ? piece : this.inline(piece, final);
    else {
      this.buf += piece;
      if (!final && this.unsettled(this.buf)) return "";
      const { code, head } = this.classify(this.buf);
      const buf = this.buf;
      this.buf = "";
      this.kind = code ? "code" : "text";
      out = code ? head : this.inline(buf, final);
    }
    if (last) this.kind = undefined;
    return out;
  }

  // a line start made only of quote, list and fence characters could still become a fence line
  private unsettled(buf: string): boolean {
    if (buf.length > 256) return false;
    const body = buf.replace(QUOTE, "").replace(EDGE_HEAD, "$1").replace(EDGE_TAIL, "$1").replace(PARTIAL_TAG, "");
    return UNSETTLED.test(body);
  }

  private classify(line: string): { code: boolean; head: string } {
    const body = line.replace(QUOTE, "");
    const quote = line.slice(0, line.length - body.length);
    const depth = quote.split(">").length - 1;
    // a wrapper around a fenced reply is not part of the fence line
    const core = body.replace(EDGE_HEAD, "$1").replace(EDGE_TAIL, "$1").replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, "    "));
    const indent = /^ */.exec(core)![0].length;
    const open = FENCE.exec(core);
    const mark = open?.[2];
    if (this.fence && (depth < this.fenceDepth || (this.fenceColumn && core.trim() && indent < this.fenceColumn))) this.fence = "";
    if (this.fence) {
      // only a wrapper that opened with the fence may come off its closing line
      const closer = this.wrapped ? CLOSER.exec(body) : null;
      const last = closer?.[1] === this.wrapped ? body.slice(0, closer.index) + closer[2] : body;
      const end = FENCE_END.exec(last)?.[1];
      if (!end || depth !== this.fenceDepth || indent > this.fenceColumn + 3 || end[0] !== this.fence[0] || end.length < this.fence.length) {
        return { code: true, head: line };
      }
      this.fence = "";
      this.blank = true;
      return { code: true, head: quote + last };
    }
    // a fence marker inside indented code is code, not a fence
    const buried = Boolean(body.trim()) && indent - this.listColumn >= 4 && (this.blank || this.indented);
    if (!buried && (mark || !body.trim())) {
      this.fence = mark ?? "";
      this.wrapped = (mark && OPENER.exec(body)?.[1]) || "";
      this.fenceDepth = depth;
      this.fenceColumn = !mark ? 0 : /[^ ]/.test(open![1]) ? open![1].length : indent >= this.listColumn ? this.listColumn : 0;
      this.span = 0;
      this.indented = false;
      this.blank = !mark;
      return { code: true, head: mark ? quote + body.replace(EDGE_HEAD, "$1") : line };
    }
    let code = buried;
    const item = code || BREAK.test(core) ? null : ITEM.exec(core);
    if (item) {
      code = item[3].length >= 5;
      this.listColumn = item[1].length + item[2].length + (code ? 1 : item[3].length);
    } else if (!code && indent < this.listColumn) this.listColumn = 0;
    this.indented = code;
    // indented code may follow a heading or rule without a blank line
    this.blank = !code && BREAK.test(core);
    return { code, head: line };
  }

  private inline(text: string, final: boolean): string {
    const all = this.held + text;
    const keep = final ? 0 : HOLD.exec(all)?.[0].length ?? 0;
    this.held = all.slice(all.length - keep);
    return this.scan(all.slice(0, all.length - keep));
  }

  private scan(text: string): string {
    let out = "";
    let at = 0;
    while (at < text.length) {
      const tick = this.span ? at : openTick(text, at);
      if (!this.span) out += text.slice(at, tick < 0 ? text.length : tick).replace(TAG, "");
      if (tick < 0) break;
      RUNS.lastIndex = tick;
      let end = text.length;
      if (this.span) {
        for (let run; (run = RUNS.exec(text)); ) if (run[0].length === this.span) { end = run.index + this.span; this.span = 0; break; }
      } else {
        this.span = RUNS.exec(text)![0].length;
        end = tick + this.span;
      }
      out += text.slice(tick, end);
      at = end;
    }
    return out;
  }
}

export function unwrapUserTags(text: string): string {
  if (!/<\/?user\d/.test(text)) return text;
  const scanner = new UserTagScanner();
  return scanner.push(text) + scanner.finish();
}
