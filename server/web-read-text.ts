// Page bytes to readable text, and the bot-check pages that must count as blocked.
import { inflateSync } from "node:zlib";

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
const HIDDEN = new Set(["head", "nav", "header", "footer", "aside", "form", "button", "select"]);
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

const CHALLENGES: Array<[RegExp, string]> = [
  [/<title>\s*just a moment/i, "Cloudflare bot check (Just a moment)"],
  [/cf-browser-verification|challenge-platform|cf_chl_|cf-turnstile/i, "Cloudflare bot check"],
  [/attention required! \| cloudflare/i, "Cloudflare block page"],
  [/blocked by network security/i, "site's network security block"],
  [/js_challenge/i, "JavaScript challenge page"],
  [/captcha-delivery\.com|datadome/i, "DataDome bot check"],
  [/px-captcha|_pxcaptcha|press (?:&amp;|&) hold/i, "PerimeterX bot check"],
  [/_incapsula_resource|incapsula incident/i, "Imperva bot check"],
  [/access denied[\s\S]{0,400}reference #[\d.a-f]+/i, "Akamai access denied page"],
];
const SHORT_CHALLENGES: Array<[RegExp, string]> = [
  [/g-recaptcha|h-captcha|hcaptcha\.com|verify (?:that )?you are (?:a )?human|are you a robot|unusual traffic/i, "CAPTCHA page"],
  [/sign ?in to (?:continue|view|see)|log ?in to (?:continue|view|see)|join now to see/i, "login wall"],
  [/enable javascript (?:and cookies )?to continue|please enable js/i, "JavaScript-only bot check"],
];
const AUTH_PATH = /\/(login|signin|sign-in|sign_in|authwall|checkpoint|uas\/login|accounts\/login|i\/flow\/login)(\/|\?|$)/i;

/** A page that is a bot check, CAPTCHA or login wall rather than the content; null when it looks real. */
export function challengeReason(html: string, finalUrl: URL, text: string): string | null {
  if (AUTH_PATH.test(finalUrl.pathname + finalUrl.search) || /^accounts\.google\.com$|^login\./i.test(finalUrl.hostname)) return "login wall (redirected to sign-in)";
  const head = html.slice(0, 60_000);
  for (const [pattern, reason] of CHALLENGES) if (pattern.test(head)) return reason;
  if (text.length < 1_500) for (const [pattern, reason] of SHORT_CHALLENGES) if (pattern.test(head)) return reason;
  return null;
}

// PDF text: inflate each content stream and keep the strings its text operators draw. Enough for most text PDFs; scanned or CID-font PDFs come back empty.
function pdfString(raw: string): string {
  return raw
    .replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, esc: string) => ({ n: "\n", r: "", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" })[esc] ?? String.fromCharCode(parseInt(esc, 8)));
}

const PDF_STREAM_BYTES = 8_000_000;

/** Text drawn with Tj/TJ in a PDF's content streams; "" when it looks scanned or garbled. Linear scans, bounded inflate. */
export function pdfToText(buffer: Buffer): string {
  const source = buffer.toString("latin1");
  const out: string[] = [];
  let pos = 0;
  let previousEnd = 0;
  while (pos < source.length) {
    const keyword = source.indexOf("stream", pos);
    if (keyword < 0) break;
    pos = keyword + 6;
    if (source.startsWith("end", keyword - 3)) continue;
    let back = keyword - 1;
    while (back > previousEnd && /\s/.test(source[back]!)) back--;
    if (source[back] !== ">" || source[back - 1] !== ">") continue;
    const start = pos + (source.startsWith("\r\n", pos) ? 2 : source[pos] === "\n" ? 1 : 0);
    const end = source.indexOf("endstream", start);
    if (end < 0) break;
    const dict = source.slice(Math.max(previousEnd, keyword - 4096), keyword);
    pos = previousEnd = end + 9;
    let content = source.slice(start, end);
    if (dict.includes("FlateDecode")) {
      try {
        content = inflateSync(Buffer.from(content, "latin1"), { maxOutputLength: PDF_STREAM_BYTES }).toString("latin1");
      } catch {
        continue;
      }
    } else if (dict.includes("Filter")) continue;
    let at = 0;
    while (at < content.length) {
      const bt = content.indexOf("BT", at);
      if (bt < 0) break;
      const et = content.indexOf("ET", bt + 2);
      if (et < 0) break;
      at = et + 2;
      const line = [...content.slice(bt + 2, et).matchAll(/\((?:[^()\\]|\\.)*\)\s*Tj|\[[^\]]{0,4096}\]\s*TJ/g)]
        .map((op) => [...op[0].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map((s) => pdfString(s[1]!)).join(""))
        .join("");
      if (line.trim()) out.push(line.trim());
    }
  }
  const text = out.join("\n");
  const words = text.match(/[A-Za-z\u00c0-\u024f]{2,}/g)?.join("").length ?? 0;
  return words >= Math.max(40, text.replace(/\s/g, "").length * 0.5) ? text : "";
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
