export interface ToolDetail {
  input?: string;
  output?: string[];
  more?: number;
  diff?: string[];
  outputHidden?: boolean;
}

interface ToolDetailInput {
  input?: string;
  output?: string;
  diff?: string[];
  outputHidden?: boolean;
  isError?: boolean;
  more?: number;
}

const NON_ASCII = /[\x80-\uffff]/;
// UTF-8 length as TextEncoder counts it: a lone surrogate encodes as U+FFFD.
const bytes = (value: unknown) => {
  const json = JSON.stringify(value);
  let length = json.length;
  if (!NON_ASCII.test(json)) return length;
  for (let i = 0; i < json.length; i++) {
    const code = json.codePointAt(i)!;
    if (code > 0xffff) i++;
    length += code < 0x80 ? 0 : code < 0x800 ? 1 : 2;
  }
  return length;
};
const clip = (text: string, chars: number) => {
  if (text.length <= chars) return text;
  let end = 0;
  for (let count = 0; count < chars && end < text.length; count++) end += text.codePointAt(end)! > 0xffff ? 2 : 1;
  return text.slice(0, end);
};
const shorten = (text: string) => Array.from(text).slice(0, -1).join("");

export function buildToolDetail(source: ToolDetailInput, redact: (text: string) => string): ToolDetail {
  const detail: ToolDetail = {};
  if (source.input) detail.input = clip(redact(source.input), 120);
  if (source.outputHidden) detail.outputHidden = true;
  else {
    const field = !source.isError && source.diff?.length ? "diff" : "output";
    const text = redact(field === "diff" ? source.diff!.join("\n") : source.output ?? "").replace(/\r\n?/g, "\n");
    const lines = text ? text.replace(/\n$/, "").split("\n") : [];
    const preview = lines.slice(0, source.isError ? 1 : 3).map((line) => clip(line, 80));
    if (preview.length) {
      detail[field] = preview;
      const more = (source.more ?? 0) + lines.length - preview.length;
      if (more > 0) detail.more = more;
      if (bytes(detail) <= 256) return detail;
      // Reserve a character per line so a long header cannot erase the output.
      detail[field] = preview.map((line) => clip(line, 1));
      while (bytes(detail) > 256) detail.input = shorten(detail.input!);
      detail[field] = preview;
      while (bytes(detail) > 256) {
        const longest = preview.map((line, index) => ({ line, index }))
          .filter(({ line }) => Array.from(line).length > 1)
          .sort((a, b) => bytes(b.line) - bytes(a.line))[0];
        if (!longest) break;
        preview[longest.index] = shorten(preview[longest.index]);
      }
    }
  }
  while (bytes(detail) > 256) detail.input = shorten(detail.input!);
  return detail;
}
