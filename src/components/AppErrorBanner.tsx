import { AlertTriangle } from "lucide-react";

import { useStore } from "@/state/store";

export function AppErrorBanner() {
  const { state } = useStore();
  if (!state.error) return null;
  return (
    <div className="w-full px-5">
      <div className="mb-2 flex items-start gap-2 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink">
        <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
        <span className="min-w-0 break-words">{state.error}</span>
      </div>
    </div>
  );
}
