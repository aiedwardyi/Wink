import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BRAND_MARKER = "brand-applied.json";

type LeadBotDeps = {
  dataDir: string;
  /** JSON `{ name, avatarPath }` from the desktop's brand override; unset on every other install. */
  leadBot: string | undefined;
  chiefId: () => string | undefined;
  saveAvatar: (bytes: Buffer) => string | null;
  applyProfile: (id: string, input: { name: string; avatarUrl: string; avatarCrop: "square" }) => { status: number };
};

/** Renames the lead bot once, so a later rename by hand is kept. */
export function applyBrandLeadBot({ dataDir, leadBot, chiefId, saveAvatar, applyProfile }: LeadBotDeps): boolean {
  if (!leadBot) return false;
  const marker = join(dataDir, BRAND_MARKER);
  try {
    if (JSON.parse(readFileSync(marker, "utf8")).leadBotAppliedAt) return false;
  } catch {}
  try {
    const { name, avatarPath } = JSON.parse(leadBot);
    // No lead bot before onboarding; the next boot tries again.
    const id = chiefId();
    if (!id || typeof name !== "string" || typeof avatarPath !== "string") return false;
    const avatarUrl = saveAvatar(readFileSync(avatarPath));
    if (!avatarUrl || applyProfile(id, { name, avatarUrl, avatarCrop: "square" }).status !== 200) return false;
    writeFileSync(marker, `${JSON.stringify({ leadBotAppliedAt: new Date().toISOString() })}\n`);
    return true;
  } catch {
    return false;
  }
}
