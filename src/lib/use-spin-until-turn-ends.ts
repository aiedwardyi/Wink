import { useState } from "react";

/** Keeps a spin going after `active` drops until the current turn ends, so the icon stops upright. Spread the result on the icon. */
export function useSpinUntilTurnEnds(active: boolean) {
  const [spinning, setSpinning] = useState(active);
  if (active && !spinning) setSpinning(true);
  return { spinning, onAnimationIteration: () => { if (!active) setSpinning(false); } };
}
