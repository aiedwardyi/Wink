import { expect, it } from "vitest";
import { blockedGuard } from "./blocked.mjs";

it("turns scripts and phone layout to not checked when page code or styles are blocked", () => {
  expect(blockedGuard([{ url: "https://cdn.tailwindcss.com/", type: "Script" }])).toEqual({ scripts: "code from cdn.tailwindcss.com is blocked in the check", layout: "styles from cdn.tailwindcss.com are blocked in the check" });
  expect(blockedGuard([{ url: "https://api.example.net/v1", type: "Fetch" }, { url: "wss://live.example.net/", type: undefined }])).toEqual({ scripts: "requests to api.example.net are blocked in the check", layout: "" });
  expect(blockedGuard([{ url: "https://images.unsplash.com/1.jpg", type: "Image" }])).toEqual({ scripts: "", layout: "" });
});
