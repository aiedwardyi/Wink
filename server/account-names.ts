import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { isInstanceId, type AccountService } from "./accounts.ts";
import { writeFileAtomic } from "./atomic.ts";

type Engine = "claude" | "codex";
type AccountRow = ReturnType<AccountService["list"]>[number];
export type AccountName = { id: string; engine: Engine; number: number; nickname: string | null; name: string };
type NameCode = "too-long" | "invalid-character" | "taken" | "reserved" | "unknown-account";
type Resolution = { kind: "account"; id: string } | { kind: "ambiguous" } | { kind: "unknown" };

const LABELS: Record<string, string> = { claude: "Claude", claudeagent: "Claude", codex: "Codex", grok: "Grok", grokagent: "Grok", gemini: "Gemini", antigravity: "Gemini", antigravityagent: "Gemini", muse: "Muse", museagent: "Muse" };
const RESERVED = /^(?:claude|codex|grok|gemini|muse)\s+\d+$/i;
const recordSchema = z.object({
  engine: z.enum(["claude", "codex"]), number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), nickname: z.string().optional(),
}).strict();
const stateSchema = z.object({ version: z.literal(1), accounts: z.record(z.string().refine(isInstanceId), recordSchema) }).strict();
type State = z.infer<typeof stateSchema>;

export class AccountNameError extends Error {
  readonly code: NameCode;
  readonly status: number;
  constructor(code: NameCode) {
    super({ "too-long": "Nickname is too long", "invalid-character": "Invalid nickname", taken: "Nickname is already used", reserved: "Nickname is reserved", "unknown-account": "Unknown account" }[code]);
    this.code = code;
    this.status = code === "unknown-account" ? 404 : 400;
  }
}

function nickname(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string") throw new AccountNameError("invalid-character");
  const text = value.trim().normalize("NFC");
  if (!text) return undefined;
  if (/[\p{Cc}\p{Cf}@:'"`]/u.test(text)) throw new AccountNameError("invalid-character");
  if ([...text].length > 24) throw new AccountNameError("too-long");
  if (text === "?" || RESERVED.test(text)) throw new AccountNameError("reserved");
  return text;
}

export interface AccountNames {
  sync(rows: readonly AccountRow[]): void;
  get(id: string): AccountName | null;
  nameOf(id: string, engine: string): string;
  setNickname(id: string, value: string | null): AccountName;
  selectorOf(id: string): string | null;
  resolve(engine: string, text: string): Resolution;
}

export function createAccountNames(dataDir: string): AccountNames {
  const file = join(dataDir, "account-names.json");
  let state: State = { version: 1, accounts: {} };
  let rows: ReadonlyArray<Pick<AccountRow, "id" | "of">> = [];
  try {
    const saved = stateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    for (const row of Object.values(saved.accounts)) {
      const name = nickname(row.nickname ?? null);
      if (name !== row.nickname) throw new Error("Invalid names store");
    }
    state = saved;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      try { renameSync(file, `${file}.bad`); } catch { /* names must not block boot */ }
    }
  }

  const commit = (accounts: State["accounts"]) => {
    const next: State = { version: 1, accounts };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    try { writeFileAtomic(file, JSON.stringify(next, null, 2), { mode: 0o600 }); }
    catch { throw new Error("Cannot save account names"); }
    state = next;
  };
  const get = (id: string): AccountName | null => {
    const row = Object.hasOwn(state.accounts, id) ? state.accounts[id] : undefined;
    return row ? { id, engine: row.engine, number: row.number, nickname: row.nickname ?? null, name: row.nickname ?? `${LABELS[row.engine]} ${row.number}` } : null;
  };
  const selectorOf = (id: string) => {
    const row = rows.find((row) => row.id === id);
    return row ? `${row.of}:${row.id === row.of ? "base" : row.id}` : null;
  };
  return {
    sync(list) {
      if (list.some((row) => row.error)) return;
      const supported = list.filter((row) => row.driverKind === "claudeAgent" || row.driverKind === "codex");
      const ordered = [...supported.filter((row) => row.id === row.of), ...supported.filter((row) => row.id !== row.of)];
      const engineOf = (row: AccountRow): Engine => row.driverKind === "claudeAgent" ? "claude" : "codex";
      const accounts = { ...state.accounts };
      for (const id of Object.keys(accounts)) if (!supported.some((row) => row.id === id && engineOf(row) === accounts[id].engine)) delete accounts[id];
      for (const row of ordered) {
        const engine = engineOf(row);
        const previous = Object.hasOwn(accounts, row.id) ? accounts[row.id] : undefined;
        if (previous) {
          if (previous.generation !== row.generation) accounts[row.id] = { ...previous, generation: row.generation };
          continue;
        }
        const used = new Set(Object.values(accounts).filter((entry) => entry.engine === engine).map((entry) => entry.number));
        const firstBase = supported.find((entry) => entry.id === entry.of && engineOf(entry) === engine);
        let number = row === firstBase && !used.has(1) ? 1 : 2;
        while (used.has(number)) number++;
        accounts[row.id] = { engine, number, generation: row.generation };
      }
      commit(accounts);
      rows = supported.map(({ id, of }) => ({ id, of }));
    },
    get,
    nameOf(id, engine) {
      const label = LABELS[engine.toLowerCase()] ?? "Account";
      if (["Grok", "Gemini", "Muse"].includes(label)) return label;
      return get(id)?.name ?? `${label} (removed)`;
    },
    setNickname(id, value) {
      const row = Object.hasOwn(state.accounts, id) ? state.accounts[id] : undefined;
      if (!row) throw new AccountNameError("unknown-account");
      const name = nickname(value);
      if (name && Object.entries(state.accounts).some(([otherId, other]) => otherId !== id && other.engine === row.engine && other.nickname?.toLowerCase() === name.toLowerCase())) throw new AccountNameError("taken");
      const next = { ...row };
      if (name) next.nickname = name;
      else delete next.nickname;
      commit({ ...state.accounts, [id]: next });
      return get(id)!;
    },
    selectorOf,
    resolve(engine, text) {
      const label = LABELS[engine.toLowerCase()];
      if (label !== "Claude" && label !== "Codex") return { kind: "unknown" };
      const input = text.trim().normalize("NFC");
      const eligible = Object.keys(state.accounts).filter((id) => LABELS[state.accounts[id].engine] === label);
      const result = (ids: string[]): Resolution => ids.length > 1 ? { kind: "ambiguous" } : ids.length ? { kind: "account", id: ids[0] } : { kind: "unknown" };
      const selectors = eligible.filter((id) => selectorOf(id) === input);
      if (selectors.length) return result(selectors);
      const number = /^(claude|codex) +([0-9]+)$/i.exec(input);
      if (number) return result(eligible.filter((id) => number[1].toLowerCase() === state.accounts[id].engine && Number(number[2]) === state.accounts[id].number));
      return result(eligible.filter((id) => state.accounts[id].nickname?.toLowerCase() === input.toLowerCase()));
    },
  };
}
