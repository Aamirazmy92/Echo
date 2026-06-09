import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, X } from 'lucide-react';
import { refreshPointerTargetUnderCursor } from '../lib/pointerSync';
import ModalOverlayRoot from './ModalOverlayRoot';
import {
  MODAL_OVERLAY_FADE,
  MODAL_PANEL_INITIAL,
  MODAL_PANEL_OPEN,
  MODAL_PANEL_EXIT,
  MODAL_SPRING,
  MODAL_SPRING_EXIT,
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
    <AnimatePresence initial={false} onExitComplete={refreshPointerTargetUnderCursor}>
      {open ? (
        <ModalOverlayRoot
          key="confirmation-modal"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-[hsl(25_18%_12%/0.30)] px-6"
          data-confirmation-modal="true"
          aria-hidden={false}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={MODAL_OVERLAY_FADE}
          onClick={loading ? undefined : onClose}
        >
          <motion.div
            className="echo-standard-modal relative w-full rounded-2xl border border-border bg-popover shadow-[0_24px_60px_-20px_rgba(31,27,22,0.20)] transform-gpu"
            initial={MODAL_PANEL_INITIAL}
            animate={MODAL_PANEL_OPEN}
            exit={{ ...MODAL_PANEL_EXIT, transition: MODAL_SPRING_EXIT }}
            transition={MODAL_SPRING}
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

        <h3 className="echo-modal-title pr-8">{title}</h3>
        <p className="echo-modal-description">{description}</p>

        <div className="echo-modal-footer">
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
            className={`echo-btn ${confirmButtonClassName ?? 'echo-btn-danger'} active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-70`}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
          </motion.div>
        </ModalOverlayRoot>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}
