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

/** Test seam — resets the once-per-session report so a suite can assert on it more than once. */
export function resetMirrorFailureReportingForTests(): void {
  mirrorFailureReported = false;
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
  const write = () => {
    localStorage.setItem("zenith_user", JSON.stringify(payload.user));
    localStorage.setItem("zenith_apps", JSON.stringify(payload.apps));
    localStorage.setItem("zenith_config", JSON.stringify(payload.config));
  };
  const clear = () => {
    for (const key of PERSISTENCE_MIRROR_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* storage itself is unavailable; there is nothing left to try */
      }
    }
  };

  try {
    write();
    return "ok";
  } catch {
    clear();
  }

  try {
    write();
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
