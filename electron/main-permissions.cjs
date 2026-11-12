// Without handlers the default session grants every permission, camera included.
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// Media is audio only, from the window's own page origin; `others` decides every other permission.
function setMicPermissions(session, { origin, micAllowed, others }) {
  const ours = (webContents, url) => webContents != null && originOf(url) === origin(webContents);
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    permission === "media" ? details?.mediaType === "audio" && ours(webContents, requestingOrigin) : others(permission));
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "media") return callback(others(permission));
    const types = details?.mediaTypes ?? [];
    callback(types.length > 0 && types.every((type) => type === "audio") && ours(webContents, details?.requestingUrl) && micAllowed());
  });
}

function setMainPermissions(session, { contents, origin, micAllowed }) {
  setMicPermissions(session, { origin: (webContents) => (webContents === contents() ? origin() : undefined), micAllowed, others: () => true });
}

module.exports = { setMainPermissions, setMicPermissions };
