import { listedRuns, listedSessionId, rosterChip, type WorkerRun } from "./worker-runs";

/** Ctrl+` toggles the terminal here. The desktop needs its preload; a device window does not. */
export function backquoteTogglesTerminal(hasPreload: boolean, desktopTerminal: boolean): boolean {
  return desktopTerminal || !hasPreload;
}

/** Alt+digit picks a pane. Desktop uses the preload; a window with no preload uses the remote view. */
export function altDigitSelectsPane(desktopTerminal: boolean, webWindow: boolean): boolean {
  return desktopTerminal || webWindow;
}

type HotkeyPane = { sessionId: string; main?: boolean; label?: string | null; exited?: boolean; changedAt?: number };

export function workerPaneOrder(panes: readonly HotkeyPane[], workers: readonly WorkerRun[] = []): string[] {
  const chip = rosterChip(workers, panes.filter((pane) => !pane.main));
  return listedRuns(chip.runs, chip.livePanes, chip.paneLabels, chip.endedPanes).flatMap(({ run }) => {
    const sessionId = listedSessionId(run, chip.livePanes);
    return sessionId ? [sessionId] : [];
  });
}
