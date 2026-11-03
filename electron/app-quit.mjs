/** Finish Electron's deferred quit. `quitAndInstall` must not run until
 * `before-quit` cleanup has completed: NSIS otherwise races the still-running
 * exe, and `preventDefault` would drop the install if we called it first. */
export function completeQuitAfterCleanup({ pendingUpdateInstall, quitAndInstall, quit }) {
  if (pendingUpdateInstall) {
    try {
      const started = quitAndInstall();
      if (started === false) {
        quit();
        return "quit";
      }
      return "install";
    } catch {
      quit();
      return "quit";
    }
  }
  quit();
  return "quit";
}

/** An update quit keeps the main window up with one line until the installer's banner takes over. */
export function hideWindowsForQuit(windows, main, updatingPage) {
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    if (updatingPage && window === main) window.loadURL(updatingPage).catch(() => {});
    else window.hide();
  }
}

/** Vendored `BaseUpdater.quitAndInstall` reports install() failures by
 * emitting `error` and returning, without throwing. */
export function callQuitAndInstall(updater) {
  let failed = false;
  const onError = () => {
    failed = true;
  };
  updater.once("error", onError);
  try {
    updater.quitAndInstall(false, true);
  } finally {
    updater.removeListener("error", onError);
  }
  return !failed;
}
