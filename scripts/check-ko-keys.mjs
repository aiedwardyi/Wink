import ts from "typescript";
import { parseSource, readSource, runCheck, walk } from "./repo-check.mjs";

export function missingKoKeys(text) {
  const source = parseSource("i18n-catalog.ts", text);
  const catalogs = new Map();
  walk(source, (node) => {
    if (!ts.isVariableDeclaration(node) || !["en", "ko"].includes(node.name.getText(source))) return;
    let value = node.initializer;
    while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression;
    if (!value || !ts.isObjectLiteralExpression(value)) throw new Error(`${node.name.getText(source)} must be a literal catalog`);
    const keys = value.properties.map((property) => {
      if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) throw new Error("Catalog keys must be explicit properties");
      return property.name.text;
    });
    catalogs.set(node.name.getText(source), new Set(keys));
  });
  if (!catalogs.get("en")?.size || !catalogs.has("ko")) throw new Error("Missing en or ko catalog");
  return [...catalogs.get("en")].filter((key) => !catalogs.get("ko").has(key));
}

runCheck(import.meta.url, () => missingKoKeys(readSource("src/lib/i18n-catalog.ts"))
  .map((key) => `src/lib/i18n-catalog.ts: missing ko key ${key}`));
