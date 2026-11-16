// What a chat's messages hand over as pictures and files: the Media tab's live tail and the server's index of a whole chat.
import { fromMarkdown } from "mdast-util-from-markdown";

import { attachmentBasename, attachmentImageUrl, splitAttachedImages } from "./composer-attachments.ts";
import { isShownMessage } from "./shown-message.ts";

export type ShowKind = "image" | "pdf" | "page";

const KINDS = new Map<string, ShowKind>([["png", "image"], ["jpg", "image"], ["jpeg", "image"], ["gif", "image"], ["webp", "image"], ["pdf", "pdf"], ["html", "page"], ["htm", "page"]]);

export function showKind(path: string): ShowKind | null {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? KINDS.get(name.slice(dot + 1).toLowerCase()) ?? null : null;
}

export const showName = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function linkedFileSrc(threadId: string, filePath: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}/linked-file?path=${encodeURIComponent(filePath)}`;
}

const LINK = /\]\(\s*(?:<([^>\n]+)>|([^\s)]+)(?=\s*[)"']))/g;
const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g;

/** Absolute local file links a bot reply hands over, in order. */
export function localLinks(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.replace(CODE, "").matchAll(LINK)) {
    let path = match[1] ?? match[2]!;
    if (/^file:\/\//i.test(path)) {
      try { path = decodeURIComponent(new URL(path).pathname).replace(/^\/([a-zA-Z]:)/, "$1"); } catch { continue; }
    } else {
      path = path.replace(/[#?].*$/, "");
      try { path = decodeURIComponent(path); } catch { /* keep the raw target */ }
    }
    if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) paths.push(path);
  }
  return paths;
}

export interface MediaMessage {
  role: string;
  kind: string;
  text?: string;
  image?: string;
  summarized?: boolean;
}

/** a: a saved attachment picture, u: a picture URL, l: a linked local file, f: a file the user attached. */
export interface MediaRef {
  kind: "a" | "u" | "l" | "f";
  name: string;
  /** the URL or path; empty for `a`, whose name is its address */
  ref: string;
  /** bytes, from an attached file's tag */
  size?: number;
}

/** The key the Media tab dedupes on: the picture's or file's URL, or an attached file's path. */
export function mediaKey(threadId: string, { kind, name, ref }: MediaRef): string {
  return kind === "a" ? `/api/attachments/${encodeURIComponent(name)}` : kind === "l" ? linkedFileSrc(threadId, ref) : ref;
}

// react-markdown's defaultUrlTransform, plus the transcript's own rule that only http(s) carries a scheme.
function safeImageUrl(url: string): boolean {
  const colon = url.indexOf(":");
  const relative = colon === -1 || ["/", "?", "#"].some((mark) => { const at = url.indexOf(mark); return at !== -1 && colon > at; });
  if (!relative && !/^(https?|ircs?|mailto|xmpp)$/i.test(url.slice(0, colon))) return false;
  return !/^[a-z][a-z\d+.-]*:/i.test(url) || /^https?:\/\//i.test(url);
}

function markdownImages(text: string): Array<[url: string, alt: string]> {
  const tree = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const found: Array<[string, string]> = [];
  const visit = (node: typeof tree | (typeof tree.children)[number], images: boolean) => {
    if (!images && node.type === "definition") definitions.set(node.identifier, node.url);
    if (images && node.type === "image") found.push([node.url, node.alt ?? ""]);
    if (images && node.type === "imageReference") found.push([definitions.get(node.identifier) ?? "", node.alt ?? ""]);
    if ("children" in node) node.children.forEach((child) => visit(child, images));
  };
  visit(tree, false);
  visit(tree, true);
  return found;
}

/** One message's pictures, then its files, in the order the chat shows them. */
export function messageRefs(message: MediaMessage): MediaRef[] {
  if (!isShownMessage(message)) return [];
  const refs: MediaRef[] = [];
  const attached = (path: string) => { if (attachmentImageUrl(path)) refs.push({ kind: "a", name: attachmentBasename(path), ref: "" }); };
  if (message.image) attached(message.image);
  if (message.kind !== "text" || !message.text) return refs;
  const { text } = message;
  if (message.role === "user") {
    const { images, files } = splitAttachedImages(text);
    images.forEach(attached);
    for (const file of files) refs.push({ kind: "f", name: file.name, ref: file.path, size: file.size });
    return refs;
  }
  // Only a picture needs the markdown parse, and every picture starts with "![".
  if (text.includes("![")) {
    for (const [url, alt] of markdownImages(text)) {
      if (!url || !safeImageUrl(url)) continue;
      const [path = "", query] = url.split(/[?#]/);
      const name = attachmentBasename(path.endsWith("/linked-file") ? new URLSearchParams(query).get("path") ?? path : path);
      refs.push({ kind: "u", name: name || alt || url, ref: url });
    }
  }
  for (const path of localLinks(text)) {
    const name = showName(path);
    // No extension reads as a folder, which the folder sheet lists instead.
    if (/\.\w+$/.test(name)) refs.push({ kind: "l", name, ref: path });
  }
  return refs;
}
