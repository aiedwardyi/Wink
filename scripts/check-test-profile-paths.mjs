import ts from "typescript";
import { location, parseSource, readSource, runCheck, testFile, trackedFiles, walk } from "./repo-check.mjs";

const testSource = /\.(?:test|node-test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|testing|__tests__|fixtures|__fixtures__|test-utils)\/.*\.[cm]?[jt]sx?$/;
const homeKey = /^(HOME|USERPROFILE)$/i;
const processEnv = /^(?:globalThis\.)?process(?:\.env|\[['"]env['"]\])$/;
const profileKey = /^(?:DATA_DIR|WORKSPACES_DIR|EVENTS_DIR|NATIVE_DIR|ATTACHMENTS_DIR|DOWNLOADS_DIR|workspaceDir|OMB_DATA_DIR|OMB_COMPANION_DIR|WINK_VITEST_HOME|homedir|testHome|requireTestHome|createFixtureHome|startTestRun)$/;
const profileFolder = /(?:^|[\\/])(?:\.(?:orbit|codex|claude[^\\/]*|grok|gemini|hermes|openmausbot-companion)|\.config[\\/]muse)(?:$|[\\/])/i;
const removal = /^(?:rm|rmSync|rmdir|rmdirSync|removeTempDir)$/;

// These references test the host cwd, forward a scratch home, restore env, or emulate a provider's own files.
const allowed = new Map([
  ["electron/terminal-host.node-test.mjs", ["os.homedir"]],
  ["server/drivers/claude.test.ts", ["process.env.USERPROFILE"]],
  ["server/testing/fake-acp-cli.ts", ["homedir", "homedir()"]],
  ["server/testing/fake-agy-cli.ts", ["process.env.HOME", "process.env.USERPROFILE"]],
  ["server/testing/fake-claude-cli.ts", ["homedir", "homedir()"]],
  ["server/testing/setup.ts", ["homedir", "homedir()", "homedir()"]],
]);

// Launchers that spawn the app or server must not forward the caller's profile overrides.
const launcherSource = /^scripts\/[^/]+\.mjs$/;
const launcherAllowed = new Set([
  "scripts/dev.mjs", // the dev runner deliberately uses the developer's own profile
]);

export function checkLauncherEnv(files = trackedFiles(launcherSource).filter((file) => !testFile.test(file)), read = readSource) {
  const hits = [];
  for (const file of files) {
    const text = read(file);
    if (launcherAllowed.has(file) || !/process\.env/.test(text)) continue;
    const source = parseSource(file, text);
    walk(source, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const forwards = node.properties.some((property) =>
        ts.isSpreadAssignment(property) && processEnv.test(property.expression.getText(source)));
      const launchesApp = node.properties.some((property) => /^OMB_(?!SMOKE_)/.test(property.name?.getText(source) ?? ""));
      if (forwards && launchesApp) {
        hits.push(`${file}:${location(source, node)}: build the launched app's env with smokeLauncherEnv from server/testing/profile-env.ts, not ...process.env`);
      }
    });
  }
  return hits;
}

export function checkTestProfilePaths(files = trackedFiles(testSource), read = readSource) {
  const hits = [];
  for (const file of files) {
    const text = read(file);
    if (!/homedir|USERPROFILE|HOME|\brm\b|rmSync|rmdir|removeTempDir|createTempDirs/i.test(text)) continue;
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
    const tempFactories = new Set();
    const tempCollections = new Set();
    const assignments = [];
    const memberName = (node) => ts.isPropertyAccessExpression(node) ? node.name.text :
      ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
    const createsTempDirs = (node) => ts.isCallExpression(node) &&
      (node.expression.getText(source) === "createTempDirs" || memberName(node.expression) === "createTempDirs" || tempFactories.has(symbol(node.expression)));
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
        if (name === "createTempDirs") tempFactories.add(symbol(node.name));
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
    const aliasCount = () => profileAliases.size + removalAliases.size + tempFactories.size + tempCollections.size;
    for (let previous = -1; previous !== aliasCount();) {
      previous = aliasCount();
      for (const [name, value] of assignments) {
        const binding = symbol(name);
        if (!binding) continue;
        if (namesProfile(value)) profileAliases.add(binding);
        const called = memberName(value) ?? (ts.isIdentifier(value) ? value.text : "");
        if (removal.test(called) || removalAliases.has(symbol(value))) removalAliases.add(binding);
        if (called === "createTempDirs" || tempFactories.has(symbol(value))) tempFactories.add(binding);
        if (createsTempDirs(value) || tempCollections.has(symbol(value))) tempCollections.add(binding);
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
        const rawTempCleanup = called === "make" && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
          (tempCollections.has(symbol(node.expression.expression)) || createsTempDirs(node.expression.expression));
        if ((rawTempCleanup || (removal.test(called) || aliasedRemoval) && recursive) && namesProfile(target)) {
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

runCheck(import.meta.url, () => [...checkTestProfilePaths(), ...checkLauncherEnv()]);
