/**
 * Entry for `scripts/icon-map-smoke.mjs`. Kept as a real source file rather than a temp one so it
 * resolves `../src/iconMap` and the `virtual:lucide-icon-set` plugin through the project's own
 * Vite config — the same resolution the app gets. Not imported by the app.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CURATED_ICON_MAP,
  curatedIcon,
  getIcon,
  getLoadedFullIconMap,
  listPickableIconNames,
  loadFullIconMap,
  preloadIconsByName,
} from "../src/iconMap";

const boxMarkup = renderToStaticMarkup(React.createElement(CURATED_ICON_MAP.Box, { size: 24 }));

/** True when `name` renders the fallback glyph rather than a real icon. */
const drawsFallback = (name: string) =>
  renderToStaticMarkup(React.createElement(getIcon(name), { size: 24 })) === boxMarkup;

export async function collect() {
  const before: Record<string, unknown> = {
    curatedCount: Object.keys(CURATED_ICON_MAP).length,
    mapHasNullPrototype: Object.getPrototypeOf(CURATED_ICON_MAP) === null,

    // A name that happens to match an Object.prototype member must not become the icon component.
    constructorFallsBackToBox: drawsFallback("constructor"),
    protoFallsBackToBox: drawsFallback("__proto__"),
    toStringFallsBackToBox: drawsFallback("toString"),
    hasOwnPropertyFallsBackToBox: drawsFallback("hasOwnProperty"),
    unknownNameFallsBackToBox: drawsFallback("NotARealIcon"),
    emptyNameFallsBackToBox: drawsFallback(""),

    // Alias spellings of curated glyphs resolve synchronously, to the very same component.
    iconSuffixAlias: getIcon("GlobeIcon") === CURATED_ICON_MAP.Globe,
    lucidePrefixAlias: getIcon("LucideLayers") === CURATED_ICON_MAP.Layers,
    humanAliasGrid: getIcon("Grid3X3") === CURATED_ICON_MAP.Grid3x3,
    humanAliasSidebar: getIcon("Sidebar") === CURATED_ICON_MAP.PanelLeft,
    humanAliasStars: getIcon("Stars") === CURATED_ICON_MAP.Sparkles,
    curatedIconOnGarbage: curatedIcon("MyIcon") === undefined,
    curatedIconOnBareIconSuffix: curatedIcon("Icon") === undefined,
    curatedIconOnBareLucidePrefix: curatedIcon("Lucide") === undefined,

    fullSetNotLoadedYet: getLoadedFullIconMap() === null,
  };

  // A config made only of curated glyphs and their alias spellings must never fetch the chunk.
  preloadIconsByName(["Layers", "LayersIcon", "LucideGlobe", "Grid3X3", "Sidebar", "constructor"]);
  before.aliasOnlyConfigSkipsChunk = getLoadedFullIconMap() === null;

  // One genuinely uncurated name is enough to warm it.
  preloadIconsByName(["Accessibility"]);
  const full = (await loadFullIconMap()) as Record<string, unknown>;

  return {
    ...before,
    uncuratedNameLoadsChunk: getLoadedFullIconMap() !== null,
    pickableCount: listPickableIconNames(full as never).length,
    pickableHasNoAffixedAliases: !listPickableIconNames(full as never).some(
      (name) => name.endsWith("Icon") || name.startsWith("Lucide"),
    ),
    uncuratedResolvesAfterLoad: getIcon("Accessibility") === full.Accessibility,
    aliasStillPrefersCuratedAfterLoad: getIcon("GlobeIcon") === CURATED_ICON_MAP.Globe,
  };
}
