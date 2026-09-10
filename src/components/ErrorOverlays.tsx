import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Wrench, X } from 'lucide-react';
import {
  humanizeExecutionError,
  type FaultShortcutRef,
  type HumanFault,
  type SurfacedFault,
} from '../launchFailure';

/**
 * What appears when something went wrong — and it is one card.
 *
 * There used to be two: an opaque red banner and a pill toast, both wired to the same IPC event,
 * both printing the PowerShell stderr raw. The banner had no `max-width` and no clipping, so eight
 * lines of `CommandNotFoundException` covered the Settings window. Here the human text is short by
 * construction (see `src/launchFailure.ts`) and the Windows dump exists only inside `.zs-fault-raw`,
 * which has a maximum height and scrolls.
 *
 * This file, with `PanelTransition`, is still the reason `framer-motion` is no longer in the chunk
 * the wheel waits on: none of this is on screen in a session where nothing fails, and a card that
 * reports an error can afford to arrive a few milliseconds after the error itself.
 *
 * `App.tsx` keeps this mounted once it has been needed, rather than unmounting it the moment the
 * error clears — `AnimatePresence` can only play an exit animation for a child it still owns.
 */

/** Time on screen. Island mode is shorter because there the card has no buttons to hold it. */
const AUTO_DISMISS_MS = 8000;
const GLANCE_MS = 6000;

type Described = HumanFault & { severity: 'error' | 'warning'; sticky: boolean };

const describe = (fault: SurfacedFault): Described =>
  fault.kind === 'notice'
    ? {
        /** The persistence warning arrives already written and never leaves on its own: data loss. */
        severity: 'warning',
        sticky: true,
        code: 'unknown',
        title: fault.title,
        message: fault.message,
        hint: fault.hint,
        raw: '',
        report: `${fault.title}\n${fault.message}${fault.hint ? `\n${fault.hint}` : ''}`,
      }
    : {
        severity: 'error',
        sticky: false,
        ...humanizeExecutionError(fault.raw, fault.details, fault.appLabel),
      };

const FaultCard: React.FC<{
  fault: SurfacedFault;
  theme: 'black' | 'white';
  interactive: boolean;
  onDismiss: (seq: number) => void;
  onFixShortcut?: (target: FaultShortcutRef) => void;
}> = ({ fault, theme, interactive, onDismiss, onFixShortcut }) => {
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  /**
   * Two sources, two flags. One shared boolean meant the last writer won: tabbing out of the card
   * while the pointer was still over it cleared a hold the pointer still owned, and the timer
   * started again under the cursor.
   */
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [copied, setCopied] = useState(false);

  const human = useMemo(() => describe(fault), [fault]);
  const seq = fault.seq;

  /**
   * `App.tsx` passes a fresh arrow every render, and it re-renders on window mode, panel flags and
   * radial position. Listing the callback in the timer's deps would re-arm the timeout on each of
   * those, and a card left alone would never actually close.
   */
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const dismiss = useCallback(() => dismissRef.current(seq), [seq]);

  /** Nobody closes a card that is being read: with the details open, or the pointer/focus inside,
   * the timer does not exist at all, and is born again when the user leaves. */
  useEffect(() => {
    if (human.sticky || expanded || hovered || focusWithin) return;
    const timer = window.setTimeout(dismiss, interactive ? AUTO_DISMISS_MS : GLANCE_MS);
    return () => window.clearTimeout(timer);
  }, [human.sticky, expanded, hovered, focusWithin, interactive, dismiss]);

  useEffect(() => {
    /**
     * Escape is the app's global "close what is open" key — the radial and Settings both answer it
     * — and nothing stops its propagation, so it reaches here too. It must not double as "throw
     * away the data-loss warning": that card leaves only by its own X.
     */
    if (!interactive || human.sticky) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interactive, human.sticky, dismiss]);

  const fixTarget = fault.kind === 'launch' && onFixShortcut ? fault.shortcut : undefined;
  const fix = useCallback(() => {
    if (fixTarget) onFixShortcut?.(fixTarget);
  }, [fixTarget, onFixShortcut]);

  const copy = useCallback(() => {
    const text = human.report;
    if (!text) return;
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    };
    /** `navigator.clipboard` needs the window focused, and it is not always. The textarea is plan B. */
    const fallback = () => {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(field);
      field.select();
      try {
        document.execCommand('copy');
        done();
      } catch {
        /* no clipboard: the text stays selectable inside the details block */
      }
      field.remove();
    };
    const viaApi = navigator.clipboard?.writeText(text);
    if (viaApi) void viaApi.then(done).catch(fallback);
    else fallback();
  }, [human]);

  return (
    <motion.div
      className={`zs-fault${interactive ? '' : ' is-glance'}${human.severity === 'warning' ? ' is-warning' : ''}`}
      /** The card draws outside the subtree carrying `data-zn-theme`, so it brings its own. */
      data-zn-theme={theme}
      role={human.severity === 'warning' ? 'status' : 'alert'}
      aria-live={human.severity === 'warning' ? 'polite' : 'assertive'}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocusWithin(true)}
      /** Only when focus actually left the card — moving between its own buttons must not count. */
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
      }}
    >
      <span className="zs-fault-mark" aria-hidden>
        <AlertTriangle size={13} strokeWidth={1.9} />
      </span>

      <div className="zs-fault-body">
        <p className="zs-fault-title" title={human.title}>{human.title}</p>
        <p className="zs-fault-message">{human.message}</p>
        {human.hint && <p className="zs-fault-hint" title={human.hint}>{human.hint}</p>}

        {interactive && expanded && human.raw && (
          <pre className="zs-fault-raw" id={`zs-fault-raw-${seq}`}>{human.raw}</pre>
        )}

        {interactive && (
          <div className="zs-fault-actions">
            {/*
              First, and the only one that is a verb: reading the error is not what the user came
              to do. It is offered only when the failure carries the shortcut it belongs to — a
              button that opened Settings on nothing in particular would be worse than no button.
            */}
            {fixTarget && (
              <button type="button" className="is-primary" onClick={fix}>
                <Wrench size={12} strokeWidth={1.9} aria-hidden /> Fix shortcut
              </button>
            )}
            {human.raw && (
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
                aria-expanded={expanded}
                aria-controls={`zs-fault-raw-${seq}`}
              >
                {expanded ? 'Hide details' : 'Details'}
              </button>
            )}
            <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        )}
      </div>

      {interactive && (
        <button type="button" className="zs-fault-close" onClick={dismiss} aria-label="Dismiss">
          <X size={14} strokeWidth={1.9} />
        </button>
      )}
    </motion.div>
  );
};

export const ErrorOverlays: React.FC<{
  /**
   * At most two, and they are different in kind: the sticky persistence warning outlives every
   * launch failure, so it cannot share a slot with them — a failed launch used to silently evict
   * the one message in the app that reports data loss.
   */
  faults: SurfacedFault[];
  theme: 'black' | 'white';
  /**
   * False in island mode with no panel open: there the HWND has `setIgnoreMouseEvents(true)` and
   * the `App` root is `pointer-events-none` — a button drawn there would never get the click. The
   * card becomes a notice only.
   */
  interactive: boolean;
  onDismiss: (seq: number) => void;
  /** Opens Settings on the shortcut that failed. Absent → the card offers no repair. */
  onFixShortcut?: (target: FaultShortcutRef) => void;
}> = ({ faults, theme, interactive, onDismiss, onFixShortcut }) => (
  <div className={`zs-fault-stack${interactive ? '' : ' is-glance'}`}>
    {/* No `initial={false}`: this container is only ever mounted once a fault already exists, so
        suppressing the first entrance just made the very first card of a session appear without
        its animation while every later one had it. */}
    <AnimatePresence>
      {faults.map((fault) => (
        <FaultCard
          key={fault.seq}
          fault={fault}
          theme={theme}
          interactive={interactive}
          onDismiss={onDismiss}
          onFixShortcut={onFixShortcut}
        />
      ))}
    </AnimatePresence>
  </div>
);
