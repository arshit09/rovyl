import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, X } from 'lucide-react';
import { Toast } from './Toast';
import type { AppItem } from '../types';

/**
 * The two things that appear only when something went wrong: the launch-failure toast and the
 * execution-error banner.
 *
 * Together with `PanelTransition` this is why `framer-motion` is no longer in the chunk the wheel
 * waits on. Both animate, neither is ever on screen in a session where nothing fails, and a banner
 * that reports an error can afford to arrive a few milliseconds after the error itself.
 *
 * `App.tsx` keeps this mounted once it has been needed, rather than unmounting it the moment the
 * error clears — `AnimatePresence` can only play an exit animation for a child it still owns.
 */
export const ErrorOverlays: React.FC<{
  lastLaunched: AppItem | null;
  executionError: string | null;
  onDismissError: () => void;
}> = ({ lastLaunched, executionError, onDismissError }) => (
  <>
    <Toast app={lastLaunched} />

    <AnimatePresence>
      {executionError && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[1000]">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="px-6 py-4 bg-red-500/90 backdrop-blur-xl border border-red-400/50 rounded-2xl shadow-2xl flex items-center gap-4 min-w-[320px]"
          >
            <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center text-white shrink-0">
              <AlertTriangle size={20} />
            </div>
            <div className="flex-1">
              <div className="text-[10px] font-black uppercase tracking-widest text-white/60 mb-1">Execution Error</div>
              <div className="text-sm font-bold text-white leading-tight">{executionError}</div>
            </div>
            <button onClick={onDismissError} className="text-white/40 hover:text-white transition-colors">
              <X size={18} />
            </button>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  </>
);
