/**
 * A reference to an icon file the main process keeps in `userData/icons`, served over the
 * `rovyl-icon://` scheme registered in `backend/electron-main.js`.
 *
 * `AppItem.customIconUrl` used to be a `data:image/png;base64,…` string of about 21 kB. Now it is
 * one of these, 85 bytes, and goes into `<img src>` exactly the same way — see
 * `backend/icon-store.cjs` for why the bytes moved out of the config file.
 *
 * The pattern is kept in step with `REF_PATTERN` there. Both are anchored and lowercase-only
 * because the same string ends up naming a file inside userData.
 */
import type { AppItem } from "./types";
import { isLikelyWebUrl } from "./siteFavicon";

const ICON_REF_PATTERN = /^rovyl-icon:\/\/icon\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|bmp|ico)$/;

export function isStoredIconRef(value: string | null | undefined): boolean {
  return ICON_REF_PATTERN.test(String(value ?? "").trim());
}

/**
 * A remote favicon rather than something this machine produced. Neither the `.exe` icon cache-bust
 * nor the healing pass should treat one as a stale native icon — it did not come from the Windows
 * pipeline and re-extracting will not improve it.
 */
export function isRemoteIconUrl(value: string | undefined): boolean {
  return /^https?:\/\//i.test(String(value ?? "").trim());
}

/** A shortcut whose target is a web page, so its icon comes from a favicon and not from a file. */
export function isWebShortcutItem(item: AppItem): boolean {
  return item.commandType === "url" || isLikelyWebUrl(item.command);
}
