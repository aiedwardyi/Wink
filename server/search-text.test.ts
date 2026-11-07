import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "./config.ts";
import { closeMessageDb, insertMessage, messageDatabase, searchHaystack, searchMessages } from "./message-db.ts";
import { redactBotAuthored, type Message } from "./store.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "server/search-text.ts");
const scratch = join(tmpdir(), "search-text");
const dirs: string[] = [];
const message = (id: string, text: string, extra: Partial<Message> = {}): Message => ({ id, role: "user", kind: "text", at: 1, text, ...extra });
const load = () => import("./search-text.ts");
const activity = (id: string, tool: Message["tool"], extra: Partial<Message> = {}) => message(id, "", { kind: "activity", tool, ...extra });
const comm: Message["comm"] = { groupId: "pair", withBotId: "helper", withName: "Helper", withColor: "blue", peer: "reply" };
const fixtures: Array<{ row: Message; full: string; chips: string }> = [
  { row: message("text", "Mixed CASE 검사 🧠 e\u0301"), full: "Mixed CASE 검사 🧠 e\u0301", chips: "Mixed CASE 검사 🧠 e\u0301" },
  { row: message("literal", "100% _ \\ \" ' \u0000\t\r\n"), full: "100% _ \\ \" ' \u0000\t\r\n", chips: "100% _ \\ \" ' \u0000\t\r\n" },
  { row: activity("comm", { name: "Reply from @Helper" }, { comm, text: "검사 결과", from: { botId: "helper", name: "Helper", color: "blue" } }), full: "Reply from @Helper\n검사 결과", chips: "Reply from @Helper\n검사 결과" },
  { row: activity("ordinary-body", { name: "Read" }, { text: "not drawn" }), full: "Read", chips: "Read" },
  { row: activity("hidden", { name: "Read", summary: "notes", detail: { input: "notes.txt", outputHidden: true, output: ["hidden"] } }), full: "Read\nnotes", chips: "Read\nnotes" },
  { row: activity("bash", { name: "shell", detail: { input: "npm test", output: ["passed"] }, summary: "run tests" }), full: "shell\nnpm test\npassed", chips: "shell\nrun tests" },
  { row: activity("verb", { name: "app.ts", verb: "Edit", summary: "updated", detail: { input: "path.ts", diff: ["-old", "+new", "context"] } }), full: "app.ts\npath.ts\n- old\n+ new\ncontext", chips: "app.ts\nupdated" },
  { row: activity("diff-input", { name: "Read", summary: "summary", detail: { input: "extra input", diff: ["+line"] } }), full: "Read\nsummary\nextra input\n+ line", chips: "Read\nsummary" },
  { row: activity("diff-more", { name: "Read", summary: "summary", detail: { input: "extra input", diff: ["+line"], more: 2 } }), full: "Read\nsummary\n+ line", chips: "Read\nsummary" },
  { row: activity("failed-diff", { name: "Edit", ok: false, detail: { input: "app.ts", diff: ["+never drawn"] } }), full: "Edit\napp.ts", chips: "Edit" },
  { row: activity("failed-output", { name: "Edit", ok: false, detail: { input: "app.ts", output: ["+literal", "-literal"] } }), full: "Edit\napp.ts\n+literal\n-literal", chips: "Edit" },
  { row: activity("secret-path", { name: "Read", detail: { input: "C:\\work\\.ssh\\config", output: ["PrivateCanary987654321"] } }), full: "Read\nC:\\work\\.ssh\\config", chips: "Read" },
  { row: activity("secret-command", { name: "Bash", detail: { input: "printenv", output: ["PrivateCanary987654321"] } }), full: "Bash\nprintenv", chips: "Bash" },
  { row: activity("credential", { name: "Bash", detail: { input: "npm test", output: ["PASSWORD=PreviewCanary987654321"] } }), full: "Bash\nnpm test\nPASSWORD=«redacted 22 chars»", chips: "Bash" },
  { row: activity("controls", { name: "Read", detail: { output: ["\u001b[32mhello\u001b[0m\t한🧠\u0007\u202e"] } }), full: "Read\nhello 한🧠", chips: "Read" },
  { row: activity("line-cap", { name: "Read", detail: { output: ["one", "two", "three", "four"] } }), full: "Read\none\ntwo\nthree", chips: "Read" },
  { row: activity("char-cap", { name: "Read", detail: { output: ["x".repeat(100)] } }), full: `Read\n${"x".repeat(80)}`, chips: "Read" },
  { row: activity("input-cap", { name: "Bash", detail: { input: "x".repeat(150) } }), full: `Bash\n${"x".repeat(120)}`, chips: "Bash" },
  { row: activity("unicode-cap", { name: "Read", detail: { output: ["🧠".repeat(100)] } }), full: `Read\n${"🧠".repeat(60)}`, chips: "Read" },
  { row: activity("punctuation", { name: "Read", summary: "100% _ \\ \" ' e\u0301 검사 🧠" }), full: "Read\n100% _ \\ \" ' e\u0301 검사 🧠", chips: "Read\n100% _ \\ \" ' e\u0301 검사 🧠" },
  { row: activity("empty", undefined, { comm, text: "not shown" }), full: "", chips: "" },
];

afterEach(() => {
  closeMessageDb();
  for (const dir of dirs.splice(0)) {
    expect(dirname(resolve(dir))).toBe(resolve(scratch));
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("search text", () => {
  it.each(fixtures)("pins the baseline visible projection for $row.id", ({ row, full, chips }) => {
    const client = redactBotAuthored(row);
    expect(searchHaystack(client, false)).toBe(full);
    expect(searchHaystack(client, true)).toBe(chips);
  });

  it.each(fixtures)("preserves pure projection parity for $row.id", async ({ row }) => {
    const pure = await load();
    const client = redactBotAuthored(row);
    const before = JSON.stringify(row);
    for (const chips of [false, true]) {
      expect(pure.searchHaystack(client, chips)).toBe(searchHaystack(client, chips));
      expect(pure.searchText(row, chips) ?? "").toBe(searchHaystack(client, chips));
      if (row.kind === "activity") {
        expect(pure.activityHaystack(row.tool ? JSON.stringify(row.tool) : null, row.comm ? row.text ?? null : null, chips)).toBe(searchHaystack(client, chips));
      }
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("retains a two-character Korean candidate through encoded FTS", async () => {
    expect(existsSync(source), "pure gram entry point exists").toBe(true);
    const { messageSearchGrams, needleGrams } = await load();
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE VIRTUAL TABLE grams USING fts5(body, tokenize='ascii'); CREATE VIRTUAL TABLE tri USING fts5(body, tokenize='trigram')");
      db.prepare("INSERT INTO grams(rowid,body) VALUES(?,?)").run(1, messageSearchGrams(message("ko", "검사 결과")).join(" "));
      db.prepare("INSERT INTO tri(body) VALUES(?)").run("검사 결과");
      expect(db.prepare("SELECT rowid FROM tri WHERE tri MATCH ?").all("검사")).toEqual([]);
      expect(needleGrams("검사")).toEqual(["g00ac8000c0ac"]);
      expect(db.prepare("SELECT rowid FROM grams WHERE grams MATCH ?").all(needleGrams("검사").map((gram) => `"${gram}"`).join(" AND "))).toEqual([{ rowid: 1 }]);
    } finally {
      db.close();
    }
  });

  it("keeps the static relative-import closure free of runtime state", () => {
    expect(existsSync(source), "pure projection module exists").toBe(true);
    const visited = new Set<string>();
    const walk = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      expect(["config.ts", "store.ts", "message-db.ts", "index.ts"]).not.toContain(basename(file));
      const text = readFileSync(file, "utf8");
      const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      const importTime = (node: ts.Node) => {
        if (ts.isFunctionLike(node)) return;
        expect(ts.isCallExpression(node), `${file}: import-time call`).toBe(false);
        if (ts.isNewExpression(node)) expect(["Map", "Set"], file).toContain(node.expression.getText(parsed));
        ts.forEachChild(node, importTime);
      };
      for (const statement of parsed.statements) {
        if (ts.isVariableStatement(statement)) importTime(statement);
        else if (ts.isClassDeclaration(statement)) {
          expect(statement.heritageClauses, file).toBeUndefined();
          for (const member of statement.members) {
            expect(ts.isClassStaticBlockDeclaration(member), file).toBe(false);
            if (ts.isPropertyDeclaration(member)) importTime(member.initializer ?? member.name);
          }
        } else {
          expect(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isFunctionDeclaration(statement), file).toBe(true);
        }
      }
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
          if (clause?.isTypeOnly || (ts.isExportDeclaration(node) && node.isTypeOnly)) return;
          const bindings = clause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings) && !clause?.name && bindings.elements.every((item) => item.isTypeOnly)) return;
          if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((item) => item.isTypeOnly)) return;
          if (!node.moduleSpecifier) return;
          expect(ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
          const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
          if (specifier.startsWith(".")) walk(resolve(dirname(file), specifier));
          else expect(specifier, file).toBe("node:util");
        }
        if (ts.isIdentifier(node)) expect(["process", "globalThis", "global", "require", "eval", "Function"], file).not.toContain(node.text);
        if (ts.isCallExpression(node)) {
          expect(node.expression.kind, file).not.toBe(ts.SyntaxKind.ImportKeyword);
          expect(node.expression.getText(parsed), file).not.toMatch(/^(?:require|eval|Function)$/);
        }
        ts.forEachChild(node, visit);
      };
      visit(parsed);
    };
    walk(source);
    expect(visited.has(join(root, "server/tool-redact.ts"))).toBe(true);
    expect(visited.has(join(root, "shared/redact.ts"))).toBe(true);
  });

  it("imports and computes grams in a worker without creating runtime files", async () => {
    mkdirSync(scratch, { recursive: true });
    const home = mkdtempSync(join(scratch, "worker-"));
    dirs.push(home);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.OMB_DATA_DIR;
    const worker = new Worker(`
      import { parentPort } from "node:worker_threads";
      const { messageSearchGrams } = await import(${JSON.stringify(pathToFileURL(source).href)});
      parentPort.postMessage(messageSearchGrams({ kind: "text", text: "검사 🧠" }));
    `, { eval: true, env, execArgv: ["--experimental-strip-types"] });
    let grams: string[] | undefined;
    await new Promise<void>((resolve, reject) => {
      worker.on("message", (value: string[]) => { grams = value; });
      worker.on("error", reject);
      worker.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
    });
    expect(grams).toEqual(expect.arrayContaining(["g00ac8000c0ac", "g01f9e0", "kindtext"]));
    expect(readdirSync(home)).toEqual([]);
  });

  it("matches text eligibility and excludes other message kinds", async () => {
    const { messageSearchGrams, searchText } = await load();
    for (const summarized of [true, 1]) {
      const row = { kind: "text" as const, text: "hidden", summarized };
      expect(searchText(row)).toBeNull();
      expect(messageSearchGrams(row)).toEqual([]);
    }
    for (const text of [undefined, null]) expect(messageSearchGrams({ kind: "text", text })).toEqual([]);
    for (const summarized of [undefined, false, 0]) expect(messageSearchGrams({ kind: "text", text: "A", summarized })).toEqual(["g000061", "kindtext"]);
    expect(messageSearchGrams({ kind: "text", text: "" })).toEqual(["kindtext"]);
    const kinds: Message["kind"][] = ["options", "screen", "connector", "secret", "routine.run", "compaction", "note", "launch"];
    for (const kind of kinds) expect(messageSearchGrams({ kind, text: "excluded", tool: { name: "excluded" }, comm })).toEqual([]);
    expect(messageSearchGrams({ kind: "activity", text: "not a comm" })).toEqual([]);
    expect(messageSearchGrams({ kind: "activity", tool: { name: "A" } })).toEqual(["g000061", "kindactivity"]);
    expect(messageSearchGrams({ kind: "activity", tool: { name: "A" }, comm, text: "검사" })).toContain("g00ac8000c0ac");
  });

  it("indexes the exact union of full and chips grams", async () => {
    const { messageSearchGrams, searchGrams, searchText } = await load();
    for (const { row } of fixtures.filter(({ row }) => row.kind === "activity")) {
      const full = searchText(row);
      if (full === null) continue;
      const expected = new Set([...searchGrams(full), ...searchGrams(searchText(row, true)!), "kindactivity"]);
      expect(new Set(messageSearchGrams(row))).toEqual(expected);
    }
  });

  it("encodes unique lowercase code-point grams without normalization", async () => {
    const { searchGrams } = await load();
    expect(searchGrams("Aa")).toEqual(["g000061", "g000061000061"]);
    expect(searchGrams("🧠검")).toEqual(["g01f9e0", "g00ac80", "g01f9e000ac80"]);
    expect(searchGrams("\ud800\udfff\ud800")).toEqual(["g0103ff", "g00d800", "g0103ff00d800"]);
    expect(searchGrams("\udfff")).toEqual(["g00dfff"]);
    expect(searchGrams("\u{10ffff}")).toEqual(["g10ffff"]);
    expect(searchGrams("e\u0301")).not.toEqual(searchGrams("é"));
    expect(searchGrams("İKẞ")).toEqual(searchGrams("i\u0307kß"));
    expect(searchGrams("\u0000%_\\\"")).toEqual(expect.arrayContaining(["g000000", "g000025", "g00005f", "g00005c", "g000022"]));
    expect(searchGrams("Aa 검사 🧠 İKẞ").every((gram) => /^g(?:[0-9a-f]{6}){1,3}$/.test(gram))).toBe(true);
  });

  it("returns only necessary needle grams at every code-point length", async () => {
    const { needleGrams } = await load();
    expect(needleGrams("  ")).toEqual([]);
    expect(needleGrams(" A ")).toEqual(["g000061"]);
    expect(needleGrams("🧠검")).toEqual(["g01f9e000ac80"]);
    expect(needleGrams("AbCd")).toEqual(["g000061000062000063", "g000062000063000064"]);
    expect(needleGrams("AAAAA")).toEqual(["g000061000061000061"]);
    expect(needleGrams("\ud800")).toEqual(["g00d800"]);
    expect(needleGrams("İ")).toEqual(["g000069000307"]);
    expect(needleGrams("abcdefghijklmnopqrstuvwxyz")).toHaveLength(24);
  });

  it("contains every necessary gram for generated baseline search hits", async () => {
    const { messageSearchGrams, needleGrams } = await load();
    mkdirSync(DATA_DIR, { recursive: true });
    let seed = 0x3a4186c2;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const alphabet = ["a", "A", "z", "Z", "İ", "i", "ı", "Σ", "σ", "ς", "ß", "ẞ", "K", "K", "k", "검", "사", "한", "🧠", "😀", "e", "\u0301", "%", "_", "\\", '"', "'", " ", "\n", "\t"];
    const texts = ["İ i\u0307 ı I", "ΟΣ ος Σ σ ς", "ẞ ß SS ss", "K K k", "검사 결과 한글 🧠😀", "100% _ \\ \" ' e\u0301 é"];
    for (let i = 0; i < 154; i++) texts.push(Array.from({ length: 8 + random(24) }, () => alphabet[random(alphabet.length)]).join(""));
    const rows = texts.flatMap((text, index) => [
      message(`text-${index}`, text),
      activity(`tool-${index}`, { name: "Read", summary: text, detail: { output: [text] } }),
      activity(`comm-${index}`, { name: "Reply" }, { text, comm }),
    ]);
    const indexed = new Map(rows.map((row) => [row.id, new Set(messageSearchGrams(row))]));
    for (const row of rows) insertMessage("property", row);
    const queries = new Set(["İ", "i\u0307", "ı", "I", "Σ", "σ", "ς", "ΟΣ", "ος", "ẞ", "ß", "SS", "K", "K", "검사", "한글", "🧠", "🧠😀", "e\u0301", "é", "%", "_", "\\", '"', "'", "100%"]);
    for (const text of texts) {
      const points = Array.from(text);
      const start = random(points.length);
      const part = points.slice(start, start + 1 + random(6)).join("");
      queries.add(part);
      queries.add(part.toUpperCase());
    }
    let cases = 0;
    let hits = 0;
    for (const query of queries) {
      for (const chips of [false, true]) {
        for (const threadId of [undefined, "property"]) {
          const accepted = searchMessages(query, 10_000, threadId, { chips });
          for (const hit of accepted) {
            for (const gram of needleGrams(query)) expect(indexed.get(hit.messageId)?.has(gram), `${JSON.stringify(query)} ${hit.messageId} ${gram}`).toBe(true);
          }
          cases++;
          hits += accepted.length;
        }
      }
    }
    expect(cases).toBeGreaterThan(800);
    expect(hits).toBeGreaterThan(1000);
    expect(messageDatabase().prepare("SELECT COUNT(*) AS count FROM messages WHERE thread_id = 'property'").get()).toEqual({ count: 480 });
  });
});
