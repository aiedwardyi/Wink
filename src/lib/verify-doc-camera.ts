const SPEED_MS = 1_000;
const CATCH_MS = 600;
const EASE_MS = 200;
const WALL_MS = 100;
const TOP = 8;
// The cursor's y is its arrow tip; the arrow is 21 px tall, plus room for the drawn glide trailing the modeled one.
const BOTTOM = 40;

/** In the stage's scroll space: the leading reader, `y` where it is now and `to` where its glide ends; `stop`: the names cursor, never pushed out the top. */
export interface DocView { lead?: { y: number; to: number }; stop?: number }
export interface DocCamera { x: number; v: number; speed: number; to?: number }

/** One frame of the view: the readers' average speed plus a catch-up to their next stop, so their hops read as one glide; walls keep them in. */
export function cameraStep(cam: DocCamera, { lead, stop }: DocView, view: number, max: number, ms: number): DocCamera {
  const dt = Math.min(100, Math.max(1, ms)), ease = 1 - Math.exp(-dt / EASE_MS), wall = (y: number) => (y - TOP - cam.x) * 1000 / WALL_MS;
  const held = stop === undefined ? Infinity : Math.max(0, wall(stop));
  let v: number, speed = 0;
  if (!lead) v = Math.min(cam.v * (1 - ease), held);
  else {
    if (cam.to !== undefined) speed = Math.max(0, cam.speed + ((lead.to - cam.to) * 1000 / dt - cam.speed) * (1 - Math.exp(-dt / SPEED_MS)));
    v = cam.v + (Math.max(0, speed + (lead.to - view / 3 - cam.x) * 1000 / CATCH_MS) - cam.v) * ease;
    const above = wall(lead.y), below = lead.y + BOTTOM - view - cam.x;
    v = above < 0 ? above : Math.min(v, above, held);
    if (below > 0) v = Math.max(v, below * 1000 / WALL_MS);
  }
  const floor = lead ? Math.min(lead.y + BOTTOM - view, lead.y - TOP) : 0;
  const x = Math.min(max, Math.max(0, cam.x + v * dt / 1000, floor));
  return { x, v: (x - cam.x) * 1000 / dt, speed, to: lead?.to };
}

/** Moves `stage` every frame until stopped, the follow is off, or a hand scrolls it. */
export function docCamera(stage: HTMLElement, cursors: (now: number) => DocView, following: () => boolean, onHand: () => void): () => void {
  let cam: DocCamera = { x: stage.scrollTop, v: 0, speed: 0 }, set = stage.scrollTop, last = performance.now(), frame = 0;
  const tick = () => {
    if (!following()) return;
    if (Math.abs(stage.scrollTop - set) > 1) { onHand(); return; }
    const now = performance.now();
    cam = cameraStep(cam, cursors(now), stage.clientHeight, stage.scrollHeight - stage.clientHeight, now - last);
    last = now;
    stage.scrollTop = cam.x;
    set = stage.scrollTop;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}
