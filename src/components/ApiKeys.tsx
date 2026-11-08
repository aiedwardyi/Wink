import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  CREDENTIAL_BROKER,
  CREDENTIAL_TARGETS,
  customCredentialId,
  type BrokeredCredentialId,
  type CredentialId,
} from "../../shared/credential-request";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { credentialErrorMessage, saveCredential } from "@/lib/credentials";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { ROW_BUTTON } from "./SettingsPrimitives";
import { ConfirmDialog } from "./ConfirmDialog";
import { Fold } from "./Fold";

const OPEN_KEY = "omb-keys-open";

function loadKeysOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

const BROKERED_CONFIGURED: Record<BrokeredCredentialId, (config: ConfigStatus) => boolean> = {
  openaiImageApiKey: (c) => c.imageGen?.configured ?? false,
  xaiApiKey: (c) => c.xai?.configured ?? false,
  geminiApiKey: (c) => c.gemini?.configured ?? false,
  ttsKey: (c) => c.tts?.configured ?? false,
  anthropicApiKey: (c) => c.anthropic?.configured ?? false,
  vertexApiKey: (c) => c.vertex?.configured ?? false,
};

export function relativeTimeLabel(at: string, locale: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(at) - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of [["day", 86_400], ["hour", 3_600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, "minute");
}

/** Saved keys bots can use through call_api. Values are never shown. */
export function SavedKeys() {
  const { t, locale } = useI18n();
  const { state, dispatch } = useStore();
  const [uses, setUses] = useState<Record<string, { botId: string; at: string }>>({});
  const [removing, setRemoving] = useState<{ id: CredentialId; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(loadKeysOpen);
  const config = state.config;
  const saved: { id: CredentialId; label: string }[] = [
    ...(Object.keys(CREDENTIAL_BROKER) as BrokeredCredentialId[])
      .filter((id) => config && BROKERED_CONFIGURED[id](config))
      .map((id) => ({ id, label: CREDENTIAL_TARGETS[id].label })),
    ...(config?.customKeys ?? []).map((k) => ({ id: customCredentialId(k.host), label: `${k.name} · ${k.host}` })),
  ];

  useEffect(() => {
    let live = true;
    api("/api/key-uses")
      .then((body: { uses?: typeof uses }) => live && setUses(body.uses ?? {}))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const remove = (id: CredentialId) => {
    setError(null);
    const request = saveCredential(id, "");
    request
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(credentialErrorMessage(e, t)));
  };

  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(OPEN_KEY, open ? "0" : "1");
    } catch {
      /* The fold still applies for this session. */
    }
  };

  if (saved.length === 0) return null;

  return (
    <div>
      <button type="button" aria-expanded={open} onClick={toggle} className="flex min-h-[44px] w-full items-center gap-2 text-left">
        <span className="flex-1 text-[13px] font-medium text-ink">{t("keys.title")}</span>
        <span className="text-[12px] text-ink-secondary">{t("keys.saved", { count: saved.length })}</span>
        <ChevronDown size={16} className={cn("shrink-0 text-ink-secondary transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      <Fold open={open}>
        <div className="pb-1">
          {saved.map(({ id, label }) => {
            const use = uses[id];
            const bot = use && state.bots.find((b) => b.id === use.botId);
            return (
              <div key={id} className="flex min-h-[44px] items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] text-ink [overflow-wrap:anywhere]">{label}</div>
                  <div className="truncate text-[12px] text-ink-secondary">
                    {use
                      ? t("keys.lastUsed", { bot: bot?.name ?? use.botId, time: relativeTimeLabel(use.at, locale) })
                      : t("keys.notUsed")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setRemoving({ id, label })}
                  aria-label={t("connections.removeKey")}
                  className={ROW_BUTTON}
                >
                  {t("keys.remove")}
                </button>
              </div>
            );
          })}
        </div>
      </Fold>
      {removing && (
        <ConfirmDialog
          title={t("connections.removeKey")}
          body={t("keys.removeConfirm", { label: removing.label })}
          confirmLabel={t("connections.removeKey")}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            setRemoving(null);
            remove(removing.id);
          }}
        />
      )}
      {error && <div className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
