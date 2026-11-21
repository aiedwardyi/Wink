import ts from "typescript";
import { location, parseSource, readSource, runCheck, trackedFiles, walk } from "./repo-check.mjs";

const testSource = /\.(?:test|node-test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|testing|__tests__|fixtures|__fixtures__|test-utils)\/.*\.[cm]?[jt]sx?$/;
const homeKey = /^(HOME|USERPROFILE)$/i;
const processEnv = /^(?:globalThis\.)?process(?:\.env|\[['"]env['"]\])$/;

// These references test the host cwd, forward a scratch home, restore env, or emulate a provider's own files.
const allowed = new Map([
  ["electron/terminal-host.node-test.mjs", ["os.homedir"]],
  ["server/drivers/claude.test.ts", ["process.env.USERPROFILE"]],
  ["server/testing/fake-acp-cli.ts", ["homedir", "homedir()"]],
  ["server/testing/fake-agy-cli.ts", ["process.env.HOME", "process.env.USERPROFILE"]],
  ["server/testing/fake-claude-cli.ts", ["homedir", "homedir()"]],
  ["server/testing/setup.ts", ["homedir", "homedir()", "homedir()"]],
]);

export function checkTestProfilePaths(files = trackedFiles(testSource), read = readSource) {
  const hits = [];
  for (const file of files) {
    const text = read(file);
    if (!/homedir|USERPROFILE|HOME/i.test(text)) continue;
    const source = parseSource(file, text);
    const exceptions = [...(allowed.get(file) ?? [])];
    const envAliases = new Set();
    walk(source, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
          processEnv.test(node.initializer.getText(source))) envAliases.add(node.name.text);
    });
    const isProcessEnv = (node) => !!node && (processEnv.test(node.getText(source)) || envAliases.has(node.getText(source)));
    walk(source, (node) => {
      const member = ts.isPropertyAccessExpression(node) ? node.name :
        ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression : undefined;
      const name = (ts.isImportSpecifier(node) || ts.isBindingElement(node)) ? (node.propertyName ?? node.name).text : undefined;
      const assignment = node.parent && ts.isBinaryExpression(node.parent) && node.parent.left === node &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
      const homeLookup = member?.text === "homedir" ||
        name === "homedir" ||
        (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "homedir");
      const envRead = (member && homeKey.test(member.text) && isProcessEnv(node.expression) && !assignment) ||
        (name && homeKey.test(name) && ts.isBindingElement(node) && isProcessEnv(node.parent.parent.initializer));
      if (!homeLookup && !envRead) return;
      const exception = exceptions.indexOf(node.getText(source));
      if (exception !== -1) {
        exceptions.splice(exception, 1);
        return;
      }
      hits.push(`${file}:${location(source, node)}: use DATA_DIR from server/config.ts for Wink profile paths, or a verified test home or temp fixture for OS-home behavior`);
    });
  }
  return hits;
}

runCheck(import.meta.url, checkTestProfilePaths);
