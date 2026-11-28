// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { holdVideoKeys } from "./video-keys";

let video: HTMLVideoElement;
let composer: HTMLTextAreaElement;
let release: () => void;
const blurred = vi.fn();
const fire: [string, () => void][] = [
  ["seek", () => video.dispatchEvent(new Event("seeked"))],
  ["full screen", () => document.dispatchEvent(new Event("fullscreenchange"))],
];

beforeEach(() => {
  video = document.createElement("video");
  video.setAttribute("tabindex", "0");
  video.addEventListener("blur", blurred);
  composer = document.createElement("textarea");
  document.body.append(video, composer);
  release = holdVideoKeys(video);
});

afterEach(() => {
  release();
  video.remove();
  composer.remove();
  blurred.mockClear();
});

it.each(fire)("hands Space back to the video after its %s control", (_, control) => {
  video.focus();
  control();
  expect(blurred).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(video);
});

it.each(fire)("leaves the composer focused through a %s", (_, control) => {
  composer.focus();
  control();
  expect(blurred).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(composer);
});

it("stops once released", () => {
  release();
  video.focus();
  for (const [, control] of fire) control();
  expect(blurred).not.toHaveBeenCalled();
});
