const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseVdf, parseAcf, listSteamGames } = require("./steam.cjs");

const fixtures = path.join(__dirname, "fixtures", "steam");

/** The fixture library names itself `__ROOT__`; a copy in a temp dir points at that real folder. */
function stagedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rovyl-steam-"));
  fs.cpSync(fixtures, root, { recursive: true });
  const vdf = path.join(root, "steamapps", "libraryfolders.vdf");
  fs.writeFileSync(vdf, fs.readFileSync(vdf, "utf8").replace("__ROOT__", root));
  return root;
}

test("parseVdf reads nested blocks", () => {
  const parsed = parseVdf(fs.readFileSync(path.join(fixtures, "steamapps", "libraryfolders.vdf"), "utf8"));
  assert.strictEqual(parsed.libraryfolders["0"].path, "__ROOT__");
  assert.strictEqual(parsed.libraryfolders["0"].apps["620"], "1");
});

test("parseAcf reads a manifest and rejects a truncated one", () => {
  const read = (n) => fs.readFileSync(path.join(fixtures, "steamapps", n), "utf8");
  assert.deepStrictEqual(parseAcf(read("appmanifest_620.acf")), { appid: "620", name: "Portal 2", installdir: "Portal 2" });
  assert.strictEqual(parseAcf(read("appmanifest_999.acf")), null);
});

test("listSteamGames returns real games only, even with a missing library", async () => {
  const games = await listSteamGames({ roots: [stagedRoot()] });
  assert.deepStrictEqual(games.map((g) => g.name), ["Counter-Strike 2", "Portal 2"]);
  const portal = games.find((g) => g.id === "steam:620");
  assert.strictEqual(portal.command, "steam steam://rungameid/620");
  assert.strictEqual(portal.kind, "game");
});

test("a root that does not exist yields nothing", async () => {
  assert.deepStrictEqual(await listSteamGames({ roots: ["/nope/never"] }), []);
});
