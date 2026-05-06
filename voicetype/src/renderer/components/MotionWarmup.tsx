import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import {
  MODAL_CLOSE_TRANSITION,
  MODAL_OPEN_TRANSITION,
  MODAL_PANEL_EXIT,
  MODAL_PANEL_INITIAL,
  MODAL_PANEL_OPEN,
} from '../lib/modalMotion';

/**
 * Pre-warms framer-motion's spring solver at app startup.
 *
 * Why this exists:
 *   The first time framer-motion runs a spring against a brand-new
 *   DOM node, it has to JIT-compile the math, build internal state for
 *   the node, and prime the rAF scheduler. That cost (~5-15 ms on a
 *   warm machine) shows up as a stutter on the very first modal open
 *   — visible enough that the modal "snaps" instead of animating.
 *
 *   By rendering this hidden `<motion.div>` once at boot and running
 *   it through a full spring cycle, we pay that cost up front while
 *   the user is still looking at the splash / dashboard. Every modal
 *   open after that uses the warm code paths and animates smoothly.
 *
 * Implementation notes:
 *   - The element is positioned far off-screen with zero size so it
 *     can't be seen, focused, or interacted with. It uses the exact
 *     modal spring targets so those paths are warm before the first
 *     real dialog opens.
 *   - It unmounts itself after one full open+close cycle so it stops
 *     consuming rAF ticks.
 *   - `aria-hidden` keeps it out of accessibility trees.
 */
export default function MotionWarmup() {
  const [phase, setPhase] = useState<'enter' | 'exit' | 'done'>('enter');

  useEffect(() => {
    // Wait one tick after mount, animate to the resting state, then
    // animate back out, then unmount. Total wall-clock ≈ 350 ms,
    // plenty of time for the user to focus the window.
    const t1 = window.setTimeout(() => setPhase('exit'), 200);
    const t2 = window.setTimeout(() => setPhase('done'), 400);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  if (phase === 'done') return null;

  return (
    <motion.div
      aria-hidden
      style={{
        position: 'fixed',
        top: -9999,
        left: -9999,
        width: 1,
        height: 1,
        pointerEvents: 'none',
      }}
      initial={MODAL_PANEL_INITIAL}
      animate={
        phase === 'exit'
          ? MODAL_PANEL_EXIT
          : MODAL_PANEL_OPEN
      }
      transition={phase === 'exit' ? MODAL_CLOSE_TRANSITION : MODAL_OPEN_TRANSITION}
    />
  );
}
