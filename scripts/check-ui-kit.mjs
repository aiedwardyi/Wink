import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { location, parseSource, readSource, runCheck, testFile, trackedFiles, walk } from "./repo-check.mjs";

// Each screen uses the shared parts in docs/ui-kit.md; a hand-rolled copy drifts from the rest of the app.
const allowedUrl = new URL("./ui-kit.json", import.meta.url);
const uiFile = /^src\/.+\.(?:tsx?|css)$/;
const rules = ["motion", "back", "menu", "button", "switch", "segmented", "press"];
const tokenFiles = new Set(["src/motion.css", "src/lib/motion.ts", "src/lib/motion-character.ts", "src/lib/phone-swipe.ts"]);

const fix = {
  motion: "use the --motion-* and --ease-* tokens or animate-* classes from src/motion.css, or MOTION_*_MS and EASE_* from src/lib/motion.ts (docs/ui-kit.md#motion)",
  back: "use <BackButton> from src/components/BackButton.tsx (docs/ui-kit.md#back)",
  menu: "use MENU_CLASS from src/components/MessageMenu.tsx for the panel and MENU_ITEM_HOVER from src/lib/menu-style.ts for its rows (docs/ui-kit.md#menus)",
  button: "use PRIMARY_BUTTON from src/lib/button-style.ts (docs/ui-kit.md#buttons)",
  switch: "use <DetailsSwitch> or <SwitchRow> from src/components/BotDetailsRows.tsx (docs/ui-kit.md#settings-row)",
  segmented: "use <Segmented> or <SegmentedRow> from src/components/Segmented.tsx (docs/ui-kit.md#settings-row)",
  press: "buttons get the shared press and hover fade from src/motion.css; drop the button's own transition-* (bare transition if it also moves) and active: classes, and make a clickable element a <button> (docs/ui-kit.md#hover-and-press)",
};

const time = /(?<![\w.-])(\d*\.?\d+)(m?s)\b/g;
// Plain linear is a steady rate (timers, progress), not a curve; linear() is a curve.
const easing = /(?<![\w-])(?:ease(?:-in-out|-in|-out)?|linear(?=\()|step-start|step-end|cubic-bezier|steps)(?![\w-])/;

function stripVars(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    if (!value.startsWith("var(", i)) {
      out += value[i];
      continue;
    }
    for (let depth = 0; i < value.length; i += 1) {
      if (value[i] === "(") depth += 1;
      else if (value[i] === ")" && !(depth -= 1)) break;
    }
    out += " ";
  }
  return out;
}

// Endless loops (spinners, shimmer) are ambient, and under a millisecond is the reduced-motion off switch.
export function rawMotion(value) {
  const plain = stripVars(value);
  if (/\binfinite\b/.test(plain)) return false;
  return easing.test(plain) || [...plain.matchAll(time)].some((match) => Number(match[1]) * (match[2] === "s" ? 1000 : 1) >= 1);
}

// Tailwind variants end at the last colon outside brackets.
function utility(token) {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < token.length; i += 1) {
    if ("[(".includes(token[i])) depth += 1;
    else if ("])".includes(token[i])) depth -= 1;
    else if (token[i] === ":" && !depth) cut = i + 1;
  }
  return token.slice(cut).replace(/^!|!$/g, "");
}

function rawClass(token) {
  const name = utility(token);
  const arbitrary = (value) => value.startsWith("[") && rawMotion(value.slice(1, -1).replaceAll("_", " "));
  let match;
  if ((match = /^(?:duration|delay)-(.+)$/.exec(name))) return /^\d+$/.test(match[1]) ? Number(match[1]) > 0 : arbitrary(match[1]);
  if ((match = /^ease-(.+)$/.exec(name))) return /^(?:in|out|in-out)$/.test(match[1]) || arbitrary(match[1]);
  if ((match = /^animate-(\[.+\])$/.exec(name))) return arbitrary(match[1]);
  if ((match = /^\[(?:transition|animation)[a-z-]*:(.+)\]$/.exec(name))) return rawMotion(match[1].replaceAll("_", " "));
  return false;
}

function cssHits(file, text) {
  const plain = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const hits = [];
  for (const match of plain.matchAll(/(?<![\w-])(--[\w-]+|(?:transition|animation)(?:-duration|-delay|-timing-function)?)\s*:([^;{}]*)/g)) {
    if (!rawMotion(match[2])) continue;
    hits.push({ rule: "motion", line: plain.slice(0, match.index).split("\n").length, what: `raw ${match[1]} value`, fix: fix.motion });
  }
  return hits;
}

const nameOf = (name) => (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : "");
const textOf = (node) => (ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" ") : undefined);
const motionProp = /^(?:transition|animation)(?:-?(?:duration|delay|timing-?function))?$/i;
const words = (text) => new Set(text.split(/[\s"'\x60]+/));

// The className as text: literals, same-file consts spelled out, and identifiers kept so MENU_CLASS-style names show.
function classText(node, consts, seen = new Set()) {
  if (!node) return "";
  if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const value = consts.get(node.text);
    if (!value || seen.has(node.text)) return node.text;
    seen.add(node.text);
    return `${node.text} ${classText(value, consts, seen)}`;
  }
  let text = "";
  ts.forEachChild(node, (child) => {
    text += ` ${classText(child, consts, seen)}`;
  });
  return text;
}

function rawTiming(object) {
  let raw = false;
  for (const prop of object.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const name = nameOf(prop.name);
    const value = prop.initializer;
    if (name === "iterations" && /\bInfinity\b/.test(value.getText())) return false;
    if ((name === "duration" || name === "delay") && ts.isNumericLiteral(value) && Number(value.text) > 0) raw = true;
    if (name === "easing" && textOf(value) !== undefined && rawMotion(textOf(value))) raw = true;
  }
  return raw;
}

function tsHits(file, text) {
  const source = parseSource(file, text);
  const icons = new Map();
  const consts = new Map();
  walk(source, (node) => {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === "lucide-react" && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const item of node.importClause.namedBindings.elements) icons.set(item.name.text, (item.propertyName ?? item.name).text.replace(/^Lucide/, "").replace(/Icon$/, ""));
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) consts.set(node.name.text, node.initializer);
  });
  const iconOf = (node) => {
    const tag = ts.isJsxSelfClosingElement(node) ? node.tagName : ts.isJsxElement(node) ? node.openingElement.tagName : undefined;
    return tag && ts.isIdentifier(tag) ? icons.get(tag.text) : undefined;
  };
  const hasIcon = (node, names) => {
    let found = false;
    walk(node, (child) => {
      if (names.includes(iconOf(child))) found = true;
    });
    return found;
  };
  const motion = !tokenFiles.has(file);
  const hits = [];
  const done = new Set();
  const looked = new Set();
  const hit = (rule, node, what) => hits.push({ rule, line: location(source, node), what, fix: fix[rule] });
  const claim = (node) => walk(node, (child) => done.add(child));
  walk(source, (node) => {
    if (done.has(node)) return;
    if (motion && ts.isObjectLiteralExpression(node) && (node.properties.some((prop) => nameOf(prop.name) === "easing") || (ts.isCallExpression(node.parent) && node.parent.arguments[1] === node && nameOf(node.parent.expression.name) === "animate"))) {
      if (rawTiming(node)) {
        hit("motion", node, "raw animation timing");
        claim(node);
      }
      return;
    }
    if (motion && ts.isCallExpression(node) && nameOf(node.expression.name) === "animate" && node.arguments[1] && ts.isNumericLiteral(node.arguments[1]) && Number(node.arguments[1].text) > 0) {
      hit("motion", node, "raw animation duration");
      return;
    }
    const styleValue = ts.isPropertyAssignment(node) && motionProp.test(nameOf(node.name)) ? node.initializer
      : ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && nameOf(node.left.expression.name) === "style" && motionProp.test(node.left.name.text) ? node.right
        : ts.isCallExpression(node) && nameOf(node.expression.name) === "setProperty" && node.arguments[0] && motionProp.test(textOf(node.arguments[0]) ?? "") ? node.arguments[1]
          : undefined;
    if (motion && styleValue && textOf(styleValue) !== undefined) {
      if (rawMotion(textOf(styleValue))) {
        hit("motion", styleValue, "raw transition or animation value");
        claim(styleValue);
      }
      return;
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
      const tokens = words(textOf(node));
      if (motion && [...tokens].some(rawClass)) hit("motion", node, "raw duration, delay or easing class");
      if ([...tokens].some((name) => /(?:^|[:-])active:\S/.test(name))) hit("press", node, "hand-rolled press state");
      if (!looked.has(node) && ["bg-card", "rounded-xl", "shadow-2xl", "shadow-black/60"].every((name) => tokens.has(name)) && !(ts.isVariableDeclaration(node.parent) && nameOf(node.parent.name) === "MENU_CLASS")) {
        hit("menu", node, "hand-rolled menu look");
      }
      return;
    }
    if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const attr = (name) => node.attributes.properties.find((prop) => ts.isJsxAttribute(prop) && nameOf(prop.name) === name)?.initializer;
    const literal = (value) => (value && ts.isJsxExpression(value) ? value.expression : value);
    const roleValue = literal(attr("role"));
    const role = roleValue && ts.isStringLiteralLike(roleValue) ? roleValue.text : "";
    const className = literal(attr("className"));
    const cls = classText(className, consts);
    const classes = words(cls);
    if (role === "switch" && file !== "src/components/BotDetailsRows.tsx") hit("switch", node, "hand-rolled switch");
    if ((role === "radiogroup" || role === "tablist") && file !== "src/components/Segmented.tsx" && [/^bg-(?:inset|raised)(?:\/\d+)?$/, /^p-(?:1|0\.5|\[[23]px\])$/, /^rounded-(?:lg|xl|2xl|full)$/].every((look) => [...classes].some((name) => look.test(name)))) {
      hit("segmented", node, "hand-rolled segmented control");
    }
    if ((role === "menu" || (role === "listbox" && (classes.has("absolute") || classes.has("fixed")))) && !/\bMENU_CLASS\b/.test(cls)) {
      hit("menu", node, `hand-rolled ${role} panel`);
      if (className) walk(className, (child) => looked.add(child));
    }
    if (/^menuitem(?:radio|checkbox)?$/.test(role) && !/\bMENU_ITEM_HOVER\b/.test(cls)) hit("menu", node, "hand-rolled menu row");
    const tag = nameOf(node.tagName);
    if (/^(?:div|span|li|img|p|td|tr|section|article)$/.test(tag) && attr("onClick") && role !== "separator" && role !== "button" && [...classes].some((name) => /(?:^|:)hover:/.test(name))) hit("press", node, `clickable <${tag}> with a hover`);
    if ((tag === "button" || role === "button") && [...classes].some((name) => !name.startsWith("motion-reduce:") && /^transition-(?:colors|opacity|shadow|transform|none|\[.+\])$/.test(utility(name)))) hit("press", node, "own transition class on a button");
    if (tag !== "button") return;
    const element = ts.isJsxOpeningElement(node) ? node.parent : undefined;
    const label = ["aria-label", "title", "onClick"].map((name) => attr(name)?.getText() ?? "").join(" ");
    if (classes.has("bg-accent") && classes.has("text-accent-ink") && !/\bPRIMARY_BUTTON\b/.test(cls)) hit("button", node, "hand-rolled primary button");
    if (!element) return;
    const arrow = element.children.some((child) => ts.isJsxText(child) && /^\s*[‹←]/.test(child.text));
    const pager = /prev|next|older|newer|earlier|later|scroll|collapse/i.test(label) || (ts.isJsxElement(element.parent) && hasIcon(element.parent, ["ChevronRight", "ArrowRight"]));
    if ((arrow || hasIcon(element, ["ChevronLeft", "ArrowLeft"])) && !pager && file !== "src/components/BackButton.tsx") hit("back", node, "hand-rolled back button");
  });
  return hits;
}

export function uiKitHits(file, text) {
  if (file.endsWith(".css")) return tokenFiles.has(file) ? [] : cssHits(file, text);
  return tsHits(file, text);
}

const readAllowed = () => JSON.parse(readFileSync(allowedUrl, "utf8"));
const uiFiles = () => trackedFiles(uiFile).filter((file) => !testFile.test(file));

function scan(files, read) {
  const found = {};
  for (const file of files) for (const hit of uiKitHits(file, read(file))) ((found[hit.rule] ??= {})[file] ??= []).push(hit);
  return found;
}

export function checkUiKit(files = uiFiles(), read = readSource, allowed = readAllowed()) {
  const found = scan(files, read);
  const out = [];
  for (const [rule, byFile] of Object.entries(found)) {
    for (const [file, hits] of Object.entries(byFile)) {
      const limit = allowed[rule]?.[file] ?? 0;
      if (hits.length <= limit) continue;
      const note = limit ? ` (one of ${hits.length}; ui-kit.json allows ${limit})` : "";
      for (const hit of hits) out.push(`${file}:${hit.line}: ${hit.what}${note}; ${hit.fix}`);
    }
  }
  for (const [rule, byFile] of Object.entries(allowed)) {
    for (const [file, limit] of Object.entries(byFile)) {
      const count = found[rule]?.[file]?.length ?? 0;
      if (count < limit) out.push(`${file}: ui-kit.json allows ${limit} ${rule} hits but the file has ${count}; run node scripts/check-ui-kit.mjs --lower`);
    }
  }
  return out;
}

// Counts only go down: a new hand-rolled part is never written into the list.
function lower() {
  const allowed = readAllowed();
  const found = scan(uiFiles(), readSource);
  const next = {};
  for (const rule of rules) {
    for (const [file, limit] of Object.entries(allowed[rule] ?? {})) {
      const count = Math.min(limit, found[rule]?.[file]?.length ?? 0);
      if (count) (next[rule] ??= {})[file] = count;
    }
  }
  writeFileSync(allowedUrl, `${JSON.stringify(next, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv.includes("--lower")) lower();
runCheck(import.meta.url, checkUiKit);
