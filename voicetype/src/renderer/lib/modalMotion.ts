import type { TargetAndTransition, Transition } from 'framer-motion';

export type ModalPhase = 'closed' | 'enter' | 'open' | 'exit';

export const MODAL_PANEL_INITIAL: TargetAndTransition = {
  opacity: 0,
  scale: 0.965,
  y: 10,
};

export const MODAL_PANEL_OPEN: TargetAndTransition = {
  opacity: 1,
  scale: 1,
  y: 0,
};

export const MODAL_PANEL_EXIT: TargetAndTransition = {
  opacity: 0,
  scale: 0.98,
  y: 8,
};

export const MODAL_OPEN_TRANSITION: Transition = {
  type: 'spring',
  stiffness: 520,
  damping: 34,
  mass: 0.7,
};

export const MODAL_CLOSE_TRANSITION: Transition = {
  type: 'tween',
  duration: 0.12,
  ease: [0.32, 0.72, 0, 1],
};

export const MODAL_BACKDROP_INITIAL: TargetAndTransition = { opacity: 0 };
export const MODAL_BACKDROP_OPEN: TargetAndTransition = { opacity: 1 };
export const MODAL_BACKDROP_EXIT: TargetAndTransition = { opacity: 0 };
export const MODAL_BACKDROP_TRANSITION: Transition = {
  type: 'tween',
  duration: 0.14,
  ease: [0.22, 1, 0.36, 1],
};

export function getModalPanelTarget(phase: ModalPhase): TargetAndTransition {
  if (phase === 'open') return MODAL_PANEL_OPEN;
  if (phase === 'exit') return MODAL_PANEL_EXIT;
  return MODAL_PANEL_INITIAL;
}

export function getModalPanelTransition(phase: ModalPhase): Transition {
  return phase === 'exit' ? MODAL_CLOSE_TRANSITION : MODAL_OPEN_TRANSITION;
}
