import { useEffect, useRef, useState } from 'react';
import type { AppItem, UIConfig, Workspace } from '../types';
import { isRemoteIconUrl, isWebShortcutItem, isStoredIconRef } from '../iconRef';
import { resolveWebsiteIconFields } from '../siteFavicon';

/**
 * Re-fetches shortcut icons that are missing, and retries the ones that failed.
 *
 * Lifted out of `App.tsx` whole — 241 lines of the 2,861 that file had, and the largest piece of it
 * that answers to one question. Nothing here changed: same effect, same dependency array, same
 * refs, so the behaviour is identical by construction.
 *
 * It owns its own retry bookkeeping because none of it means anything outside this loop: which
 * targets have been attempted this session, whether the last pass left failures, and how many
 * retries have been spent.
 */
export function useIconHealing({
  isLoaded,
  config,
  setConfig,
}: {
  isLoaded: boolean;
  config: UIConfig;
  setConfig: React.Dispatch<React.SetStateAction<UIConfig>>;
}): void {
  /** Prevents broken/missing shell targets from spawning PowerShell after every settings edit. */
  const iconHealingAttemptedRef = useRef(new Set<string>());
  /** Some icons failed to resolve this pass — worth a retry in a moment. */
  const healingHadFailuresRef = useRef(false);
  /** Retry ceiling: two. Without this, a permanently invalid target spun forever. */
  const healingRetriesRef = useRef(0);
  const [iconHealingPass, setIconHealingPass] = useState(0);

  // ICON HEALING: Automatically re-fetch missing native icons
  useEffect(() => {
    if (!isLoaded) return;
    if (!window.electron?.getFileIcon && !window.electron?.getWebsiteFaviconDataUrl) return;

    let cancelled = false;
    const healingKey = (item: AppItem) =>
      `${isWebShortcutItem(item) ? 'web' : 'native'}:${item.id ?? ''}:${item.command?.trim().toLowerCase() ?? ''}`;
    const canAttempt = (item: AppItem) => !iconHealingAttemptedRef.current.has(healingKey(item));
    const rememberAttempt = (item: AppItem) => {
      const attempted = iconHealingAttemptedRef.current;
      attempted.add(healingKey(item));
      // Config imports can contain thousands of stale entries. Bound this session-only guard too.
      while (attempted.size > 512) {
        const oldest = attempted.values().next().value as string | undefined;
        if (!oldest) break;
        attempted.delete(oldest);
      }
    };

    const findMissingIcons = (items: AppItem[]): AppItem[] => {
      let missing: AppItem[] = [];
      const traverse = (list: AppItem[]) => {
        list.forEach(item => {
          const web = isWebShortcutItem(item);
          const iconStr = String(item.customIconUrl ?? '').trim();
          if (web && item.command?.trim()) {
            // Missing icon, or only a remote URL (renderer won't show it → migrate to a data URL)
            if ((!iconStr || isRemoteIconUrl(item.customIconUrl)) && canAttempt(item)) {
              missing.push(item);
            }
          } else if (
            item.iconSource === 'native' &&
            !item.customIconUrl &&
            item.command &&
            !web &&
            canAttempt(item)
          ) {
            missing.push(item);
          }
          if (item.children) traverse(item.children);
        });
      };
      traverse(items);
      return missing;
    };

    const sourceWorkspaces = config.workspaces;
    const appsToHeal = findMissingIcons(sourceWorkspaces.flatMap(ws => ws.apps));
    if (appsToHeal.length === 0) return;

    // console.log(`[Icon Healing] Attempting to fix ${appsToHeal.length} icons...`);

    const hasUpdatesLog = { value: false };
    const heal = async () => {
      let hasUpdates = false;
      /** Limits concurrent getFileIcon IPC (large configs used to spawn dozens at once and stall the UI). */
      const ICON_HEAL_BATCH = 5;
      const healRecursive = async (items: AppItem[]): Promise<AppItem[]> => {
        if (cancelled) return items;
        const out: AppItem[] = [];
        for (let i = 0; i < items.length; i += ICON_HEAL_BATCH) {
          if (cancelled) return items;
          const chunk = items.slice(i, i + ICON_HEAL_BATCH);
          const done = await Promise.all(
            chunk.map(async (item) => {
              let newItem = { ...item };
              const web = isWebShortcutItem(item);
              const iconStr = String(item.customIconUrl ?? '').trim();
              const webNeedsIcon =
                web &&
                item.command?.trim() &&
                (!iconStr || isRemoteIconUrl(item.customIconUrl)) &&
                canAttempt(item);
              if (webNeedsIcon) {
                rememberAttempt(item);
                let iconFields: Partial<AppItem> | null = null;
                try {
                  iconFields = await resolveWebsiteIconFields(item.command!.trim());
                } catch (e) {
                  iconFields = null;
                }
                const url = iconFields?.customIconUrl;
                /**
                 * A stored reference counts as a resolved icon, exactly as an inline `data:` URL
                 * did. Without this the branch below scores a successful upgrade as a failure:
                 * an item already holding an `https://unavatar.io/...` placeholder has a truthy
                 * `iconStr`, so it would fall through to the failure arm and burn its retry.
                 * `data:` stays accepted — the `.bak` fallback path still hands them over.
                 */
                if (isStoredIconRef(url) || url?.startsWith('data:')) {
                  newItem = { ...newItem, ...iconFields };
                  hasUpdates = true;
                } else if (!iconStr && url) {
                  newItem = { ...newItem, ...iconFields };
                  hasUpdates = true;
                } else {
                  /**
                   * A favicon is network: at startup the link may not be up yet, and a failure
                   * like that stayed marked as a spent attempt — the shortcut only got its icon
                   * the next session. Same rule as the native path: failing gives the turn back.
                   */
                  iconHealingAttemptedRef.current.delete(healingKey(item));
                  healingHadFailuresRef.current = true;
                }
              } else if (
                item.iconSource === 'native' &&
                !item.customIconUrl &&
                item.command &&
                !web &&
                canAttempt(item) &&
                window.electron?.getFileIcon
              ) {
                rememberAttempt(item);
                try {
                  const iconUrl = await window.electron.getFileIcon(
                    item.command,
                  );
                  if (iconUrl) {
                    newItem.customIconUrl = iconUrl;
                    hasUpdates = true;
                  } else {
                    /**
                     * The "already tried" mark exists to keep extractions from repeating back to
                     * back, but it was being set BEFORE the attempt and never removed: one
                     * isolated failure — a busy PowerShell queue, say — condemned the icon until
                     * the app was restarted. Dropping the mark on failure gives it a second
                     * chance on the next pass.
                     */
                    iconHealingAttemptedRef.current.delete(healingKey(item));
                    healingHadFailuresRef.current = true;
                  }
                } catch (e) {
                  iconHealingAttemptedRef.current.delete(healingKey(item));
                  healingHadFailuresRef.current = true;
                  console.warn(`[Icon Healing] Failed for ${item.label}`);
                }
              }
              if (newItem.children) {
                newItem.children = await healRecursive(newItem.children);
              }
              return newItem;
            })
          );
          out.push(...done);
        }
        return out;
      };

      const updatedWorkspaces: Workspace[] = [];
      for (const ws of sourceWorkspaces) {
        const newApps = await healRecursive(ws.apps);
        updatedWorkspaces.push({ ...ws, apps: newApps });
      }

      hasUpdatesLog.value = hasUpdates;
      /**
       * `cancelled` must NOT block the write.
       *
       * The effect is cancelled every time `config.workspaces` changes — and at startup that
       * happens several times (hydration, Start Menu discovery, normalization) while the icons
       * are being resolved. The work finished successfully and was thrown away at the door:
       * the log said `changed=true failures=false` and the file stayed empty, with the next
       * pass finding the same items. A perfect cycle of wasted work.
       *
       * `cancelled` is for STOPPING work midway, not for discarding results already obtained.
       * The merge is by ID and only fills whoever still has no icon, so applying late is safe.
       */
      if (hasUpdates) {
        /**
         * Apply by ID, not by array identity.
         *
         * The previous version only wrote if `prev.workspaces` was EXACTLY the same array the
         * healing started with. On a restore that never happens: the config changes several times
         * (import, Start Menu discovery, normalization) while PowerShell resolves the icons,
         * which takes seconds. The whole batch was discarded — and only in the next session,
         * with the config already settled, did the icons show up. This is what forced closing
         * and reopening the app to see them.
         *
         * Now we collect only the resolved icons and apply them to the current state, whatever
         * it is. Only whoever still has no icon gets filled, so nothing the user (or another
         * step) has set in the meantime is overwritten.
         */
        const resolved = new Map<string, { customIconUrl?: string; iconSource?: AppItem['iconSource']; iconName?: string }>();
        const collect = (items: AppItem[]) => {
          items.forEach((item) => {
            if (item.id && item.customIconUrl) {
              resolved.set(item.id, {
                customIconUrl: item.customIconUrl,
                iconSource: item.iconSource,
                iconName: item.iconName,
              });
            }
            if (item.children) collect(item.children);
          });
        };
        updatedWorkspaces.forEach((ws) => collect(ws.apps));
        if (resolved.size === 0) return;

        setConfig((prev) => {
          let touched = 0;
          const apply = (items: AppItem[]): AppItem[] =>
            items.map((item) => {
              /** No icon, or a remote URL the renderer won't show: both cases qualify. */
              const stale = !item.customIconUrl || isRemoteIconUrl(item.customIconUrl);
              const patch = item.id ? resolved.get(item.id) : undefined;
              const next: AppItem = patch && stale ? { ...item, ...patch } : { ...item };
              if (patch && stale) touched += 1;
              if (item.children) next.children = apply(item.children);
              return next;
            });
          const workspaces = prev.workspaces.map((ws) => ({ ...ws, apps: apply(ws.apps) }));
          if (touched === 0) return prev;
          window.electron?.savePersistenceLog?.(`iconHealing applied ${touched} icons`);
          return { ...prev, workspaces };
        });
      }
    };

    window.electron?.savePersistenceLog?.(
      `[IconHealing] pass ${iconHealingPass} | unresolved=${appsToHeal.length} ` +
        `(${appsToHeal.map((a) => a.label).slice(0, 8).join(', ')}${appsToHeal.length > 8 ? '…' : ''})`,
    );

    let retryTimer: number | undefined;
    void heal().then(() => {
      window.electron?.savePersistenceLog?.(
        `[IconHealing] pass ${iconHealingPass} finished | changed=${hasUpdatesLog.value} failures=${healingHadFailuresRef.current}`,
      );
      /** There were failures and nothing else will touch the config: schedule a retry. */
      if (cancelled || !healingHadFailuresRef.current) return;
      healingHadFailuresRef.current = false;
      if (healingRetriesRef.current >= 2) return;
      healingRetriesRef.current += 1;
      retryTimer = window.setTimeout(() => setIconHealingPass((pass) => pass + 1), 4000);
    });
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [isLoaded, config.workspaces, iconHealingPass]); // Re-run after hydration, on workspace changes, and on retry.
}
