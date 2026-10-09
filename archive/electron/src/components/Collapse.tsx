import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PresenceContext, usePresence, useReducedMotion } from 'framer-motion';

/**
 * How long a reveal takes. Shared with `index.css` through `--zn-collapse`, and read back here
 * because the exit has to hold the node in the tree for exactly as long as the transition paints.
 */
export const COLLAPSE_MS = 240;

/** Breathing room kept between a revealed block and the edges of the box that scrolls it. */
const REVEAL_PAD = 14;

/**
 * The first ancestor that actually scrolls.
 *
 * Deliberately not "the first one that has something to scroll": a list that only overflows once
 * the new rows are in it has `scrollHeight === clientHeight` at the moment the reveal is
 * scheduled, and testing for overflow here would walk straight past the box we mean to move.
 */
function scrollableAncestor(node: HTMLElement): HTMLElement | null {
  for (let element = node.parentElement; element; element = element.parentElement) {
    const { overflowY } = getComputedStyle(element);
    if (overflowY === 'auto' || overflowY === 'scroll') return element;
  }
  return null;
}

/**
 * How much of the top of a scroller is already spoken for.
 *
 * Appearance keeps the wheel preview pinned to the top of the list, so the first rows of that box
 * are behind it. Scrolling a revealed row to the top of the scroller would be scrolling it
 * underneath the preview — visible to the arithmetic, not to the user.
 */
function stickyTopInset(container: HTMLElement): number {
  let inset = 0;
  container.querySelectorAll<HTMLElement>('[data-sticky-top]').forEach((element) => {
    if (getComputedStyle(element).position !== 'sticky') return;
    inset = Math.max(inset, element.getBoundingClientRect().height);
  });
  return inset;
}

let followers = 0;

/**
 * True while a reveal is moving a scroller.
 *
 * Settings rewrites `.zs-scroll`'s offset after every commit, from the last position it saw the
 * user at — that is what survives the wheel opening over the panel and taking the window to full
 * screen. It reads that position from a `scroll` event, which Chromium only delivers at the top of
 * the next frame, so a commit landing in between would put the list back where the reveal had just
 * moved it from. For the length of a reveal, the reveal is the authority.
 */
export function isRevealScrolling(): boolean {
  return followers > 0;
}

/**
 * Keep a growing block in view while it grows.
 *
 * The obvious version — measure the final height, then `scrollTo` with `behavior: 'smooth'` — does
 * not work here: at the moment the reveal starts the container has not grown yet, so the target is
 * clamped to the old scroll range and the scroll stops short. Following the block instead means
 * asking, every frame, for only the scroll that is possible right now. That amount is exactly the
 * height already revealed, so the list rises at the same rate as the rows arrive rather than after
 * them, and nothing has to be measured up front.
 */
function followIntoView(nodes: HTMLElement[], durationMs: number) {
  const anchor = nodes.find((node) => node.isConnected);
  const container = anchor && scrollableAncestor(anchor);
  if (!container) return;

  let frame = 0;
  let running = true;
  followers += 1;
  const stop = () => {
    if (!running) return;
    running = false;
    followers -= 1;
    cancelAnimationFrame(frame);
    container.removeEventListener('wheel', stop);
    container.removeEventListener('touchstart', stop);
  };
  /** Whoever takes the wheel keeps it: an assist that fights the user is worse than none. */
  container.addEventListener('wheel', stop, { passive: true });
  container.addEventListener('touchstart', stop, { passive: true });

  const start = performance.now();
  const step = () => {
    const view = container.getBoundingClientRect();
    const safeTop = view.top + stickyTopInset(container) + REVEAL_PAD;
    const safeBottom = view.bottom - REVEAL_PAD;

    let top = Infinity;
    let bottom = -Infinity;
    for (const node of nodes) {
      if (!node.isConnected) continue;
      const box = node.getBoundingClientRect();
      top = Math.min(top, box.top);
      bottom = Math.max(bottom, box.bottom);
    }

    if (top !== Infinity) {
      let delta = 0;
      /**
       * Down only as far as the block's own top: something taller than the viewport is read from
       * its first line, not chased by its last.
       */
      if (bottom > safeBottom) delta = Math.min(bottom - safeBottom, Math.max(0, top - safeTop));
      else if (top < safeTop) delta = top - safeTop;
      if (Math.abs(delta) >= 0.5) container.scrollTop += delta;
    }

    /** A little past the transition: the last frame of an ease is where most of it is still moving. */
    if (performance.now() - start < durationMs + 60) frame = requestAnimationFrame(step);
    else stop();
  };
  frame = requestAnimationFrame(step);
}

/**
 * Reveals that land in the same frame are one movement.
 *
 * Turning the system dock on opens seven rows at once, and seven boxes each scrolling themselves
 * into view is seven scrollers fighting over one container — the last one registered wins and the
 * rest are never accounted for. Collecting a frame's worth first lets the follow loop aim at the
 * union of the boxes, which is what the eye is reading anyway.
 */
const pendingReveals = new Set<HTMLElement>();
let revealFrame = 0;

function scheduleReveal(node: HTMLElement) {
  pendingReveals.add(node);
  if (revealFrame) return;
  revealFrame = requestAnimationFrame(() => {
    revealFrame = 0;
    const nodes = [...pendingReveals];
    pendingReveals.clear();
    if (nodes.length) followIntoView(nodes, COLLAPSE_MS);
  });
}

/**
 * A block that opens and closes in place instead of appearing.
 *
 * Every conditional row in Settings — the dwell tunings, a dock's placement and readouts, the
 * fullscreen scope — exists because another switch is on. Mounting them outright made the list
 * jump under the pointer that had just moved that switch, which reads as a flash and says nothing
 * about the new rows belonging to the thing the user just turned on.
 *
 * The transition is `grid-template-rows: 0fr → 1fr` and not an animated `height`, because the box
 * has to go on tracking its own content afterwards: a row restacks at narrow widths, a confirm
 * opens inside one, an IDE probe answers late. Animating `height` ends with a pixel value frozen
 * into the style attribute, and every one of those later changes would be clipped by it.
 *
 * Removal is held open by `usePresence`, so a parent only has to wrap the list in
 * `<AnimatePresence initial={false}>` and go on rendering the rows it actually wants.
 */
export const Collapse: React.FC<{
  children: React.ReactNode;
  className?: string;
  /** Follow the block into view as it opens. Off for anything not worth a scroll. */
  reveal?: boolean;
}> = ({ children, className, reveal = true }) => {
  const [isPresent, safeToRemove] = usePresence();
  const presence = useContext(PresenceContext);
  const reduceMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  /**
   * `initial === false` marks the children `AnimatePresence` already had on its first render — a
   * section that has just been opened, or a search that has just been retyped. Those are not
   * reveals: opening the whole list every time the nav is clicked is a curtain, and it would bury
   * the one row that actually changed.
   */
  const isEntering = presence?.initial !== false && !reduceMotion;
  const [open, setOpen] = useState(!isEntering);
  const [settled, setSettled] = useState(!isEntering);

  useLayoutEffect(() => {
    if (!isEntering) return;
    /** One frame closed, or the transition has nowhere to come from. */
    const frame = requestAnimationFrame(() => {
      setOpen(true);
      if (reveal && ref.current) scheduleReveal(ref.current);
    });
    return () => cancelAnimationFrame(frame);
    // Mount only: whether this instance animates in is decided once, by how it arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  /**
   * Through a ref, because `usePresence` hands back a new `safeToRemove` on every render — as a
   * dependency it would restart the removal timer each time anything re-rendered the panel, and a
   * row on its way out would sit there half-closed for as long as that kept happening.
   */
  const safeToRemoveRef = useRef(safeToRemove);
  safeToRemoveRef.current = safeToRemove;

  useEffect(() => {
    if (isPresent) return;
    setOpen(false);
    const timer = window.setTimeout(() => safeToRemoveRef.current?.(), reduceMotion ? 0 : COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [isPresent, reduceMotion]);

  return (
    <div
      ref={ref}
      className={className ? `zs-collapse ${className}` : 'zs-collapse'}
      data-open={open ? 'true' : 'false'}
      /**
       * Clipping is only needed while the box is shorter than its contents. Left on, it would cut
       * the focus ring of the last row and the 2px drop marker that sits one pixel above it.
       */
      data-settled={settled ? 'true' : undefined}
    >
      <div className="zs-collapse-inner">{children}</div>
    </div>
  );
};
