import { useEffect, useMemo, useRef, useState } from 'react';
import type { AutoWorkspacesConfig, CatalogEntry } from '../types';

/** Icons resolved at once. The ring is short on patience and a 110-app catalog is not. */
const ICON_CONCURRENCY = 4;

/**
 * The catalog of installed apps and games, and an icon for each entry as it resolves.
 *
 * Fetches only what the switches ask for — with both off it asks for nothing and costs nothing —
 * and refetches when a switch changes, when main reports `catalog-changed`, and when the wheel
 * opens (main answers that from a one-minute cache, so the open is not a scan).
 */
export function useCatalog(cfg: AutoWorkspacesConfig): { entries: CatalogEntry[]; icons: Record<string, string> } {
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [icons, setIcons] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());

  /** The sources actually needed: games off drops every game-only source. */
  const sources = useMemo(
    () => ({
      desktop: (cfg.apps || cfg.games) && cfg.sources.desktop,
      steam: cfg.games && cfg.sources.steam,
      lutris: cfg.games && cfg.sources.lutris,
      heroic: cfg.games && cfg.sources.heroic,
    }),
    [cfg.apps, cfg.games, cfg.sources.desktop, cfg.sources.steam, cfg.sources.lutris, cfg.sources.heroic],
  );
  const wanted = sources.desktop || sources.steam || sources.lutris || sources.heroic;

  useEffect(() => {
    const api = window.electron;
    if (!api?.getCatalog || !wanted) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      void api
        .getCatalog({ sources })
        .then((list) => {
          if (!cancelled && Array.isArray(list)) setEntries(list);
        })
        .catch(() => undefined);
    };
    load();
    const offChanged = api.onCatalogChanged?.(load);
    const offOpen = api.onOpenMenu?.(load);
    return () => {
      cancelled = true;
      offChanged?.();
      offOpen?.();
    };
  }, [sources, wanted]);

  /** Icons, a few at a time, each once: the entries that already have one are not asked again. */
  useEffect(() => {
    const api = window.electron;
    if (!api?.getFileIcon) return;
    const queue = entries.filter((e) => !requested.current.has(e.id));
    if (!queue.length) return;
    queue.forEach((e) => requested.current.add(e.id));
    let cancelled = false;
    const found: Record<string, string> = {};
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (cancelled) return;
      const batch = { ...found };
      setIcons((prev) => ({ ...prev, ...batch }));
    };
    const worker = async () => {
      for (let entry = queue.shift(); entry && !cancelled; entry = queue.shift()) {
        try {
          const icon = await api.getFileIcon(entry.iconPath || entry.command);
          if (icon) {
            found[entry.id] = icon;
            if (!flushTimer) flushTimer = setTimeout(flush, 150);
          }
        } catch (e) {
          /* no icon for this one: the glyph stays */
        }
      }
    };
    void Promise.all(Array.from({ length: ICON_CONCURRENCY }, worker)).then(() => {
      if (flushTimer) clearTimeout(flushTimer);
      flush();
    });
    return () => {
      cancelled = true;
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [entries]);

  return { entries, icons };
}
