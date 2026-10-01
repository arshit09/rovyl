const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { parseLutrisList, listLutrisGames } = require("./lutris.cjs");
const { parseHeroicInstalled, listHeroicGames } = require("./heroic.cjs");

const fixtures = path.join(__dirname, "fixtures");

test("Lutris keeps installed, named rows and builds the launch line", () => {
  const games = parseLutrisList(fs.readFileSync(path.join(fixtures, "lutris-list.json"), "utf8"));
  assert.deepStrictEqual(games.map((g) => g.name), ["Hades"]);
  assert.strictEqual(games[0].command, "lutris lutris:rungameid/12");
  assert.strictEqual(games[0].id, "lutris:12");
});

test("Heroic reads both layouts and skips rows without a title", () => {
  const dir = path.join(fixtures, "heroic");
  const epic = parseHeroicInstalled(fs.readFileSync(path.join(dir, "legendaryConfig/legendary/installed.json"), "utf8"), "legendary");
  assert.deepStrictEqual(epic.map((g) => g.name), ["Rocket League"]);
  assert.strictEqual(epic[0].command, "heroic heroic://launch/legendary/Sugar");
  const gog = parseHeroicInstalled(fs.readFileSync(path.join(dir, "gogdlConfig/heroic_gogdl/installed.json"), "utf8"), "gog");
  assert.strictEqual(gog[0].command, "heroic heroic://launch/gog/1207658924");
});

test("garbage input is no games", () => {
  for (const bad of ["not json", "{}", "[]", "null", "42"]) {
    assert.deepStrictEqual(parseLutrisList(bad), []);
    assert.deepStrictEqual(parseHeroicInstalled(bad, "gog"), []);
  }
});

test("listHeroicGames reads a config dir and tolerates a missing one", async () => {
  assert.strictEqual((await listHeroicGames({ configDir: path.join(fixtures, "heroic") })).length, 2);
  assert.deepStrictEqual(await listHeroicGames({ configDir: "/nope/never" }), []);
});

test("Lutris absent from PATH is no games, not an error", async () => {
  const saved = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.deepStrictEqual(await listLutrisGames(), []);
  } finally {
    process.env.PATH = saved;
  }
});
