import React from 'react';
import { Keyboard, Mouse, SquareStack, Target } from 'lucide-react';
import type { UIConfig } from '../types';
import { mouseTriggerPhrase } from '../constants/mouseTrigger';
import { useTranslation } from '../i18n/useTranslation';

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

/** Key per button, resolved through `t` at render — the names are prose, not identifiers. */
const MOUSE_BUTTON_KEYS = {
  middle: 'firstRunBtnMiddle',
  x1: 'firstRunBtnX1',
  x2: 'firstRunBtnX2',
  left: 'firstRunBtnLeft',
  right: 'firstRunBtnRight',
} as const;

export const FirstRun: React.FC<{
  config: UIConfig;
  onDismiss: () => void;
}> = ({ config, onDismiss }) => {
  const { t, tf } = useTranslation(config.language);
  const shortcut = (config.globalShortcut || 'Alt+Z').split('+').filter(Boolean);
  /** Whatever is bound, named the way the recorder named it — modifiers and all, translated. */
  const mouseButton = mouseTriggerPhrase(config.mouseTriggerButton, {
    names: Object.fromEntries(
      Object.entries(MOUSE_BUTTON_KEYS).map(([button, key]) => [button, t(key)]),
    ) as Record<keyof typeof MOUSE_BUTTON_KEYS, string>,
    and: t('firstRunBtnAnd'),
  });
  /**
   * The shortcut is rendered as `<kbd>` chips, so the sentence carries one `%s` where they go
   * rather than being split into a fixed before-and-after: English opens with "Press %s", Japanese
   * puts the keys mid-sentence, and only a slot can hold both.
   */
  const shortcutHint = t('firstRunShortcutDesc').split('%s');
  const byHold = config.mouseTriggerMode === 'hold';
  /** Both triggers can be turned off independently now, so neither point is guaranteed a place. */
  const byKeyboard = config.enableKeyboardTrigger !== false;
  const byMouse = config.enableMouseTrigger !== false;
  const workspaces = config.workspaces?.length ?? 0;
  const handsFree = config.radialInstantActivate === 'dwell';
  const byDirection = handsFree || config.radialSelectionMode !== 'cursor';

  return (
    <div className="zs-firstrun-layer" role="presentation">
      <section className="zs-firstrun" role="dialog" aria-modal="true" aria-labelledby="zs-firstrun-title">
        <header>
          <h1 id="zs-firstrun-title">{t('firstRunTitle')}</h1>
          {/* No count in the sentence: the mouse point only exists when the mouse trigger does. */}
          <p>{t('firstRunSubtitle')}</p>
        </header>

        <ol className="zs-firstrun-points">
          {byKeyboard && (
            <li>
              <span className="zs-firstrun-mark" aria-hidden><Keyboard size={15} strokeWidth={1.9} /></span>
              <div>
                <b>{t('firstRunOpenWheel')}</b>
                <p>
                  {shortcutHint[0]}
                  {shortcut.map((key, index) => (
                    <React.Fragment key={key}>
                      {index > 0 && <span className="zs-firstrun-plus">+</span>}
                      <kbd>{key}</kbd>
                    </React.Fragment>
                  ))}
                  {shortcutHint[1] ?? ''}
                </p>
              </div>
            </li>
          )}

          {byMouse && (
            <li>
              <span className="zs-firstrun-mark" aria-hidden><Mouse size={15} strokeWidth={1.9} /></span>
              <div>
                {/* "Or" only makes sense as the second way in. */}
                <b>{byKeyboard ? t('firstRunOrMouse') : t('firstRunOpenWheel')}</b>
                <p>
                  {tf(byHold ? 'firstRunMouseHold' : 'firstRunMouseClick', { button: mouseButton })}
                </p>
              </div>
            </li>
          )}

          <li>
            <span className="zs-firstrun-mark" aria-hidden><Target size={15} strokeWidth={1.9} /></span>
            <div>
              <b>{t('firstRunAimTitle')}</b>
              <p>
                {byDirection ? t('firstRunAimDirection') : t('firstRunAimCursor')}
                {' '}{t('firstRunAimSuffix')}
              </p>
            </div>
          </li>

          <li>
            <span className="zs-firstrun-mark" aria-hidden><SquareStack size={15} strokeWidth={1.9} /></span>
            <div>
              <b>{t('workspaces')}</b>
              <p>
                {workspaces > 1
                  ? tf('firstRunWorkspacesMany', { count: workspaces })
                  : t('firstRunWorkspacesOne')}
              </p>
            </div>
          </li>
        </ol>

        <footer>
          {/* Nothing here is a setting, so there is nothing to cancel — only one way out. */}
          <button type="button" className="zs-btn is-primary" onClick={onDismiss} autoFocus>
            {t('firstRunGotIt')}
          </button>
          <small>{t('firstRunFooter')}</small>
        </footer>
      </section>
    </div>
  );
};
