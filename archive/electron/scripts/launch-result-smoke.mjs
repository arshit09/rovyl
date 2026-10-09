/**
 * The contract behind "a failed launch reaches the user": `execute-command` ANSWERS.
 *
 * It used to be `ipcMain.on` — a send with no reply. A shortcut pointing at an uninstalled program
 * did, from the renderer's side, exactly what a working one did: the wheel closed and nothing
 * happened. Main knew, and shouted it on a broadcast channel that carried a command string and no
 * item, which the renderer matched back to a shortcut by comparing commands inside a 15-second
 * window.
 *
 * String-matching that this file says `ipcMain.handle` would not be worth running. What actually
 * breaks the promise is subtler: ONE early `return;` left behind in the ladder resolves the
 * renderer's promise with `undefined`, and that shortcut is silent again — for that path only, so
 * every other launch keeps working and nothing looks wrong. So the body is parsed, and every
 * return that belongs to `runExecuteCommand` itself is required to carry a value. Returns inside
 * the closures it declares (`runAutoCommands` bails with a bare `return;`, correctly) are not its
 * returns and are left alone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mainPath = join(root, "backend", "electron-main.js");
const preloadPath = join(root, "backend", "electron-preload.js");

const mainSource = readFileSync(mainPath, "utf8");
const preloadSource = readFileSync(preloadPath, "utf8");
const ast = parseAst(mainSource, { jsx: false });

/** Every node in the tree, so the walk does not depend on knowing each parent's field names. */
function* walk(node) {
  if (!node || typeof node.type !== "string") return;
  yield node;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) yield* walk(child);
    } else if (value && typeof value === "object" && typeof value.type === "string") {
      yield* walk(value);
    }
  }
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Returns owned by `fn` — those not sitting inside another function declared within it. */
function ownReturns(fn) {
  const found = [];
  const visit = (node, insideNested) => {
    if (!node || typeof node.type !== "string") return;
    if (node !== fn && FUNCTION_TYPES.has(node.type)) insideNested = true;
    if (node.type === "ReturnStatement" && !insideNested) found.push(node);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child, insideNested);
      } else if (value && typeof value === "object" && typeof value.type === "string") {
        visit(value, insideNested);
      }
    }
  };
  visit(fn, false);
  return found;
}

const lineOf = (node) => mainSource.slice(0, node.start).split("\n").length;

// ── 1. The handler exists, and the send-only registration is gone ─────────────
let handleRegistrations = 0;
let onRegistrations = 0;
for (const node of walk(ast)) {
  if (node.type !== "CallExpression") continue;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression") continue;
  if (callee.object?.name !== "ipcMain") continue;
  const channel = node.arguments?.[0];
  if (channel?.type !== "Literal" || channel.value !== "execute-command") continue;
  if (callee.property?.name === "handle") handleRegistrations += 1;
  if (callee.property?.name === "on") onRegistrations += 1;
}

assert.equal(handleRegistrations, 1, 'expected exactly one ipcMain.handle("execute-command")');
assert.equal(
  onRegistrations,
  0,
  'ipcMain.on("execute-command") is back: a send with no reply cannot report a failure',
);

// ── 2. The preload asks for that answer instead of firing and forgetting ──────
assert.match(
  preloadSource,
  /executeCommand:[\s\S]{0,200}ipcRenderer\.invoke\("execute-command"/,
  "preload must invoke execute-command, not send it",
);
assert.ok(
  !/ipcRenderer\.(on|removeListener)\("execution-error"/.test(preloadSource),
  "the execution-error broadcast is gone; a listener for it would never fire",
);
/** Comment lines are stripped first: the channel is named in the notes explaining why it went. */
assert.ok(
  !/"execution-error"/.test(mainSource.replace(/^\s*\*.*$/gm, "")),
  "no code path may still report a launch failure by broadcast",
);

// ── 3. Every exit from the ladder carries a result ────────────────────────────
let ladder = null;
for (const node of walk(ast)) {
  if (node.type !== "VariableDeclarator") continue;
  if (node.id?.name !== "runExecuteCommand") continue;
  ladder = node.init;
}
assert.ok(ladder && FUNCTION_TYPES.has(ladder.type), "runExecuteCommand not found in main");

const returns = ownReturns(ladder);
assert.ok(returns.length >= 8, `expected the ladder to have many exits, found ${returns.length}`);

const bare = returns.filter((node) => node.argument === null);
assert.deepEqual(
  bare.map(lineOf),
  [],
  `bare return in runExecuteCommand resolves the renderer's promise with undefined ` +
    `(electron-main.js:${bare.map(lineOf).join(", ")})`,
);

/**
 * And they must be shapes the renderer knows how to read, not any old truthy value.
 *
 * Three are allowed. Two are the helpers. The third is the early-out guard, and it is allowed only
 * in the exact form `if (x) return x;` — a name that was just proven truthy on the line above
 * cannot be the `undefined` this file exists to keep out, whereas returning any other bare name
 * could be.
 */
const helperNames = new Set(["launchOk", "launchFailed"]);
const GUARDED_RETURN = /^if\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*return\s+([A-Za-z_$][\w$]*)\s*;/;
const badShapes = returns.filter((node) => {
  const arg = node.argument;
  if (arg?.type === "CallExpression" && helperNames.has(arg.callee?.name)) return false;
  /** `return await something()` in the tail position is the handler's own re-throw guard. */
  if (arg?.type === "AwaitExpression") return false;
  if (arg?.type === "Identifier") {
    const before = mainSource.lastIndexOf("if", node.start);
    const text = mainSource.slice(before, node.end + 1).replace(/\s+/g, " ");
    const guarded = GUARDED_RETURN.exec(text);
    /** All three names must agree, or this is a bare name nothing proved is not undefined. */
    return !(guarded && guarded[1] === guarded[2] && guarded[2] === arg.name);
  }
  return true;
});
assert.deepEqual(
  badShapes.map(lineOf),
  [],
  `every exit must be launchOk()/launchFailed() (electron-main.js:${badShapes.map(lineOf).join(", ")})`,
);

const okReturns = returns.filter(
  (node) => node.argument?.type === "CallExpression" && node.argument.callee?.name === "launchOk",
);
const failReturns = returns.filter(
  (node) => node.argument?.type === "CallExpression" && node.argument.callee?.name === "launchFailed",
);
assert.ok(okReturns.length >= 4, "expected several success exits");
assert.ok(failReturns.length >= 3, "expected several failure exits");

console.log(
  `launch-result-smoke: OK (${returns.length} exits, ${okReturns.length} ok / ${failReturns.length} failed, 8 assertions)`,
);
