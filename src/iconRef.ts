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
const ICON_REF_PATTERN = /^rovyl-icon:\/\/icon\/[0-9a-f]{64}\.(?:png|jpg|gif|webp|bmp|ico)$/;

export function isStoredIconRef(value: string | null | undefined): boolean {
  return ICON_REF_PATTERN.test(String(value ?? "").trim());
}
