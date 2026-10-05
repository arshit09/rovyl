import { FALLBACK_LANGUAGE, normalizeLanguage, type SupportedLanguage } from './languages';

/**
 * The window frame's own strings — the title bar and the navigation rail that `App.tsx` draws.
 *
 * They are here and not in `./translations.ts` for the reason that file's header gives: `t()`
 * indexes its tables by a runtime key, so nothing in them tree-shakes, and `App.tsx` importing them
 * would drag all eight tables into the settings ENTRY chunk — 160 kB parsed before the window can
 * paint, to render seven `aria-label`s. Seven short strings in eight languages is about 1.5 kB, so
 * this pack ships statically and costs nothing worth measuring.
 *
 * The same shape as `./wheel/`, one size down: there the packs are big enough to be worth fetching,
 * here they are small enough not to be.
 */
export const SHELL_STRINGS = {
  en: {
    settingsNavigation: 'Settings navigation',
    toggleSidebar: 'Hide or show sidebar',
    backInSettings: 'Back in settings',
    forwardInSettings: 'Forward in settings',
    windowMinimize: 'Minimize',
    windowMaximize: 'Maximize',
    windowRestore: 'Restore',
    windowClose: 'Close',
  },
  es: {
    settingsNavigation: 'Navegación de ajustes',
    toggleSidebar: 'Ocultar o mostrar la barra lateral',
    backInSettings: 'Atrás en los ajustes',
    forwardInSettings: 'Adelante en los ajustes',
    windowMinimize: 'Minimizar',
    windowMaximize: 'Maximizar',
    windowRestore: 'Restaurar',
    windowClose: 'Cerrar',
  },
  zh: {
    settingsNavigation: '设置导航',
    toggleSidebar: '隐藏或显示侧边栏',
    backInSettings: '在设置中后退',
    forwardInSettings: '在设置中前进',
    windowMinimize: '最小化',
    windowMaximize: '最大化',
    windowRestore: '还原',
    windowClose: '关闭',
  },
  ja: {
    settingsNavigation: '設定のナビゲーション',
    toggleSidebar: 'サイドバーの表示を切り替え',
    backInSettings: '設定内で戻る',
    forwardInSettings: '設定内で進む',
    windowMinimize: '最小化',
    windowMaximize: '最大化',
    windowRestore: '元のサイズに戻す',
    windowClose: '閉じる',
  },
  pt: {
    settingsNavigation: 'Navegação dos ajustes',
    toggleSidebar: 'Ocultar ou mostrar a barra lateral',
    backInSettings: 'Voltar nos ajustes',
    forwardInSettings: 'Avançar nos ajustes',
    windowMinimize: 'Minimizar',
    windowMaximize: 'Maximizar',
    windowRestore: 'Restaurar',
    windowClose: 'Fechar',
  },
  ru: {
    settingsNavigation: 'Навигация по настройкам',
    toggleSidebar: 'Скрыть или показать боковую панель',
    backInSettings: 'Назад в настройках',
    forwardInSettings: 'Вперёд в настройках',
    windowMinimize: 'Свернуть',
    windowMaximize: 'Развернуть',
    windowRestore: 'Восстановить',
    windowClose: 'Закрыть',
  },
  de: {
    settingsNavigation: 'Einstellungsnavigation',
    toggleSidebar: 'Seitenleiste aus- oder einblenden',
    backInSettings: 'In den Einstellungen zurück',
    forwardInSettings: 'In den Einstellungen vorwärts',
    windowMinimize: 'Minimieren',
    windowMaximize: 'Maximieren',
    windowRestore: 'Wiederherstellen',
    windowClose: 'Schließen',
  },
  ar: {
    settingsNavigation: 'التنقل في الإعدادات',
    toggleSidebar: 'إخفاء الشريط الجانبي أو إظهاره',
    backInSettings: 'رجوع في الإعدادات',
    forwardInSettings: 'تقدّم في الإعدادات',
    windowMinimize: 'تصغير',
    windowMaximize: 'تكبير',
    windowRestore: 'استعادة',
    windowClose: 'إغلاق',
  },
} as const satisfies Record<SupportedLanguage, Record<string, string>>;

export type ShellStringKey = keyof (typeof SHELL_STRINGS)['en'];

export function shellString(key: ShellStringKey, language: unknown): string {
  const table = SHELL_STRINGS[normalizeLanguage(language)] as Record<ShellStringKey, string>;
  return table[key] || SHELL_STRINGS[FALLBACK_LANGUAGE][key];
}
