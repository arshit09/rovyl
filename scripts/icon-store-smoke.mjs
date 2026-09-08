/**
 * Contract of `backend/icon-store.cjs`, driven from plain node.
 *
 * The store is the piece of the icon change that decides whether a user's icons survive: it moves
 * bytes out of `config-v2.json`, hands back the string that replaces them, and later deletes files
 * nothing points at. Every one of those steps has a way to fail that looks like nothing at all
 * until an icon is gone, so each is asserted here rather than checked by opening the wheel.
 *
 * The store takes no `electron` import precisely so this can exist.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { createIconStore } = require(join(root, "backend", "icon-store.cjs"));

const workDir = mkdtempSync(join(tmpdir(), "rovyl-icon-store-"));
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}

/** A one-pixel PNG, and a different one, so dedup and distinctness are both observable. */
const PNG_A =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_B =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

try {
  const store = createIconStore(join(workDir, "icons"));

  check("putDataUrl returns a well-formed reference", () => {
    const ref = store.putDataUrl(PNG_A);
    assert.ok(store.isIconRef(ref), `not a reference: ${ref}`);
    assert.match(ref, /^rovyl-icon:\/\/icon\/[0-9a-f]{64}\.png$/);
    assert.ok(store.exists(ref));
  });

  check("identical bytes store once and keep the same name", () => {
    const first = store.putDataUrl(PNG_A);
    const before = statSync(store.resolvePath(first));
    const second = store.putDataUrl(PNG_A);
    assert.equal(second, first);
    const after = statSync(store.resolvePath(first));
    assert.equal(after.size, before.size);
    assert.equal(readIconCount(store), 1, "a second put created a second file");
  });

  check("different bytes get different names", () => {
    const a = store.putDataUrl(PNG_A);
    const b = store.putDataUrl(PNG_B);
    assert.notEqual(a, b);
    assert.equal(readIconCount(store), 2);
  });

  check("non-image and malformed data URLs are refused, not guessed at", () => {
    assert.equal(store.putDataUrl("data:text/html;base64,PHNjcmlwdD4="), null);
    assert.equal(store.putDataUrl("data:image/svg+xml;base64,PHN2Zy8+"), null);
    assert.equal(store.putDataUrl("data:image/png,notbase64"), null);
    assert.equal(store.putDataUrl("https://example.com/favicon.ico"), null);
    assert.equal(store.putDataUrl(""), null);
    assert.equal(store.putDataUrl(undefined), null);
  });

  check("refToFilename refuses anything that could escape the store directory", () => {
    const hash = "a".repeat(64);
    for (const bad of [
      "rovyl-icon://icon/../../etc/passwd",
      "rovyl-icon://icon/..%2F..%2Fx.png",
      "rovyl-icon://icon/%2e%2e/x.png",
      `rovyl-icon://icon/..\\${hash}.png`,
      `rovyl-icon://icon/${hash.toUpperCase()}.png`,
      `rovyl-icon://icon/${"a".repeat(63)}.png`,
      `rovyl-icon://icon/${"a".repeat(65)}.png`,
      `rovyl-icon://icon/${hash}.svg`,
      `rovyl-icon://icon/${hash}.exe`,
      `rovyl-icon://icon/${hash}`,
      `rovyl-icon://other/${hash}.png`,
      `rovyl-icon:/icon/${hash}.png`,
      `file:///${hash}.png`,
      `data:image/png;base64,AAAA`,
      "",
      null,
    ]) {
      assert.equal(store.refToFilename(bad), null, `accepted: ${bad}`);
      assert.equal(store.resolvePath(bad), null, `resolved: ${bad}`);
    }
    assert.equal(store.refToFilename(`rovyl-icon://icon/${hash}.png`), `${hash}.png`);
  });

  check("externalizeBlob converts every tree, nested children included, and dedups", () => {
    const blob = makeBlob();
    const before = JSON.stringify(blob).length;
    const result = store.externalizeBlob(blob);
    const text = JSON.stringify(blob);
    assert.ok(result.changed);
    // Three icons per `tree()`, two mirrored trees, plus the single one under `config`.
    assert.equal(result.converted, 7, `converted ${result.converted}`);
    assert.equal(result.failed, 0);
    assert.ok(!text.includes("data:image"), "a data: URL survived");
    assert.equal(text.match(/rovyl-icon:\/\/icon\//g).length, 7);
    /**
     * The property that matters is not a ratio — these test PNGs are one pixel, smaller than the
     * reference replacing them — but that a stored icon field is now BOUNDED. A data: URL grows
     * with the image; a reference is always the same 85 characters, which is what stops
     * config-v2.json scaling with the icon set.
     */
    for (const value of text.match(/"customIconUrl":"[^"]*"/g) || []) {
      assert.ok(value.length <= 110, `unbounded icon field survived: ${value.slice(0, 60)}…`);
    }
    assert.ok(before > 0 && text.length > 0);
    // PNG_A appears five times across the mirrored trees; all five must name one file.
    const refs = new Set([...text.matchAll(/rovyl-icon:\/\/icon\/([0-9a-f]{64}\.png)/g)].map((m) => m[1]));
    assert.equal(refs.size, 2, `expected 2 distinct blobs, got ${refs.size}`);
  });

  check("https favicons and unknown strings are left exactly as they are", () => {
    const blob = { apps: [{ customIconUrl: "https://unavatar.io/example.com" }, { customIconUrl: "" }] };
    store.externalizeBlob(blob);
    assert.equal(blob.apps[0].customIconUrl, "https://unavatar.io/example.com");
    assert.equal(blob.apps[1].customIconUrl, "");
  });

  check("inlineBlob(externalizeBlob(x)) round-trips back to the original", () => {
    const original = makeBlob();
    const copy = JSON.parse(JSON.stringify(original));
    store.externalizeBlob(copy);
    const result = store.inlineBlob(copy);
    assert.ok(result.changed);
    assert.equal(result.missing, 0);
    assert.deepEqual(copy, original);
  });

  check("a reference whose file is gone is dropped, not left dangling", () => {
    const ref = store.putDataUrl(PNG_B);
    unlinkSync(store.resolvePath(ref));
    const blob = { apps: [{ id: "x", customIconUrl: ref }] };
    const result = store.externalizeBlob(blob);
    assert.equal(result.dropped, 1);
    assert.ok(!("customIconUrl" in blob.apps[0]), "the dead reference survived");
    store.putDataUrl(PNG_B); // put it back for later assertions
  });

  check("collectRefFilenames finds references in text JSON.parse would reject", () => {
    const hash = "b".repeat(64);
    const corrupt = `{"apps":[{"customIconUrl":"rovyl-icon://icon/${hash}.png"},{"lab`;
    const found = store.collectRefFilenames(corrupt);
    assert.ok(found.has(`${hash}.png`), "missed the reference in a truncated file");
  });

  await checkAsync("sweep never runs against an empty root set", async () => {
    const result = await store.sweep({ rootFilenames: new Set(), minFiles: 0 });
    assert.equal(result.skipped, "no-roots");
    assert.equal(result.deleted, 0);
  });

  await checkAsync("sweep spares referenced and recent files, deletes only old orphans", async () => {
    const sweepStore = createIconStore(join(workDir, "sweep"));
    const referenced = sweepStore.putDataUrl(PNG_A);
    const recentOrphan = sweepStore.putDataUrl(PNG_B);
    const oldOrphanPath = join(sweepStore.dir, `${"c".repeat(64)}.png`);
    writeFileSync(oldOrphanPath, Buffer.from([1, 2, 3]));
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(oldOrphanPath, longAgo, longAgo);

    const result = await sweepStore.sweep({
      rootFilenames: new Set([sweepStore.refToFilename(referenced)]),
      minFiles: 0,
    });
    assert.equal(result.deleted, 1, `deleted ${result.deleted}`);
    assert.ok(sweepStore.exists(referenced), "deleted a referenced icon");
    assert.ok(sweepStore.exists(recentOrphan), "deleted an icon written this session");
    assert.equal(readIconCount(sweepStore), 2);
  });

  await checkAsync("sweep collects temp files a hard kill left behind", async () => {
    const tempStore = createIconStore(join(workDir, "temps"));
    const kept = tempStore.putDataUrl(PNG_A);
    const stalePath = join(tempStore.dir, `${"d".repeat(64)}.png.tmp-4242`);
    writeFileSync(stalePath, Buffer.from([9, 9, 9]));
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(stalePath, longAgo, longAgo);
    const freshTemp = join(tempStore.dir, `${"e".repeat(64)}.png.tmp-4243`);
    writeFileSync(freshTemp, Buffer.from([8, 8, 8]));

    const result = await tempStore.sweep({
      rootFilenames: new Set([tempStore.refToFilename(kept)]),
      minFiles: 0,
    });
    assert.equal(result.deleted, 1, `deleted ${result.deleted}`);
    assert.ok(!readdirSync(tempStore.dir).includes(`${"d".repeat(64)}.png.tmp-4242`), "stale temp survived");
    assert.ok(readdirSync(tempStore.dir).includes(`${"e".repeat(64)}.png.tmp-4243`), "deleted a temp being written now");
    assert.ok(tempStore.exists(kept), "deleted a referenced icon");
  });

  check("externalizeBlob stats each distinct reference once, not once per field", () => {
    const memoStore = createIconStore(join(workDir, "memo"));
    const ref = memoStore.putDataUrl(PNG_A);
    // The same reference in five places across the mirrored trees.
    const blob = {
      apps: [{ customIconUrl: ref }, { children: [{ customIconUrl: ref }] }],
      workspaces: [{ apps: [{ customIconUrl: ref }, { customIconUrl: ref }] }],
      config: { workspaces: [{ apps: [{ customIconUrl: ref }] }] },
    };
    const result = memoStore.externalizeBlob(blob);
    assert.equal(result.dropped, 0);
    assert.equal(result.changed, false, "a valid reference was rewritten");
    assert.equal(JSON.stringify(blob).match(/rovyl-icon/g).length, 5);
  });

  await checkAsync("sweep leaves a small store alone", async () => {
    const result = await store.sweep({ rootFilenames: new Set(["nope.png"]), minFiles: 1000 });
    assert.equal(result.skipped, "small-store");
  });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function readIconCount(store) {
  return readdirSync(store.dir).filter((n) => /^[0-9a-f]{64}\.[a-z]+$/.test(n)).length;
}

/** The real blob shape: the workspace tree mirrored three ways, with a nested folder. */
function makeBlob() {
  const tree = () => [
    { id: "a", customIconUrl: PNG_A },
    {
      id: "folder",
      children: [
        { id: "b", customIconUrl: PNG_B },
        { id: "c", customIconUrl: PNG_A },
      ],
    },
  ];
  return {
    user: { name: "someone" },
    apps: tree(),
    workspaces: [{ id: "w1", apps: tree() }],
    config: { workspaces: [{ id: "w1", apps: [{ id: "a", customIconUrl: PNG_A }] }] },
  };
}

if (failures) {
  console.error(`icon-store-smoke: FAILED (${failures})`);
  process.exit(1);
}
console.log("icon-store-smoke: OK");
