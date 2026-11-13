import { expect, it } from "vitest";
import { mapFollow, type MapSelection } from "./map-follow";

const workers = [
  { id: "a", nick: "ALPHA", task: "Fix layout", git: true, editedAt: 1, path: "a.ts", files: [{ path: "a.ts", added: 1, removed: 0 }] },
  { id: "b", nick: "BETA", task: "Fix calls", git: true, editedAt: 2, path: "b.ts", files: [{ path: "b.ts", added: 0, removed: 1 }] },
];
const initial: MapSelection = { follow: true, worker: null, path: null, pinned: null };

it("follows the latest edit across workers and files", () => {
  const first = mapFollow(initial, workers);
  expect(first).toMatchObject({ worker: "b", path: "b.ts" });
  const edited = [{ ...workers[0], editedAt: 3 }, workers[1]];
  expect(mapFollow(first, edited)).toMatchObject({ worker: "a", path: "a.ts" });
});

it("keeps manual selection with Follow off and resumes on toggle", () => {
  const manual = { ...initial, follow: false, worker: "a", path: "a.ts" };
  expect(mapFollow(manual, workers)).toEqual(manual);
  expect(mapFollow({ ...manual, follow: true }, workers).worker).toBe("b");
});

it("follows only the pinned worker and releases a departed pin", () => {
  const pinned = mapFollow({ ...initial, pinned: "a" }, workers);
  expect(pinned).toMatchObject({ worker: "a", path: "a.ts", pinned: "a" });
  expect(mapFollow(pinned, [workers[1]])).toMatchObject({ worker: "b", path: "b.ts", pinned: null });
  expect(mapFollow(pinned, [])).toMatchObject({ worker: null, path: null, pinned: null });
});

it("moves an unfollowed selection off a file that is no longer changed", () => {
  const manual = { ...initial, follow: false, worker: "a", path: "reverted.ts" };
  expect(mapFollow(manual, workers)).toEqual({ ...manual, path: "a.ts" });
  expect(mapFollow(manual, [{ ...workers[0], path: undefined, files: [] }, workers[1]])).toEqual({ ...manual, path: null });
});
