function setDevicePermissions(session) {
  const allowed = (permission) => permission === "clipboard-sanitized-write" || permission === "fullscreen";
  session.setPermissionCheckHandler((_webContents, permission) => allowed(permission));
  session.setPermissionRequestHandler((_webContents, permission, callback) => callback(allowed(permission)));
}

module.exports = { setDevicePermissions };
