import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  UNKNOWN_FOREGROUND,
  parseForegroundSnapshot,
  createLineSplitter,
} = require("../backend/foreground-snapshot.cjs");

const checks = [];
const check = (name, run) => checks.push([name, run]);

check("reads a normal reply", () => {
  const snapshot = parseForegroundSnapshot("100,50,1920,1080|C:\\Windows\\explorer.exe|Documents");
  assert.equal(snapshot.owner.path, "C:\\Windows\\explorer.exe");
  assert.equal(snapshot.title, "Documents");
  assert.deepEqual(snapshot.bounds, { x: 100, y: 50, width: 1920, height: 1080 });
});

check("keeps separators that belong to the title", () => {
  // A real one, straight off a live host: only the first two bars are structural.
  const snapshot = parseForegroundSnapshot(
    "-8,-8,1936,1056|C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe|Text to Speech | ElevenLabs - Google Chrome",
  );
  assert.equal(snapshot.owner.path, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  assert.equal(snapshot.title, "Text to Speech | ElevenLabs - Google Chrome");
  assert.deepEqual(snapshot.bounds, { x: -8, y: -8, width: 1936, height: 1056 });
});

check("accepts negative bounds off a secondary monitor", () => {
  const snapshot = parseForegroundSnapshot("-1920,-200,1920,1080|C:\\a.exe|x");
  assert.deepEqual(snapshot.bounds, { x: -1920, y: -200, width: 1920, height: 1080 });
});

check("an empty title is a title, not a missing field", () => {
  const snapshot = parseForegroundSnapshot("0,0,10,10|C:\\a.exe|");
  assert.equal(snapshot.title, "");
  assert.equal(snapshot.owner.path, "C:\\a.exe");
});

check("no exe means unknown, bounds included", () => {
  // The helper answers `||` when there is no foreground window or the process cannot be opened.
  // Bounds must not survive that: isBoundsFullscreenMonitor without an exe loses its own-exe and
  // shell guards and would start blocking the wheel instead of failing open.
  for (const payload of ["||", "0,0,1920,1080||", "|"]) {
    const snapshot = parseForegroundSnapshot(payload);
    assert.equal(snapshot.owner.path, null, payload);
    assert.equal(snapshot.bounds, null, payload);
    assert.equal(snapshot, UNKNOWN_FOREGROUND, payload);
  }
});

check("unparseable bounds do not invent a rectangle", () => {
  for (const payload of ["|C:\\a.exe|t", "1,2,3|C:\\a.exe|t", "a,b,c,d|C:\\a.exe|t"]) {
    const snapshot = parseForegroundSnapshot(payload);
    assert.equal(snapshot.bounds, null, payload);
    assert.equal(snapshot.owner.path, "C:\\a.exe", payload);
  }
});

check("splits a chunk carrying two lines", () => {
  const seen = [];
  const read = createLineSplitter((line) => seen.push(line));
  read("READY\r\nFG|0,0,1,1|C:\\a.exe|one\r\n");
  assert.deepEqual(seen, ["READY", "FG|0,0,1,1|C:\\a.exe|one"]);
});

check("holds a half line until the rest arrives", () => {
  const seen = [];
  const read = createLineSplitter((line) => seen.push(line));
  read("FG|0,0,1,1|C:\\a.e");
  assert.deepEqual(seen, []);
  read("xe|title\n");
  assert.deepEqual(seen, ["FG|0,0,1,1|C:\\a.exe|title"]);
});

check("a window titled READY is not the helper announcing itself", () => {
  // The reason this splitter exists: the old handler matched `chunk.includes("READY")`, so this
  // reply would have been read as a readiness banner and the snapshot behind it dropped.
  const seen = [];
  const read = createLineSplitter((line) => seen.push(line));
  read("FG|0,0,1,1|C:\\a.exe|ARE YOU READY - Notepad\n");
  assert.deepEqual(seen, ["FG|0,0,1,1|C:\\a.exe|ARE YOU READY - Notepad"]);
  assert.notEqual(seen[0], "READY");
});

let failed = 0;
for (const [name, run] of checks) {
  try {
    run();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}
if (failed) {
  console.error(`foreground-snapshot-smoke: ${failed} failed`);
  process.exit(1);
}
console.log(`foreground-snapshot-smoke: OK (${checks.length} checks)`);
