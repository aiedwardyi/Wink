// Real markdown for bot bubbles: react-markdown + GFM (tables, task lists,
// strikethrough, autolinks) with a chromed code block — language label, copy
// button, lazy Shiki highlighting. Model output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. While a message is still streaming, a code block renders
// as plain <pre> until its content has held still for STREAM_SETTLE_MS (the
// fence is very likely complete), then highlights and caches.
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Extension } from "mdast-util-from-markdown";
import { Check, Copy, PanelRight } from "lucide-react";
import { LinkedFolderLink } from "./LinkedFolderSheet";
import { FileMenu, type FileMenuAt } from "./MediaMenu";
import { ReadableImage } from "./MediaViewerProvider";
import { PhoneVideo } from "./PhoneVideo";
import { BADGE, ShowCard } from "./ShowCard";
import { z } from "zod";

import { useI18n, type MessageKey } from "@/lib/i18n";
import { EASE_STANDARD, MOTION_LARGE_MS } from "@/lib/motion";
import { linkedFileSrc, paneKind, saveFile, showItem, showKind, showName } from "@/lib/show-pane";
import { isTerminalSkin, useSkin } from "@/lib/skins";
import { useReplyStyle } from "@/lib/reply-style";
import { splitReplyBlocks } from "@/lib/turn-stage";
import { cardFile } from "../../shared/file-cards";
import { unwrapUserTags } from "../../shared/user-tags";
import { windowsPathLinks } from "../../shared/windows-path-links";
import { remarkWebLinks } from "@/lib/web-links";

// tiny highlight cache so revisiting a thread doesn't re-tokenize settled
// blocks; keys are content-hashed and capped. Streamed partials may land here
// under their own hash — harmless (never collides with the final content's
// key, and the cap evicts it), and the final content's entry is exactly what
// makes the settled bubble render highlighted on mount.
const highlightCache = new Map<string, string>();
const CACHE_MAX = 200;
// how long a streaming block's content must be unchanged before we spend a
// tokenize on it — long enough to skip per-token churn mid-fence, short
// enough that the highlight lands before the stream settles
const STREAM_SETTLE_MS = 250;
const TALL_CODE_LINES = 15;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// A markdown link whose target is a file on this machine: bots hand over
// bot-created documents as absolute paths or file:// URLs. Web links stay
// ordinary anchors handled by the shell's window-open policy.
// A leading slash covers macOS and Linux; "C:\…" and "C:/…" cover Windows,
// where a file:// URL's pathname also arrives as "/C:/…".
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;
const absolutePath = (value: string): string | null => {
  if (value.startsWith("/") && WINDOWS_PATH.test(value.slice(1))) return value.slice(1);
  if (value.startsWith("/") || WINDOWS_PATH.test(value)) return value;
  return null;
};

// hrefs arrive percent-encoded, so "C:\a" reaches us as "C:%5Ca"
const decodeHref = (href: string): string => {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
};

const localFilePath = (href?: string): string | null => {
  if (!href) return null;
  // URL schemes are case-insensitive, so FILE:// is as valid as file://
  if (/^file:\/\//i.test(href)) {
    try {
      return absolutePath(decodeURIComponent(new URL(href).pathname));
    } catch {
      return null;
    }
  }
  return absolutePath(decodeHref(href.replace(/[#?].*$/, "")));
};

// react-markdown's default transform blanks file: URLs and "C:\…" paths (an
// unknown scheme to it), and a blank href opened the app origin. Keep those
// for links only; LocalFileLink never puts them in the DOM.
const urlTransform = (url: string, key: string): string =>
  key === "href" && (/^file:/i.test(url) || WINDOWS_PATH.test(decodeHref(url))) ? url : defaultUrlTransform(url);

function remarkWindowsPaths(this: { data(): object }) {
  // SAFETY: remark-parse reads its mdast extensions from this list on the processor data.
  const data = this.data() as { fromMarkdownExtensions?: Extension[] };
  (data.fromMarkdownExtensions ??= []).push(windowsPathLinks);
}

// A bare relative target ("reps.py", "./notes.md", "..\x.txt") means a file in
// the writing bot's folder. As an anchor it would resolve against Orbit's own
// server and open a second Orbit window. "C:foo" reads as a scheme and stays an
// anchor, like any other non-file scheme.
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
export const isRelativeHref = (href: string): boolean => !SCHEME.test(href);

// Null when there is nothing to open: no known base, a #anchor / ?query, or a
// target that climbs out of the bot's folder.
export const resolveRelativePath = (href: string, base?: string | null): string | null => {
  const root = base ? absolutePath(base) : null;
  if (!root || /^[#?]/.test(href)) return null;
  let rel = href.replace(/[#?].*$/, "");
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* keep the raw target */
  }
  const win = WINDOWS_PATH.test(root);
  const drive = win ? `${root.slice(0, 2)}\\` : "/";
  const parts = root.slice(win ? 3 : 1).split(/[\\/]+/).filter(Boolean);
  const depth = parts.length;
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg === "..") {
      if (parts.length === depth) return null;
      parts.pop();
    } else if (seg && seg !== ".") parts.push(seg);
  }
  return drive + parts.join(win ? "\\" : "/");
};

const cardLink = (href: string) => {
  const path = localFilePath(href) ?? (isRelativeHref(href) ? href : null);
  return Boolean(path && (showKind(path) || cardFile(path)));
};

type MdNode = { type: string; value?: string; url?: string; children?: MdNode[]; data?: { hProperties?: Record<string, unknown> } };

// A bot often wraps a file link in "( )", which left lone parens above and below its card.
function remarkCardParens() {
  const walk = (node: MdNode) => node.children?.forEach((child, i, all) => {
    const before = all[i - 1];
    const after = all[i + 1];
    if (child.type === "link" && child.url && cardLink(child.url) && before?.type === "text" && after?.type === "text" && /\(\s*$/.test(before.value ?? "") && after.value?.startsWith(")")) {
      before.value = before.value!.replace(/\(\s*$/, "");
      after.value = after.value.slice(1);
    }
    walk(child);
  });
  return walk;
}

// A card is a block, so one named mid-line split its sentence; those draw as a plain link, and a file alone on its line keeps the card.
function remarkInlineFiles() {
  const walk = (node: MdNode) => {
    if (node.type !== "paragraph" && node.type !== "heading" && node.type !== "tableCell") return void node.children?.forEach(walk);
    let cards: MdNode[] = [];
    let worded = false;
    const endLine = () => {
      if (worded) for (const card of cards) card.data = { ...card.data, hProperties: { ...card.data?.hProperties, dataInline: "" } };
      cards = [];
      worded = false;
    };
    const read = (child: MdNode) => {
      if (child.type === "link" && child.url && cardLink(child.url)) cards.push(child);
      else if (child.type === "break") endLine();
      else if (child.children) child.children.forEach(read);
      else if (child.type !== "text") worded = true;
      else child.value?.split("\n").forEach((part, i) => {
        if (i) endLine();
        if (part.trim()) worded = true;
      });
    };
    node.children?.forEach(read);
    endLine();
  };
  return walk;
}

const StreamingContext = createContext(false);
const MarkdownTextContext = createContext("");
const PictureContext = createContext<((path: string) => () => void) | null>(null);

// Streaming replies split at blank lines that open a top-level block, so only
// the growing block re-parses per frame. HTML or a fence of unclear depth stops
// the split; a link definition keeps the reply whole.
const LIST_ITEM = /^(?:[-+*]|\d{1,9}[.)]?)(?:[ \t]|$)/;
const FENCE = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})/;

function backtickRunAt(line: string, length: number, from: number) {
  for (let at = from; at < line.length; at++) {
    if (line[at] !== "`") continue;
    let n = 1;
    while (line[at + n] === "`") n++;
    if (n === length) return at;
    at += n - 1;
  }
  return -1;
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isPunct = (c: string | undefined) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

// The growing tail paints as if an unambiguous open `**` or backtick were
// already closed, and leaves out a marker with nothing after it yet, so raw
// markdown never flashes. Anything less certain stays raw, as it settles.
export function settleStreamTail(block: string): string {
  let fence = "";
  for (const row of block.split("\n")) {
    const mark = FENCE.exec(row);
    if (!fence) fence = mark?.[2] ?? "";
    else if (mark && mark[2][0] === fence[0] && mark[2].length >= fence.length && !row.slice(mark[0].length).trim()) fence = "";
  }
  if (fence) return block;
  const start = block.lastIndexOf("\n") + 1;
  const line = block.slice(start);
  // Indented code, or a list continuation that reads the same: never rewrite code.
  if (/^(?: {4}|\t)/.test(line)) return block;
  if (/^\s*(?:[-*+>]|\d{1,9}[.)]|#{1,6})\s*$/.test(line)) return block.slice(0, start);
  const open: { at: number; n: number }[] = [];
  let visible = line.length;
  let tick = "";
  for (let at = 0; at < line.length; at++) {
    const c = line[at];
    if (c === "\\") {
      at++;
      continue;
    }
    if (c !== "`" && c !== "*") continue;
    let n = 1;
    while (line[at + n] === c) n++;
    const prev = line[at - 1];
    const next = line[at + n];
    if (c === "`") {
      const close = backtickRunAt(line, n, at + n);
      if (close >= 0) {
        at = close + n - 1;
        continue;
      }
      if (line.slice(at + n).trim()) tick = line.slice(at, at + n);
      else visible = at;
      break;
    }
    // A trailing run is an opener, half a closer or a bullet: unknown until the next character.
    if (next === undefined) {
      if (open.at(-1)?.n === n && !isSpace(prev)) open.pop();
      else visible = at;
      break;
    }
    // CommonMark flanking: an opener leans on the text after it, a closer on the text before.
    const opens = !isSpace(next) && (!isPunct(next) || isSpace(prev) || isPunct(prev));
    const closes = !isSpace(prev) && (!isPunct(prev) || isSpace(next) || isPunct(next));
    if (closes && open.at(-1)?.n === n) open.pop();
    else if (opens) open.push({ at, n });
    at += n - 1;
  }
  // Only `**` opening a word is safe to close early; a lone `*` is as often `*.ts` or `*args` as italics.
  const strong = open.length === 1 && open[0].n === 2 && (open[0].at === 0 || /[\s([{"']/.test(line[open[0].at - 1]))
    && /[\p{L}\p{N}]/u.test(line[open[0].at + 2]);
  const shown = line.slice(0, visible);
  const kept = shown.trimEnd();
  return block.slice(0, start) + kept + tick + (strong ? "**" : "") + shown.slice(kept.length);
}

export function streamBlocks(text: string): string[] {
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(text)) return [text];
  const blocks: string[] = [];
  let start = 0;
  let blank = false;
  let fence: { mark: string; indent: number } | null = null;
  for (let at = 0; at < text.length; ) {
    const end = text.indexOf("\n", at);
    const next = end === -1 ? text.length : end + 1;
    const line = text.slice(at, next);
    const indent = line.length - line.trimStart().length;
    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[2][0] === fence.mark[0] && close[2].length >= fence.mark.length && !line.slice(close[0].length).trim()) {
        if (indent < fence.indent) break;
        fence = null;
      } else if (line.trim() && indent < fence.indent) break;
    } else if (!line.trim()) {
      blank = true;
    } else {
      if (blank && indent === 0 && !LIST_ITEM.test(line)) {
        blocks.push(text.slice(start, at));
        start = at;
      }
      blank = false;
      if (/^ {0,3}</.test(line)) break;
      const open = FENCE.exec(line);
      if (open) fence = { mark: open[2], indent: open[1].length };
    }
    at = next;
  }
  blocks.push(text.slice(start));
  return blocks;
}

const REMARK = [remarkGfm, remarkWindowsPaths, remarkCardParens, remarkInlineFiles, remarkWebLinks];

/** Parses a scrap at idle, so the first reply doesn't pay the parser's compile. */
export function warmMarkdown() {
  Markdown({ children: "**a** `b`\n\n- c", remarkPlugins: REMARK, urlTransform });
}

const MarkdownBlock = memo(function MarkdownBlock({ text, components }: { text: string; components: Components }) {
  return (
    <MarkdownTextContext.Provider value={text}>
      <Markdown remarkPlugins={REMARK} components={components} urlTransform={urlTransform}>
        {text}
      </Markdown>
    </MarkdownTextContext.Provider>
  );
});

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const streaming = useContext(StreamingContext);
  const [html, setHtml] = useState<string | null>(null);
  const highlighted = useMemo(() => ({ __html: html ?? "" }), [html]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const key = `${lang}:${hash(code)}`;
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const highlight = () => {
      import("shiki")
        .then((shiki) =>
          shiki.codeToHtml(code, {
            lang: lang || "text",
            theme: "github-dark-default",
          }),
        )
        .then((out) => {
          if (!alive) return;
          if (highlightCache.size >= CACHE_MAX) {
            const first = highlightCache.keys().next().value;
            if (first) highlightCache.delete(first);
          }
          highlightCache.set(key, out);
          setHtml(out);
        })
        .catch(() => {
          /* unknown language or shiki failed — the plain <pre> stays */
        });
    };
    if (streaming) {
      // any earlier highlight is of a shorter snapshot — drop it so the
      // growing plain <pre> shows the real content, then wait for the block
      // to hold still. The effect re-runs (and this cleanup clears the timer)
      // on every content change, which is the debounce.
      setHtml(null);
      timer = setTimeout(highlight, STREAM_SETTLE_MS);
    } else {
      highlight();
    }
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [code, lang, streaming]);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const tall = code.split("\n").length > TALL_CODE_LINES;

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between border-b border-hairline/30 px-3 py-1">
        <span className="text-[11px] uppercase tracking-wide text-ink-secondary">{lang || "code"}</span>
        <button
          onClick={copy}
          className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Copy code"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
        </button>
      </div>
      {html ? (
        <div
          className="overflow-x-auto text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3"
          dangerouslySetInnerHTML={highlighted}
        />
      ) : (
        <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed text-ink">{code}</pre>
      )}
      {tall && (
        <div className="flex justify-end border-t border-hairline/30 px-3 py-1">
          <button
            onClick={copy}
            className="rounded p-1 text-ink-secondary hover:bg-raised hover:text-ink"
            title="Copy code"
          >
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          </button>
        </div>
      )}
    </div>
  );
}

const PHONE_MEDIA = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  mp4: "video", webm: "video", mov: "video", m4v: "video",
  mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", aac: "audio", flac: "audio",
  pdf: "pdf",
} as const;

type PhoneExt = keyof typeof PHONE_MEDIA;
type PhoneKind = (typeof PHONE_MEDIA)[PhoneExt];

function isPhoneExt(value: string): value is PhoneExt {
  return Object.hasOwn(PHONE_MEDIA, value);
}

function phoneMediaKind(filePath: string): PhoneKind | null {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return isPhoneExt(ext) ? PHONE_MEDIA[ext] : null;
}

const missingFileSchema = z.object({ deviceId: z.string().min(1).optional(), reason: z.literal("outside").optional() });
const deviceListSchema = z.object({
  devices: z.array(z.object({
    deviceId: z.string(),
    name: z.string().min(1),
    host: z.string().min(1),
    current: z.boolean().optional(),
    offline: z.boolean().optional(),
  })).optional(),
});

/** The other PC the server named for a file it does not have, when the device list knows it. */
async function otherPc(deviceId: string | undefined): Promise<{ name: string; host: string; offline: boolean } | null> {
  if (!deviceId) return null;
  const listed = deviceListSchema.safeParse(await fetch("/api/devices").then((response) => response.json()).catch(() => null));
  const device = listed.success
    ? listed.data.devices?.find((item) => item.deviceId === deviceId && !item.current && item.host && item.name)
    : undefined;
  return device ? { name: device.name, host: device.host, offline: device.offline === true } : null;
}

// Texts from the desktop app's file opening, shown in the active language.
// Anything not listed shows as it came.
const FILE_LINK_MESSAGES = new Map<string, MessageKey>([
  ["Files open in the desktop app", "chat.fileLink.desktopOnly"],
  ["Opening files needs a newer version of the desktop app", "chat.fileLink.needsUpdate"],
  ["That file path is invalid", "chat.fileLink.invalidPath"],
  ["That file no longer exists", "chat.fileLink.missing"],
  ["That file is outside the bot's folder", "chat.fileLink.outsideFolder"],
  ["That path is not a file", "chat.fileLink.notAFile"],
  ["That file could not be opened", "chat.fileLink.fileFailed"],
  ["That folder could not be opened", "chat.fileLink.folderFailed"],
]);

// A local file link renders as a button that asks the shell to open the file,
// not an anchor. An absolute path in an href resolves against the page origin
// (http://127.0.0.1:8799<path>, a second chat UI in the browser), and an
// <a href="file://…"> would still reach setWindowOpenHandler on a middle or
// modifier click. The shell decides whether to open or only reveal the file.
function DesktopFileLink({ filePath, base, threadId, card, inline, pictured, children }: { filePath: string; base?: string; threadId?: string; card?: boolean; inline?: boolean; pictured?: boolean; children?: ReactNode }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [onPc, setOnPc] = useState("");
  const [menuAt, setMenuAt] = useState<FileMenuAt | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const terminal = isTerminalSkin(useSkin());
  const text = useContext(MarkdownTextContext);
  // No bridge at all means a phone or browser, not an outdated desktop app.
  const desktop = Boolean(window.ogb);
  const reasonKey = FILE_LINK_MESSAGES.get(reason);
  // A link alone on its line is the one the Terminal skin draws as `⎿ path`.
  useLayoutEffect(() => {
    if (!terminal) return;
    const link = ref.current;
    if (link) link.toggleAttribute("data-file-line", link.parentElement?.textContent?.trim() === link.textContent?.trim());
    return () => link?.removeAttribute("data-file-line");
  }, [terminal, text, children]);

  // False when no other PC is named for the file, so the first reason stands.
  const fromOtherPc = async (thread: string) => {
    const res = await fetch(linkedFileSrc(thread, filePath), { headers: { Range: "bytes=0-0" } }).catch(() => null);
    const body = res && !res.ok ? missingFileSchema.safeParse(await res.json().catch(() => null)) : null;
    const pc = await otherPc(body?.success ? body.data.deviceId : undefined);
    if (!pc) return false;
    const openPeerFile = pc.offline ? undefined : window.ogb?.openPeerFile;
    const refused = openPeerFile
      ? await openPeerFile(pc.host, thread, filePath).then(() => null, (error: unknown) => (error instanceof Error ? error.message : ""))
      : "";
    if (refused === "That file is outside the bot's folder") setReason(refused);
    else if (refused !== null) setOnPc(pc.name);
    return true;
  };

  const open = async () => {
    const openFile = window.ogb?.openFile;
    if (!openFile) {
      setReason(desktop ? "Opening files needs a newer version of the desktop app" : "Files open in the desktop app");
      return;
    }
    try {
      setReason("");
      setOnPc("");
      await openFile(filePath, base);
    } catch (error) {
      const message = error instanceof Error ? error.message : "That file could not be opened";
      // A plain drive path is invalid only on a Mac or Linux desktop, where another PC wrote it.
      const foreign = message === "That file path is invalid" && WINDOWS_PATH.test(filePath) && !filePath.slice(2).includes(":");
      if ((foreign || message === "That file no longer exists") && threadId && (await fromOtherPc(threadId))) return;
      setReason(message);
    }
  };

  const menu = (event: MouseEvent<HTMLElement>) => {
    if (!window.ogb?.openFile) return;
    event.preventDefault();
    setReason("");
    setMenuAt({ x: event.clientX, y: event.clientY, opener: event.currentTarget });
  };

  // A file this PC doesn't have would only fail in the pane; open it the link's way instead.
  const show = async (thread: string) => {
    const res = await fetch(linkedFileSrc(thread, filePath), { headers: { Range: "bytes=0-0" } }).catch(() => null);
    if (res && !res.ok && res.status !== 416) await open();
    else showItem({ threadId: thread, path: filePath, kind: paneKind(filePath)! });
  };

  return (
    <>
      {card && threadId && !inline ? <ShowCard threadId={threadId} path={filePath} bare={pictured} onOpen={() => void (paneKind(filePath) ? show(threadId) : open())} /> : <button
        ref={ref}
        type="button"
        onClick={() => void (card && threadId && paneKind(filePath) ? show(threadId) : open())}
        onContextMenu={menu}
        title={filePath}
        data-file-link
        className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        {children}
      </button>}
      <FileMenu at={menuAt} path={filePath} base={base} onOpen={() => void open()} onError={setReason} onClose={() => setMenuAt(null)} />
      {onPc
        ? <span data-file-on-pc className="block break-keep [overflow-wrap:anywhere]">{t("chat.fileLink.onOtherPc", { name: onPc })}</span>
        : reason && <span className={`ml-1.5 text-[12px] ${desktop ? "text-danger" : "text-ink-secondary"}`}>{reasonKey ? t(reasonKey) : reason}</span>}
    </>
  );
}

function PhoneFile({
  filePath,
  threadId,
  kind,
  inline,
  pictured,
  children,
}: {
  filePath: string;
  threadId: string;
  kind: PhoneKind | null;
  inline?: boolean;
  pictured?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const src = linkedFileSrc(threadId, filePath);
  const [phase, setPhase] = useState<"pending" | "local" | "remote" | "desktop" | "outside">("pending");
  const [remote, setRemote] = useState<{ name: string; host: string } | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(src, { headers: { Range: "bytes=0-0" } })
      .then(async (res) => {
        if (!alive) return;
        if (res.ok || (res.status === 416 && res.headers.get("content-range") === "bytes */0")) {
          setPhase("local");
          return;
        }
        const body = missingFileSchema.safeParse(await res.json().catch(() => null));
        if (body.success && body.data.reason === "outside") {
          setPhase("outside");
          return;
        }
        const device = await otherPc(body.success ? body.data.deviceId : undefined);
        if (!alive) return;
        if (!device) {
          setPhase("desktop");
          return;
        }
        setRemote({ name: device.name, host: device.host });
        setPhase("remote");
      })
      .catch(() => {
        if (alive) setPhase("desktop");
      });
    return () => {
      alive = false;
    };
  }, [src]);

  if (phase === "outside") {
    return (
      <span title={filePath} data-file-unavailable="outside" className="block">
        <span className="text-accent underline decoration-accent/40 [overflow-wrap:anywhere]">{children}</span>
        <span className="block break-keep [overflow-wrap:normal]">{t("chat.fileLink.remoteOutsideFolder")}</span>
      </span>
    );
  }
  if (phase === "desktop") {
    return kind
      ? <DesktopFileLink filePath={filePath}>{children}</DesktopFileLink>
      : <LinkedFolderLink folderPath={filePath} threadId={threadId} fileSrc={(path) => linkedFileSrc(threadId, path)}>{children}</LinkedFolderLink>;
  }
  if (phase === "remote" && remote) {
    return (
      <a
        href={`https://${remote.host}${src}`}
        data-open-on-pc={remote.name}
        className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent"
      >
        {children}
        <span className="ml-1.5">{t("chat.openOnPc", { name: remote.name })}</span>
      </a>
    );
  }
  if (phase !== "local") {
    return (
      <>
        <button type="button" onClick={() => setAsked(true)} title={filePath} className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent">
          {children}
        </button>
        {asked && <span className="ml-1.5 text-[12px] text-ink-secondary">{t("chat.fileLink.checking")}</span>}
      </>
    );
  }
  if (kind === "image" && !inline && !pictured) {
    return <ReadableImage src={src} alt="" data-phone-media="image" className="rounded-lg border border-hairline/30" />;
  }
  if (kind === "audio") return <audio src={src} controls data-phone-media="audio" className="max-w-full" />;
  if (showKind(filePath) || (!kind && cardFile(filePath))) {
    if (!inline) return <ShowCard threadId={threadId} path={filePath} bare={pictured} />;
    const pane = paneKind(filePath);
    return (
      <button type="button" onClick={() => (pane ? showItem({ threadId, path: filePath, kind: pane }) : saveFile(src, showName(filePath), filePath))} title={filePath} data-file-link className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent">
        {children}
      </button>
    );
  }
  if (!kind) {
    return (
      <a href={src} download rel="noreferrer" className="break-words text-left text-accent underline decoration-accent/40 hover:decoration-accent">
        {children}
      </a>
    );
  }
  return <PhoneVideo src={src} />;
}

function LocalFileLink({
  filePath,
  base,
  threadId,
  inline,
  pictured,
  children,
}: {
  filePath: string;
  base?: string;
  threadId?: string;
  inline?: boolean;
  pictured?: boolean;
  children?: ReactNode;
}) {
  const streaming = useContext(StreamingContext);
  const picture = useContext(PictureContext);
  const linked = inline && !pictured && !streaming && showKind(filePath) === "image";
  useEffect(() => (linked ? picture?.(filePath) : undefined), [linked, picture, filePath]);
  if (!window.ogb && !streaming && threadId) return <PhoneFile filePath={filePath} threadId={threadId} kind={phoneMediaKind(filePath)} inline={inline} pictured={pictured}>{children}</PhoneFile>;
  return <DesktopFileLink filePath={filePath} base={base} threadId={threadId} card={Boolean(window.ogb && threadId && (showKind(filePath) || cardFile(filePath)))} inline={inline} pictured={pictured}>{children}</DesktopFileLink>;
}

/** A picture a sentence links to, drawn under the reply with the card's pane mark and file menu. A click shows it in the pane; one that can't load draws nothing. */
function LinkedPicture({ threadId, path }: { threadId: string; path: string }) {
  const [failed, setFailed] = useState(false);
  const [menuAt, setMenuAt] = useState<FileMenuAt | null>(null);
  if (failed) return null;
  const menu = (event: MouseEvent<HTMLElement>) => {
    if (!window.ogb?.openFile) return;
    event.preventDefault();
    event.stopPropagation();
    setMenuAt({ x: event.clientX, y: event.clientY, opener: event.currentTarget });
  };
  return (
    <div data-linked-picture onContextMenu={menu}>
      <ReadableImage src={linkedFileSrc(threadId, path)} loading="lazy" className="rounded-lg border border-hairline/30" onOpen={() => showItem({ threadId, path, kind: "image" })} onError={() => setFailed(true)}
        badge={<span className={`${BADGE} right-1.5 top-1.5`}><PanelRight data-show-icon size={11} aria-hidden="true" /></span>} />
      <FileMenu at={menuAt} path={path} onOpen={() => void window.ogb?.openFile?.(path).catch(() => {})} onClose={() => setMenuAt(null)} />
    </div>
  );
}

// Spoiler spans: GFM parses ~~text~~ to <del>; in bot messages that content
// is usually a spoiler (answers, plot points, surprises), not a deletion —
// hide it behind a tap-to-reveal chip instead of striking it through.
// Display only: the stored markdown, exports, and the model's own context
// all keep the raw ~~text~~.
function Spoiler({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return (
      <span className="relative mx-px inline-block rounded px-1 py-px">
        <span
          aria-hidden="true"
          className="pointer-events-none select-none bg-raised text-transparent [&_*]:!text-transparent [&_a]:!no-underline"
        >
          {children}
        </span>
        <button
          type="button"
          aria-label="Reveal spoiler"
          title="Reveal spoiler"
          onClick={() => setRevealed(true)}
          className="absolute inset-0 rounded bg-raised/90"
        />
      </span>
    );
  }
  return (
    <span className="mx-px inline rounded px-1 py-px text-[13px] leading-relaxed text-ink underline decoration-dotted decoration-hairline underline-offset-2">
      {children}
      <button
        type="button"
        aria-label="Hide spoiler"
        title="Hide spoiler"
        onClick={() => setRevealed(false)}
        className="ml-1 rounded px-0.5 text-[11px] text-ink-secondary hover:text-ink"
      >
        Hide
      </button>
    </span>
  );
}

function ChatMarkdownComponent({
  text: source,
  streaming = false,
  whole = 0,
  baseDir,
  threadId,
  localLinks = true,
  pictured = false,
}: {
  text: string;
  streaming?: boolean;
  whole?: number;
  baseDir?: string | null;
  threadId?: string;
  /** False for text written on another PC: its file paths mean nothing here. */
  localLinks?: boolean;
  /** The chat already shows this reply's picture, so its file links draw none. */
  pictured?: boolean;
}) {
  const text = useMemo(() => unwrapUserTags(source), [source]);
  const style = useReplyStyle();
  const root = useRef<HTMLDivElement>(null);
  const seen = useRef(new WeakSet<Element>());
  const previousWhole = useRef(0);
  const previousStyle = useRef(style);
  const [pictures, setPictures] = useState<string[]>([]);
  const picture = useCallback((path: string) => {
    setPictures((paths) => [...paths, path]);
    return () => setPictures((paths) => paths.filter((_, i) => i !== paths.indexOf(path)));
  }, []);
  // Live typing keeps its blocks once settled.
  const [split, setSplit] = useState(streaming);
  if (streaming && !split) setSplit(true);
  const blocks = useMemo(() => {
    if (style === "paragraphs") return streaming ? splitReplyBlocks(text, false, whole, settleStreamTail) : [text];
    if (!split) return [text];
    const parts = streamBlocks(text);
    if (streaming) parts[parts.length - 1] = settleStreamTail(parts[parts.length - 1]);
    return parts;
  }, [split, text, streaming, style, whole]);
  useLayoutEffect(() => {
    const catchup = whole > previousWhole.current || whole >= text.length;
    const typing = blocks.length === 1 && !/\n[ \t]*\r?\n/.test(text);
    const fade = style === "paragraphs" && previousStyle.current === style && streaming && !catchup && !typing
      && document.visibilityState === "visible" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    for (const child of root.current?.children ?? []) {
      if (!seen.current.has(child) && fade) child.animate?.(
        [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: MOTION_LARGE_MS, easing: EASE_STANDARD },
      );
      seen.current.add(child);
    }
    previousWhole.current = whole;
    previousStyle.current = style;
  }, [blocks, streaming, style, whole, text.length]);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const stop = () => {
      if (media?.matches) root.current?.getAnimations?.({ subtree: true }).forEach((animation) => animation.cancel());
    };
    media?.addEventListener?.("change", stop);
    return () => media?.removeEventListener?.("change", stop);
  }, []);
  const components = useMemo(() => ({
    pre({ children }: { children?: ReactNode }) {
      // fenced code arrives as <pre><code class="language-x">…</code></pre>
      const child: any = Array.isArray(children) ? children[0] : children;
      const className: string = child?.props?.className ?? "";
      const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
      // children can be a string OR an array of strings/nodes - flatten
      // strings only, so String() never comma-joins an array
      const flat = (n: any): string =>
        typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : (n?.props?.children ? flat(n.props.children) : "");
      const code = flat(child?.props?.children).replace(/\n$/, "");
      return <CodeBlock code={code} lang={lang} />;
    },
    img({ src, alt }: { src?: string; alt?: string }) {
      return (
        <ReadableImage
          src={src}
          alt={alt ?? ""}
          loading="lazy"
          className="rounded-lg border border-hairline/30"
        />
      );
    },
    code({ children }: { children?: ReactNode }) {
      return (
        <code className="rounded bg-inset px-1 py-px text-[13px]">{children}</code>
      );
    },
    a({ href, children, "data-inline": inline }: { href?: string; children?: ReactNode; "data-inline"?: string }) {
      // a stripped target (javascript:, empty) would open the app origin
      if (!href) return <>{children}</>;
      const localPath = localFilePath(href);
      if (!localLinks && (localPath || isRelativeHref(href))) return <>{children}</>;
      const file = { threadId, inline: inline !== undefined, pictured };
      if (localPath) return <LocalFileLink filePath={localPath} {...file}>{children}</LocalFileLink>;
      if (isRelativeHref(href)) {
        const resolved = resolveRelativePath(href, baseDir);
        return resolved ? <LocalFileLink filePath={resolved} base={baseDir ?? undefined} {...file}>{children}</LocalFileLink> : <>{children}</>;
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="break-words text-accent underline decoration-accent/40 hover:decoration-accent"
        >
          {children}
        </a>
      );
    },
    table({ children }: { children?: ReactNode }) {
      return (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">{children}</table>
        </div>
      );
    },
    th({ children }: { children?: ReactNode }) {
      return (
        <th className="border-b border-hairline/40 px-2 py-1.5 text-left font-semibold">{children}</th>
      );
    },
    td({ children }: { children?: ReactNode }) {
      return <td className="border-b border-hairline/20 px-2 py-1.5 align-top">{children}</td>;
    },
    ul({ children }: { children?: ReactNode }) {
      return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
    },
    ol({ children }: { children?: ReactNode }) {
      return <ol className="list-decimal space-y-1 pl-5">{children}</ol>;
    },
    h1({ children }: { children?: ReactNode }) {
      return <div className="mt-2 text-[16px] font-semibold">{children}</div>;
    },
    h2({ children }: { children?: ReactNode }) {
      return <div className="mt-2 text-[15.5px] font-semibold">{children}</div>;
    },
    h3({ children }: { children?: ReactNode }) {
      return <div className="mt-1.5 font-semibold">{children}</div>;
    },
    h4({ children }: { children?: ReactNode }) {
      return <div className="mt-1.5 font-semibold">{children}</div>;
    },
    h5({ children }: { children?: ReactNode }) {
      return <div className="mt-1.5 text-[14px] font-semibold">{children}</div>;
    },
    h6({ children }: { children?: ReactNode }) {
      return <div className="mt-1.5 text-[13.5px] font-semibold text-ink-secondary">{children}</div>;
    },
    blockquote({ children }: { children?: ReactNode }) {
      return (
        <blockquote className="border-l-2 border-hairline pl-3 text-ink-secondary">{children}</blockquote>
      );
    },
    del({ children }: { children?: ReactNode }) {
      return <Spoiler>{children}</Spoiler>;
    },
    hr() {
      return <hr className="border-hairline/40" />;
    },
  }), [baseDir, threadId, localLinks, pictured]);
  return (
    <StreamingContext.Provider value={streaming}>
      <PictureContext.Provider value={picture}>
        <div ref={root} className="chat-md min-w-0 [&>*+*]:mt-2">
          {blocks.map((block, i) => (
            <MarkdownBlock key={i} text={block} components={components} />
          ))}
          {threadId && [...new Set(pictures)].map((path) => <LinkedPicture key={path} threadId={threadId} path={path} />)}
        </div>
      </PictureContext.Provider>
    </StreamingContext.Provider>
  );
}

export const ChatMarkdown = memo(ChatMarkdownComponent);
