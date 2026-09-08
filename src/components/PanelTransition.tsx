import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * Enter/exit for the settings surface.
 *
 * Its own module so that `framer-motion` is not in the chunk the wheel waits on. The wheel does not
 * animate with it — `RadialMenu` has zero `motion.` usages, all of its motion is CSS — yet 111 kB
 * of it sat in the critical path because `App.tsx` imported it for this transition, an error banner
 * and a toast. All three are lazy now, so the library loads when something actually animates.
 *
 * `mode="sync"` is load-bearing and predates this: without it the dashboard leaves before settings
 * arrives, and the gap is a frame of bare background that DWM composites as a flash.
 */
export const PanelTransition: React.FC<{
  show: boolean;
  children: React.ReactNode;
}> = ({ show, children }) => (
  <AnimatePresence mode="sync">
    {show && (
      <motion.div
        key="settings-page"
        initial={{ opacity: 0, x: 20, filter: 'blur(10px)' }}
        animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
        exit={{ opacity: 0, x: 20, filter: 'blur(10px)' }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="absolute inset-x-0 bottom-0 top-[var(--zenith-title-bar-h)] z-20"
      >
        {children}
      </motion.div>
    )}
  </AnimatePresence>
);
