import { describe, expect, it } from "vitest";

import { BUBBLE_ARM, BUBBLE_FOLLOW, BUBBLE_MAX, bubbleSwipe } from "./phone-swipe";

const both = { right: true, left: true };

describe("bubbleSwipe", () => {
  it("follows the finger 1:1 up to 64 px", () => {
    expect(bubbleSwipe(0, both).offset).toBe(0);
    expect(bubbleSwipe(30, both).offset).toBe(30);
    expect(bubbleSwipe(BUBBLE_FOLLOW, both).offset).toBe(BUBBLE_FOLLOW);
    expect(bubbleSwipe(-BUBBLE_FOLLOW, both).offset).toBe(-BUBBLE_FOLLOW);
  });

  it("moves at 0.3x past 64 px and stops at 96 px", () => {
    expect(bubbleSwipe(94, both).offset).toBeCloseTo(73, 5);
    expect(bubbleSwipe(-94, both).offset).toBeCloseTo(-73, 5);
    expect(bubbleSwipe(400, both).offset).toBe(BUBBLE_MAX);
    expect(bubbleSwipe(-400, both).offset).toBe(-BUBBLE_MAX);
  });

  it("arms at 56 px and not before", () => {
    expect(bubbleSwipe(BUBBLE_ARM - 1, both).armed).toBeNull();
    expect(bubbleSwipe(BUBBLE_ARM, both).armed).toBe("right");
    expect(bubbleSwipe(-(BUBBLE_ARM - 1), both).armed).toBeNull();
    expect(bubbleSwipe(-BUBBLE_ARM, both).armed).toBe("left");
  });

  it("disarms when the finger comes back under 56 px", () => {
    expect(bubbleSwipe(80, both).armed).toBe("right");
    expect(bubbleSwipe(40, both).armed).toBeNull();
  });

  it("right means reply and left means translate, each only where allowed", () => {
    expect(bubbleSwipe(-80, { right: true, left: false })).toEqual({ offset: 0, armed: null });
    expect(bubbleSwipe(80, { right: false, left: true })).toEqual({ offset: 0, armed: null });
    expect(bubbleSwipe(80, { right: true, left: false }).armed).toBe("right");
  });
});
