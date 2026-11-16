import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { CODEX_PROMO_MESSAGE, clearCodexPromo, markCodexPromo } from "../electron/codex-promo.mjs";
import { DATA_DIR } from "./config.ts";
import { codexCredit } from "./codex-credit.ts";
import { createCodexPromoStatus, refreshCodexPromo } from "./codex-promo.ts";
import type { InstanceConfigMap } from "./contracts.ts";
import { en } from "../src/lib/i18n-catalog.ts";

it("refreshes an open board for the bot and worker promo notice", () => {
  const refresh = vi.fn();
  refreshCodexPromo("An unrelated failure", refresh);
  expect(refresh).not.toHaveBeenCalled();
  refreshCodexPromo("This OpenAI key's org is on API credit, which Codex can't use. Pick another Codex account.", refresh);
  expect(refresh).toHaveBeenCalledOnce();
});

it("reads persisted promo marks for the exact base, added and credit account", () => {
  const root = join(DATA_DIR, "promo-status");
  const added = { id: "added", of: "codex", home: join(root, "added"), generation: 2 };
  const configs: InstanceConfigMap = {
    codex: { driver: "codex", environment: { CODEX_HOME: join(root, "base") } },
    added: { driver: "codex", account: added },
    claude: { driver: "claudeAgent" },
  };
  const credit = codexCredit(root, configs, "fixture-key")!;
  const status = () => createCodexPromoStatus(() => configs, () => credit);
  for (const account of [{ id: "codex", home: join(root, "base"), generation: 0 }, added, credit.account]) {
    expect(status()(account.id, account.generation)).toBe(false);
    markCodexPromo(account.home, account.generation);
    expect(status()(account.id, account.generation)).toBe(true);
    expect(status()(account.id, account.generation + 1)).toBe(false);
    expect(status()("claude", 0)).toBe(false);
    expect(status()("missing", 0)).toBe(false);
    clearCodexPromo(account.home);
    expect(status()(account.id, account.generation)).toBe(false);
  }
});

it("keeps the localized promo note keyed to the sent message", () => {
  expect(en["errors.codexPromo"]).toBe(CODEX_PROMO_MESSAGE);
});
