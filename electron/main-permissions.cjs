// Without handlers the default session grants every permission, camera included.
function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function setMainPermissions(session, { contents, origin, micAllowed }) {
  const ours = (webContents, url) => webContents != null && webContents === contents() && originOf(url) === origin();
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) =>
    permission !== "media" || (details?.mediaType === "audio" && ours(webContents, requestingOrigin)));
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission !== "media") return callback(true);
    const types = details?.mediaTypes ?? [];
    callback(types.length > 0 && types.every((type) => type === "audio") && ours(webContents, details?.requestingUrl) && micAllowed());
  });
}

module.exports = { setMainPermissions };
