import { describe, expect, it } from "vitest";

import { placeJoins } from "./room-joins";

const join = (personId: string, at: number) => ({ personId, name: personId, at });

describe("placeJoins", () => {
  it("puts a join before the first shown row at or after it, in time order", () => {
    const { at, tail } = placeJoins([join("b", 25), join("a", 15)], [10, null, 20, 30], true);
    expect([...at]).toEqual([[2, [join("a", 15)]], [3, [join("b", 25)]]]);
    expect(tail).toEqual([]);
  });

  it("trails joins newer than every row, and all of them with no rows", () => {
    expect(placeJoins([join("a", 50)], [10, 20], true).tail).toEqual([join("a", 50)]);
    expect(placeJoins([join("a", 5)], [null], true).tail).toEqual([join("a", 5)]);
  });

  it("drops joins older than a window that starts below the top", () => {
    expect([...placeJoins([join("a", 5), join("b", 15)], [10, 20], false).at]).toEqual([[1, [join("b", 15)]]]);
    expect([...placeJoins([join("a", 5)], [10, 20], true).at]).toEqual([[0, [join("a", 5)]]]);
  });
});
