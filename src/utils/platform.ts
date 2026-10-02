/**
 * The Linux build has its own wording and its own releases; the Windows ones are unchanged.
 * Read once: the platform does not change under a running window.
 */
export const IS_LINUX_UI =
  typeof navigator !== 'undefined' && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
