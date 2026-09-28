import type { WheelStrings } from './types';

/** Fetched on demand — never import this from a module the wheel's entry can reach. */
const ja: WheelStrings = {
  menuBack: '戻る',
  menuCenter: '中央',
  menuRecentsFallback: 'アプリを開く（最近使ったフォルダーなし）',
  menuFetchingIcon: 'アイコンを取得中',
  menuRestartToUpdate: '再起動して更新',
  menuNoMatches: '該当なし',
  menuFilterCount: '{total} 件中 {shown} 件',
  menuDiscoveryScanning: 'スタートメニューを調べています…',
  menuDiscoveryPending: 'アプリを用意しています。このホイールはすぐに埋まります。',
  menuDirectionHint: '対象の方へ動かすと開きます。閉じるには %s を押します。',
  hudOpenSettings: 'Rovyl の設定を開く',
  hudSettingsTitle: 'Rovyl の設定',
};

export default ja;
