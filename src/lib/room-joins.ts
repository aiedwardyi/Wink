import type { RoomJoin } from "@/state/store-types";

/** Each join sits before the first shown row (null time = hidden) at or after it; newer ones trail.
 * A window that doesn't start at the top drops joins older than its first row. */
export function placeJoins(joins: readonly RoomJoin[], times: readonly (number | null)[], fromTop: boolean): { at: Map<number, RoomJoin[]>; tail: RoomJoin[] } {
  const at = new Map<number, RoomJoin[]>();
  const tail: RoomJoin[] = [];
  const first = times.findIndex((time) => time !== null);
  for (const join of [...joins].sort((a, b) => a.at - b.at)) {
    const index = times.findIndex((time) => time !== null && time >= join.at);
    if (index === -1) tail.push(join);
    else if (index !== first || fromTop) at.set(index, [...(at.get(index) ?? []), join]);
  }
  return { at, tail };
}
