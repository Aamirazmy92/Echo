import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, X, Info } from 'lucide-react';
import type { ToastType } from './useToast';

interface ToastItemProps {
  id: number;
  type: ToastType;
  message: string;
  /** Auto-dismiss after this many ms. Hover pauses the timer. */
  duration: number;
  onDismiss: (id: number) => void;
}

/*
 * A single toast card. Black background, white text, bare colored stroke
 * icon (no chip background) — matches the reference screenshot exactly.
 *
 * Animation matches the dialog modal's spring (`MODAL_OPEN_TRANSITION`
 * in `ui/dialog.tsx`) so the toast feels visually consistent with the
 * rest of the app:
 *
 *   - Enter: framer-motion spring with `duration: 0.18, bounce: 0.24`
 *     (the same values the dialog uses) — has a satisfying overshoot
 *     without feeling slow.
 *   - Exit: smooth no-bounce spring that floats the card up 24 px while
 *     fading out. Slightly longer (~280 ms) than the enter so the
 *     dismissal reads as graceful rather than rushed.
 *   - `prefers-reduced-motion` collapses both to a short fade.
 *
 * Auto-dismiss timer pauses while the pointer is over the toast so users
 * can read multi-line errors without them disappearing mid-sentence.
 */
export default function ToastItem({ id, type, message, duration, onDismiss }: ToastItemProps) {
  const reduceMotion = useReducedMotion();
  const [isHovered, setIsHovered] = useState(false);
  const remainingRef = useRef<number>(duration);
  const timerStartRef = useRef<number>(performance.now());
  const timerIdRef = useRef<number | null>(null);

  useEffect(() => {
    const start = (ms: number) => {
      timerStartRef.current = performance.now();
      timerIdRef.current = window.setTimeout(() => {
        timerIdRef.current = null;
        onDismiss(id);
      }, ms);
    };

    if (!isHovered) {
      start(remainingRef.current);
    } else if (timerIdRef.current !== null) {
      // Pause: subtract elapsed time from the remaining budget so the
      // timer resumes from where it left off when the pointer leaves.
      window.clearTimeout(timerIdRef.current);
      timerIdRef.current = null;
      const elapsed = performance.now() - timerStartRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    }

    return () => {
      if (timerIdRef.current !== null) {
        window.clearTimeout(timerIdRef.current);
        timerIdRef.current = null;
      }
    };
  }, [id, isHovered, onDismiss]);

  // Bare-stroke icon set, sized 18 px with stroke-width 2.5 — matches the
  // visual weight of the reference screenshot.
  const iconColor =
    type === 'success' ? '#34d399' : type === 'error' ? '#f87171' : '#d4d4d8';
  const Icon = type === 'success' ? Check : type === 'error' ? X : Info;

  // Spring transitions copied from `ui/dialog.tsx` so the toast pop
  // matches the modal pop exactly. Framer-motion's duration+bounce API
  // is the v11+ shorthand: `bounce` controls overshoot (0 = none,
  // 1 = lots), `duration` is the perceived settle time.
  const ENTER_SPRING = { type: 'spring' as const, duration: 0.18, bounce: 0.24 };
  // No-bounce spring with a longer duration so the upward float on exit
  // feels graceful rather than yanked off-screen.
  const EXIT_SPRING = { type: 'spring' as const, duration: 0.28, bounce: 0 };

  const enter = reduceMotion
    ? { opacity: 1, y: 0 }
    : { opacity: 1, y: 0, transition: ENTER_SPRING };

  const exit = reduceMotion
    ? { opacity: 0, transition: { duration: 0.08 } }
    : { opacity: 0, y: -24, transition: EXIT_SPRING };

  const initial = reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14 };

  return (
    <motion.div
      layout={!reduceMotion}
      initial={initial}
      animate={enter}
      exit={exit}
      onHoverStart={() => setIsHovered(true)}
      onHoverEnd={() => setIsHovered(false)}
      className="pointer-events-auto inline-flex max-w-[360px] items-center gap-2.5 rounded-[14px] px-4 py-2.5 shadow-2xl"
      style={{
        background: 'hsl(220 8% 8%)',
        // Subtle inner highlight on the top edge gives the card depth on
        // dark backdrops without showing a hard border.
        boxShadow:
          '0 18px 38px -12px rgba(0, 0, 0, 0.55), 0 8px 16px -8px rgba(0, 0, 0, 0.35), inset 0 1px 0 0 rgba(255, 255, 255, 0.06)',
      }}
      role={type === 'error' ? 'alert' : 'status'}
      aria-live={type === 'error' ? 'assertive' : 'polite'}
    >
      <Icon
        size={18}
        strokeWidth={2.5}
        color={iconColor}
        className="shrink-0"
        aria-hidden="true"
      />
      <p className="text-[14px] font-medium leading-tight text-white line-clamp-2">
        {message}
      </p>
    </motion.div>
  );
}
