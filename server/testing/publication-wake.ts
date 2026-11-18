import { readFileSync } from "node:fs";

import ts from "typescript";

import type { GoogleSync } from "../google-sync.ts";

/** The `published` wake index.ts hands the chat store, bound to `googleSync`. */
export function publicationWake(googleSync: GoogleSync): () => void {
  const source = ts.createSourceFile("index.ts", readFileSync(new URL("../index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    const options = ts.isCallExpression(node) && node.expression.getText(source) === "createThreadSyncV2Store" ? node.arguments[0] : undefined;
    if (options && ts.isObjectLiteralExpression(options)) {
      found = options.properties.filter(ts.isPropertyAssignment).find((property) => property.name.getText(source) === "published")?.initializer;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error("index.ts passes no published wake to createThreadSyncV2Store");
  const wake: () => void = new Function("googleSync", `return (${found.getText(source)});`)(googleSync);
  return wake;
}
