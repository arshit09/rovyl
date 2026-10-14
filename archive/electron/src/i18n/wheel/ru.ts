import type { WheelStrings } from './types';

/** Fetched on demand — never import this from a module the wheel's entry can reach. */
const ru: WheelStrings = {
  menuBack: 'Назад',
  menuCenter: 'Центр',
  menuRecentsFallback: 'Открыть приложение (недавних папок нет)',
  menuFetchingIcon: 'Получение значка',
  menuRestartToUpdate: 'Перезапустить для обновления',
  menuNoMatches: 'нет совпадений',
  menuFilterCount: '{shown} из {total}',
  menuDiscoveryScanning: 'Просматриваем меню «Пуск»…',
  menuDiscoveryPending: 'Ваши приложения уже в пути — колесо заполнится само через мгновение.',
  menuDirectionHint: 'Двиньте в сторону цели, чтобы открыть её, или нажмите %s, чтобы закрыть колесо.',
  hudOpenSettings: 'Открыть настройки Rovyl',
  hudSettingsTitle: 'Настройки Rovyl',
};

export default ru;
