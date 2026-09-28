import type { WheelStrings } from './types';

/** Fetched on demand — never import this from a module the wheel's entry can reach. */
const zh: WheelStrings = {
  menuBack: '返回',
  menuCenter: '中心',
  menuRecentsFallback: '打开应用（没有最近的文件夹）',
  menuFetchingIcon: '正在获取图标',
  menuRestartToUpdate: '重启以更新',
  menuNoMatches: '没有匹配项',
  menuFilterCount: '{total} 项中的 {shown} 项',
  menuDiscoveryScanning: '正在查看你的开始菜单…',
  menuDiscoveryPending: '你的应用马上就到——这个轮盘稍后会自己填满。',
  menuDirectionHint: '朝目标推过去即可打开，或按 %s 关闭轮盘。',
  hudOpenSettings: '打开 Rovyl 设置',
  hudSettingsTitle: 'Rovyl 设置',
};

export default zh;
