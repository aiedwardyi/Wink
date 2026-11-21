import ts from "typescript";
import { location, parseSource, readSource, runCheck, trackedFiles, walk } from "./repo-check.mjs";

const testSource = /\.(?:test|node-test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|testing|__tests__|fixtures|__fixtures__|test-utils)\/.*\.[cm]?[jt]sx?$/;
const homeKey = /^(HOME|USERPROFILE)$/i;
const processEnv = /^(?:globalThis\.)?process(?:\.env|\[['"]env['"]\])$/;
const profileKey = /^(?:DATA_DIR|OMB_DATA_DIR|OMB_COMPANION_DIR|WINK_VITEST_HOME|homedir|testHome|requireTestHome|createFixtureHome|startTestRun)$/;
const profileFolder = /(?:^|[\\/])\.(?:orbit|codex|openmausbot-companion)(?:$|[\\/])/i;
const removal = /^(?:rm|rmSync|removeTempDir)$/;

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
    if (!/homedir|USERPROFILE|HOME|\brm\b|rmSync|removeTempDir/i.test(text)) continue;
    const source = parseSource(file, text);
    const compilerOptions = { allowJs: true, noLib: true, noResolve: true };
    const program = ts.createProgram([file], compilerOptions, {
      ...ts.createCompilerHost(compilerOptions),
      getSourceFile: (name) => name === file ? source : undefined,
    });
    const symbol = (node) => program.getTypeChecker().getSymbolAtLocation(node);
    const exceptions = [...(allowed.get(file) ?? [])];
    const envAliases = new Set();
    walk(source, (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
          processEnv.test(node.initializer.getText(source))) envAliases.add(node.name.text);
    });
    const isProcessEnv = (node) => !!node && (processEnv.test(node.getText(source)) || envAliases.has(node.getText(source)));
    const profileAliases = new Set();
    const removalAliases = new Set();
    const assignments = [];
    const memberName = (node) => ts.isPropertyAccessExpression(node) ? node.name.text :
      ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
    const namesProfile = (node) => {
      let found = false;
      walk(node, (part) => {
        if (ts.isIdentifier(part) && (profileKey.test(part.text) || profileAliases.has(symbol(part))) ||
            ts.isStringLiteralLike(part) && profileFolder.test(part.text) ||
            profileKey.test(memberName(part) ?? "") ||
            homeKey.test(memberName(part) ?? "") && isProcessEnv(part.expression)) found = true;
      });
      return found;
    };
    walk(source, (node) => {
      if ((ts.isImportSpecifier(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
        const name = (node.propertyName ?? node.name).getText(source);
        if (profileKey.test(name) || homeKey.test(name) && ts.isBindingElement(node) && isProcessEnv(node.parent.parent.initializer)) {
          profileAliases.add(symbol(node.name));
        }
        if (removal.test(name)) removalAliases.add(symbol(node.name));
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        assignments.push([node.name, node.initializer]);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        assignments.push([node.left, node.right]);
      }
      if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
        for (const { name } of node.initializer.declarations) assignments.push([name, node.expression]);
      }
      if (ts.isCallExpression(node) && memberName(node.expression) === "push") {
        for (const item of node.arguments) assignments.push([node.expression.expression, item]);
      }
    });
    for (let previous = -1; previous !== profileAliases.size + removalAliases.size;) {
      previous = profileAliases.size + removalAliases.size;
      for (const [name, value] of assignments) {
        const binding = symbol(name);
        if (!binding) continue;
        if (namesProfile(value)) profileAliases.add(binding);
        const called = memberName(value) ?? (ts.isIdentifier(value) ? value.text : "");
        if (removal.test(called) || removalAliases.has(symbol(value))) removalAliases.add(binding);
      }
    }
    walk(source, (node) => {
      if (ts.isCallExpression(node) && node.arguments.length) {
        const called = memberName(node.expression) ?? node.expression.getText(source);
        const aliasedRemoval = removalAliases.has(symbol(node.expression));
        const [target, options] = node.arguments;
        const recursive = called === "removeTempDir" ||
          options && (!ts.isObjectLiteralExpression(options) || options.properties.some((property) =>
            ts.isSpreadAssignment(property) || property.name?.getText(source).replace(/['"]/g, "") === "recursive" &&
              !(ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword)));
        if ((removal.test(called) || aliasedRemoval) && recursive && namesProfile(target)) {
          hits.push(`${file}:${location(source, node)}: use removeTestData from server/testing/test-home.ts for recursive profile cleanup`);
        }
      }
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
