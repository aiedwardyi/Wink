import { ArrowUpRight, Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { IMPORT_PROVIDERS, importLink } from "@/lib/import-links";
import { ROW_BUTTON } from "./SettingsPrimitives";

function open(provider: (typeof IMPORT_PROVIDERS)[number], prompt: string) {
  if (window.ogb?.openExternal) void window.ogb.openExternal(importLink(provider, prompt, true)).catch((error) => console.warn(`Could not open ${provider.name}`, error));
  else window.open(importLink(provider, prompt), "_blank", "noopener,noreferrer");
}

/** `copy`: each chip copies the prompt first, and Gemini and any other AI, which open with nothing typed in, only copy it. */
export function ImportProviderButtons({ prompt, copy = false }: { prompt: string; copy?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  // started before the site opens: the clipboard takes a write only while this page has focus
  const copyPrompt = (name: string) => {
    void navigator.clipboard?.writeText(prompt).then(() => {
      setCopied(name);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1200);
    }, () => {});
  };

  if (!copy) {
    return (
      <div className="-mt-1 mb-2 flex flex-wrap gap-2">
        {IMPORT_PROVIDERS.map((provider) => (
          <button key={provider.name} type="button" className={ROW_BUTTON} onClick={() => open(provider, prompt)}>
            {provider.name}
          </button>
        ))}
      </div>
    );
  }
  const icon = (name: string, Idle: typeof Copy) => (copied === name ? <Check size={12} aria-hidden className="text-success" /> : <Idle size={12} aria-hidden className="text-ink-secondary" />);
  return (
    <div className="flex flex-wrap gap-2">
      {IMPORT_PROVIDERS.map((provider) => (
        <button key={provider.name} type="button" title={t("importCard.opens", { name: provider.name })} className={cn(ROW_BUTTON, "gap-1.5 text-ink")} onClick={() => {
          copyPrompt(provider.name);
          open(provider, prompt);
        }}>
          {provider.name}
          {icon(provider.name, ArrowUpRight)}
        </button>
      ))}
      {["Gemini", t("importCard.otherAi")].map((name) => (
        <button key={name} type="button" title={t("importCard.copies")} className={cn(ROW_BUTTON, "gap-1.5 text-ink")} onClick={() => copyPrompt(name)}>
          {name}
          {icon(name, Copy)}
        </button>
      ))}
    </div>
  );
}
