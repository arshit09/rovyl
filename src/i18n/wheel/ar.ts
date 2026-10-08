import type { WheelStrings } from './types';

/** Fetched on demand — never import this from a module the wheel's entry can reach. */
const ar: WheelStrings = {
  menuBack: 'رجوع',
  menuCenter: 'المركز',
  menuRecentsFallback: 'فتح التطبيق (لا مجلدات حديثة)',
  menuFetchingIcon: 'جارٍ جلب الأيقونة',
  menuRestartToUpdate: 'أعد التشغيل للتحديث',
  menuNoMatches: 'لا نتائج',
  menuFilterCount: '{shown} من {total}',
  menuDiscoveryScanning: 'جارٍ تصفّح قائمة ابدأ…',
  menuDiscoveryPending: 'تطبيقاتك في الطريق — ستمتلئ هذه العجلة من تلقاء نفسها بعد لحظات.',
  menuDirectionHint: 'ادفع نحو هدف لفتحه، أو اضغط %s لإغلاق العجلة.',
  hudOpenSettings: 'فتح إعدادات Rovyl',
  hudSettingsTitle: 'إعدادات Rovyl',
};

export default ar;
