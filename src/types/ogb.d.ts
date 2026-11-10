// The narrow bridge the Electron preload exposes. Absent in the browser.

declare global {
  type DesktopCapabilities = {
    host: {
      platform: "darwin" | "linux" | "win32" | "other";
      /** The user's home folder, for showing paths as ~/… */
      homeDir?: string;
      label: string;
      session: "x11" | "wayland" | "headless" | "unknown";
      packaged: boolean;
    };
    windowChrome: "mac-inset" | "native";
    screenPreview: {
      available: boolean;
      interaction: "direct" | "portal-picker" | "none";
      reasonCode?: string;
    };
    dictation: {
      available: boolean;
      engine: "apple-speech" | "none";
      onDevice: boolean;
      reasonCode?: string;
    };
    localComputer: {
      available: boolean;
      support: "supported" | "limited" | "unsupported";
      enabled: boolean;
      status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
      reasonCode?: string;
      message?: string;
      driverPath?: string;
      driverVersion?: string;
      driverSource?: "bundled" | "environment" | "user-local" | "path";
      session?: "x11" | "wayland" | "headless" | "unknown";
      compositor?: "gnome-mutter";
    };
    /** Present in the desktop shell when it has probed native toast support. */
    toasts?: { available: boolean };
  };

  interface TerminalRun {
    t: string;
    fg?: number | string;
    bg?: number | string;
    b?: 1;
    d?: 1;
    i?: 1;
    u?: 1;
    s?: 1;
  }

  interface TerminalBotSnapshot {
    botId: string;
    state?: "no-terminal";
    sessionId?: string;
    generation?: number;
    label?: string | null;
    cwd?: string;
    seq: number;
    capturedAt: number;
    exitCode: number | null;
    exited: boolean;
    screenText: string;
    screenRuns?: TerminalRun[][];
    recentText: string;
    truncated: boolean;
    cols?: number;
    rows?: number;
    alternate?: boolean;
    modes?: number[];
    resetModes?: number[];
    cursor?: { x: number; y: number; visible: boolean };
    panes?: { sessionId: string; generation: number; label: string | null; cwd: string; main: boolean; exited: boolean; changedAt?: number }[];
  }

  interface Window {
    ogb?: {
      platform: NodeJS.Platform;
      terminal?: {
        readBot?(botId: string, options: { panesOnly: true }): Promise<Pick<TerminalBotSnapshot, "botId" | "state" | "capturedAt" | "panes">>;
        readBot?(botId: string, options?: { panesOnly?: false }): Promise<TerminalBotSnapshot>;
        paneLabels?(): Promise<Record<string, string[]>>;
        sendBot?(botId: string, input: { sessionId: string; generation: number; text: string }): Promise<TerminalBotSnapshot>;
        appearance(): Promise<{ profileName: string; fontFamily?: string; fontSize?: number; theme: Record<string, string> } | null>;
        openBot?(botId: string, input: { label?: string; cwd?: string; command?: string }): Promise<{ sessionId: string; generation: number }>;
        close?(id: string): Promise<void>;
        open(input: { botId: string; cols: number; rows: number; restart?: boolean; cwd?: string; projectCwd?: string | null; sessionId?: string }): Promise<
          | { id: string; cwd: string; shell: string; output: string; exitCode: number | null; seq: number; launchProject?: string | null; label?: string; cols?: number; rows?: number; alternate?: boolean; modes?: number[]; resetModes?: number[] }
          | { needsFolder: true; reason?: string }
        >;
        cancelOpen?(botId: string): Promise<boolean>;
        prestart?(input: { botId: string; cols: number; rows: number; projectCwd: string | null }): Promise<boolean>;
        write(id: string, data: string): Promise<void>;
        acknowledge?(id: string): Promise<void>;
        resize(id: string, cols: number, rows: number): Promise<void>;
        onData(cb: (event: { id: string; data: string; seq: number }) => void): () => void;
        onExit(cb: (event: { id: string; exitCode: number }) => void): () => void;
        onError?: (cb: (event: { id: string; message: string }) => void) => () => void;
        onOpened?: (cb: (event: { id: string; botId: string; label: string | null; generation: number }) => void) => () => void;
        onClosed?: (cb: (event: { id: string; botId: string }) => void) => () => void;
        onAttention?: (cb: (event: { id: string; botId: string; reason: "bell" | "activity" | "exit" | "error" }) => void) => () => void;
      };
      getCapabilities(): Promise<DesktopCapabilities>;
      getBrand?(): Promise<{ name: string; icon: string } | null>;
      onCapabilitiesChanged(cb: (capabilities: DesktopCapabilities) => void): () => void;
      companionAccount?: {
        state(): Promise<CompanionAccountState>;
        requestCode(email: string): Promise<CompanionAccountState>;
        verifyCode(email: string, code: string): Promise<CompanionAccountState>;
        retry(): Promise<CompanionAccountState>;
        signOut(): Promise<CompanionAccountState>;
      };
      googleAccount?: {
        signIn(): Promise<{ ok: true; email: string } | { ok: false; error: string }>;
        cancel(): Promise<void>;
        signOut(): Promise<{ ok: true }>;
      };
      localControl: {
        status(): Promise<LinuxLocalControlStatus>;
        enable(): Promise<LinuxLocalControlStatus>;
        disable(): Promise<LinuxLocalControlStatus>;
        retry(): Promise<LinuxLocalControlStatus>;
      };
      /** Arms one user-initiated display capture request from this frame. */
      beginScreenPreviewIntent(): boolean;
      /** Start native dictation. Call mode supplies endpointMs so silence
       * finalizes a turn; composer dictation omits it and remains manual. */
      speechStart(options?: { endpointMs?: number }): Promise<void>;
      speechStop(): Promise<void>;
      /** Finish capture and emit the recognizer's final transcript. */
      speechFinish?(): Promise<void>;
      onSpeechTranscript(
        cb: (line: { partial?: boolean; text?: string; error?: string }) => void,
      ): () => void;
      onSpeechEnd(cb: (info: { code: number | null; reason?: string }) => void): () => void;
      transcription?: {
        status(): Promise<{ configured: boolean }>;
        setKey(value: string): Promise<{ configured: boolean }>;
        streamingToken(): Promise<{ token: string; expiresInSeconds: number }>;
      };
      /** Absolute path of a dropped File ("" when the drag carried no
       * file on disk). Absent in older builds of the shell. */
      getPathForFile?(file: File): string;
      /** PNG bytes of the clipboard image, or null. Absent in older shells. */
      readClipboardImage?(): Promise<Uint8Array<ArrayBuffer> | null>;
      /** Native clipboard channel; absent in current shells, so the terminal
       * prefers navigator.clipboard and treats this as a fallback. */
      clipboard?: {
        readText(): Promise<string>;
        writeText(text: string): Promise<void>;
      };
      /** Opens System Settings on a privacy pane: mic|screen|speech|accessibility. */
      permOpenSettings(pane: "mic" | "screen" | "speech" | "accessibility"): Promise<void>;
      /** Copies an engine install command and opens a blank terminal. False
       * when no terminal could be launched; the clipboard still has it. */
      openInstallTerminal?(command: string): Promise<boolean>;
      openEngineSignIn?(instanceId: string): Promise<"running" | "opened" | "copied">;
      openEngineInstall?(instanceId: string, installOnly?: true): Promise<"running" | "opened" | "copied">;
      /** Opens an http(s) link in the user's default browser. */
      openExternal?(url: string): Promise<boolean>;
      /** Recolor the native window chrome for a skin; absent on older builds. */
      applySkin?(skin: string): Promise<boolean>;
      setModelPickerBackground?(view: "dial" | "list" | null): Promise<boolean>;
      /** Installed app version, from the main process. */
      getAppVersion?(): Promise<string>;
      startFresh?(): Promise<void>;
      /** OS/app locale tag from Electron, e.g. "ko-KR". */
      getLocale?(): string;
      /** Remember the Settings language choice for packaged copy. */
      setLocalePreference?(preference: "system" | "en" | "ko"): Promise<boolean>;
      getLocalePreference?(): "system" | "en" | "ko";
      /** Receives a GitHub package URL opened through orbit://install. */
      onPackageInstall?(cb: (url: string) => void): () => void;
      /** Updates the native Dock/taskbar unread indicator. */
      setUnreadCount?(count: number): void;
      /** Windows taskbar progress while any bot turn is running. */
      setTaskbarBusy?(busy: boolean): void;
      /** Open image preview takes Ctrl/Cmd +/-/0 until it closes. */
      imageZoom?: {
        own(owned: boolean): void;
        onShortcut(cb: (action: "in" | "out" | "reset") => void): () => void;
      };
      /** Asks the main process to fire a native toast. */
      showNotification?(payload: {
        title: string;
        body?: string;
        icon?: string;
        botId: string;
        threadId: string;
        visibleThreadId?: string | null;
        openTerminal?: boolean;
        terminalSessionId?: string;
      }): void;
      /** Toast click: focus already happened in main; open this bot/thread. */
      onNotificationClick?(cb: (target: {
        botId: string;
        threadId: string;
        openTerminal?: boolean;
        terminalSessionId?: string;
      }) => void): () => void;
      /** Another PC's Orbit in its own sandboxed window; focuses it when already open. */
      deviceWindow?: {
        open(host: string, name: string): Promise<boolean>;
      };
      /** Native folder picker; resolves null when the user cancels. */
      pickFolder?(current?: string): Promise<string | null>;
      /** Writes the redacted diagnostics report to a user-chosen file;
       * resolves the path, or null when cancelled. */
      exportDiagnostics?(): Promise<string | null>;
      errorReportConsent?(): Promise<boolean | null>;
      setErrorReportConsent?(enabled: boolean): Promise<boolean>;
      captureErrorReport?(site: number): void;
      /** Opens a local file in its default app, or reveals it when its
       * type could run. A relative link passes its bot folder as `base`,
       * and the file must stay inside it. */
      openFile?(filePath: string, base?: string): Promise<void>;
      /** Pops the native right-click menu (show in folder, save a copy, copy
       * path) for a local file link. Rejects like `openFile`. */
      fileMenu?(filePath: string, base?: string): Promise<void>;
      /** Opens a chat's linked file from the PC that has it, under that PC's
       * own link checks. Rejects with a readable reason. */
      openPeerFile?(host: string, threadId: string, filePath: string): Promise<void>;
      /** Save a provider credential through Electron's OS-backed store. */
      setCredential?(
        name: "composioApiKey" | "xaiApiKey" | "geminiApiKey" | "openaiCompatKey" | "boxToken" | "ttsKey" | "openaiImageApiKey" | "anthropicApiKey" | "vertexApiKey" | `custom:${string}`,
        value: string,
      ): Promise<ConfigStatus>;
      /** In-app auto-update (packaged app only; dormant in dev). onState
       * fires immediately with the current state, then on transitions. */
      updater?: {
        check(): Promise<void>;
        download(): Promise<void>;
        /** quit-and-install the downloaded update */
        install(): Promise<void>;
        onState(cb: (s: UpdaterState) => void): () => void;
      };
    };
  }
}

export interface LinuxLocalControlStatus {
  enabled: boolean;
  status: "disabled" | "checking" | "starting" | "ready" | "error" | "stopped" | "unavailable";
  reasonCode?: string;
  message?: string;
  driverPath?: string;
  driverVersion?: string;
  driverSource?: "bundled" | "environment" | "user-local" | "path";
  session?: "x11" | "wayland" | "headless" | "unknown";
  compositor?: "gnome-mutter";
  warnings?: Array<{ label: string; status: string; message: string; detail?: string }>;
}

export interface UpdaterState {
  status:
    | "idle"
    | "checking"
    | "available"
    | "downloading"
    | "downloaded"
    | "installing"
    | "error";
  version?: string;
  percent?: number;
  message?: string;
  /** Running app version; only the remote proxy sends it. */
  appVersion?: string;
}

export interface CompanionAccountState {
  available: boolean;
  status: "signed-out" | "connecting" | "ready" | "error";
  email?: string;
  endpoint?: string;
  message?: string;
}
