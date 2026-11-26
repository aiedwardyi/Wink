import { z } from "zod";

/** The account and section order the user drags on the Usage page, Usage card and Connections.
 * It lives in config.json so every client of this Wink (desktop app, relay link, Tailscale link) shows one order. */
const id = z.string().min(1).max(256);
const key = z.string().min(1).max(256);
const orderSchema = z.array(id).transform((ids) => [...new Set(ids)]);
const ordersSchema = z.record(key, orderSchema);

/** seed: "browser" marks an order sent up from a browser's old local copy, which the desktop app's copy may still replace.
 * rev counts saves, so a client can tell which of two copies it got is newer. */
export const usageOrderConfigSchema = z.object({ orders: ordersSchema, seed: z.literal("browser").optional(), rev: z.number().int().nonnegative().optional() });
export type UsageOrderConfig = z.output<typeof usageOrderConfigSchema>;

const bodySchema = z.union([
  z.object({ key, order: orderSchema }).strict(),
  z.object({ seed: ordersSchema, from: z.enum(["desktop", "browser"]) }).strict(),
]);

export function parseUsageOrderBody(value: unknown): z.output<typeof bodySchema> {
  const parsed = bodySchema.safeParse(value);
  if (!parsed.success) throw Object.assign(new Error("Invalid usage order"), { status: 400 });
  return parsed.data;
}

/** The saved order after a request, or null when the request changes nothing.
 * A drag sets one list and keeps the others. A seed (the one-time move of a client's old local order)
 * lands only when nothing is saved yet, or over a browser's seed when it comes from the desktop app. */
export function nextUsageOrder(current: UsageOrderConfig | undefined, body: z.output<typeof bodySchema>): UsageOrderConfig | null {
  const rev = (current?.rev ?? 0) + 1;
  if ("key" in body) return { orders: { ...current?.orders, [body.key]: body.order }, rev };
  if (current && !(current.seed === "browser" && body.from === "desktop")) return null;
  return { orders: body.seed, ...(body.from === "browser" ? { seed: "browser" as const } : {}), rev };
}

export function usageOrderStatus(saved: UsageOrderConfig | undefined): UsageOrderConfig | null {
  return saved ?? null;
}
