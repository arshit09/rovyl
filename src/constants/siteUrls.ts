/**
 * Public marketing / help site (opened in the default browser from the desktop app).
 */
export const ZENITH_LAUNCHER_SITE_URL = "https://rovyl-red.vercel.app";

/**
 * Web sign-in (Google). Desktop opens with `?client=desktop` and bridges id_token to localhost:3892.
 * Requires SPA fallback on the host (see `zenith-radial-launcher/vercel.json`, `public/_redirects`) so `/auth` is not 404.
 */
export const ZENITH_LAUNCHER_AUTH_URL = `${ZENITH_LAUNCHER_SITE_URL}/auth`;

/**
 * Same flow using a hash route — works on static hosts that only serve `index.html` at `/` (no `/auth` file).
 * Use only if the site uses `HashRouter` and registers `/auth`.
 */
export const ZENITH_LAUNCHER_AUTH_HASH_URL = `${ZENITH_LAUNCHER_SITE_URL}/#/auth?client=desktop`;

export const ZENITH_LAUNCHER_HELP_URL = `${ZENITH_LAUNCHER_SITE_URL}/help`;

/**
 * The reference docs, on the site's own domain. Spelled out rather than built on
 * `ZENITH_LAUNCHER_SITE_URL`: sign-in and the licence API still live on the Vercel host, and moving
 * those is a separate change from where people read the docs.
 */
export const ZENITH_LAUNCHER_DOCS_URL = "https://rovyl.arshitvaghasiya.com/docs";

/** Public pricing page (same tiers as the app; checkout TBD). */
export const ZENITH_LAUNCHER_PRICING_URL = `${ZENITH_LAUNCHER_SITE_URL}/pricing`;
