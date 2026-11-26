import type { UsageOrderStatus } from "@/state/store-types";
import { nextUsageOrder, parseUsageOrderBody } from "../../server/usage-order.ts";
import { receiveUsageOrder, resetUsageOrder, type UsageOrders } from "./usage-order";

/** Wink's side of the usage order in a test: the one copy every client reads, and the writes that changed it. */
export function usageOrderHost() {
  let status: UsageOrderStatus = null;
  const puts: unknown[] = [];
  return {
    get status() { return status; },
    get orders(): UsageOrders | undefined { return status?.orders; },
    puts,
    /** A fresh page: its store starts empty and its config load brings Wink's copy. */
    open() {
      resetUsageOrder();
      receiveUsageOrder(status);
    },
    /** Another client saved: Wink's config frame carries the new copy here. */
    push(orders: UsageOrders) {
      status = { orders };
      receiveUsageOrder(status);
    },
    /** Answers PUT /api/usage-order the way the server route does; null for any other request. */
    answer(path: string, init?: RequestInit): Promise<{ usageOrder: UsageOrderStatus }> | null {
      if (path !== "/api/usage-order" || init?.method !== "PUT") return null;
      const body = parseUsageOrderBody(JSON.parse(String(init.body)));
      puts.push(body);
      status = nextUsageOrder(status ?? undefined, body) ?? status;
      return Promise.resolve({ usageOrder: status });
    },
  };
}
