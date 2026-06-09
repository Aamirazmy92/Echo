import type { TargetAndTransition, Transition } from 'framer-motion';

export type ModalPhase = 'closed' | 'enter' | 'open' | 'exit';

/** Smooth natural spring — panel open (slight overshoot, ~350 ms) */
export const MODAL_SPRING: Transition = {
  type: 'spring',
  duration: 0.35,
  bounce: 0.12,
};

/** Crisp spring — panel close (no overshoot, ~280 ms) */
export const MODAL_SPRING_EXIT: Transition = {
  type: 'spring',
  duration: 0.28,
  bounce: 0,
};

/** Full-screen overlay fade — timed to feel in step with the panel spring */
export const MODAL_OVERLAY_FADE: Transition = {
  duration: 0.25,
  ease: [0.22, 1, 0.36, 1],
};

// Legacy names (used across components)
export const MODAL_OPEN_TRANSITION = MODAL_SPRING;
export const MODAL_CLOSE_TRANSITION = MODAL_SPRING_EXIT;

export const MODAL_PANEL_INITIAL: TargetAndTransition = {
  opacity: 0,
  scale: 0.96,
  y: 14,
};

export const MODAL_PANEL_OPEN: TargetAndTransition = {
  opacity: 1,
  scale: 1,
  y: 0,
};

export const MODAL_PANEL_EXIT: TargetAndTransition = {
  opacity: 0,
  scale: 0.98,
  y: 10,
};

/** @deprecated Use MODAL_OVERLAY_FADE on a single overlay root instead of a separate backdrop layer */
export const MODAL_BACKDROP_INITIAL: TargetAndTransition = { opacity: 0 };
/** @deprecated */
export const MODAL_BACKDROP_OPEN: TargetAndTransition = { opacity: 1 };
/** @deprecated */
export const MODAL_BACKDROP_EXIT: TargetAndTransition = { opacity: 0 };
/** @deprecated */
export const MODAL_BACKDROP_TRANSITION: Transition = MODAL_OVERLAY_FADE;

export function getModalPanelTarget(phase: ModalPhase): TargetAndTransition {
  if (phase === 'open') return MODAL_PANEL_OPEN;
  if (phase === 'exit') return MODAL_PANEL_EXIT;
  return MODAL_PANEL_INITIAL;
}

export function getModalPanelTransition(phase: ModalPhase): Transition {
  return phase === 'exit' ? MODAL_SPRING_EXIT : MODAL_SPRING;
}
