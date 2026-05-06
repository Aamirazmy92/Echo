import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'framer-motion';
import ToastItem from './ToastItem';
import {
  TOAST_EVENT_NAME,
  type ToastDispatch,
  type ToastType,
} from './useToast';

/*
 * Bottom-right stack of toast notifications, anchored inside the main
 * window. Listens for two event channels:
 *
 *   1. `echo:toast` (CustomEvent<ToastDispatch>) — the new dispatcher
 *      from `useToast.ts`. Preferred for all new code.
 *   2. `show-toast` (CustomEvent<{ message, type }>) — the legacy
 *      channel several components already dispatch to. Bridged here so
 *      we don't have to rewrite every existing call site in one shot.
 *
 * Stack rules:
 *   - Up to 3 visible at once. Newer toasts queue if the stack is full.
 *   - Newest renders at the bottom (closest to the screen edge), matches
 *     OS-native notification stacking conventions.
 *   - Errors auto-dismiss after 4500 ms; success / info after 2500 ms.
 *     `ToastItem` pauses its own timer while hovered.
 */

interface QueuedToast {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

const MAX_VISIBLE = 3;
// Tuned so the toast lingers long enough to read comfortably without
// overstaying its welcome. Errors get a longer window because users
// often need to read the actual reason (e.g. "Please include at least
// one modifier key…"). Hover pauses the timer regardless.
const DEFAULT_DURATION_MS: Record<ToastType, number> = {
  success: 2400,
  info: 2800,
  error: 4500,
};

export default function ToastHost() {
  const [visible, setVisible] = useState<QueuedToast[]>([]);
  const queueRef = useRef<QueuedToast[]>([]);
  const visibleRef = useRef<QueuedToast[]>([]);

  // Keep the ref in sync so the dismiss callback (which captures it via
  // closure) sees the latest visible list when it runs.
  visibleRef.current = visible;

  const promoteFromQueue = useCallback(() => {
    if (queueRef.current.length === 0) return;
    if (visibleRef.current.length >= MAX_VISIBLE) return;

    const next = queueRef.current.shift()!;
    setVisible((prev) => [...prev, next]);
  }, []);

  const handleDismiss = useCallback((id: number) => {
    setVisible((prev) => prev.filter((toast) => toast.id !== id));
    // Defer the queue promotion until after the exit animation has had
    // time to start, so the visual stack settles smoothly.
    window.setTimeout(promoteFromQueue, 80);
  }, [promoteFromQueue]);

  const enqueue = useCallback((toast: QueuedToast) => {
    if (visibleRef.current.length < MAX_VISIBLE) {
      setVisible((prev) => [...prev, toast]);
    } else {
      queueRef.current.push(toast);
    }
  }, []);

  useEffect(() => {
    // New-style dispatcher (toast.success / toast.error / toast.info).
    const handleNewToast = (event: Event) => {
      const detail = (event as CustomEvent<ToastDispatch>).detail;
      if (!detail) return;
      enqueue({
        id: detail.id,
        type: detail.type,
        message: detail.message,
        duration: detail.duration ?? DEFAULT_DURATION_MS[detail.type],
      });
    };

    // Legacy `show-toast` channel — `Dashboard.tsx` and a few other
    // places already dispatch this. Bridge it through the new host so
    // they keep working without churn.
    let legacyId = 1_000_000;
    const handleLegacyToast = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string; type?: ToastType }>).detail;
      if (!detail?.message) return;
      const type: ToastType = detail.type ?? 'success';
      enqueue({
        id: legacyId++,
        type,
        message: detail.message,
        duration: DEFAULT_DURATION_MS[type],
      });
    };

    window.addEventListener(TOAST_EVENT_NAME, handleNewToast as EventListener);
    window.addEventListener('show-toast', handleLegacyToast as EventListener);

    return () => {
      window.removeEventListener(TOAST_EVENT_NAME, handleNewToast as EventListener);
      window.removeEventListener('show-toast', handleLegacyToast as EventListener);
    };
  }, [enqueue]);

  // Portal to document.body so the toast stack escapes any ancestor
  // stacking context (App.tsx wraps the layout in `relative z-[1]`,
  // which would otherwise trap the toast below modals that portal to
  // body themselves — Settings, ConfirmationModal, Dialog, Onboarding).
  // The fixed z-index of 9999 sits well above every modal layer in the
  // app (highest existing layer is z-[200] Onboarding).
  const stack = (
    <div
      // Anchored bottom-right of the viewport. `pointer-events-none` on
      // the wrapper lets clicks pass through the empty area; individual
      // toasts re-enable pointer events on themselves so hover-pause works.
      className="pointer-events-none fixed bottom-6 right-6 flex flex-col items-end gap-2"
      style={{ zIndex: 9999 }}
      aria-live="polite"
      aria-atomic="false"
    >
      <AnimatePresence initial={false}>
        {visible.map((toast) => (
          <ToastItem
            key={toast.id}
            id={toast.id}
            type={toast.type}
            message={toast.message}
            duration={toast.duration}
            onDismiss={handleDismiss}
          />
        ))}
      </AnimatePresence>
    </div>
  );

  // SSR safety: only portal once `document` exists. In Electron renderer
  // this is always true at mount, but the guard keeps the file portable.
  if (typeof document === 'undefined') return null;
  return createPortal(stack, document.body);
}
