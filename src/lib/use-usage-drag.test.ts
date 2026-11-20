import { expect, it } from "vitest";
import { rankAccounts } from "./use-usage-drag";
import { USAGE_ORDER_SPEC, usageSnapshot, type UsageOrderMoment } from "./usage-order.fixture";

const rank = (saved: string[], { accounts }: UsageOrderMoment) => rankAccounts(accounts.map(([id]) => id), saved, (id) => id,
  accounts.map(([instanceId, signIn]) => ({ instanceId, snapshot: usageSnapshot(signIn) })));

it.each(USAGE_ORDER_SPEC.map((row) => [`${row.gate} ${row.row}`, row] as const))("ranks %s from the saved bytes alone", (_, { saved, moments }) => {
  expect(moments.map((moment) => rank(saved, moment))).toEqual(moments.map(({ shows }) => shows));
});

// ids and emails are only ever compared, so two moments that differ only in names rank alike: a row that clashes needs a decision, not a fix
it("never asks two moments for different orders from the same input", () => {
  const canon = (saved: string[], { accounts, shows }: UsageOrderMoment) => {
    const names = new Map<string, string>();
    const name = (value: string) => names.get(value) ?? names.set(value, `n${names.size}`).get(value)!;
    const email = (value: string) => name(`@${value.trim().toLowerCase()}`);
    const input = [saved.map((key) => key.startsWith("identity:") ? `identity:${email(key.slice(9))}` : name(key)),
      accounts.map(([id, signIn]) => [name(id), signIn === null || signIn === "checking" ? signIn : email(signIn)])];
    return { input: JSON.stringify(input), shows: JSON.stringify(shows.map(name)) };
  };
  const first = new Map<string, { at: string; shows: string }>();
  const clashes = USAGE_ORDER_SPEC.flatMap((row) => row.moments.flatMap((moment, index) => {
    const { input, shows } = canon(row.saved, moment);
    const at = `${row.gate} ${row.row} #${index + 1}`;
    const seen = first.get(input) ?? first.set(input, { at, shows }).get(input)!;
    return seen.shows === shows ? [] : [`${seen.at} <> ${at}`];
  }));
  expect(clashes).toEqual([]);
});
