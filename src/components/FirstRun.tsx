import React from 'react';
import { Keyboard, Mouse, SquareStack, Target } from 'lucide-react';
import type { UIConfig } from '../types';

/**
 * What a new user cannot work out by looking, said once.
 *
 * A fresh install opened Settings on an empty workspace and left it there. Nothing said which key
 * opens the wheel, that the other workspace exists, or that there are two ways to aim — and none of
 * those is discoverable from a wheel you do not yet know how to summon.
 *
 * Deliberately NOT `WelcomeScreen.tsx`, the 659-line tour this replaces. That file is already dead
 * (nothing imports it, and §2.2 exists to delete it) and it pulls in `translations.ts`, which §6.4
 * is removing. Reviving it would have un-deleted both.
 *
 * Every line is read from the live config rather than written as prose, so it names the key that is
 * actually registered and the mode that is actually set. A welcome screen that describes a default
 * the user does not have is worse than none: it teaches them the wrong gesture on their first try.
 */

const MOUSE_BUTTON_NAMES: Record<string, string> = {
  middle: 'the mouse wheel button',
  x1: 'the back side-button',
  x2: 'the forward side-button',
};

export const FirstRun: React.FC<{
  config: UIConfig;
  onDismiss: () => void;
}> = ({ config, onDismiss }) => {
  const shortcut = (config.globalShortcut || 'Alt+Z').split('+').filter(Boolean);
  const mouseButton = MOUSE_BUTTON_NAMES[config.mouseTriggerButton ?? 'middle'] ?? 'the mouse wheel button';
  const byHold = config.mouseTriggerMode === 'hold';
  const workspaces = config.workspaces?.length ?? 0;
  const handsFree = config.radialInstantActivate === 'dwell';
  const byDirection = handsFree || config.radialSelectionMode !== 'cursor';

  return (
    <div className="zs-firstrun-layer" role="presentation">
      <section className="zs-firstrun" role="dialog" aria-modal="true" aria-labelledby="zs-firstrun-title">
        <header>
          <h1 id="zs-firstrun-title">Rovyl is running</h1>
          {/* No count in the sentence: the mouse point only exists when the mouse trigger does. */}
          <p>It stays out of the way in the tray. Here is what to know.</p>
        </header>

        <ol className="zs-firstrun-points">
          <li>
            <span className="zs-firstrun-mark" aria-hidden><Keyboard size={15} strokeWidth={1.9} /></span>
            <div>
              <b>Open the wheel</b>
              <p>
                Press{' '}
                {shortcut.map((key, index) => (
                  <React.Fragment key={key}>
                    {index > 0 && <span className="zs-firstrun-plus">+</span>}
                    <kbd>{key}</kbd>
                  </React.Fragment>
                ))}{' '}
                anywhere in Windows — over any application, without leaving it.
              </p>
            </div>
          </li>

          {config.enableMouseTrigger !== false && (
            <li>
              <span className="zs-firstrun-mark" aria-hidden><Mouse size={15} strokeWidth={1.9} /></span>
              <div>
                <b>Or use the mouse</b>
                <p>
                  {byHold
                    ? `Hold ${mouseButton} to open the wheel, and let go on a target to run it.`
                    : `Click ${mouseButton} to open the wheel. It stays open until you pick something.`}
                </p>
              </div>
            </li>
          )}

          <li>
            <span className="zs-firstrun-mark" aria-hidden><Target size={15} strokeWidth={1.9} /></span>
            <div>
              <b>Aim, do not hunt</b>
              <p>
                {byDirection
                  ? 'Every target owns a whole wedge of the screen, so a flick in its direction is enough — you never have to land on the icon.'
                  : 'Move onto the icon you want and click it. Release away from every icon to cancel.'}
                {' '}Start typing to narrow a crowded wheel down to what you meant.
              </p>
            </div>
          </li>

          <li>
            <span className="zs-firstrun-mark" aria-hidden><SquareStack size={15} strokeWidth={1.9} /></span>
            <div>
              <b>Workspaces</b>
              <p>
                {workspaces > 1
                  ? `You have ${workspaces} sets of shortcuts — one for work, one for whatever else. Switch between them from the wheel or the tray.`
                  : 'Keep separate sets of shortcuts — one for work, one for whatever else — and switch between them from the wheel or the tray.'}
              </p>
            </div>
          </li>
        </ol>

        <footer>
          {/* Nothing here is a setting, so there is nothing to cancel — only one way out. */}
          <button type="button" className="zs-btn is-primary" onClick={onDismiss} autoFocus>
            Got it
          </button>
          <small>Everything above is in Settings, and can be changed there.</small>
        </footer>
      </section>
    </div>
  );
};
