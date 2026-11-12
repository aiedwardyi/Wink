import { Suspense } from "react";

import { useActiveCall } from "@/lib/live-call/active";
import { lazyView } from "@/lib/stale-build";

const LiveCallHost = lazyView(() => import("./LiveCallBar").then((m) => ({ default: m.LiveCallHost })));
const CallWidget = lazyView(() => import("./CallWidget").then((m) => ({ default: m.CallWidget })));

// Both load with the first call, so a chat without one pays nothing.
export function CallHostSlot() {
  return useActiveCall() ? <Suspense fallback={null}><LiveCallHost /></Suspense> : null;
}

export function CallWidgetSlot(props: { narrow?: boolean; className?: string }) {
  return useActiveCall() ? <Suspense fallback={null}><CallWidget {...props} /></Suspense> : null;
}
