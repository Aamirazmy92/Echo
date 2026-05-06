import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, X } from 'lucide-react';
import {
  MODAL_BACKDROP_EXIT,
  MODAL_BACKDROP_INITIAL,
  MODAL_BACKDROP_OPEN,
  MODAL_BACKDROP_TRANSITION,
  MODAL_PANEL_INITIAL,
  MODAL_PANEL_OPEN,
  MODAL_PANEL_EXIT,
  MODAL_OPEN_TRANSITION,
  MODAL_CLOSE_TRANSITION,
} from '../lib/modalMotion';

interface ConfirmationModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  /** Optional override for the cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  confirmButtonClassName?: string;
  /**
   * When true, both buttons disable and the confirm button shows a
   * spinner. Use this for async confirm actions (sign-out, account
   * deletion) so the user can't double-fire while the RPC is in flight.
   */
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

export default function ConfirmationModal({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmButtonClassName,
  loading = false,
  onConfirm,
  onClose,
}: ConfirmationModalProps) {
  useEffect(() => {
    if (!open || loading) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose, loading]);

  return createPortal(
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="confirmation-modal"
          className="fixed inset-0 z-[100] flex items-center justify-center"
          data-confirmation-modal="true"
          aria-hidden={false}
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 1 }}
          onClick={loading ? undefined : onClose}
        >
          <motion.div
            className="absolute inset-0 bg-black/15"
            initial={MODAL_BACKDROP_INITIAL}
            animate={MODAL_BACKDROP_OPEN}
            exit={MODAL_BACKDROP_EXIT}
            transition={MODAL_BACKDROP_TRANSITION}
          />
          <motion.div
            className="relative w-full max-w-sm rounded-2xl border border-border bg-background p-6 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.25)] transform-gpu"
            initial={MODAL_PANEL_INITIAL}
            animate={MODAL_PANEL_OPEN}
            exit={{ ...MODAL_PANEL_EXIT, transition: MODAL_CLOSE_TRANSITION }}
            transition={MODAL_OPEN_TRANSITION}
            style={{ willChange: 'opacity, transform' }}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
        {/* Top-right close affordance. Hidden while `loading` so the
            user can't dismiss a half-finished destructive action. */}
        {!loading ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}

        <h3 className="pr-8 text-[15px] font-semibold text-foreground">{title}</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="btn-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            disabled={loading}
            className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-4 text-[13px] font-medium transition-[transform,opacity] duration-100 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70 ${
              confirmButtonClassName ?? 'bg-[#cf6f63] text-white hover:bg-[#c76357]'
            }`}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}
