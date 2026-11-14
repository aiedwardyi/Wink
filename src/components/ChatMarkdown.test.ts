// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatMarkdown, isRelativeHref, resolveRelativePath, settleStreamTail, streamBlocks, warmMarkdown } from "./ChatMarkdown";
import { LinkedText } from "./LinkedText";
import { applyLocale } from "@/lib/i18n";
import { closeShow, lastShown, showItem } from "@/lib/show-pane";
import { applySkin } from "@/lib/skins";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("shiki", () => ({ codeToHtml: async (code: string) => `<pre><code>${code}</code></pre>` }));

beforeEach(() => localStorage.setItem("omb-reply-style", "live"));
afterEach(() => { localStorage.removeItem("omb-reply-style"); act(() => closeShow()); });

describe("web links", () => {
  it.each(["README.md", "deploy.sh", "file.ts", "notes.ai", "v1.0.259", "e.g.", "file.tsx", "file.js", "file.json", "file.py", "file.txt", "file.yml", "file.log", "www.notes.ai", "example.technology"])("keeps %s plain in user and bot text", (text) => {
    for (const Component of [LinkedText, ChatMarkdown]) {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(createElement(Component, { text }));
      expect(host.querySelector("a")).toBeNull();
      expect(host.textContent).toBe(text);
    }
  });

  it.each([["user", LinkedText], ["bot", ChatMarkdown]] as const)("links common domains in %s text", (kind, Component) => {
    const text = "starzum.com x.co.kr www.x.io";
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(Component, { text }));
    expect([...host.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://starzum.com", "https://x.co.kr", kind === "bot" ? "http://www.x.io" : "https://www.x.io",
    ]);
    expect(host.textContent).toBe(text);
  });

  it.each([
    ["https://example.com/Edward's-notes", "https://example.com/Edward's-notes"],
    ["www.starzum.com/Edward's-notes", "https://www.starzum.com/Edward's-notes"],
    ["'www.starzum.com/notes'", "https://www.starzum.com/notes"],
  ])("keeps apostrophes inside %s and surrounding quotes outside", (text, href) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(LinkedText, { text }));
    expect(host.querySelector("a")?.getAttribute("href")).toBe(href);
    expect(host.textContent).toBe(text);
  });

  it.each(["https://starzum.com", "www.x.io", "http://x.co.kr", "https://notes.ai", "http://x.io/a", "https://STARZUM.COM", "https://example.technology", "https://한글.kr"])("links %s in a bot reply", (text) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(ChatMarkdown, { text }));
    const link = host.querySelector("a");
    expect(link?.textContent).toBe(text);
    const href = text.startsWith("http") ? text : `${text.startsWith("www.") ? "http" : "https"}://${text}`;
    expect(new URL(link?.getAttribute("href") ?? "about:blank").href).toBe(new URL(href).href);
    expect(link?.target).toBe("_blank");
  });

  it("keeps files, versions, code and existing email links unchanged", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(ChatMarkdown, { text: "file.ts v1.0.259 e.g. `starzum.com` person@example.com [notes](file.ts)" }));
    expect([...host.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["mailto:person@example.com"]);
    expect(host.querySelector("code")?.textContent).toBe("starzum.com");
  });

  it("leaves explicit markdown labels and paths intact and trims sentence punctuation", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(createElement(ChatMarkdown, { text: "(starzum.com/a(b)). [starzum.com](https://example.org) [www.notes.ai](https://www.notes.ai) ./starzum.com wrong.invalidtld file.ts" }));
    expect([...host.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["https://starzum.com/a(b)", "https://example.org", "https://www.notes.ai"]);
  });
});

// warm-views swallows a throw, so a hook in react-markdown would silently undo the warm.
it("warms the parser outside a render", () => {
  expect(() => warmMarkdown()).not.toThrow();
});

describe("ChatMarkdown streaming", () => {
  it("preserves code card identity and spoiler state across deltas and settle", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const text = "```js\nconsole.log('stable');\n```\n\n~~answer~~";
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text, streaming: true })));
      const card = host.querySelector(".chat-md")?.firstElementChild;
      const copy = card?.querySelector("button");
      await act(async () => (host.querySelector('[aria-label="Reveal spoiler"]') as HTMLButtonElement).click());
      await act(async () => root.render(createElement(ChatMarkdown, { text: `${text}\n\nMore text.`, streaming: true })));
      expect.soft(host.querySelector(".chat-md")?.firstElementChild).toBe(card);
      expect.soft(host.querySelector('[aria-label="Hide spoiler"]')).not.toBeNull();
      await act(async () => root.render(createElement(ChatMarkdown, { text: `${text}\n\nMore text.`, streaming: false })));
      expect.soft(host.querySelector(".chat-md")?.firstElementChild).toBe(card);
      expect.soft(host.querySelector(".chat-md button")).toBe(copy);
      expect.soft(host.querySelector('[aria-label="Hide spoiler"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("ChatMarkdown paragraphs", () => {
  it.each([
    ["English loose list", "1. First step\n\n   More detail.\n\n2. Second step"],
    ["Korean loose list", "1. 첫 번째 단계\n\n   추가 설명.\n\n2. 두 번째 단계"],
    ["English nested list", "- First\n\n  - Nested\n\n    More detail.\n\n- Second"],
    ["Korean nested list", "- 첫 번째\n\n  - 하위 항목\n\n    추가 설명.\n\n- 두 번째"],
    ["English quote", "> First paragraph\n>\n> Second paragraph"],
    ["Korean quote", "> 첫 번째 문단\n>\n> 두 번째 문단"],
    ["English list fence", "1. Run:\n\n   ```sh\n   echo first\n\n   echo second\n   ```\n\n   Then continue.\n\n2. Finish"],
    ["Korean list fence", "1. 실행:\n\n   ```sh\n   echo 처음\n\n   echo 다음\n   ```\n\n   계속 진행.\n\n2. 완료"],
    ["English indented code", "    first\n\n    second"],
    ["Korean indented code", "    처음\n\n    다음"],
    ["English reference", "See [docs][d].\n\n[d]: https://example.com"],
    ["Korean reference", "[문서][d]를 보세요.\n\n[d]: https://example.com"],
  ])("renders %s like history while staged and after settling", async (_, text) => {
    localStorage.setItem("omb-reply-style", "paragraphs");
    const host = document.createElement("div");
    const history = document.createElement("div");
    const root = createRoot(host);
    const historyRoot = createRoot(history);
    try {
      await act(async () => historyRoot.render(createElement(ChatMarkdown, { text })));
      await act(async () => root.render(createElement(ChatMarkdown, { text, streaming: true, whole: text.length })));
      expect(host.innerHTML).toBe(history.innerHTML);
      const settled = `Intro.\n\n${text}\n\nDone.`;
      await act(async () => historyRoot.render(createElement(ChatMarkdown, { text: settled })));
      await act(async () => root.render(createElement(ChatMarkdown, { text: settled })));
      expect(host.innerHTML).toBe(history.innerHTML);
    } finally {
      await act(async () => { root.unmount(); historyRoot.unmount(); });
    }
  });
});

// whitespace between blocks aside
const markup = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text)).replace(/\s*(<[^>]+>)\s*/g, "$1");

const SPLITS: Array<[name: string, text: string, blocks: number]> = [
  ["a loose list", "Steps:\n\n1. First\n\n   More on first.\n\n2. Second\n\nDone.", 2],
  ["a fence with blank lines", "- a\n- b\n\n```js\nconst x = 1;\n\nconst y = 2;\n```\n\nAfter the code.", 3],
  ["a fence in a list item", "1. Install:\n   ```sh\n   npm i\n\n   npm test\n   ```\n\nThat's it.", 2],
  ["a closing fence outside its list", "1. Run:\n   ```sh\n   npm i\n```\n\nNot code?\n\nStill?", 1],
  ["an HTML block", "Intro\n\n<details>\n\nHidden\n\n</details>\n\nOutro", 2],
  ["a reference link", "See [the docs][d].\n\nMore.\n\n[d]: https://example.com", 1],
  ["headings, tables and quotes", "# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n\n> another\n\n***\n\nEnd", 6],
  ["indented code", "Para\n\n    code line\n\n    more code\n\nAfter", 2],
];

describe("streaming blocks", () => {
  it("leaves finished blocks untouched as a reply grows", () => {
    const settled = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} with **bold** words.`).join("\n\n");
    const before = streamBlocks(`${settled}\n\nThe tail`);
    const after = streamBlocks(`${settled}\n\nThe tail grows`);
    expect(before).toHaveLength(31);
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(after.at(-1)).toBe("The tail grows");
  });

  it.each(SPLITS)("splits %s only where each block renders as in the whole reply", (_, text, blocks) => {
    const split = streamBlocks(text);
    expect(split).toHaveLength(blocks);
    expect(split.join("")).toBe(text);
    expect(split.map(markup).join("")).toBe(markup(text));
  });
});

describe("streaming tail", () => {
  it.each([
    ["First I will **check the con", "First I will **check the con**"],
    ["make sure the `stag", "make sure the `stag`"],
    ["**bold `code", "**bold `code`**"],
    ["**check the config*", "**check the config**"],
    ["clean. Then **", "clean. Then "],
    ["the `staging` branch `", "the `staging` branch "],
    ["Done.\n\n- ", "Done.\n\n"],
    ["Done.\n2.", "Done.\n"],
    ["- **Run", "- **Run**"],
  ])("paints %j as %j", (tail, painted) => {
    expect(settleStreamTail(tail)).toBe(painted);
  });

  it.each([
    "First I will **check the config** and",
    "the `staging` branch",
    "- Check the env",
    "5 * 3 is fifteen",
    "an escaped \\*star",
    "```bash\necho `date` **",
    "Use *.ts files in the build",
    "2*3 equals six",
    "glob **/*.md",
    "use *args and **kwar",
    "Use `a*`",
    "Use `a*` and",
    "1",
    "42",
    "2026",
    "Done.\n2026",
    "Keep \\*",
    "type \\`",
    "````md\n```\n**not closed",
    "~~~\n```\n**not closed",
    "    indented **code",
    "\t**tabbed",
    "**first\nsecond",
  ])("leaves %j alone", (tail) => {
    expect(settleStreamTail(tail)).toBe(tail);
  });

  it("never paints styling the settled reply does not have", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const reply = "Use *.ts files, 2*3 equals six, glob **/*.md and `a*` here.\n\n2026\n\n```js\nconst x = 2 * 3; // **not bold**\n```\n\n    indented **code\n\nThen **check the config** and `staging`, then *done*.";
    const styled = () => [...host.querySelectorAll(".chat-md :is(em, strong, code)")].map((el) => [el.tagName, el.textContent ?? ""] as const);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: reply, streaming: false })));
      const settled = styled();
      for (let at = 1; at <= reply.length; at++) {
        await act(async () => root.render(createElement(ChatMarkdown, { text: reply.slice(0, at), streaming: true })));
        for (const [tag, text] of styled()) {
          expect.soft(settled.some(([t, full]) => t === tag && full.startsWith(text)), `${tag} ${JSON.stringify(text)} at ${at}`).toBe(true);
        }
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("never shows a raw marker or an empty bullet while a reply types out", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const reply = "First I will **check the config** and make sure the `staging` branch is clean.\n\n- Check the environment\n- Run the build";
    try {
      for (let at = 1; at <= reply.length; at++) {
        await act(async () => root.render(createElement(ChatMarkdown, { text: reply.slice(0, at), streaming: true })));
        const md = host.querySelector(".chat-md")!;
        expect.soft(md.textContent, reply.slice(0, at)).not.toMatch(/[*`]/);
        expect.soft([...md.querySelectorAll("li")].filter((li) => !li.textContent?.trim()), reply.slice(0, at)).toHaveLength(0);
      }
      await act(async () => root.render(createElement(ChatMarkdown, { text: reply, streaming: false })));
      expect(host.querySelector(".chat-md strong")?.textContent).toBe("check the config");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("ChatMarkdown first paragraph", () => {
  it("shows only what the finished paragraph shows, one character at a time", async () => {
    localStorage.setItem("omb-reply-style", "paragraphs");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const reply = "See [the docs](https://example.com/a_b) and ![cat](cat.png) for ~~old~~ _new_ steps, use `my_var` or **bold** <b>tag</b> now.";
    const rendered = async (text: string, streaming: boolean) => {
      await act(async () => root.render(createElement(ChatMarkdown, { text, streaming, whole: 0 })));
      return host.querySelector(".chat-md")?.textContent ?? "";
    };
    try {
      const final = await rendered(reply, false);
      for (let at = 1; at <= reply.length; at++) {
        const partial = await rendered(reply.slice(0, at), true);
        expect.soft(final.startsWith(partial), `${JSON.stringify(reply.slice(0, at))} -> ${JSON.stringify(partial)}`).toBe(true);
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      localStorage.setItem("omb-reply-style", "live");
    }
  });
});

describe("ChatMarkdown stray user tags", () => {
  it("renders a stored row with raw tags clean and keeps code literal", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { streaming: true, text: "<user1>Got it</user1> use `<user2>`\n\n```\n<user3>x</user3>\n```" })));
      const text = host.querySelector(".chat-md")?.textContent ?? "";
      expect(text).toContain("Got it use <user2>");
      expect(text).toContain("<user3>x</user3>");
      expect(text).not.toContain("<user1>");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

describe("relative file links", () => {
  it.each(["precision", "tui", "ledger"] as const)("does not measure file-only lines in %s", async (skin) => {
    applySkin(skin);
    const measure = vi.spyOn(HTMLElement.prototype, "toggleAttribute");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[a](/tmp/a.ts)", streaming: true })));
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[a](/tmp/a.ts) more", streaming: true })));
      expect(measure.mock.calls.filter(([name]) => name === "data-file-line")).toHaveLength(0);
      expect(host.querySelector("[data-file-line]")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      measure.mockRestore();
      applySkin("precision");
    }
  });

  it("updates a Terminal file line when only sibling text streams in", async () => {
    applySkin("terminal");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[a](/tmp/a.ts)", streaming: true })));
      const link = host.querySelector("[data-file-link]")!;
      expect(link.hasAttribute("data-file-line")).toBe(true);
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[a](/tmp/a.ts) more", streaming: true })));
      expect(host.querySelector("[data-file-link]")).toBe(link);
      expect(link.hasAttribute("data-file-line")).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      applySkin("precision");
    }
  });

  it("measures a file line only when its Terminal text or skin changes", async () => {
    applySkin("terminal");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      const props = { text: "[a](/tmp/a.ts)", streaming: true };
      await act(async () => root.render(createElement(ChatMarkdown, props)));
      const link = host.querySelector("[data-file-link]")!;
      const measure = vi.spyOn(link, "toggleAttribute");
      await act(async () => root.render(createElement(ChatMarkdown, { ...props, streaming: false })));
      expect(measure).not.toHaveBeenCalled();
      await act(async () => applySkin("precision"));
      expect(link.hasAttribute("data-file-line")).toBe(false);
      await act(async () => applySkin("terminal"));
      expect(host.querySelector("[data-file-link]")).toBe(link);
      expect(link.hasAttribute("data-file-line")).toBe(true);
      measure.mockRestore();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      applySkin("precision");
    }
  });

  it("resolves against a Windows base", () => {
    const base = "C:\\Users\\me\\proj";
    expect(resolveRelativePath("reps.py", base)).toBe("C:\\Users\\me\\proj\\reps.py");
    expect(resolveRelativePath("src/app.py", base)).toBe("C:\\Users\\me\\proj\\src\\app.py");
    expect(resolveRelativePath("./notes.md", base)).toBe("C:\\Users\\me\\proj\\notes.md");
    expect(resolveRelativePath("src\\..\\x.txt", base)).toBe("C:\\Users\\me\\proj\\x.txt");
    expect(resolveRelativePath("..\\x.txt", base)).toBeNull();
    expect(resolveRelativePath("../../../../x.txt", "C:/proj/")).toBeNull();
  });

  it("resolves against a POSIX base", () => {
    expect(resolveRelativePath("reps.py", "/home/me/proj")).toBe("/home/me/proj/reps.py");
    expect(resolveRelativePath("a/../b/./c.txt", "/home/me/proj/")).toBe("/home/me/proj/b/c.txt");
    expect(resolveRelativePath("..\\x.txt", "/home/me/proj")).toBeNull();
    expect(resolveRelativePath("../../../../x.txt", "/home/me")).toBeNull();
  });

  it("refuses a link that climbs out of the bot's folder", () => {
    const base = "C:\\Users\\audit\\.orbit\\workspaces\\bot-a";
    expect(resolveRelativePath("%2e%2e/bot-b/private.txt", base)).toBeNull();
    expect(resolveRelativePath("docs/%2E%2E/%2e%2e/bot-b/private.txt", base)).toBeNull();
    expect(resolveRelativePath("docs/%2e%2e/report.md", base)).toBe(`${base}\\report.md`);
  });

  it("decodes escapes and drops a fragment or query", () => {
    expect(resolveRelativePath("my%20file.py#L3", "/p")).toBe("/p/my file.py");
    expect(resolveRelativePath("a.py?x=1", "/p")).toBe("/p/a.py");
    expect(resolveRelativePath("100%.txt", "/p")).toBe("/p/100%.txt");
  });

  it("has nothing to open without a usable base or for #anchor and ?query", () => {
    expect(resolveRelativePath("reps.py")).toBeNull();
    expect(resolveRelativePath("reps.py", null)).toBeNull();
    expect(resolveRelativePath("reps.py", "relative/dir")).toBeNull();
    expect(resolveRelativePath("#top", "/p")).toBeNull();
    expect(resolveRelativePath("?q=1", "/p")).toBeNull();
  });

  it("treats only scheme-less targets as relative", () => {
    for (const href of ["reps.py", "src/app.py", "./notes.md", "..\\x.txt", "#top", "?q=1"]) {
      expect(isRelativeHref(href)).toBe(true);
    }
    for (const href of ["https://a.com", "http://a.com/x", "mailto:a@b.c", "file:///tmp/a", "C:foo"]) {
      expect(isRelativeHref(href)).toBe(false);
    }
  });

  it("renders file, plain and web links per base folder", async () => {
    const text = "[reps](reps.py) [win](..\\x.txt) [top](#top) [q](?q=1) [web](https://a.com) [abs](/tmp/a.py)";
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text, baseDir: "/home/me/proj" })));
      const buttons = [...host.querySelectorAll("button")].map((b) => b.getAttribute("title"));
      expect(buttons).toEqual([
        "/home/me/proj/reps.py",
        "/tmp/a.py",
      ]);
      expect([...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://a.com"]);
      expect(host.textContent).toContain("win top");

      await act(async () => root.render(createElement(ChatMarkdown, { text, baseDir: null })));
      expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["abs"]);
      expect([...host.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["https://a.com"]);
      expect(host.textContent).toContain("reps win top q");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("opens a file:// link with an escaped space instead of the app origin", async () => {
    const file = "C:/Users/you/OneDrive/Documents/Chat Downloads/Project_Draft_v2_EN.docx";
    const text =
      "[Project_Draft_v2_EN.docx](file:///C:/Users/you/OneDrive/Documents/Chat%20Downloads/Project_Draft_v2_EN.docx)";
    const openFile = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text })));
      expect(host.querySelector("a")).toBeNull();
      const button = host.querySelector("button") as HTMLButtonElement;
      expect(button?.getAttribute("title")).toBe(file);
      await act(async () => button.click());
      expect(openFile).toHaveBeenCalledWith(file, undefined);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });

  it("opens a markdown link to a backslash Windows path", async () => {
    const file = "C:\\Users\\you\\Desktop\\demo-app\\out\\clip.mp4";
    const openFile = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: `[clip.mp4](${file})` })));
      expect(host.querySelector("a")).toBeNull();
      const button = host.querySelector("button") as HTMLButtonElement;
      expect(button?.getAttribute("title")).toBe(file);
      await act(async () => button.click());
      expect(openFile).toHaveBeenCalledWith(file, undefined);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });

  it("opens an angle-bracketed Windows path with spaces", async () => {
    const file = "C:\\My Drive\\bots\\out\\clip (1).mp4";
    const openFile = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: `[clip.mp4](<${file}>)` })));
      expect(host.querySelector("a")).toBeNull();
      const button = host.querySelector("button") as HTMLButtonElement;
      expect(button?.getAttribute("title")).toBe(file);
      await act(async () => button.click());
      expect(openFile).toHaveBeenCalledWith(file, undefined);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });

  describe("Windows paths as written", () => {
    const open = async (text: string, streaming = false) => {
      const openFile = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(createElement(ChatMarkdown, { text, streaming })));
        for (const link of host.querySelectorAll<HTMLButtonElement>("[data-file-link]")) await act(async () => link.click());
        return { opened: openFile.mock.calls.map(([file]) => file), text: host.textContent };
      } finally {
        await act(async () => root.unmount());
        host.remove();
        Reflect.deleteProperty(window, "ogb");
      }
    };

    it("opens every backslash and punctuation pair with encoded URL delimiters, plain and in angle brackets", async () => {
      const files = [..."._-()[]#~!$&'+,;=@^`{}"].map((mark) => `C:\\Users\\me\\.orbit\\${mark}x\\clip.mp4`).concat("C:\\.hidden\\x.txt");
      const text = files.map((file) => {
        const href = file.replaceAll("#", "%23");
        return `[a](${href}) [b](<${href}>)`;
      }).join("\n\n");
      expect((await open(text)).opened).toEqual(files.flatMap((file) => [file, file]));
    });

    it("keeps the target apart from its title", async () => {
      const file = "C:\\Users\\me\\.orbit\\clip.mp4";
      expect((await open(`[a](${file} "title") [b](<${file}> 'title')`)).opened).toEqual([file, file]);
    });

    it("keeps the target while a reply streams", async () => {
      const file = "C:\\Users\\me\\.orbit\\workspaces\\b\\clip.mp4";
      expect((await open(`Done.\n\n[clip.mp4](${file})`, true)).opened).toEqual([file]);
    });

    it("never rewrites a link in code", async () => {
      const link = "[a](C:\\x\\.y.txt)";
      const shown = await open(`\`${link}\`\n\n\`\`\`\n${link}\n\`\`\``);
      expect(shown.opened).toEqual([]);
      expect(shown.text?.split(link)).toHaveLength(3);
    });

    it("asks the phone route for the path as written", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0]), { status: 206 })));
      const file = "C:\\Users\\me\\.orbit\\workspaces\\b\\clip.mp4";
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(createElement(ChatMarkdown, { text: `[clip.mp4](${file})`, threadId: "t1" })));
        await act(async () => {
          await vi.waitFor(() => {
            expect(host.querySelector("video")).not.toBeNull();
          });
        });
        expect(host.querySelector("video")?.getAttribute("src")).toBe(`/api/threads/t1/linked-file?path=${encodeURIComponent(file)}`);
      } finally {
        await act(async () => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
      }
    });
  });

  it("renders a link whose target is stripped as plain text", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[bad](javascript:alert(1)) [empty]()" })));
      expect(host.querySelector("a")).toBeNull();
      expect(host.querySelector("button")).toBeNull();
      expect(host.textContent).toContain("bad empty");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("says why when the resolved file is missing", async () => {
    const openFile = vi.fn().mockRejectedValue(new Error("That file no longer exists"));
    Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[gone](gone.py)", baseDir: "/p" })));
      await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
      expect(openFile).toHaveBeenCalledWith("/p/gone.py", "/p");
      expect(host.textContent).toContain("That file no longer exists");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });

  it("tells a phone that files open in the desktop app", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[notes.md](C:/My%20Drive/notes.md)" })));
      await act(async () => host.querySelector("button")!.click());
      expect(host.textContent).toContain("Files open in the desktop app");
      expect(host.textContent).not.toContain("newer version");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  describe("link messages by language", () => {
    type Bridge = { openFile?: ReturnType<typeof vi.fn> };
    const clickLink = async (locale: "en" | "ko", ogb: Bridge | undefined, link: string) => {
      if (ogb) Object.defineProperty(window, "ogb", { configurable: true, value: ogb });
      applyLocale(locale);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(createElement(ChatMarkdown, { text: link })));
        await act(async () => host.querySelector("button")!.click());
        return host.querySelector("button")!.nextElementSibling?.textContent;
      } finally {
        await act(async () => root.unmount());
        host.remove();
        applyLocale("en");
        Reflect.deleteProperty(window, "ogb");
      }
    };
    const rejecting = (message: string) => ({ openFile: vi.fn().mockRejectedValue(new Error(message)) });

    it("shows a rejected folder link in Korean", async () => {
      const shown = await clickLink("ko", rejecting("That folder could not be opened"), "[shots](C:/Users/me/shots)");
      expect(shown).toBe("폴더를 열 수 없습니다");
    });

    it("shows a rejected file link in Korean", async () => {
      const shown = await clickLink("ko", rejecting("That file no longer exists"), "[notes.md](C:/My%20Drive/notes.md)");
      expect(shown).toBe("파일이 더 이상 없습니다");
    });

    it("tells a Korean phone that files open in the desktop app", async () => {
      const shown = await clickLink("ko", undefined, "[notes.md](C:/My%20Drive/notes.md)");
      expect(shown).toBe("파일은 데스크톱 앱에서 열 수 있습니다");
    });

    it("tells an older Korean desktop app to update", async () => {
      const shown = await clickLink("ko", {}, "[notes.md](C:/My%20Drive/notes.md)");
      expect(shown).toBe("파일을 열려면 데스크톱 앱을 최신 버전으로 업데이트해야 합니다");
    });

    it("keeps the English text in English", async () => {
      const shown = await clickLink("en", rejecting("That folder could not be opened"), "[shots](C:/Users/me/shots)");
      expect(shown).toBe("That folder could not be opened");
    });

    it("shows an unknown message as it came", async () => {
      const shown = await clickLink("ko", rejecting("EPERM: operation not permitted"), "[notes.md](C:/My%20Drive/notes.md)");
      expect(shown).toBe("EPERM: operation not permitted");
    });
  });

  it("asks an older desktop app without file opening to update", async () => {
    Object.defineProperty(window, "ogb", { configurable: true, value: {} });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[notes.md](C:/My%20Drive/notes.md)" })));
      await act(async () => host.querySelector("button")!.click());
      expect(host.textContent).toContain("Opening files needs a newer version of the desktop app");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
    }
  });

  describe("file link right-click", () => {
    const rightClick = async (ogb: object | undefined, text: string, baseDir?: string, then?: (host: HTMLElement) => Promise<void>) => {
      if (ogb) Object.defineProperty(window, "ogb", { configurable: true, value: ogb });
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(createElement(ChatMarkdown, { text, baseDir })));
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
        await act(async () => void host.querySelector("button")!.dispatchEvent(event));
        const items = [...document.querySelectorAll("[data-file-menu] [role=menuitem]")].map((item) => item.textContent);
        await then?.(host);
        return { prevented: event.defaultPrevented, text: host.textContent, items };
      } finally {
        await act(async () => root.unmount());
        host.remove();
        Reflect.deleteProperty(window, "ogb");
      }
    };
    const item = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("[data-file-menu] [role=menuitem]")].find((each) => each.textContent === name)!;

    it("opens the app menu with the native menu's actions and keeps the browser menu away", async () => {
      const fileMenu = vi.fn();
      const openFile = vi.fn().mockResolvedValue(undefined);
      const showInFolder = vi.fn().mockResolvedValue(undefined);
      const saveFile = vi.fn().mockResolvedValue(undefined);
      const localMediaFile = vi.fn().mockResolvedValue("/p/real/clip.mp4");
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const result = await rightClick({ fileMenu, openFile, showInFolder, saveFile, localMediaFile }, "[1080p](clip.mp4)", "/p", async () => {
        expect(localMediaFile).toHaveBeenCalledWith({ path: "/p/clip.mp4" });
        await act(async () => item("Show in folder").click());
        expect(showInFolder).toHaveBeenCalledWith("/p/clip.mp4", "/p");
        expect(document.querySelector("[data-file-menu]:not([data-closing])")).toBeNull();
        await act(async () => void document.querySelector<HTMLElement>("[data-file-link]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
        await act(async () => item("Save as").click());
        expect(saveFile).toHaveBeenCalledWith("/p/real/clip.mp4");
        await act(async () => void document.querySelector<HTMLElement>("[data-file-link]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1 })));
        await act(async () => item("Copy path").click());
        expect(writeText).toHaveBeenCalledWith("/p/real/clip.mp4");
        await act(async () => void document.querySelector<HTMLElement>("[data-file-link]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 2 })));
        await act(async () => item("Open").click());
        expect(openFile).toHaveBeenCalledWith("/p/clip.mp4", "/p");
      });
      vi.unstubAllGlobals();
      expect(result.items).toEqual(["Open", "Show in folder", "Save as", "Copy path"]);
      expect(fileMenu).not.toHaveBeenCalled();
      expect(result.prevented).toBe(true);
    });

    it("offers no Save as and copies the link's own path when it resolves outside the bot's folder", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const result = await rightClick({ openFile: vi.fn(), showInFolder: vi.fn(), saveFile: vi.fn(), localMediaFile: vi.fn().mockResolvedValue("/elsewhere/secret.py") }, "[report](report.py)", "/p", async () => {
        await act(async () => item("Copy path").click());
      });
      vi.unstubAllGlobals();
      expect(result.items).toEqual(["Open", "Show in folder", "Copy path"]);
      expect(writeText).toHaveBeenCalledWith("/p/report.py");
    });

    it("leaves the default menu alone without the bridge", async () => {
      expect((await rightClick(undefined, "[notes](C:/My%20Drive/notes.md)")).prevented).toBe(false);
      const older = await rightClick({ fileMenu: vi.fn() }, "[notes](C:/My%20Drive/notes.md)");
      expect(older.prevented).toBe(false);
    });

    it("offers no Save as for a folder or a missing file, and says why Show in folder failed", async () => {
      const showInFolder = vi.fn().mockRejectedValue(new Error("That file no longer exists"));
      const result = await rightClick({ openFile: vi.fn(), showInFolder, saveFile: vi.fn(), localMediaFile: vi.fn().mockResolvedValue(null) }, "[gone](gone.py)", "/p", async (host) => {
        await act(async () => item("Show in folder").click());
        expect(host.textContent).toContain("That file no longer exists");
      });
      expect(result.prevented).toBe(true);
      expect(result.items).toEqual(["Open", "Show in folder", "Copy path"]);
    });
  });

  it.each([
    ["en", "This file is outside the bot's folder, so it can't open here."],
    ["ko", "이 파일은 봇 폴더 밖에 있어서 여기서는 열 수 없어요."],
  ] as const)("explains an outside-folder refusal in %s without a desktop bridge", async (locale, message) => {
    applyLocale(locale);
    const fetchFile = vi.fn(async () => new Response(JSON.stringify({ error: "not found", reason: "outside" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchFile);
    const host = document.createElement("div");
    const root = createRoot(host);
    const file = "C:\\Users\\alice\\Desktop\\donecheck-demo.mp4";
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: `[donecheck-demo.mp4](<${file}>)`, threadId: "t1" })));
      expect(host.textContent).toContain(message);
      expect(host.textContent).toContain("donecheck-demo.mp4");
      const refusal = host.querySelector('[data-file-unavailable="outside"]')!;
      expect(refusal.firstElementChild?.textContent).toBe("donecheck-demo.mp4");
      expect(refusal.lastElementChild?.textContent).toBe(message);
      expect(host.querySelector("button, a, video")).toBeNull();
      expect(fetchFile).toHaveBeenCalledTimes(1);
      expect(fetchFile).toHaveBeenCalledWith(`/api/threads/t1/linked-file?path=${encodeURIComponent(file)}`, { headers: { Range: "bytes=0-0" } });
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
      applyLocale("en");
    }
  });

  it("waits to play a video and shows a pdf in the pane", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0]), { status: 206 })));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const text = "[clip.mp4](C:/clips/clip.mp4)\n\n[notes.pdf](C:/clips/notes.pdf)";
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text, threadId: "t1" })));
      await act(async () => {
        await vi.waitFor(() => {
          expect(host.querySelector("video")).not.toBeNull();
        });
      });
      const video = host.querySelector("video")!;
      expect(video.hasAttribute("autoplay")).toBe(false);
      expect(video.muted).toBe(false);
      expect(video.getAttribute("preload")).toBe("metadata");
      const pdf = host.querySelector<HTMLButtonElement>("[data-show-card]")!;
      expect(pdf.textContent).toContain("notes.pdf");
      await act(async () => pdf.click());
      expect(pdf.hasAttribute("data-showing")).toBe(true);
      expect(host.querySelector("iframe")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it("hands focus back to a scrubbed video so Space plays and pauses it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0]), { status: 206 })));
    const host = document.createElement("div");
    const composer = document.createElement("textarea");
    document.body.append(host, composer);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[clip.mp4](C:/clips/clip.mp4)", threadId: "t1" })));
      await act(async () => {
        await vi.waitFor(() => {
          expect(host.querySelector("video")).not.toBeNull();
        });
      });
      const video = host.querySelector("video")!;
      const blurred = vi.fn();
      video.addEventListener("blur", blurred);
      video.setAttribute("tabindex", "0");
      video.focus();
      await act(async () => { video.dispatchEvent(new Event("seeked")); });
      expect(blurred).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(video);
      composer.focus();
      blurred.mockClear();
      await act(async () => { video.dispatchEvent(new Event("seeked")); });
      expect(blurred).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(composer);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      composer.remove();
      vi.unstubAllGlobals();
    }
  });

  describe("phone video full screen", () => {
    let host: HTMLDivElement;
    let root: Root;
    let shown: Element | null;
    let layers: WindowEventMap["orbit:back-layer"][];
    const record = (event: WindowEventMap["orbit:back-layer"]) => layers.push(event);
    const setFullscreen = (element: Element | null) => {
      shown = element;
      document.dispatchEvent(new Event("fullscreenchange"));
    };

    async function mount(touch = true, supported = true) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0]), { status: 206 })));
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: touch && query === "(pointer: coarse)", addEventListener() {}, removeEventListener() {} }));
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: supported });
      Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => shown });
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
        configurable: true,
        value: supported ? vi.fn(async function (this: Element) { setFullscreen(this); }) : undefined,
      });
      document.exitFullscreen = vi.fn(async () => setFullscreen(null));
      await act(async () => root.render(createElement(ChatMarkdown, { text: "[clip.mp4](C:/clips/clip.mp4)", threadId: "t1" })));
      await act(async () => {
        await vi.waitFor(() => {
          expect(host.querySelector("video")).not.toBeNull();
        });
      });
    }
    const button = () => host.querySelector<HTMLButtonElement>("[data-phone-video-fullscreen]");

    beforeEach(() => {
      shown = null;
      layers = [];
      window.addEventListener("orbit:back-layer", record);
      host = document.body.appendChild(document.createElement("div"));
      root = createRoot(host);
    });

    afterEach(async () => {
      await act(async () => root.unmount());
      host.remove();
      window.removeEventListener("orbit:back-layer", record);
      Reflect.deleteProperty(document, "fullscreenEnabled");
      Reflect.deleteProperty(document, "fullscreenElement");
      Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
      Reflect.deleteProperty(document, "exitFullscreen");
      vi.unstubAllGlobals();
      applyLocale("en");
    });

    it("puts the wrapper holding the same video into full screen and turns the browser button off", async () => {
      await mount();
      const video = host.querySelector("video")!;
      const play = vi.spyOn(video, "play");
      const pause = vi.spyOn(video, "pause");
      expect(video.getAttribute("controlslist")).toBe("nofullscreen");
      expect(video.className).toContain("[&::-webkit-media-controls-fullscreen-button]:hidden");
      await act(async () => button()!.click());
      expect(shown).toBe(video.parentElement);
      expect(shown).not.toBe(video);
      expect(host.querySelector("video")).toBe(video);
      expect(button()!.getAttribute("aria-label")).toBe("Exit full screen");
      expect(play).not.toHaveBeenCalled();
      expect(pause).not.toHaveBeenCalled();
      expect(video.className).toContain("object-contain");
      expect(video.className).toContain("[&::-webkit-media-controls-fullscreen-button]:hidden");
    });

    it("exits with the same button and keeps the video element", async () => {
      await mount();
      const video = host.querySelector("video")!;
      await act(async () => button()!.click());
      await act(async () => button()!.click());
      expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
      expect(shown).toBeNull();
      expect(host.querySelector("video")).toBe(video);
      expect(button()!.getAttribute("aria-label")).toBe("Full screen");
    });

    it("focuses the video on entry so the browser shows its controls", async () => {
      await mount();
      const video = host.querySelector("video")!;
      video.setAttribute("tabindex", "0");
      expect(document.activeElement).not.toBe(video);
      await act(async () => button()!.click());
      expect(document.activeElement).toBe(video);
    });

    it("lets phone Back leave full screen first", async () => {
      await mount();
      expect(layers).toHaveLength(0);
      await act(async () => button()!.click());
      const layer = layers.at(-1)!;
      expect(layer.detail.close).toBeTypeOf("function");
      await act(async () => layer.detail.close!());
      expect(shown).toBeNull();
      expect(layers.at(-1)!.detail.close).toBeUndefined();
    });

    it("drops the Back layer when the browser leaves full screen itself", async () => {
      await mount();
      await act(async () => button()!.click());
      await act(async () => setFullscreen(null));
      expect(layers.at(-1)!.detail.close).toBeUndefined();
      expect(button()!.getAttribute("aria-label")).toBe("Full screen");
    });

    it("ignores another element's full screen", async () => {
      await mount();
      await act(async () => setFullscreen(document.body));
      expect(button()!.getAttribute("aria-label")).toBe("Full screen");
      expect(layers).toHaveLength(0);
    });

    it("names the button in Korean with a real icon", async () => {
      applyLocale("ko");
      await mount();
      expect(button()!.getAttribute("aria-label")).toBe("전체 화면");
      expect(button()!.title).toBe("전체 화면");
      expect(button()!.querySelector("svg")).not.toBeNull();
      expect(button()!.textContent).toBe("");
      await act(async () => button()!.click());
      expect(button()!.getAttribute("aria-label")).toBe("전체 화면 종료");
    });

    it("sizes the touch target and keeps it off the seek bar", async () => {
      await mount();
      const classes = button()!.className;
      expect(classes).toContain("h-11");
      expect(classes).toContain("w-11");
      expect(classes).toContain("bottom-14");
    });

    it.each([
      ["a mouse pointer", true, false],
      ["no element full screen", false, true],
    ] as const)("renders the plain video with %s", async (_, supported, touch) => {
      await mount(touch, supported);
      expect(button()).toBeNull();
      const video = host.querySelector("video")!;
      expect(video.hasAttribute("controlslist")).toBe(false);
      expect(video.className).not.toContain("[&::-webkit-media-controls-fullscreen-button]:hidden");
      expect(video.parentElement!.tagName).not.toBe("SPAN");
    });
  });

  describe("show cards", () => {
    const text = ["signups.png", "launch-deck.pdf", "sync-flow.html", "notes.md", "report.docx"].map((name) => `[${name}](C:\\w\\${name})`).join("\n\n");
    let host: HTMLElement;
    let root: Root;
    const cards = () => [...host.querySelectorAll<HTMLButtonElement>("[data-show-card]")];
    beforeEach(async () => {
      Object.defineProperty(window, "ogb", { configurable: true, value: { openFile: vi.fn() } });
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0]), { status: 206 })));
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
      await act(async () => root.render(createElement(ChatMarkdown, { text, threadId: "t1" })));
    });
    afterEach(async () => {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
      vi.unstubAllGlobals();
      applyLocale("en");
    });

    it("turns image, PDF, web page and document links into cards, the showable ones with the panel icon", () => {
      expect(cards().map((card) => card.textContent)).toEqual(["signups.pngImage", "launch-deck.pdfPDF", "sync-flow.htmlWeb page", "report.docxDOCX"]);
      expect(cards().map((card) => Boolean(card.querySelector("[data-show-icon]")))).toEqual([true, true, true, false]);
      expect(host.querySelector("[data-file-link]")?.textContent).toBe("notes.md");
    });

    it("opens a document card in its default app", async () => {
      await act(async () => cards()[3]!.click());
      expect(window.ogb!.openFile).toHaveBeenCalledWith("C:\\w\\report.docx", undefined);
      expect(cards()[3]!.hasAttribute("data-showing")).toBe(false);
    });

    it("drops the parentheses a bot wraps around a card", async () => {
      const wrapped = "- **PDF:**\n  `C:\\w\\a.pdf`\n  ([a.pdf](<C:\\w\\a.pdf>))\n- see (the [notes](C:\\w\\notes.md))";
      await act(async () => root.render(createElement(ChatMarkdown, { key: "wrapped", text: wrapped, threadId: "t1" })));
      const item = host.querySelector("li")!;
      expect(item.querySelector("[data-show-card]")).not.toBeNull();
      expect(item.textContent).not.toMatch(/[()]/);
      expect(host.querySelectorAll("li")[1]!.textContent).toBe("see (the notes)");
    });

    it("lights the showing card and a tap shows it again after a close", async () => {
      await act(async () => showItem({ threadId: "t1", path: "C:\\w\\sync-flow.html", kind: "page" }));
      expect(cards().map((card) => card.hasAttribute("data-showing"))).toEqual([false, false, true, false]);
      await act(async () => closeShow());
      expect(cards().some((card) => card.hasAttribute("data-showing"))).toBe(false);
      await act(async () => cards()[2]!.click());
      expect(cards()[2]!.hasAttribute("data-showing")).toBe(true);
      expect(cards()[2]!.getAttribute("aria-pressed")).toBe("true");
    });

    it("names the kinds in Korean", async () => {
      applyLocale("ko");
      await act(async () => root.render(createElement(ChatMarkdown, { key: "ko", text, threadId: "t1" })));
      expect(cards().map((card) => card.textContent)).toEqual(["signups.png이미지", "launch-deck.pdfPDF", "sync-flow.html웹 페이지", "report.docxDOCX"]);
    });
  });

  describe("files named in a sentence", () => {
    const sentences = "Updated [test.txt](C:\\w\\test.txt) to say test4.\n\nGenerated a dog image: [the dog](C:\\w\\dog.png).\n\nSaved to [dog.png](C:\\w\\dog.png).";
    const read = ["Updated test.txt to say test4.", "Generated a dog image: the dog.", "Saved to dog.png."];
    let host: HTMLElement;
    let root: Root;
    const links = () => [...host.querySelectorAll<HTMLButtonElement>("[data-file-link]")];
    const cards = () => [...host.querySelectorAll<HTMLButtonElement>("[data-show-card]")];
    const lines = () => [...host.querySelectorAll("p")].map((line) => line.textContent);
    const mount = (text: string, pictured = false) => act(async () => root.render(createElement(ChatMarkdown, { text, threadId: "t1", pictured })));
    const desktop = () => Object.defineProperty(window, "ogb", { configurable: true, value: { openFile: vi.fn() } });
    const phoneFiles = () => act(async () => {
      await vi.waitFor(() => expect(host.querySelector("[data-show-card], [data-phone-media], [data-file-link]")).not.toBeNull());
    });
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0]), { status: 206 })));
      host = document.createElement("div");
      document.body.append(host);
      root = createRoot(host);
    });
    afterEach(async () => {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
      vi.unstubAllGlobals();
    });

    it("draws a file named in a sentence as the plain file link, with no box, icon or thumbnail", async () => {
      desktop();
      await mount(`${sentences}\n\nNotes: [notes.md](C:\\w\\notes.md)`);
      expect(lines()).toEqual([...read, "Notes: notes.md"]);
      expect(links().map((link) => link.textContent)).toEqual(["test.txt", "the dog", "dog.png", "notes.md"]);
      expect(new Set(links().map((link) => link.className)).size).toBe(1);
      expect(links()[0]!.className).toContain("underline");
      expect(cards()).toHaveLength(0);
      expect(host.querySelector("img, svg")).toBeNull();
    });

    it("keeps the card for a file on its own line", async () => {
      desktop();
      await mount("Here it is:\n[dog.png](C:\\w\\dog.png)\n\n- [a.pdf](C:\\w\\a.pdf)\n- Report: [d.pdf](C:\\w\\d.pdf)\n\n**[b.pdf](C:\\w\\b.pdf)**");
      expect(cards().map((card) => card.textContent)).toEqual(["dog.pngImage", "a.pdfPDF", "b.pdfPDF"]);
      expect(links().map((link) => link.textContent)).toEqual(["d.pdf"]);
    });

    it("opens a sentence link's file in the pane, a text file too", async () => {
      desktop();
      await mount(sentences);
      await act(async () => links()[0]!.click());
      expect(lastShown("t1")).toEqual({ threadId: "t1", path: "C:\\w\\test.txt", kind: "text" });
      await act(async () => links()[1]!.click());
      expect(lastShown("t1")).toEqual({ threadId: "t1", path: "C:\\w\\dog.png", kind: "image" });
      expect(window.ogb!.openFile).not.toHaveBeenCalled();
    });

    it("opens a sentence link the pane can't show in its default app, and keeps the file menu", async () => {
      desktop();
      await mount("Wrote [the report](C:\\w\\report.docx) for you.");
      await act(async () => links()[0]!.click());
      expect(window.ogb!.openFile).toHaveBeenCalledWith("C:\\w\\report.docx", undefined);
      await act(async () => void links()[0]!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
      expect(document.querySelector("[data-file-menu]")).not.toBeNull();
    });

    it("draws no second picture for a file the reply already showed", async () => {
      desktop();
      await mount("Generated a dog image: [dog.png](C:\\w\\dog.png).\n\n[dog.png](C:\\w\\dog.png)", true);
      expect(links().map((link) => link.textContent)).toEqual(["dog.png"]);
      expect(cards().map((card) => card.textContent)).toEqual(["dog.pngImage"]);
      expect(host.querySelector("img")).toBeNull();
      await act(async () => cards()[0]!.click());
      expect(cards()[0]!.hasAttribute("data-showing")).toBe(true);
    });

    it("draws the same plain link on a phone, and a tap shows the file in the pane", async () => {
      await mount(sentences);
      await phoneFiles();
      expect(lines()).toEqual(read);
      expect(links().map((link) => link.textContent)).toEqual(["test.txt", "the dog", "dog.png"]);
      expect(links()[0]!.className).toContain("underline");
      expect(cards()).toHaveLength(0);
      expect(host.querySelector("img, svg, [data-phone-media]")).toBeNull();
      await act(async () => links()[0]!.click());
      expect(lastShown("t1")).toEqual({ threadId: "t1", path: "C:\\w\\test.txt", kind: "text" });
      await act(async () => links()[1]!.click());
      expect(lastShown("t1")).toEqual({ threadId: "t1", path: "C:\\w\\dog.png", kind: "image" });
    });

    it("saves a sentence link the pane can't show on a phone", async () => {
      const saved: [string | null, string | null][] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push([this.getAttribute("href"), this.getAttribute("download")]); });
      await mount("Wrote [the report](C:\\w\\report.docx) for you.");
      await phoneFiles();
      await act(async () => links()[0]!.click());
      expect(saved).toEqual([["/api/threads/t1/linked-file?path=C%3A%5Cw%5Creport.docx", "report.docx"]]);
      vi.restoreAllMocks();
    });

    it("draws no second picture on a phone either", async () => {
      await mount("[dog.png](C:\\w\\dog.png)", true);
      await phoneFiles();
      expect(cards().map((card) => card.textContent)).toEqual(["dog.pngImage"]);
      expect(host.querySelector("img")).toBeNull();
    });
  });

  it.each(["zip", "docx"])("saves a linked %s card from an authenticated browser without the desktop bridge", async (ext) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 206 })));
    const saved: [string | null, string | null][] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push([this.getAttribute("href"), this.getAttribute("download")]); });
    const host = document.createElement("div");
    const root = createRoot(host);
    const file = `C:/Users/alice/Desktop/file.${ext}`;
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: `([file](${file}))`, threadId: "t1" })));
      const card = host.querySelector<HTMLButtonElement>("[data-show-card]")!;
      expect(card.textContent).toBe(`file.${ext}${ext.toUpperCase()}`);
      expect(host.textContent).not.toMatch(/[()]/);
      await act(async () => card.click());
      expect(saved).toEqual([[`/api/threads/t1/linked-file?path=${encodeURIComponent(file)}`, `file.${ext}`]]);
    } finally {
      await act(async () => root.unmount());
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("shows a linked txt card in the pane from a browser without the desktop bridge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 206 })));
    const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const host = document.createElement("div");
    const root = createRoot(host);
    const file = "C:/Users/alice/Desktop/file.txt";
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: `([file](${file}))`, threadId: "t1" })));
      const card = host.querySelector<HTMLButtonElement>("[data-show-card]")!;
      expect(card.textContent).toBe("file.txtTXT");
      expect(card.querySelector("[data-show-icon]")).not.toBeNull();
      await act(async () => card.click());
      expect(lastShown("t1")).toEqual({ threadId: "t1", path: file, kind: "text" });
      expect(download).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("opens a linked md from an authenticated browser without the desktop bridge", async () => {
    const ext = "md";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 206 })));
    const host = document.createElement("div");
    const root = createRoot(host);
    const file = `C:/clips/file.${ext}`;
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: `[file](${file})`, threadId: "t1" })));
      const link = host.querySelector("a")!;
      expect(link).not.toBeNull();
      expect(link.getAttribute("href")).toBe(`/api/threads/t1/linked-file?path=${encodeURIComponent(file)}`);
      expect(link.hasAttribute("download")).toBe(true);
      expect(host.textContent).not.toContain("Files open in the desktop app");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("opens a remote image in the existing viewer and shows a desktop image link in the pane", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 206 })));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const text = "[picture](C:/clips/picture.png)";
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text, threadId: "t1" })));
      expect(host.querySelector('[data-phone-media="image"]')).not.toBeNull();
      await act(async () => host.querySelector("button")!.click());
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      const openFile = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
      await act(async () => root.render(createElement(ChatMarkdown, { key: "local", text, threadId: "t1" })));
      await act(async () => host.querySelector<HTMLButtonElement>("[data-show-card]")!.click());
      expect(host.querySelector("[data-show-card]")!.hasAttribute("data-showing")).toBe(true);
      expect(openFile).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.deleteProperty(window, "ogb");
      vi.unstubAllGlobals();
    }
  });

  it.each([["unlisted-folder", 404, false], ["empty.py", 416, true]] as const)("keeps the behavior for %s", async (name, status, download) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status, headers: { "content-range": "bytes */0" } })));
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, { text: `[file](C:/clips/${name})`, threadId: "t1" })));
      expect(Boolean(host.querySelector("a[download]"))).toBe(download);
      if (!download) {
        await act(async () => host.querySelector("button")!.click());
        expect(host.textContent).toContain("Files open in the desktop app");
      }
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  describe("a folder link", () => {
    const folder = "C:/Users/홍길동/Desktop/showcase-1111";
    const files = [
      { name: "2026-11-11 쇼케이스 최종 발표 자료 (수정본).html", path: `${folder}/2026-11-11 쇼케이스 최종 발표 자료 (수정본).html`, size: 48_213 },
      { name: "hero-shot.png", path: `${folder}/hero-shot.png`, size: 1_532_001 },
      { name: "notes.txt", path: `${folder}/notes.txt`, size: 812 },
    ];
    const mount = async (locale: "en" | "ko" = "en", listed = files, link = folder, more = 7) => {
      applyLocale(locale);
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("/linked-folder?")
        ? new Response(JSON.stringify({ files: listed, more }), { headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      await act(async () => root.render(createElement(ChatMarkdown, { text: `[showcase-1111](${link})`, threadId: "t1" })));
      await act(async () => host.querySelector("button")!.click());
      return { host, root };
    };
    const src = (path: string) => `/api/threads/t1/linked-file?path=${encodeURIComponent(path)}`;
    afterEach(() => {
      document.body.replaceChildren();
      applyLocale("en");
      Reflect.deleteProperty(window, "ogb");
      vi.unstubAllGlobals();
    });

    it("a remote folder link lists its files", async () => {
      const { root } = await mount();
      try {
        expect(fetch).toHaveBeenCalledWith(`/api/threads/t1/linked-folder?path=${encodeURIComponent(folder)}`);
        const sheet = document.querySelector('[role="dialog"][data-linked-folder]')!;
        expect(sheet.querySelector("h2")!.textContent).toBe("showcase-1111");
        expect([...sheet.querySelectorAll("[data-folder-file]")].map((row) => row.textContent)).toEqual([
          `${files[0]!.name}47.1 KB`, `${files[2]!.name}812 B`,
        ]);
        expect(sheet.textContent).toContain("7 more files");
        const [page, notes] = [...sheet.querySelectorAll<HTMLElement>("[data-folder-file]")];
        expect([page!.getAttribute("href"), page!.getAttribute("target")]).toEqual([src(files[0]!.path), "_blank"]);
        expect([notes!.getAttribute("href"), notes!.hasAttribute("download")]).toEqual([src(files[2]!.path), true]);
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("images show as a grid", async () => {
      const photos = ["IMG_20261111_093012.jpg", "DSC04417.png", "sunset-over-han-river.webp"].map((name) => ({ name, path: `${folder}/${name}`, size: 2_000_000 }));
      const { root } = await mount("en", [files[0]!, photos[0]!, files[2]!, photos[1]!, photos[2]!]);
      try {
        const sheet = document.querySelector('[role="dialog"][data-linked-folder]')!;
        const grid = sheet.querySelector("[data-folder-grid]")!;
        expect(grid.compareDocumentPosition(sheet.querySelector("[data-folder-file]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        const tiles = [...grid.querySelectorAll("button")];
        expect(tiles.map((tile) => [tile.title, tile.querySelector("img")?.getAttribute("src"), tile.querySelector("img")?.getAttribute("loading")]))
          .toEqual(photos.map((photo) => [photo.name, src(photo.path), "lazy"]));
        expect(tiles[0]!.textContent).toBe("");
        expect(tiles[0]!.getAttribute("aria-label")).toBe(`Open Image ${photos[0]!.name}`);
        expect(sheet.querySelectorAll("[data-folder-file]")).toHaveLength(2);
        await act(async () => tiles[1]!.click());
        expect(document.querySelector("[data-media-viewer] img")?.getAttribute("src")).toBe(src(photos[1]!.path));
      } finally {
        await act(async () => root.unmount());
      }
      const plain = await mount("en", [files[0]!, files[2]!]);
      try {
        expect(document.querySelector("[data-folder-grid]")).toBeNull();
      } finally {
        await act(async () => plain.root.unmount());
      }
    });

    it.each([["en", "Download notes.txt"], ["ko", "notes.txt 다운로드"]] as const)("file rows have a download button in %s", async (locale, label) => {
      const { root } = await mount(locale);
      try {
        const sheet = document.querySelector('[role="dialog"][data-linked-folder]')!;
        const saves = [...sheet.querySelectorAll<HTMLAnchorElement>("a[data-folder-download]")];
        expect(saves.map((save) => [save.getAttribute("href"), save.getAttribute("download")])).toEqual([files[0]!, files[2]!].map((file) => [src(file.path), file.name]));
        expect(saves[1]!.getAttribute("aria-label")).toBe(label);
        expect(saves[1]!.querySelector("svg")).not.toBeNull();
      } finally {
        await act(async () => root.unmount());
      }
    });

    it.each([["en", "1 more file"], ["ko", "파일 1개가 더 있어요"]] as const)("says one more file in %s", async (locale, line) => {
      const { root } = await mount(locale, files, folder, 1);
      try {
        expect(document.querySelector("[data-linked-folder] p")?.textContent).toBe(line);
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("lists a folder once for a double tap", async () => {
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input).includes("/linked-folder?")
        ? new Response(JSON.stringify({ files, more: 0 }))
        : new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(createElement(ChatMarkdown, { text: `[showcase-1111](${folder})`, threadId: "t1" })));
        await act(async () => {
          host.querySelector("button")!.click();
          host.querySelector("button")!.click();
        });
        expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes("/linked-folder?"))).toHaveLength(1);
        expect(document.querySelectorAll("[data-linked-folder]")).toHaveLength(1);
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("a backslash folder link in angle brackets opens too", async () => {
      const windows = String.raw`C:\Users\alice\Desktop\projects\showcase-1111`;
      const { root } = await mount("en", files, `<${windows}>`);
      try {
        expect(fetch).toHaveBeenCalledWith(`/api/threads/t1/linked-folder?path=${encodeURIComponent(windows)}`);
        expect(document.querySelector("[data-linked-folder] h2")?.textContent).toBe("showcase-1111");
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("names the sheet in Korean", async () => {
      const { root } = await mount("ko");
      try {
        const sheet = document.querySelector('[role="dialog"][data-linked-folder]')!;
        expect(sheet.textContent).toContain("파일 7개가 더 있어요");
        expect(sheet.querySelector("button[aria-label]")!.getAttribute("aria-label")).toBe("폴더 닫기");
      } finally {
        await act(async () => root.unmount());
      }
    });

    it("desktop folder link still opens explorer", async () => {
      const openFile = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(window, "ogb", { configurable: true, value: { openFile } });
      vi.stubGlobal("fetch", vi.fn());
      const host = document.createElement("div");
      const root = createRoot(host);
      try {
        await act(async () => root.render(createElement(ChatMarkdown, { text: `[showcase-1111](${folder})`, threadId: "t1" })));
        await act(async () => host.querySelector("button")!.click());
        expect(openFile).toHaveBeenCalledWith(folder, undefined);
        expect(fetch).not.toHaveBeenCalled();
        expect(document.querySelector("[data-linked-folder]")).toBeNull();
      } finally {
        await act(async () => root.unmount());
      }
    });
  });

  it("keeps the file name beside Open on PC", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/devices")) {
        return new Response(JSON.stringify({
          devices: [{ deviceId: "home-pc", name: "Home", host: "home.example", current: false }],
        }), { headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ deviceId: "home-pc" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(ChatMarkdown, {
        text: "[clip.mp4](C:/clips/clip.mp4)",
        threadId: "t1",
      })));
      await act(async () => {
        await vi.waitFor(() => {
          expect(host.querySelector("[data-open-on-pc]")).not.toBeNull();
        });
      });
      expect(host.textContent).toContain("clip.mp4");
      expect(host.textContent).toContain("Open on Home");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  describe("a desktop link whose file is on another PC", () => {
    const file = "C:/Users/홍길동/문서/주간 보고서.docx";
    const missing = () => vi.fn().mockRejectedValue(new Error("That file no longer exists"));
    const invalid = () => vi.fn().mockRejectedValue(new Error("That file path is invalid"));
    const click = async (ogb: object | undefined, pc: { offline?: boolean; writer?: boolean; locale?: "en" | "ko"; pending?: boolean; link?: string } = {}) => {
      applyLocale(pc.locale ?? "en");
      if (ogb) Object.defineProperty(window, "ogb", { configurable: true, value: ogb });
      vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
        if (pc.pending) return new Promise<Response>(() => {});
        if (String(input).includes("/api/devices")) {
          return new Response(JSON.stringify({ devices: [{ deviceId: "home-pc", name: "Home", host: "home.example", current: false, offline: pc.offline === true }] }));
        }
        return new Response(JSON.stringify(pc.writer === false ? { error: "not found" } : { error: "not found", deviceId: "home-pc" }), { status: 404 });
      }));
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () => root.render(createElement(ChatMarkdown, { text: `[주간 보고서.docx](${pc.link ?? "C:/Users/홍길동/문서/주간%20보고서.docx"})`, threadId: "t1" })));
        await act(async () => host.querySelector("button")!.click());
        return host.querySelector("button")!.nextElementSibling?.textContent;
      } finally {
        await act(async () => root.unmount());
        host.remove();
        applyLocale("en");
        Reflect.deleteProperty(window, "ogb");
        vi.unstubAllGlobals();
      }
    };

    it("fetches it from the PC that wrote the link when that PC is on", async () => {
      const openPeerFile = vi.fn().mockResolvedValue(undefined);
      expect(await click({ openFile: missing(), openPeerFile }, { writer: false })).toBe("That file no longer exists");
      expect(openPeerFile).not.toHaveBeenCalled();
      expect(await click({ openFile: missing(), openPeerFile })).toBeUndefined();
      expect(openPeerFile).toHaveBeenCalledWith("home.example", "t1", file);
    });

    it.each([["en", "This file is on Home."], ["ko", "이 파일은 Home에 있어요."]] as const)("says which PC has it in %s when that PC is off", async (locale, line) => {
      const openPeerFile = vi.fn();
      expect(await click({ openFile: missing(), openPeerFile }, { offline: true, locale })).toBe(line);
      expect(openPeerFile).not.toHaveBeenCalled();
    });

    it("says which PC has it when the fetch fails or the desktop app is older", async () => {
      expect(await click({ openFile: missing(), openPeerFile: vi.fn().mockRejectedValue(new Error("That file could not be opened")) })).toBe("This file is on Home.");
      expect(await click({ openFile: missing() })).toBe("This file is on Home.");
    });

    it("runs the same check from a file card, and says why it can't open", async () => {
      const pdf = "C:/Users/a/report.pdf";
      const openPeerFile = vi.fn().mockResolvedValue(undefined);
      expect(await click({ openFile: missing(), openPeerFile }, { link: pdf })).toBeUndefined();
      expect(openPeerFile).toHaveBeenCalledWith("home.example", "t1", pdf);
      expect(await click({ openFile: missing(), openPeerFile: vi.fn() }, { link: pdf, offline: true })).toBe("This file is on Home.");
      expect(await click({ openFile: missing() }, { link: pdf, writer: false })).toBe("That file no longer exists");
    });

    it("keeps the reason that PC refused with", async () => {
      const openPeerFile = vi.fn().mockRejectedValue(new Error("That file is outside the bot's folder"));
      expect(await click({ openFile: missing(), openPeerFile })).toBe("That file is outside the bot's folder");
    });

    it("asks the PC that wrote a Windows path a Mac or Linux desktop calls invalid", async () => {
      const openPeerFile = vi.fn().mockResolvedValue(undefined);
      expect(await click({ openFile: invalid(), openPeerFile })).toBeUndefined();
      expect(openPeerFile).toHaveBeenCalledWith("home.example", "t1", file);
      expect(await click({ openFile: invalid(), openPeerFile: vi.fn() }, { offline: true })).toBe("This file is on Home.");
    });

    it("keeps a path invalid when no other PC wrote it or no PC may open it", async () => {
      const openPeerFile = vi.fn();
      expect(await click({ openFile: invalid(), openPeerFile }, { writer: false })).toBe("That file path is invalid");
      for (const link of ["C:/Users/a/notes.txt:secret", "//nas/share/notes.txt", "/C:/Users/a/notes.txt:secret"]) {
        expect(await click({ openFile: invalid(), openPeerFile }, { link }), link).toBe("That file path is invalid");
      }
      expect(openPeerFile).not.toHaveBeenCalled();
    });

    it.each([["en", "Checking this file..."], ["ko", "파일을 확인하는 중이에요..."]] as const)("answers a click in %s before the file check lands", async (locale, line) => {
      expect(await click(undefined, { pending: true, locale })).toBe(line);
    });
  });
});
