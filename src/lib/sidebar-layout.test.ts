import { describe, expect, it } from "vitest";

import {
  moveSection,
  placeSection,
  sameSectionOrder,
  userSectionId,
  userSectionName,
} from "./sidebar-layout";

describe("sidebar section ordering", () => {
  const work = userSectionId("Work");
  const personal = userSectionId("Personal");

  it("moves sections with keyboard or drag placement without wrapping", () => {
    const ids = [work, personal, userSectionId("Ideas")];
    expect(moveSection(ids, work, -1)).toBe(ids);
    expect(moveSection(ids, work, 1)).toEqual([personal, work, userSectionId("Ideas")]);
    expect(placeSection(ids, userSectionId("Ideas"), work, "before")).toEqual([
      userSectionId("Ideas"),
      work,
      personal,
    ]);
    expect(placeSection(ids, personal, personal, "after")).toBe(ids);
  });

  it("compares section order and reads user section names", () => {
    expect(sameSectionOrder([personal, work], [personal, work])).toBe(true);
    expect(userSectionName(work)).toBe("Work");
  });
});
