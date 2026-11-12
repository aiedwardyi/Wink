const CARD_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "txt", "csv",
  "zip", "7z", "rar",
  "png", "jpg", "jpeg", "gif", "webp",
  "mp4", "webm", "mov", "m4v", "mp3", "m4a", "wav", "ogg", "aac", "flac",
]);

/** A document, media or archive file a bot reply shows as a file card, even from outside the bot's folder. */
export function cardFile(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && CARD_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
