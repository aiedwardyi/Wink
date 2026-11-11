const { setMicPermissions } = require("./main-permissions.cjs");

function setDevicePermissions(session, { origin, micAllowed }) {
  const allowed = (permission) => permission === "clipboard-sanitized-write" || permission === "fullscreen";
  setMicPermissions(session, { origin, micAllowed, others: allowed });
}

module.exports = { setDevicePermissions };
