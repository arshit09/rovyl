/**
 * Where the Start Menu scan has got to, for the two surfaces that would otherwise just look broken.
 *
 * At login the scan is deliberately deferred twenty seconds so it cannot compete with Windows for
 * the disk — and for those twenty seconds the Main workspace is genuinely empty. A wheel with
 * nothing in it and no explanation is indistinguishable from one that has lost its shortcuts, and
 * the empty state in Settings said "Add an application", which is advice to undo work that is
 * already on its way.
 *
 * Its own module because the two surfaces are two renderers now: the scan runs in the settings
 * window and the wheel is told about it over IPC. Left in `App.tsx`, importing this type from the
 * wheel would be a value-free import today and a whole settings bundle the first time somebody
 * forgot the `type` keyword.
 */
export type DiscoveryPhase = 'idle' | 'waiting' | 'scanning';
