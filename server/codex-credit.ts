import { join } from "node:path";

import type { AccountContext } from "./account-policy.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { codexPromoBlocked } from "../electron/codex-promo.mjs";

export const CODEX_CREDIT_ID = "codex-credit";
export const CODEX_CREDIT_NAME = "OpenAI credit";
export const CODEX_CREDIT_ENV = "WINK_OPENAI_CREDIT_KEY";
export type CodexCredit = { account: AccountContext; key: string };

// Codex reads the key from the named variable, so argv never carries it.
export const CODEX_CREDIT_ARGS = [
  "-c", `model_providers.openai_credit.name=${JSON.stringify(CODEX_CREDIT_NAME)}`,
  "-c", 'model_providers.openai_credit.base_url="https://api.openai.com/v1"',
  "-c", `model_providers.openai_credit.env_key=${JSON.stringify(CODEX_CREDIT_ENV)}`,
  "-c", 'model_providers.openai_credit.wire_api="responses"',
  "-c", 'model_provider="openai_credit"',
  "-c", `shell_environment_policy.exclude=${JSON.stringify([CODEX_CREDIT_ENV])}`,
];

export function codexCredit(dataDir: string, bases: InstanceConfigMap, key: string | undefined): CodexCredit | undefined {
  const of = Object.entries(bases).find(([, base]) => base.enabled !== false && base.driver === "codex")?.[0];
  if (!key?.trim() || !of || Object.hasOwn(bases, CODEX_CREDIT_ID)) return undefined;
  return { account: Object.freeze({ id: CODEX_CREDIT_ID, of, home: join(dataDir, CODEX_CREDIT_ID), generation: 1 }), key: key.trim() };
}

export function codexCreditRows(credit: CodexCredit | undefined) {
  return credit ? [{ id: credit.account.id, of: credit.account.of, driverKind: "codex", generation: credit.account.generation, existing: false, state: "ready" as const, credit: true as const }] : [];
}

export function isCodexCredit(account: { id: string; generation: number }) {
  return account.id === CODEX_CREDIT_ID && account.generation > 0;
}

type Deps = {
  available(id: string, generation: number): boolean;
  resumeAccount?(id: string, generation: number): AccountContext | undefined | Promise<AccountContext | undefined>;
  nameOf?(id: string, engine: string): string;
  accounts?(): readonly AccountContext[];
  credit?(): CodexCredit | undefined;
};

export function withCodexCredit<T extends Deps>(deps: T): T {
  const { credit } = deps;
  if (!credit) return deps;
  const own = (id: string, generation: number) => {
    const live = credit()?.account;
    return live?.id === id && live.generation === generation ? live : undefined;
  };
  return { ...deps,
    available: (id: string, generation: number) => {
      const account = own(id, generation);
      return account ? !codexPromoBlocked(account.home, generation) : deps.available(id, generation);
    },
    resumeAccount: (id: string, generation: number) => own(id, generation) ?? deps.resumeAccount?.(id, generation),
    nameOf: (id: string, engine: string) => credit()?.account.id === id ? CODEX_CREDIT_NAME : deps.nameOf?.(id, engine) ?? engine,
    accounts: () => [...(deps.accounts?.() ?? []), ...[credit()?.account ?? []].flat()],
  };
}
