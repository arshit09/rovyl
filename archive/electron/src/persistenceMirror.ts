/**
 * The `localStorage` copy of the persisted blob.
 *
 * Disk is authoritative. `App.tsx` reads these three keys only when `get-full-config` comes back
 * with nothing — a quarantined config, a first run after a crash — so this is the last resort
 * behind the real file, not a second source of truth.
 */
const PERSISTENCE_MIRROR_KEYS = ["zenith_user", "zenith_apps", "zenith_config"] as const;

/** Reported once per session: a full quota is a standing condition, not an event worth repeating. */
let mirrorFailureReported = false;

/**
 * What the three keys were last known to hold.
 *
 * The mirror is rewritten on every debounced save *and* every wheel close, which meant
 * re-stringifying ~26 kB of workspace tree roughly twice per close on the renderer's main thread —
 * for a cache that is read only when the real file comes back empty. Comparing first turns the
 * common case, where nothing changed, into three string compares.
 */
let lastMirrored: { user: string; apps: string; config: string } | null = null;

/** Test seam — resets the once-per-session report so a suite can assert on it more than once. */
export function resetMirrorFailureReportingForTests(): void {
  mirrorFailureReported = false;
  lastMirrored = null;
}

export type MirrorOutcome = "ok" | "dropped";

export interface PersistenceMirrorPayload {
  user: unknown;
  apps: unknown;
  config: unknown;
}

/**
 * Writes the mirror, and never throws.
 *
 * Two things went wrong here before. The debounced save wrote the three keys unguarded and then
 * called `saveFullConfig` — so a `QuotaExceededError` on the mirror, which is only a cache, threw
 * out of the effect before the authoritative disk write, the one that actually matters. And a
 * partial write left a torn mirror: a new `zenith_user` beside a stale `zenith_config`, which the
 * fallback path would hydrate as though it were one coherent blob.
 *
 * So: all three keys or none. On failure the mirror is removed rather than left half-written —
 * absent is a state the read path already handles, torn is not — and removing is also what frees
 * the room a retry needs, since the old value is only released once the new one is committed.
 */
export function mirrorPersistenceToLocalStorage(
  payload: PersistenceMirrorPayload,
): MirrorOutcome {
  const next = {
    user: JSON.stringify(payload.user),
    apps: JSON.stringify(payload.apps),
    config: JSON.stringify(payload.config),
  };

  /**
   * Skipping an unchanged key cannot tear the mirror: what storage already holds for it is exactly
   * what this call would write. `force` exists for the retry below, which runs after `clear()` has
   * emptied all three and so must rewrite all three.
   */
  const write = (force: boolean) => {
    if (force || lastMirrored?.user !== next.user) {
      localStorage.setItem("zenith_user", next.user);
    }
    if (force || lastMirrored?.apps !== next.apps) {
      localStorage.setItem("zenith_apps", next.apps);
    }
    if (force || lastMirrored?.config !== next.config) {
      localStorage.setItem("zenith_config", next.config);
    }
    lastMirrored = next;
  };
  const clear = () => {
    lastMirrored = null;
    for (const key of PERSISTENCE_MIRROR_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* storage itself is unavailable; there is nothing left to try */
      }
    }
  };

  if (
    lastMirrored !== null &&
    lastMirrored.user === next.user &&
    lastMirrored.apps === next.apps &&
    lastMirrored.config === next.config
  ) {
    return "ok";
  }

  try {
    write(false);
    return "ok";
  } catch {
    clear();
  }

  try {
    write(true);
    return "ok";
  } catch (err) {
    clear();
    if (!mirrorFailureReported) {
      mirrorFailureReported = true;
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.warn("[Persist] localStorage mirror dropped —", reason);
      try {
        window.electron?.savePersistenceLog?.(
          `localStorage mirror dropped (${reason}); the disk config is unaffected`,
        );
      } catch {
        /* diagnostics must never be the thing that breaks a save */
      }
    }
    return "dropped";
  }
}
