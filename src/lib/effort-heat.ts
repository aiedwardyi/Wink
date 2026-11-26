/** 0 to 1: every effort step a little stronger than the one below it, the top step 1. */
export function effortHeat(index: number, total: number): number {
  if (index < 0 || total <= 0) return 0;
  return Number(((Math.min(index, total - 1) + 1) / total).toFixed(3));
}
