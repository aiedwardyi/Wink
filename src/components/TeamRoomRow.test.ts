// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

import { TeamRoomTranscript } from "./TeamRoomRow";
import type { RoomLine } from "@/lib/team-rooms";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("labels old lines by current author id and keeps departed names", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const lines: RoomLine[] = [
    { id: "a", at: 1, author: { kind: "person", id: "p1", name: "Mina" }, text: "old line", files: [] },
    { id: "b", at: 2, author: { kind: "host", id: "host", name: "Edward" }, text: "host line", files: [] },
    { id: "c", at: 3, author: { kind: "person", id: "gone", name: "Daniel Cho" }, text: "left", files: [] },
  ];
  try {
    await act(async () => root.render(createElement(TeamRoomTranscript, {
      lines, mine: () => false, base: "", label: "Room", hostName: "에드워드", people: [{ id: "p1", name: "민아" }],
    })));
    expect(host.textContent).toContain("민아");
    expect(host.textContent).toContain("에드워드");
    expect(host.textContent).toContain("Daniel Cho");
    expect(host.textContent).not.toContain("Mina");
  } finally {
    await act(async () => root.unmount());
  }
});
