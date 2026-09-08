/**
 * Entry for `scripts/persistence-mirror-smoke.mjs`. A real source file so it resolves
 * `../src/persistenceMirror` through the project's own Vite config. Not imported by the app.
 */
import {
  mirrorPersistenceToLocalStorage,
  resetMirrorFailureReportingForTests,
} from "../src/persistenceMirror";

/** A `localStorage` that refuses writes past a byte budget, the way a browser at quota does. */
function makeStore(limitBytes: number, seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const used = () => [...map.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    map,
    setItem(key: string, value: string) {
      const existing = map.has(key) ? key.length + (map.get(key) as string).length : 0;
      if (used() - existing + key.length + value.length > limitBytes) {
        const err = new Error("quota");
        err.name = "QuotaExceededError";
        throw err;
      }
      map.set(key, value);
    },
    removeItem(key: string) {
      map.delete(key);
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
  };
}

const DEAD_STORE = {
  setItem() {
    throw new Error("denied");
  },
  removeItem() {
    throw new Error("denied");
  },
  getItem() {
    return null;
  },
};

function withStore<T>(store: unknown, fn: () => T): T {
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.localStorage;
  globals.localStorage = store;
  try {
    return fn();
  } finally {
    globals.localStorage = previous;
  }
}

export function collect() {
  const globals = globalThis as Record<string, unknown>;
  if (!globals.window) globals.window = globals;
  const small = { user: { n: 1 }, apps: [1], config: { a: 1 } };
  const huge = {
    user: { n: "x".repeat(400) },
    apps: ["y".repeat(400)],
    config: { a: "z".repeat(400) },
  };

  resetMirrorFailureReportingForTests();
  const roomy = makeStore(100_000);
  const wroteAll = withStore(roomy, () => mirrorPersistenceToLocalStorage(small));

  resetMirrorFailureReportingForTests();
  const tiny = makeStore(300);
  const refused = withStore(tiny, () => mirrorPersistenceToLocalStorage(huge));

  // Old values occupying the room the new ones need: clearing first is what makes the retry fit.
  resetMirrorFailureReportingForTests();
  const stale = makeStore(1500, {
    zenith_user: "x".repeat(400),
    zenith_apps: "y".repeat(400),
    zenith_config: "z".repeat(400),
  });
  const retried = withStore(stale, () => mirrorPersistenceToLocalStorage(small));

  // Fails partway: `zenith_user` fits, `zenith_config` does not.
  resetMirrorFailureReportingForTests();
  const partial = makeStore(60);
  const torn = withStore(partial, () =>
    mirrorPersistenceToLocalStorage({ user: { n: 1 }, apps: [1], config: { a: "z".repeat(200) } }),
  );

  resetMirrorFailureReportingForTests();
  const dead = withStore(DEAD_STORE, () => mirrorPersistenceToLocalStorage(small));

  return {
    fittingPayloadWritesEverything: wroteAll === "ok",
    fittingPayloadKeys: [...roomy.map.keys()].sort().join(","),

    oversizedPayloadIsDropped: refused === "dropped",
    oversizedPayloadLeavesNothing: tiny.map.size === 0,

    clearingFreesRoomForTheRetry: retried === "ok",
    retryStoredTheNewValue: JSON.parse(stale.getItem("zenith_config") || "{}").a === 1,

    partialWriteIsDropped: torn === "dropped",
    partialWriteLeavesNothing: partial.map.size === 0,

    unavailableStorageIsDropped: dead === "dropped",
  };
}
