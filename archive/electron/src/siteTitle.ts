/**
 * The name a web shortcut is given when the user does not type one.
 *
 * The host (`github.com`) is what the address happens to be, not what the site is called. The page
 * says what it is called in its own `<title>`, so that is asked for first; the host stays the
 * fallback for a link that cannot be reached, a private address, or a browser-only build with no
 * Electron bridge to fetch through.
 */

/** Adds the scheme the user left out, so `example.com` and `https://example.com` agree. */
export function normalizeSiteUrl(urlString: string): string {
  const trimmed = String(urlString ?? "").trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** The fallback label: the host without the `www.` that nobody reads. */
export function hostLabelFromUrl(urlString: string): string {
  const normalized = normalizeSiteUrl(urlString);
  if (!normalized) return "";
  try {
    return new URL(normalized).hostname.replace(/^www\./i, "") || normalized;
  } catch {
    return normalized;
  }
}

/** An address worth spending a network round trip on. */
export function looksFetchable(urlString: string): boolean {
  const normalized = normalizeSiteUrl(urlString);
  if (!normalized) return false;
  try {
    const { hostname } = new URL(normalized);
    if (!hostname) return false;
    return hostname.includes(".") || hostname.toLowerCase() === "localhost";
  } catch {
    return false;
  }
}

/** One fetch per address per session — retyping the same URL should not hit the network again. */
const titleCache = new Map<string, string | null>();

/**
 * The page's `<title>`, or null when there is none to be had (offline, blocked, not HTML).
 * Callers fall back to {@link hostLabelFromUrl}; this never throws and never blocks for long.
 */
export async function resolveWebsiteTitle(urlString: string): Promise<string | null> {
  const normalized = normalizeSiteUrl(urlString);
  if (!normalized || !looksFetchable(normalized)) return null;
  if (titleCache.has(normalized)) return titleCache.get(normalized) ?? null;

  const fetchTitle =
    typeof window !== "undefined" ? window.electron?.getWebsitePageTitle : undefined;
  if (!fetchTitle) return null;

  let title: string | null = null;
  try {
    const resolved = await fetchTitle(normalized);
    if (typeof resolved === "string" && resolved.trim()) title = resolved.trim();
  } catch {
    /* the host label covers it */
  }
  titleCache.set(normalized, title);
  return title;
}

/** What the shortcut ends up called: the user's own name, else the page's, else the host. */
export async function resolveWebsiteLabel(
  urlString: string,
  typedLabel?: string,
): Promise<string> {
  const typed = String(typedLabel ?? "").trim();
  if (typed) return typed;
  return (await resolveWebsiteTitle(urlString)) || hostLabelFromUrl(urlString);
}
