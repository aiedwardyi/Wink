import type { AccountService } from "./accounts.ts";
import { instanceConfigs, type AppConfig } from "./config.ts";

export function validateAccountSettings(accounts: AccountService, cfg: AppConfig, patch: Partial<AppConfig>) {
  const instances = { ...cfg.instances };
  for (const [id, entry] of Object.entries(patch.instances ?? {})) instances[id] = { ...instances[id], ...entry };
  accounts.validateBases(instanceConfigs({ ...cfg, ...patch, ...(patch.instances ? { instances } : {}) }));
}
