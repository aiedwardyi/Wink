// Page bytes to readable text, and the bot-check pages that must count as blocked.
import { promisify } from "node:util";
import { inflate } from "node:zlib";

export const TEXT_CAP = 8_000;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: "(c)", reg: "(R)", trade: "(TM)", middot: "·", bull: "*" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const point = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

// Raw-text elements skipped whole; hidden ones keep their tags (for <meta>) but not their text.
const RAW = new Set(["script", "style", "noscript", "svg", "template", "iframe", "canvas", "title", "textarea"]);
// A <form> keeps its text: ASP.NET, SharePoint, DNN and many Korean boards wrap the whole page in one; its controls (button, select, textarea) still drop.
const HIDDEN = new Set(["head", "nav", "header", "footer", "aside", "button", "select"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "blockquote", "pre", "table", "tr", "ul", "ol", "dl", "dt", "dd", "figure", "figcaption"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

function tidy(raw: string): string {
  return decodeEntities(raw)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join("\n")
    .trim();
}

export type PageText = { title: string; description: string; text: string };

/**
 * The page's main text: the biggest <article> or <main>, else the body, minus navigation chrome.
 * One left-to-right pass with indexOf, so hostile markup (unclosed tags, comments) stays linear.
 */
export function htmlToText(html: string): PageText {
  const metas = new Map<string, string>();
  let title = "";
  const body: string[] = [];
  const regions: string[][] = [];
  let region: string[] | null = null;
  let regionDepth = 0;
  let hidden = 0;
  const emit = (piece: string) => {
    if (hidden) return;
    body.push(piece);
    region?.push(piece);
  };
  let pos = 0;
  while (pos < html.length) {
    const open = html.indexOf("<", pos);
    if (open < 0) {
      emit(html.slice(pos));
      break;
    }
    if (open > pos) emit(html.slice(pos, open));
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close < 0) break;
      pos = close + 3;
      continue;
    }
    const name = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(open, open + 40));
    const special = html[open + 1] === "!" || html[open + 1] === "?";
    if (!name && !special) {
      emit("<");
      pos = open + 1;
      continue;
    }
    const end = html.indexOf(">", open + 1);
    if (end < 0) break;
    pos = end + 1;
    if (!name) continue;
    const closing = name[1] === "/";
    const tag = name[2]!.toLowerCase();
    if (!closing && RAW.has(tag)) {
      const finish = new RegExp(`</${tag}\\s*>`, "gi");
      finish.lastIndex = pos;
      const found = finish.exec(html);
      if (tag === "title" && !title) title = html.slice(pos, found ? found.index : Math.min(html.length, pos + 2000)).slice(0, 2000);
      if (!found) break;
      pos = found.index + found[0].length;
      continue;
    }
    if (tag === "meta" && !closing) {
      const tagText = html.slice(open, end);
      const key = (attribute(tagText, "property") ?? attribute(tagText, "name"))?.toLowerCase();
      const content = attribute(tagText, "content");
      if (key && content !== undefined && !metas.has(key)) metas.set(key, content);
      continue;
    }
    if (HIDDEN.has(tag)) {
      if (!VOID.has(tag) && !html.slice(open, end).endsWith("/")) hidden = Math.max(0, hidden + (closing ? -1 : 1));
      continue;
    }
    if (tag === "article" || tag === "main") {
      if (!closing && regionDepth++ === 0 && !hidden) regions.push((region = []));
      if (closing && regionDepth > 0 && --regionDepth === 0) region = null;
      emit("\n");
      continue;
    }
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) emit(closing ? "\n" : `\n\n${"#".repeat(Number(heading[1]))} `);
    else if (tag === "li" && !closing) emit("\n- ");
    else if (tag === "br" || tag === "hr") emit("\n");
    else if (BLOCK.has(tag)) emit("\n");
    else if (closing && (tag === "td" || tag === "th")) emit(" | ");
  }
  const meta = (key: string) => decodeEntities(metas.get(key) ?? "").trim();
  const best = regions.map((parts) => tidy(parts.join(""))).sort((a, b) => b.length - a.length)[0] ?? "";
  return {
    title: decodeEntities(title).replace(/\s+/g, " ").trim() || meta("og:title"),
    description: meta("og:description") || meta("description") || meta("twitter:description"),
    text: best.length >= 300 ? best : tidy(body.join("")),
  };
}

// Marks only a challenge page carries: always a block.
const CHALLENGES: Array<[RegExp, string]> = [
  [/<title>\s*just a moment/i, "Cloudflare bot check (Just a moment)"],
  [/cf-browser-verification|cf_chl_/i, "Cloudflare bot check"],
  [/attention required! \| cloudflare/i, "Cloudflare block page"],
  [/blocked by network security/i, "site's network security block"],
  [/js_challenge/i, "JavaScript challenge page"],
  [/px-captcha|_pxcaptcha|press (?:&amp;|&) hold/i, "PerimeterX bot check"],
  [/_incapsula_resource|incapsula incident/i, "Imperva bot check"],
  [/access denied[\s\S]{0,400}reference #[\d.a-f]+/i, "Akamai access denied page"],
];
// Scripts and widgets a normal page may also carry: a block only when the page has little text.
const SHORT_CHALLENGES: Array<[RegExp, string]> = [
  [/challenge-platform|cf-turnstile/i, "Cloudflare bot check"],
  [/captcha-delivery\.com|datadome/i, "DataDome bot check"],
  [/g-recaptcha|h-captcha|hcaptcha\.com|verify (?:that )?you are (?:a )?human|are you a robot|unusual traffic/i, "CAPTCHA page"],
  [/sign ?in to (?:continue|view|see)|log ?in to (?:continue|view|see)|join now to see/i, "login wall"],
  [/enable javascript (?:and cookies )?to continue|please enable js/i, "JavaScript-only bot check"],
];
const AUTH_PATH = /\/(login|signin|sign-in|sign_in|authwall|checkpoint|uas\/login|accounts\/login|i\/flow\/login)(\/|\?|$)/i;

/** A page that is a bot check, CAPTCHA or login wall rather than the content; null when it looks real. A sign-in address counts only when a redirect led there (a page about signing in is a page). */
export function challengeReason(html: string, finalUrl: URL, text: string, askedUrl: URL = finalUrl): string | null {
  const redirected = finalUrl.origin !== askedUrl.origin || finalUrl.pathname !== askedUrl.pathname;
  if (redirected && (AUTH_PATH.test(finalUrl.pathname + finalUrl.search) || /^accounts\.google\.com$|^login\./i.test(finalUrl.hostname))) return "login wall (redirected to sign-in)";
  const head = html.slice(0, 60_000);
  for (const [pattern, reason] of CHALLENGES) if (pattern.test(head)) return reason;
  if (text.length < 1_500) for (const [pattern, reason] of SHORT_CHALLENGES) if (pattern.test(head)) return reason;
  return null;
}

// PDF text: inflate each content stream and keep the strings its text operators draw. Enough for most text PDFs; scanned or CID-font PDFs come back empty.
// Every scan is a hand loop over the bytes (no regex on untrusted PDF data), inflate runs off the main thread, and the work yields to the event loop.
const PDF_STREAM_BYTES = 8_000_000;
/** Inflated bytes read from one PDF in all; the rest of a bigger PDF is skipped. */
const PDF_TOTAL_BYTES = 24_000_000;
/** Text kept from one PDF; a read shows far less (TEXT_CAP), so more is wasted work. */
const PDF_TEXT_CHARS = 64_000;
const YIELD_EVERY = 256_000;
const inflateAsync = promisify(inflate);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ESCAPES: Record<string, string> = { n: "\n", r: "", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" };
const WIN_ANSI: Record<number, string> = { 0x85: "...", 0x91: "'", 0x92: "'", 0x93: '"', 0x94: '"', 0x95: "*", 0x96: "-", 0x97: "-" };
const isSpace = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
const isDelimiter = (c: string) => isSpace(c) || "()<>[]{}/%".includes(c);

/** Text drawn by one content stream: Tj, TJ, ' and " strings, a space for a word-sized TJ kerning gap and between text moves, a new line for a line move. */
async function contentText(content: string, room: number): Promise<string> {
  let out = "";
  let pending = "";
  let numbers: number[] = [];
  let inText = false;
  let inArray = false;
  let nextYield = YIELD_EVERY;
  const flush = (separator: string) => {
    if (separator && out && !out.endsWith(separator) && !out.endsWith("\n")) out += separator;
  };
  let i = 0;
  while (i < content.length && out.length < room) {
    if (i >= nextYield) {
      nextYield = i + YIELD_EVERY;
      await tick();
    }
    const c = content[i]!;
    if (c === "(") {
      // A literal string: balanced parentheses nest, a backslash escapes the next char.
      let depth = 1;
      let text = "";
      i++;
      while (i < content.length && depth > 0) {
        const d = content[i]!;
        if (d === "\\") {
          const e = content[i + 1] ?? "";
          if (e >= "0" && e <= "7") {
            let digits = "";
            let j = i + 1;
            while (j < content.length && digits.length < 3 && content[j]! >= "0" && content[j]! <= "7") digits += content[j++];
            text += String.fromCharCode(parseInt(digits, 8) & 255);
            i = j;
            continue;
          }
          if (e === "\r" || e === "\n") {
            i += content[i + 1] === "\r" && content[i + 2] === "\n" ? 3 : 2;
            continue;
          }
          text += ESCAPES[e] ?? e;
          i += 2;
          continue;
        }
        if (d === "(") depth++;
        else if (d === ")" && --depth === 0) break;
        text += d;
        i++;
      }
      i++;
      if (inText) pending += text;
      continue;
    }
    if (c === "[") {
      inArray = true;
      i++;
      continue;
    }
    if (c === "]") {
      inArray = false;
      i++;
      continue;
    }
    if (c === "<" && content[i + 1] !== "<") {
      // Hex strings draw glyph ids this reader can't map to text: skip them.
      const close = content.indexOf(">", i + 1);
      i = close < 0 ? content.length : close + 1;
      continue;
    }
    if (c === "%") {
      while (i < content.length && content[i] !== "\n" && content[i] !== "\r") i++;
      continue;
    }
    if (isSpace(c) || isDelimiter(c)) {
      i++;
      continue;
    }
    let j = i;
    while (j < content.length && !isDelimiter(content[j]!)) j++;
    const token = content.slice(i, j);
    i = j;
    const value = Number(token);
    if (token && Number.isFinite(value) && /[0-9]/.test(token[0] === "-" || token[0] === "+" || token[0] === "." ? token.slice(1, 2) || "0" : token[0]!)) {
      // A gap wider than about a fifth of an em inside TJ is a word space (LaTeX writes no space characters).
      if (inArray && inText && value < -200 && pending && !pending.endsWith(" ")) pending += " ";
      numbers.push(value);
      if (numbers.length > 6) numbers = numbers.slice(-6);
      continue;
    }
    if (token === "BT") inText = true;
    else if (token === "ET") {
      inText = false;
      flush("\n");
    } else if (token === "Tj" || token === "TJ" || token === "'" || token === '"') {
      if (token !== "Tj" && token !== "TJ") flush("\n");
      out += pending;
      pending = "";
    } else if (token === "Td" || token === "TD") {
      flush(numbers.at(-1) ? "\n" : " ");
    } else if (token === "T*") flush("\n");
    else if (token === "Tm") flush(" ");
    numbers = [];
  }
  return out;
}

/** Text drawn with Tj/TJ in a PDF's content streams; "" when it looks scanned or garbled. Linear scans, bounded inflate, yields to the event loop. */
export async function pdfToText(buffer: Buffer): Promise<string> {
  const source = buffer.toString("latin1");
  const parts: string[] = [];
  let size = 0;
  let inflated = 0;
  let pos = 0;
  let previousEnd = 0;
  while (pos < source.length && size < PDF_TEXT_CHARS && inflated < PDF_TOTAL_BYTES) {
    const keyword = source.indexOf("stream", pos);
    if (keyword < 0) break;
    pos = keyword + 6;
    if (source.startsWith("end", keyword - 3)) continue;
    let back = keyword - 1;
    while (back > previousEnd && isSpace(source[back]!)) back--;
    if (source[back] !== ">" || source[back - 1] !== ">") continue;
    const start = pos + (source.startsWith("\r\n", pos) ? 2 : source[pos] === "\n" ? 1 : 0);
    const end = source.indexOf("endstream", start);
    if (end < 0) break;
    const dict = source.slice(Math.max(previousEnd, keyword - 4096), keyword);
    pos = previousEnd = end + 9;
    let content = source.slice(start, end);
    if (dict.includes("FlateDecode")) {
      try {
        const room = Math.min(PDF_STREAM_BYTES, PDF_TOTAL_BYTES - inflated);
        content = (await inflateAsync(Buffer.from(content, "latin1"), { maxOutputLength: room })).toString("latin1");
      } catch {
        continue;
      }
    } else if (dict.includes("Filter")) continue;
    inflated += content.length;
    const text = (await contentText(content, PDF_TEXT_CHARS - size)).trim();
    if (text) {
      parts.push(text);
      size += text.length;
    }
    await tick();
  }
  // Control bytes are font codes this reader can't map (ligatures, symbols); they are not text. 0x80-0x9f are WinAnsi punctuation.
  let text = "";
  for (const ch of parts.join("\n")) {
    const code = ch.charCodeAt(0);
    if (code >= 0x80 && code <= 0x9f) text += WIN_ANSI[code] ?? "";
    else text += code < 32 && ch !== "\n" ? (code === 9 ? " " : "") : code === 127 ? "" : ch;
  }
  let letters = 0;
  let visible = 0;
  let run = 0;
  for (const ch of text) {
    const letter = /\p{L}/u.test(ch);
    if (!isSpace(ch)) visible++;
    run = letter ? run + 1 : 0;
    if (run === 2) letters += 2;
    else if (run > 2) letters++;
  }
  return letters >= Math.max(40, visible * 0.5) ? text : "";
}

/** The body as text in the charset the server or the page declares; UTF-8 when none or unknown. */
export function bodyText(body: Buffer, contentType = ""): string {
  const declared = /charset=["']?([\w.:-]+)/i.exec(contentType)?.[1]
    ?? /<meta[^>]{0,200}?charset=["']?([\w.:-]+)/i.exec(body.subarray(0, 2048).toString("latin1"))?.[1];
  try {
    return new TextDecoder(declared ?? "utf-8").decode(body);
  } catch {
    return body.toString("utf8");
  }
}

export function capText(text: string, cap = TEXT_CAP): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}\n[truncated: showing ${cap.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} chars]`;
}
