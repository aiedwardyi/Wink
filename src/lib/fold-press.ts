/** Runs a fold's toggle once the fold at `id` stops moving. Fold starts each motion from the far end, so a second press mid-motion (a fast double press) would make it jump. */
export function afterFold(id: string, toggle: () => void) {
  const moving = document.getElementById(id)?.getAnimations?.().filter((each) => each.playState === "running") ?? [];
  if (!moving.length) toggle();
  else void Promise.allSettled(moving.map((each) => each.finished)).then(toggle);
}
