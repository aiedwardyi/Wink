// Renderer bridge. contextIsolation stays on; the renderer only ever sees
// this narrow surface (window.ogb), never Node or ipcRenderer itself.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch((error) => {
  const message = String(error?.message ?? error);
  throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
});

let pendingPackageInstallUrl = null;
const packageInstallListeners = new Set();
ipcRenderer.on("package:install", (_event, url) => {
  if (typeof url !== "string") return;
  pendingPackageInstallUrl = url;
  for (const listener of packageInstallListeners) listener(url);
});

contextBridge.exposeInMainWorld("ogb", {
  /** Host platform ("darwin" | "win32" | "linux") — for platform-aware UI. */
  platform: process.platform,
  terminal: {
    appearance: () => invoke("terminal:appearance"),
    open: (input) => invoke("terminal:open", input),
    prestart: (input) => invoke("terminal:prestart", input),
    cancelOpen: (botId) => invoke("terminal:cancel-open", botId),
    write: (id, data) => invoke("terminal:write", id, data),
    acknowledge: (id) => invoke("terminal:acknowledge", id),
    resize: (id, cols, rows) => invoke("terminal:resize", id, cols, rows),
    readBot: (botId, options) => invoke("terminal:read-bot", botId, options),
    paneLabels: () => invoke("terminal:pane-labels"),
    sendBot: (botId, input) => invoke("terminal:send-bot", botId, input),
    openBot: (botId, input) => invoke("terminal:open-bot", botId, input),
    close: (id) => invoke("terminal:close", id),
    onData: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("terminal:data", handler);
      return () => ipcRenderer.removeListener("terminal:data", handler);
    },
    onExit: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("terminal:exit", handler);
      return () => ipcRenderer.removeListener("terminal:exit", handler);
    },
    onError: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("terminal:error", handler);
      return () => ipcRenderer.removeListener("terminal:error", handler);
    },
    onAttention: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("terminal:attention", handler);
      return () => ipcRenderer.removeListener("terminal:attention", handler);
    },
    onOpened: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("terminal:opened", handler);
      return () => ipcRenderer.removeListener("terminal:opened", handler);
    },
    onClosed: (cb) => {
      const handler = (_event, value) => cb(value);
      ipcRenderer.on("terminal:closed", handler);
      return () => ipcRenderer.removeListener("terminal:closed", handler);
    },
  },
  getCapabilities: () => invoke("desktop:capabilities"),
  getBrand: () => invoke("desktop:brand"),
  onCapabilitiesChanged: (cb) => {
    const handler = (_event, capabilities) => cb(capabilities);
    ipcRenderer.on("desktop:capabilities-changed", handler);
    return () => ipcRenderer.removeListener("desktop:capabilities-changed", handler);
  },
  /** The companion sidecar: the one part of this app that listens off the
   * machine, so it runs as its own process and is off until switched on.
   * Every call answers with the whole state, so the panel never has to
   * stitch two round-trips together. */
  companion: {
    state: () => ipcRenderer.invoke("companion:state"),
    start: () => ipcRenderer.invoke("companion:start"),
    stop: () => ipcRenderer.invoke("companion:stop"),
    keepAwake: (enabled) => ipcRenderer.invoke("companion:keep-awake", enabled),
    pairing: (open, expectedToken) => ipcRenderer.invoke("companion:pairing", open, expectedToken),
    cloudDesktop: (deviceId, allowed) => ipcRenderer.invoke("companion:cloud-desktop", deviceId, allowed),
    revoke: (deviceId) => ipcRenderer.invoke("companion:revoke", deviceId),
  },
  /** Optional account-backed HTTPS access for Companion. Secrets stay in the
   * main process; the renderer sees only status and narrow user actions. */
  companionAccount: {
    state: () => ipcRenderer.invoke("companion-account:state"),
    requestCode: (email) => ipcRenderer.invoke("companion-account:request-code", email),
    verifyCode: (email, code) => ipcRenderer.invoke("companion-account:verify-code", email, code),
    retry: () => ipcRenderer.invoke("companion-account:retry"),
    signOut: () => ipcRenderer.invoke("companion-account:sign-out"),
  },
  /** Google sign-in for Drive sync. Tokens stay in the main process; status comes from GET /api/google-account. */
  googleAccount: {
    signIn: () => ipcRenderer.invoke("google-account:sign-in"),
    cancel: () => ipcRenderer.invoke("google-account:cancel"),
    signOut: () => ipcRenderer.invoke("google-account:sign-out"),
  },
  localControl: {
    status: () => ipcRenderer.invoke("cua:linux-status"),
    enable: () => ipcRenderer.invoke("cua:linux-enable"),
    disable: () => ipcRenderer.invoke("cua:linux-disable"),
    retry: () => ipcRenderer.invoke("cua:linux-retry"),
  },
  /** Arms exactly one display-media request from the current renderer frame. */
  beginScreenPreviewIntent: () => ipcRenderer.sendSync("screen:preview-intent"),
  speechStart: (options) => ipcRenderer.invoke("speech:start", options),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  speechFinish: () => ipcRenderer.invoke("speech:finish"),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  transcription: {
    status: () => ipcRenderer.invoke("assemblyai:status"),
    setKey: (value) => ipcRenderer.invoke("assemblyai:set-key", value),
    streamingToken: () => ipcRenderer.invoke("assemblyai:streaming-token"),
  },
  /** Absolute path of a dropped File — Electron 32 removed File.path, and
   * only the preload can ask. "" when the drag carried no file on disk. */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  /** PNG bytes of the clipboard image, or null. A screenshot paste can reach
   * the page as 0 bytes on Windows, so the composer reads it again here. */
  readClipboardImage: () => invoke("desktop:clipboard-image"),
  /** Opens System Settings on the given privacy pane: mic|screen|speech. */
  permOpenSettings: (pane) => invoke("perm:open-settings", pane),

  /** Copies an engine install command and opens a blank terminal. Resolves
   * false if no terminal could be launched; the clipboard still has it. */
  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  openEngineSignIn: (instanceId) => ipcRenderer.invoke("engine:sign-in", instanceId),
  openEngineInstall: (instanceId, installOnly) => invoke("engine:install", instanceId, installOnly),
  /** Open a web link in the default browser. Unlike renderer window.open,
   * this remains reliable after an asynchronous API request. */
  openExternal: (url) => invoke("desktop:open-external", url),
  /** Tell the window which skin the page wears, so the native chrome the
   * renderer cannot paint (the Windows caption-button overlay) matches. */
  applySkin: (skin) => invoke("desktop:skin", skin),
  setModelPickerBackground: (view) => invoke("desktop:model-picker-background", view),
  /** Installed app version, from the main process. */
  getAppVersion: () => invoke("desktop:app-version"),
  startFresh: () => invoke("desktop:start-fresh"),
  getLocale: () => ipcRenderer.sendSync("desktop:os-locale"),
  getLocalePreference: () => ipcRenderer.sendSync("desktop:locale-preference-get"),
  setLocalePreference: (preference) => invoke("desktop:locale-preference", preference),
  /** A reviewed BotMRR package opened through orbit://install. */
  onPackageInstall: (cb) => {
    packageInstallListeners.add(cb);
    if (pendingPackageInstallUrl) cb(pendingPackageInstallUrl);
    return () => packageInstallListeners.delete(cb);
  },
  /** Mirrors durable unread state into the native Dock/taskbar badge. */
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
  /** Windows taskbar progress: indeterminate while any bot turn is running. */
  setTaskbarBusy: (busy) => ipcRenderer.send("desktop:taskbar-busy", busy === true),
  /** Open image preview takes Ctrl/Cmd +/-/0 until it closes. */
  imageZoom: {
    own: (owned) => ipcRenderer.send("image-zoom:own", owned === true),
    onShortcut: (cb) => {
      const handler = (_event, action) => {
        if (action === "in" || action === "out" || action === "reset") cb(action);
      };
      ipcRenderer.on("image-zoom:shortcut", handler);
      return () => ipcRenderer.removeListener("image-zoom:shortcut", handler);
    },
  },
  /** Main-process toast. Win10 renderer Notification is silent without AUMID. */
  showNotification: (payload) => ipcRenderer.send("desktop:notify", payload),
  onNotificationClick: (cb) => {
    const handler = (_event, target) => cb(target);
    ipcRenderer.on("desktop:notification-click", handler);
    return () => ipcRenderer.removeListener("desktop:notification-click", handler);
  },
  /** Another PC's Orbit in its own sandboxed window; focuses it when already open. */
  deviceWindow: {
    open: (host, name) => invoke("device-window:open", host, name),
  },
  /** Native folder picker for a bot's working folder; null when cancelled. */
  pickFolder: (current) => invoke("desktop:pick-folder", current),
  /** Writes the redacted diagnostics report to a user-chosen file; resolves
   * the path, or null when the save dialog was cancelled. */
  exportDiagnostics: () => invoke("desktop:export-diagnostics"),
  errorReportConsent: () => invoke("error-reports:get"),
  setErrorReportConsent: (enabled) => invoke("error-reports:set", enabled),
  captureErrorReport: (site) => ipcRenderer.send("error-reports:capture", site),
  /** Open a local file or folder from a chat link in its default app, or reveal it
   * when its type could run. The chat bubble shows the rejection text
   * verbatim, so strip the "Error invoking remote method" wrapper
   * ipcRenderer adds around a main-process throw. */
  openFile: (filePath, base) =>
    invoke("desktop:open-file", filePath, base),
  /** Pops the native right-click menu for a local file link. Rejects with
   *  the same readable reason as openFile. */
  fileMenu: (filePath, base) =>
    invoke("desktop:file-menu", filePath, base),
  /** Copies a local file to where the save dialog points. */
  saveFile: (filePath) =>
    invoke("desktop:save-file", filePath),
  /** Reveals a local file in its folder. */
  showInFolder: (filePath, base) =>
    invoke("desktop:show-file", filePath, base),
  /** Opens a chat's linked file from the other PC that has it. */
  openPeerFile: (host, threadId, filePath) =>
    invoke("desktop:open-peer-file", host, threadId, filePath),
  /** Store a provider credential with OS-backed encryption. */
  setCredential: (name, value) => invoke("credential:set", name, value),

  /** In-app auto-update. State object:
   *  { status: "idle"|"checking"|"available"|"downloading"|"downloaded"|"error",
   *    version?, percent?, message? }. onState fires immediately with the
   *    current state, then on every transition. Dormant in dev (no bridge). */
  updater: {
    check: () => ipcRenderer.invoke("update:check"),
    download: () => ipcRenderer.invoke("update:download"),
    install: () => ipcRenderer.invoke("update:install"),
    /** "stable" | "dev". Only a launch flag joins dev; the app can only leave it. */
    getChannel: () => ipcRenderer.invoke("update:get-channel"),
    backToStable: () => ipcRenderer.invoke("update:set-channel", "stable"),
    onState: (cb) => {
      let alive = true;
      let pushed = false;
      const handler = (_event, s) => {
        pushed = true;
        if (alive) cb(s);
      };
      ipcRenderer.on("update:state", handler);
      ipcRenderer
        .invoke("update:get-state")
        .then((s) => { if (alive && !pushed) cb(s); })
        .catch(() => {});
      return () => {
        alive = false;
        ipcRenderer.removeListener("update:state", handler);
      };
    },
  },
});
