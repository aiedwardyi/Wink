// Marks this person active for the owner's Team page: at most one ping per slot they type or click in, never what.
export const TEAM_ACTIVE_PATH = "/api/team/active";
export const TEAM_ACTIVE_SLOT_MS = 5 * 60_000;

export function startTeamActive(): () => void {
  let last = -1;
  const mark = () => {
    const slot = Math.floor(Date.now() / TEAM_ACTIVE_SLOT_MS);
    if (slot === last) return;
    last = slot;
    void fetch(TEAM_ACTIVE_PATH, { method: "POST", headers: { "content-type": "application/json" } }).catch(() => {});
  };
  const options = { capture: true, passive: true };
  window.addEventListener("keydown", mark, options);
  window.addEventListener("pointerdown", mark, options);
  return () => {
    window.removeEventListener("keydown", mark, options);
    window.removeEventListener("pointerdown", mark, options);
  };
}
