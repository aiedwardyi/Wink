// The one rule for what a tap on a file does, so a file opens the same way from every surface, desktop and phone.
import type { PreviewImage } from "./media-viewer";
import { linkedFileSrc, showItem, showKind, showName, type PaneKind } from "./show-pane";

export type FileOpen = "picture" | "video" | "audio" | "pdf" | "text" | "page" | "download";

const kinds = (open: FileOpen, exts: string) => exts.split(" ").map((ext): [string, FileOpen] => [ext, open]);
const BY_EXT = new Map([
  ...kinds("video", "mp4 m4v mov webm"),
  ...kinds("audio", "mp3 m4a wav ogg aac flac"),
  ...kinds("text", "txt md markdown csv tsv json jsonl log yaml yml toml ini xml ts tsx js jsx mjs cjs py rb go rs java kt c h cpp hpp cs php swift sh ps1 bat sql css scss"),
]);
const SHOWN = { image: "picture", pdf: "pdf", page: "page" } as const;

export function fileOpen(path: string): FileOpen {
  const shown = showKind(path);
  if (shown) return SHOWN[shown];
  const name = showName(path);
  const dot = name.lastIndexOf(".");
  return (dot > 0 && BY_EXT.get(name.slice(dot + 1).toLowerCase())) || "download";
}

/** The kind a card marks as the pane's: what a tap shows there, and a picture, which keeps the mark it has always had. */
export function paneKind(path: string): PaneKind | null {
  const open = fileOpen(path);
  return open === "picture" ? "image" : open === "pdf" || open === "text" || open === "page" ? open : null;
}

export interface FileTap {
  /** a local path, or a room file's name */
  path: string;
  /** the chat whose pane shows it; without one, what the pane would show downloads */
  threadId?: string;
  /** a room file's own URL; a bot's or attached file goes through linked-file */
  src?: string;
}

/** What the surface holding the file can do itself. */
export interface FileHands {
  view?(media: PreviewImage): void;
  /** plays audio where the file shows */
  play?(src: string): void;
  /** the desktop's own opener, which says why it could not */
  rest?(): void;
}

/** Pictures and clips open in the viewer, audio plays in place, PDFs, pages and text show in the pane; the rest opens in its app on the desktop, else downloads. */
export function openFile(file: FileTap, hands: FileHands = {}): void {
  const { path, threadId } = file;
  const src = file.src ?? (threadId ? linkedFileSrc(threadId, path) : "");
  const open = fileOpen(path);
  if ((open === "picture" || open === "video") && hands.view) return hands.view({ src, name: showName(path), video: open === "video" || undefined });
  if (open === "audio" && hands.play) return hands.play(src);
  const kind = open === "picture" ? "image" : open === "pdf" || open === "text" || open === "page" ? open : null;
  // A room serves a page as a download, so the pane draws only its pictures, PDFs and text.
  if (kind && threadId && !(file.src && kind === "page")) return showItem(file.src ? { threadId, path, kind, src: file.src } : { threadId, path, kind });
  if (hands.rest) return hands.rest();
  const app = file.src ? undefined : window.ogb?.openFile;
  if (app) return void app(path).catch(() => {});
  saveFile(src, showName(path));
}

/** The desktop app copies a bot's file through its save dialog; elsewhere the browser downloads it. */
export function saveFile(src: string, name: string, path?: string) {
  const save = path ? window.ogb?.saveFile : undefined;
  if (save) return void save(path!).catch(() => {});
  // An empty link would download this page instead.
  if (!src) return;
  const link = document.createElement("a");
  link.href = src;
  link.download = name;
  // A room's file is on another origin, where the browser ignores `download` and would leave the app.
  link.target = "_blank";
  link.rel = "noreferrer";
  link.click();
}

/** The desktop app hands a local file to its own app, rejecting with a reason a link can say. */
export function openInApp(path: string, base?: string): Promise<void> {
  const open = window.ogb?.openFile;
  return open ? open(path, base) : Promise.reject(new Error(window.ogb ? "Opening files needs a newer version of the desktop app" : "Files open in the desktop app"));
}

/** The desktop app opens a file another PC holds; null in a browser. */
export const openOnPc = (host: string, threadId: string, path: string): Promise<void> | null => window.ogb?.openPeerFile?.(host, threadId, path) ?? null;

/** The pane's Open: the desktop hands its own file to its app, anything else opens in a new tab. */
export function openOutside(src: string, path?: string) {
  const open = window.ogb?.openFile;
  if (open && path) void open(path).catch(() => {});
  else window.open(src, "_blank", "noopener,noreferrer");
}

/** The phone's PC answered nothing, or a proxy answered for it. */
export const pcOffline = (res: Response | null) => !res || res.status === 502 || res.status === 503 || res.status === 504;
