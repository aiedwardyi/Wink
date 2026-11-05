import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

export interface BotHooks {
  pictures?: { stamps: string };
  launch?: { check: string };
  watch?: unknown;
}

export const botHooksSchema = z.object({
  pictures: z.object({
    stamps: z.string().trim().min(1).refine(isAbsolute, { message: "hooks.pictures.stamps must be an absolute path" }),
  }).strict().optional(),
}).strict();

const pictureStampSchema = z.object({
  sha256: z.string(),
  pass: z.unknown(),
  looked: z.unknown().optional(),
});

export function checkPicture(bot: { hooks?: BotHooks }, importedPath: string): { ok: true } | { ok: false; reason: string } {
  if (!bot.hooks?.pictures) return { ok: true };
  let sha256: string;
  try {
    sha256 = createHash("sha256").update(readFileSync(importedPath)).digest("hex");
  } catch {
    return { ok: false, reason: "imported picture unreadable" };
  }
  let raw: string;
  try {
    raw = readFileSync(join(bot.hooks.pictures.stamps, `${sha256}.json`), "utf8");
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "stamp missing" : "stamp unreadable" };
  }
  let stamp: z.infer<typeof pictureStampSchema>;
  try {
    stamp = pictureStampSchema.parse(JSON.parse(raw));
  } catch {
    return { ok: false, reason: "stamp unreadable" };
  }
  if (stamp.sha256 !== sha256) return { ok: false, reason: "stamp hash does not match" };
  if (stamp.pass !== true) return { ok: false, reason: "stamp did not pass" };
  if (typeof stamp.looked !== "string" || !Number.isFinite(Date.parse(stamp.looked))) {
    return { ok: false, reason: "stamp not looked at" };
  }
  return { ok: true };
}
