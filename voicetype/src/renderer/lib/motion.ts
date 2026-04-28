import type { TargetAndTransition, Transition } from 'framer-motion';

export const MOTION_EASE = [0.22, 1, 0.36, 1] as const;
export const MOTION_EASE_EMPHASIS = [0.16, 1, 0.3, 1] as const;

export const buttonTransition: Transition = {
  type: 'spring',
  stiffness: 460,
  damping: 30,
  mass: 0.72,
};

export const cardTransition: Transition = {
  type: 'spring',
  stiffness: 380,
  damping: 32,
  mass: 0.8,
};

export const switchTransition: Transition = {
  type: 'spring',
  stiffness: 540,
  damping: 34,
  mass: 0.62,
};

export const fadeTransition: Transition = {
  duration: 0.24,
  ease: MOTION_EASE,
};

export const panelTransition: Transition = {
  duration: 0.22,
  ease: MOTION_EASE_EMPHASIS,
};

export const buttonHover: TargetAndTransition = {
  y: -1,
  scale: 1.01,
};

export const buttonTap: TargetAndTransition = {
  y: 0,
  scale: 0.985,
};

export const cardHover: TargetAndTransition = {
  y: -2,
  scale: 1.005,
};

export const cardTap: TargetAndTransition = {
  y: 0,
  scale: 0.995,
};
