const test = require("node:test");
const assert = require("node:assert");
const { acceleratorToGnome, parsePathList, formatPathList } = require("./gnome-keybinding.cjs");

test("accelerators map to GNOME's form", () => {
  assert.strictEqual(acceleratorToGnome("Alt+Shift+E"), "<Alt><Shift>e");
  assert.strictEqual(acceleratorToGnome("Ctrl+Alt+Space"), "<Control><Alt>space");
  assert.strictEqual(acceleratorToGnome("Super+F9"), "<Super>F9");
  assert.strictEqual(acceleratorToGnome("Win+Up"), "<Super>Up");
  assert.strictEqual(acceleratorToGnome("E"), null);
  assert.strictEqual(acceleratorToGnome("Alt+Weird"), null);
});

test("path lists round-trip, including GNOME's empty form", () => {
  assert.deepStrictEqual(parsePathList("@as []"), []);
  assert.deepStrictEqual(parsePathList("['/a/', '/b/']"), ["/a/", "/b/"]);
  assert.strictEqual(formatPathList(["/a/", "/b/"]), "['/a/', '/b/']");
});
