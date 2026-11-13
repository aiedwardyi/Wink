import { expect, it } from "vitest";
import { mapTree, mapFollow, type MapSelection } from "./map-tree";

it("collapses single-child directories and sorts folders before files", () => {
  const tree = mapTree([
    { path: "z.ts", added: 1, removed: 2 },
    { path: "src/components/Z.tsx", added: 4, removed: 1 },
    { path: "src/components/A.tsx", added: 2, removed: 3 },
    { path: "README.md", added: 0, removed: 1 },
  ]);
  expect(tree.map(node => node.name)).toEqual(["src/components/", "README.md", "z.ts"]);
  expect(tree[0].children?.map(node => node.name)).toEqual(["A.tsx", "Z.tsx"]);
  expect(tree[0]).toMatchObject({ added: 6, removed: 4 });
  expect(tree[1]).toMatchObject({ path: "README.md", added: 0, removed: 1 });
});

it("keeps branching folders and counts each file once", () => {
  const tree = mapTree([
    { path: "src/a/x.ts", added: 3, removed: 0 },
    { path: "src/b/y.ts", added: 0, removed: 2 },
    { path: "src/root.ts", added: 1, removed: 1 },
  ]);
  expect(tree[0]).toMatchObject({ name: "src/", added: 4, removed: 3 });
  expect(tree[0].children?.map(node => node.name)).toEqual(["a/", "b/", "root.ts"]);
  expect(mapTree([])).toEqual([]);
});

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

it("keeps an unfollowed deleted file selected until the user chooses another", () => {
  const manual = { ...initial, follow: false, worker: "a", path: "gone.ts" };
  expect(mapFollow(manual, workers)).toEqual(manual);
});
