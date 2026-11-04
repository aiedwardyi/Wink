// Concept swap for src/components/ChatPlanMeters.tsx: the two bars become one live ticker line.
import { ChatTicker, ENGINE_OF } from "../QuickView";
import "../desk.css";

type ChatPlanMetersProps = { windows?: unknown; driverKind?: string; observedAt?: string; now?: number; onOpenUsage: () => void };

export function ChatPlanMeters({ driverKind }: ChatPlanMetersProps) {
  const engine = driverKind ? ENGINE_OF[driverKind] : undefined;
  return engine ? <ChatTicker engine={engine} /> : null;
}
