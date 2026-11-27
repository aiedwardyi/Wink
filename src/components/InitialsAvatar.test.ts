import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InitialsAvatar, profileInitials } from "./Avatar";

const render = (profile?: { name?: string; email?: string }) =>
  renderToStaticMarkup(createElement(InitialsAvatar, { initials: profileInitials(profile), size: 28 }));

describe("InitialsAvatar", () => {
  it("shows a person icon, never a question mark, with no name or email", () => {
    for (const profile of [undefined, {}, { name: "  ", email: " " }]) {
      const html = render(profile);
      expect(html).toContain("<svg");
      expect(html).not.toContain("?");
    }
  });

  it("keeps initials for a name or an email", () => {
    expect(render({ name: "Milind Soni" })).toContain(">MS<");
    expect(render({ email: "you@x.dev" })).toContain(">Y<");
    expect(render({ name: "Milind Soni" })).not.toContain("<svg");
  });
});
