const { DEVICE_WINDOW_PARTITION, deviceLinkedFileName, deviceWindowUrl } = require("./device-window.cjs");
const { desktopViewerWindowOptions } = require("./desktop-viewer.cjs");

function handleDeviceLinkedFile(target, origin, { createWindow, webContents, openFile, log }) {
  const name = deviceLinkedFileName(target, origin);
  if (!name) return false;
  if (!/\.html?$/i.test(name)) {
    if (/\.(pdf|png|jpe?g|gif|webp|mp4|webm|mov|m4v|mp3|m4a|wav|ogg|aac|flac)$/i.test(name)) void openFile(target, name);
    else webContents.downloadURL(target);
    return true;
  }
  const win = createWindow({
    ...desktopViewerWindowOptions(),
    title: name,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: DEVICE_WINDOW_PARTITION,
    },
  });
  const url = new URL(target);
  const scope = `${url.pathname}/${encodeURIComponent(url.searchParams.get("path"))}/`;
  const allowed = (href) => {
    try {
      const next = new URL(href);
      return next.origin === origin && (next.href === url.href || next.pathname.startsWith(scope));
    } catch {
      return false;
    }
  };
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  for (const event of ["will-navigate", "will-redirect"]) {
    win.webContents.on(event, (e, href) => { if (!allowed(href)) e.preventDefault(); });
  }
  win.once("ready-to-show", () => { if (!win.isDestroyed()) win.show(); });
  void win.loadURL(target).catch((error) => log(`device linked HTML: ${error.message}`));
  return true;
}

const PEER_TIMEOUT_MS = 8_000;

/** Opens a linked file from the PC that has it; that PC's server decides whether the link may be read. */
async function openPeerLinkedFile(rawHost, threadId, filePath, { tailnet, session, ...actions }) {
  const { origin } = deviceWindowUrl(rawHost, tailnet);
  const target = `${origin}/api/threads/${encodeURIComponent(threadId)}/linked-file?path=${encodeURIComponent(filePath)}`;
  if (!deviceLinkedFileName(target, origin)) throw new Error("That file path is invalid");
  // downloadURL and a new window fail without a word, so ask first.
  const probe = await session.fetch(target, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(PEER_TIMEOUT_MS) }).catch(() => null);
  if (!probe?.ok && !(probe?.status === 416 && probe.headers.get("content-range") === "bytes */0")) {
    const body = await probe?.json().catch(() => null);
    throw new Error(body?.reason === "outside" ? "That file is outside the bot's folder" : "That file could not be opened");
  }
  handleDeviceLinkedFile(target, origin, { ...actions, webContents: session });
}

module.exports = { handleDeviceLinkedFile, openPeerLinkedFile };
