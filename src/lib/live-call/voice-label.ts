import type { Translate } from "@/lib/i18n";
import type { LiveVoice } from "../../../shared/live-call";

/** Jenn, Eddie and Adele go by their picker names; every other voice by its own. */
export function voiceLabel(t: Translate, id: LiveVoice): string {
  return id === "Aoede" || id === "Alnilam" || id === "Erinome" ? t(`callVoice.${id}`) : id;
}
