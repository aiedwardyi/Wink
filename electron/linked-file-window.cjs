const { DEVICE_WINDOW_PARTITION, deviceLinkedFileName } = require("./device-window.cjs");
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

module.exports = { handleDeviceLinkedFile };
