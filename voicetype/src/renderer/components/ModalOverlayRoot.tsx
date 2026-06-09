import { motion, type HTMLMotionProps } from 'framer-motion';

/**
 * Full-screen modal layer under `AnimatePresence`.
 *
 * Pointer events are disabled as soon as the exit animation starts so the
 * fading overlay does not block clicks on the UI beneath it. Without this,
 * the button that triggered the modal cannot be re-clicked until the exit
 * fade fully completes (~250-300ms), which feels like input lag.
 *
 * `initial` and `animate` explicitly re-assert `pointerEvents: 'auto'` so
 * that when a closing overlay is interrupted by a fresh open (or AnimatePresence
 * reuses the same node via a stable key), the overlay is fully interactive
 * again — otherwise the stale `pointerEvents: 'none'` from the previous exit
 * would silently swallow backdrop clicks.
 */
type MotionObject = Record<string, unknown>;

function withPointerEvents(value: HTMLMotionProps<'div'>['animate'], pe: 'auto' | 'none') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as MotionObject), pointerEvents: pe };
  }
  return { pointerEvents: pe };
}

export function ModalOverlayRoot({ initial, animate, exit, ...rest }: HTMLMotionProps<'div'>) {
  return (
    <motion.div
      {...rest}
      initial={withPointerEvents(initial, 'auto') as HTMLMotionProps<'div'>['initial']}
      animate={withPointerEvents(animate, 'auto') as HTMLMotionProps<'div'>['animate']}
      exit={withPointerEvents(exit, 'none') as HTMLMotionProps<'div'>['exit']}
    />
  );
}

export default ModalOverlayRoot;
