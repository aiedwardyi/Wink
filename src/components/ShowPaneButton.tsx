import { useEffect, useLayoutEffect, useRef } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";

import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { showWorkers, togglePane, useMapThread, useMediaThread, useShowItem, useTimelineThread, useToolsThread, useWorkersThread } from "@/lib/show-pane";
import { closePane, useVerifyWatch } from "@/lib/verify-watch";
import { openWorkerCount } from "@/lib/worker-status";
import { COUNT_BADGE } from "./SidebarConversations";
import { listedFor, useShareWorkers, WORKER_STATUS, workerCounts, type WorkerSource } from "./WorkerRows";

/** What togglePane hears about a chat's workers: listed ones open Workers, else a Workers tab when the terminal is there. */
export const paneWorkers = (workers?: WorkerSource): "listed" | "tab" | undefined => workers && listedFor(workers).length > 0 ? "listed" : workers?.onOpenTerminal ? "tab" : undefined;

export function ShowPaneButton({ threadId, map, workers, className, inPane = false }: { threadId: string; map?: "idle" | "live"; workers?: WorkerSource; className?: string; inPane?: boolean }) {
  const { t } = useI18n();
  const shown = useShowItem();
  const media = useMediaThread();
  const mapping = useMapThread();
  const crew = useWorkersThread();
  const timeline = useTimelineThread();
  const tools = useToolsThread();
  const watch = useVerifyWatch();
  const ref = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useShareWorkers(threadId, inPane ? undefined : workers);
  const listed = workers ? listedFor(workers) : [];
  const hasWorkers = listed.length > 0;
  const workerTab = hasWorkers || Boolean(workers?.onOpenTerminal);
  const counts = workerCounts(listed);
  const total = openWorkerCount(listed);
  const first = listed[0];
  const badge = first && (counts.working > 0 || counts.waiting > 0 || counts.failed > 0);
  const checking = watch?.threadId === threadId;
  const onWorkers = crew === threadId;
  const open = checking || shown?.threadId === threadId || media === threadId || mapping === threadId || onWorkers || timeline === threadId || tools === threadId;
  useLayoutEffect(() => {
    if (!open && restoreFocus.current) { restoreFocus.current = false; ref.current?.focus(); }
  }, [open]);
  useEffect(() => {
    if (!workerTab || inPane) return;
    const onToggle = () => {
      // Chat stays mounted under the terminal, so only the button that is not inert answers Alt+W.
      if (ref.current?.closest("[inert]")) return;
      if (!onWorkers) return showWorkers(threadId);
      if (document.activeElement?.closest("[data-side-panel]")) restoreFocus.current = true;
      closePane();
    };
    window.addEventListener("orbit:toggle-worker-menu", onToggle);
    return () => window.removeEventListener("orbit:toggle-worker-menu", onToggle);
  }, [workerTab, inPane, onWorkers, threadId]);
  return (
    <button
      ref={ref}
      type="button"
      data-show-pane-button
      aria-pressed={open}
      aria-label={workerTab ? t("workers.stripAria", counts) : t("show.pane")}
      title={t("show.pane")}
      onClick={() => open ? closePane() : togglePane(threadId, map, paneWorkers(workers))}
      className={cn("relative shrink-0 rounded-md p-1.5 hover:text-ink md:hover:bg-raised text-ink-secondary", !inPane && "md:translate-x-3.5 md:-translate-y-[11px]", open && !inPane && "md:hidden", className)}
    >
      {open ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      {badge && (
        <span aria-hidden data-worker-badge={total} data-worker-state={first.state} className={cn(COUNT_BADGE, WORKER_STATUS[first.state].dot, WORKER_STATUS[first.state].ink, "ring-panel")}>
          {counts.working > 0 ? total : null}
        </span>
      )}
    </button>
  );
}
