import { createHash } from "node:crypto";
import { openSync, closeSync, fstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { REPORT_IMAGE_BYTES, teamReportSchema, type TeamReport } from "../shared/team-report.ts";
import { safeImageMetadata } from "../shared/image-metadata.ts";
import { isVoiceLine } from "../shared/live-call.ts";
import { sniffImageMime } from "./attachments.ts";
import { redactSecretsInText } from "./redact.ts";
import type { Message } from "./store.ts";

export const REPORT_CHECKLIST = "Use the original excerpts below, in order. Select the mistaken answer and include its preceding user request and relevant earlier instructions/corrections with earlier_message_ids (at most 8). Call collect again for those references if needed. Summarize the issue separately from originals; label diagnosis as inference and leave causes unknown without proof. Existing selected incident images travel as bytes. Inspect their existing pixels where available; omit credentials or unrelated content with exclude_image_message_ids and explain missing evidence. Text/metadata secret checks do not OCR pixels. Do not restart anything, modify the project, capture the desktop or read complete native logs. Send now under the user's explicit request; ask only if the incident is unidentified. Draft/show-first never sends. Receipts distinguish service acceptance and local filing; reading is unverified.";

export function reportText(raw: string): string {
  return redactSecretsInText(raw).replace(/\b(?:wkt1|wka1|wki1)\.[A-Za-z0-9_.-]+/g, "[redacted relay credential]")
    .replace(/([a-z]+:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:key|token|secret|password|auth|code)=)[^&#\s]+/gi, "$1[redacted]");
}

function imageBytes(path: string, roots: string[]): Buffer {
  if (/^[\\/]{2}/.test(path)) throw new Error("network image refused");
  const real = realpathSync(path);
  if (!roots.some((root) => {
    try {
      const rel = relative(realpathSync(root), real);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
    } catch { return false; }
  })) throw new Error("image outside allowed roots");
  const fd = openSync(real, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > REPORT_IMAGE_BYTES) throw new Error("image size/type refused");
    const bytes = readFileSync(fd);
    if (bytes.length > REPORT_IMAGE_BYTES) throw new Error("image grew beyond limit");
    return bytes;
  } finally { closeSync(fd); }
}

export interface EvidenceOptions {
  owner: string;
  bot: { id: string; name: string };
  threadId: string;
  path: Message[];
  request: Message;
  selectedMessageId?: string;
  earlierMessageIds?: string[];
  excludeImageMessageIds?: string[];
  attachmentsDir: string;
  roots: string[];
  current: TeamReport["current"];
}

export function collectReport(options: EvidenceOptions): TeamReport {
  const { path, request } = options;
  const before = path.slice(0, path.findIndex((message) => message.id === request.id));
  const attached = Boolean(request.image || request.png || /<attached-(?:image|file)\b/.test(request.text ?? ""));
  const selected = options.selectedMessageId
    ? [...before, ...(attached ? [request] : [])].find((message) => message.id === options.selectedMessageId)
    : before.find((message) => message.id === request.replyToId) ?? (attached ? request
      : before.findLast((message) => message.role === "bot" && message.kind === "text" && !message.comm && !isVoiceLine(message)));
  if (!selected) throw new Error("Incident unidentified. Ask which Wink answer or problem to report, without asking for send approval.");
  const index = selected === request ? before.length : before.indexOf(selected);
  const preceding = selected === request ? undefined : before.slice(0, index).findLast((message) => message.role === "user" && message.kind === "text" && !message.comm && !isVoiceLine(message));
  const wanted = new Set([selected.id, request.id, ...(preceding ? [preceding.id] : [])]);
  for (const id of options.earlierMessageIds ?? []) {
    const found = before.find((message) => message.id === id);
    if (!found || before.indexOf(found) > index) throw new Error("Earlier reference is outside this incident's branch.");
    wanted.add(id);
  }
  const window = selected === request ? [] : before.slice(Math.max(0, index - 4), index + 4);
  for (const message of window) if (message.kind === "screen" || message.kind === "activity" || /<attached-(?:image|file)\b/.test(message.text ?? "")) wanted.add(message.id);
  const records = path.filter((message) => wanted.has(message.id));
  const missing = ["Incident engine/model/version not recorded per message; unknown.", "Fresh Wink chat-window capture unavailable; existing incident images only."];
  if (!options.selectedMessageId) missing.push(`Incident selection defaulted to ${selected.id}${selected === request ? " (request attachment)" : selected.id === request.replyToId ? " (reply target)" : " (most recent bot answer)"}; select another message ID if needed.`);
  if (!preceding && selected !== request) missing.push("Preceding user request unavailable.");
  if (!(options.earlierMessageIds?.length)) missing.push("Earlier instructions/corrections not selected; use bounded earlier references if relevant.");
  let budget = 48_000;
  const originals: TeamReport["originals"] = [];
  const images: TeamReport["images"] = [];
  let diagnostics = "";
  const priority = [selected, request, ...records.filter((message) => message.id !== selected.id && message.id !== request.id)];
  for (const message of [...new Map(priority.map((message) => [message.id, message])).values()].slice(0, 24)) {
    const raw = message.text ?? (message.kind === "activity" ? [message.tool?.name, message.tool?.summary, message.tool?.detail?.input, message.tool?.detail?.output?.join("\n")].filter(Boolean).join("\n") : "");
    const scrubbed = reportText(raw).replace(/<attached-(?:image|file)\b[^>]*>/g, "[incident attachment]");
    let text = scrubbed.slice(0, Math.min(12_000, budget));
    while (Buffer.byteLength(text) > Math.min(12_000, budget)) text = text.slice(0, -1);
    budget -= Buffer.byteLength(text);
    originals.push({ id: message.id, at: message.at, role: message.role,
      speaker: reportText(message.from?.name ?? (message.role === "user" ? "user" : options.bot.name)).slice(0, 200),
      kind: message.kind, text, redacted: scrubbed !== raw, truncated: text !== scrubbed });
    if (text !== scrubbed) missing.push(`Excerpt ${message.id} truncated.`);
    if (message.kind === "activity") diagnostics += `${message.id}: ${text}\n`;
    if (message.tool?.detail?.more || message.tool?.detail?.outputHidden) missing.push(`Diagnostic output on ${message.id} was truncated or hidden in the canonical record.`);
    if (options.excludeImageMessageIds?.includes(message.id)) {
      missing.push(`Images on ${message.id} excluded as sensitive or unrelated.`);
      continue;
    }
    const candidates: Array<{ read(): Buffer; source: "stored-message" | "referenced-file" }> = [];
    if (message.image) candidates.push({ source: "stored-message", read: () => {
      if (!/^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(message.image!)) throw new Error("invalid attachment name");
      return imageBytes(join(options.attachmentsDir, message.image!), [options.attachmentsDir]);
    } });
    if (message.png) candidates.push({ source: "stored-message", read: () => {
      if (message.png!.length > Math.ceil(REPORT_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.png!)) throw new Error("invalid inline image");
      return Buffer.from(message.png!, "base64");
    } });
    for (const match of raw.matchAll(/<attached-(?:image|file)\s+path="([^"]*)"[^>]*>/g)) {
      const file = match[1]!.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
      if (/\.(?:png|jpe?g|gif|webp)$/i.test(file)) candidates.push({ source: "referenced-file", read: () => imageBytes(file, [options.attachmentsDir, ...options.roots]) });
    }
    for (const { read, source } of candidates) {
      try {
        if (images.length >= 3) throw new Error("image count exceeded");
        const bytes = read();
        const mime = sniffImageMime(bytes) as TeamReport["images"][number]["mime"] | null;
        if (!mime || bytes.length > REPORT_IMAGE_BYTES || !safeImageMetadata(bytes, mime, reportText)) throw new Error("unsafe image type/size/metadata");
        images.push({ messageId: message.id, mime, base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), source, collectedAt: Date.now() });
        if (source === "referenced-file") missing.push(`Image on ${message.id} read from referenced file at collection; historical bytes unverified.`);
      } catch { missing.push(`Image on ${message.id} unavailable or refused by path/type/size/secret checks.`); }
    }
  }
  if (!images.length) missing.push("No available incident image bytes.");
  if (diagnostics.length > 8000) missing.push("Diagnostics truncated to 8000 characters.");
  originals.sort((a, b) => path.findIndex((message) => message.id === a.id) - path.findIndex((message) => message.id === b.id));
  const id = createHash("sha256").update(JSON.stringify([options.threadId, request.id, selected.id])).digest("hex").slice(0, 32);
  return teamReportSchema.parse({ id, owner: options.owner, at: request.at, bot: { id: options.bot.id, name: reportText(options.bot.name).slice(0, 200) },
    threadId: options.threadId, branchId: request.id, selectedMessageId: selected.id, requestMessageId: request.id,
    summary: "", diagnosis: "", originals, images, diagnostics: diagnostics.slice(0, 8000),
    incident: { engine: "unknown", model: "unknown", version: "unknown" }, current: options.current, missing: missing.slice(0, 32) });
}
