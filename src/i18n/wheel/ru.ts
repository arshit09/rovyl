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
  dockNetWired: 'Проводная сеть',
  dockNetNone: 'Нет сети',
  dockNetOther: 'Подключено',
  dockNetWifiSignal: 'Wi-Fi — сигнал {percent}%',
  dockNetWifi: 'Wi-Fi',
  dockMute: 'Нажмите, чтобы отключить звук',
  dockUnmute: 'Звук отключён — нажмите, чтобы включить',
  dockVolumeNone: 'Нет аудиоустройства',
  dockVolumeLevel: 'Громкость {percent}%',
  dockNetOpenSettings: '{name} — нажмите для сетевых настроек Windows',
  dockBatteryLevel: 'Заряд {percent}%',
  dockBatteryCharging: 'Заряд {percent}% — зарядка',
  dockBatteryAria: 'Заряд {percent} процентов',
  dockMuteAria: 'Отключить звук',
  dockUnmuteAria: 'Включить звук',
};

export default ru;
