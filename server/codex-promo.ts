import { CODEX_PROMO_MESSAGE, codexPromoBlocked } from "../electron/codex-promo.mjs";
import type { CodexCredit } from "./codex-credit.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { baseAccount } from "./worker-resume.ts";

export function refreshCodexPromo(message: string, refresh: () => unknown) {
  if (message === CODEX_PROMO_MESSAGE) refresh();
}

export function createCodexPromoStatus(configs: () => InstanceConfigMap, credit: () => CodexCredit | undefined) {
  return (id: string, generation: number) => {
    const saved = credit()?.account;
    if (saved?.id === id) return codexPromoBlocked(saved.home, generation);
    const config = configs()[id];
    if (config?.driver !== "codex") return false;
    const account = config.account ?? baseAccount(id, "codex", { ...process.env, ...config.environment });
    return codexPromoBlocked(account.home, generation);
  };
}
