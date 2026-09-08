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
  /** Houve ícones que não resolveram nesta passagem — vale a pena repescar daqui a instantes. */
  const healingHadFailuresRef = useRef(false);
  /** Teto de repescagens: duas. Sem isto, um alvo permanentemente inválido girava para sempre. */
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
            // Falta ícone ou só URL remota (renderer não mostra → migrar para data URL)
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
                   * Favicon é rede: no arranque a ligação pode ainda não estar de pé, e uma falha
                   * assim ficava marcada como tentativa gasta — o atalho só ganhava ícone na
                   * sessão seguinte. Mesma regra do caminho nativo: falhar devolve a vez.
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
                     * A marca de "já tentado" existe para não repetir extrações em cadeia, mas
                     * estava a ser posta ANTES da tentativa e nunca retirada: um falhanço isolado
                     * — a fila do PowerShell ocupada, por exemplo — condenava o ícone até se
                     * reiniciar a app. Retirar a marca em caso de falha devolve-lhe uma segunda
                     * oportunidade na passagem seguinte.
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
       * O `cancelled` NÃO pode travar a escrita.
       *
       * O efeito é cancelado sempre que `config.workspaces` muda — e no arranque isso acontece
       * várias vezes (hidratação, descoberta do Menu Iniciar, normalização) enquanto os ícones
       * estão a ser resolvidos. O trabalho terminava com sucesso e era deitado fora à porta:
       * o log dizia `alterou=true falhas=false` e o ficheiro continuava vazio, com a passagem
       * seguinte a encontrar os mesmos itens. Um ciclo perfeito de trabalho desperdiçado.
       *
       * `cancelled` serve para PARAR trabalho a meio, não para descartar resultados já obtidos.
       * A fusão é por ID e só preenche quem continua sem ícone, portanto aplicar tarde é seguro.
       */
      if (hasUpdates) {
        /**
         * Aplicar por ID, não por identidade do array.
         *
         * A versão anterior só escrevia se `prev.workspaces` fosse EXATAMENTE o mesmo array com que
         * a cura começou. Numa restauração isso nunca acontece: a config muda várias vezes
         * (importação, descoberta do Menu Iniciar, normalização) enquanto o PowerShell resolve os
         * ícones, que demora segundos. O lote inteiro era descartado — e só na sessão seguinte,
         * com a config já estável, é que os ícones apareciam. Era isto que obrigava a fechar e
         * abrir a app para os ver.
         *
         * Agora recolhemos apenas os ícones resolvidos e aplicamo-los ao estado atual, seja ele
         * qual for. Só se preenche quem continua sem ícone, portanto nada do que o utilizador (ou
         * outra etapa) tenha entretanto definido é sobreposto.
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
              /** Sem ícone, ou com um URL remoto que o renderer não mostra: nos dois casos entra. */
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
      `[IconHealing] passagem ${iconHealingPass} | por resolver=${appsToHeal.length} ` +
        `(${appsToHeal.map((a) => a.label).slice(0, 8).join(', ')}${appsToHeal.length > 8 ? '…' : ''})`,
    );

    let retryTimer: number | undefined;
    void heal().then(() => {
      window.electron?.savePersistenceLog?.(
        `[IconHealing] passagem ${iconHealingPass} terminada | alterou=${hasUpdatesLog.value} falhas=${healingHadFailuresRef.current}`,
      );
      /** Houve falhas e nada mais vai mexer na config: agendar uma repescagem. */
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
