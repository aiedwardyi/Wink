const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("verifyWall", {
  ready: () => ipcRenderer.invoke("verify:ready"),
  onEvent(callback) {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("verify:event", listener);
    return () => ipcRenderer.removeListener("verify:event", listener);
  },
  setMuted: (muted) => ipcRenderer.send("verify:mute", { muted }),
  close: () => ipcRenderer.send("verify:close"),
});
