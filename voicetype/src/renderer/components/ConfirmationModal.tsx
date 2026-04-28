import { useEffect, useLayoutEffect, useState } from 'react';
import { motion } from 'framer-motion';

interface ConfirmationModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirmButtonClassName?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}

type ConfirmationModalPhase = 'closed' | 'enter' | 'open' | 'exit';
const CONFIRMATION_MODAL_EXIT_DURATION_MS = 95;
const MODAL_OPEN_TRANSITION = { type: 'spring', duration: 0.18, bounce: 0.24 } as const;
const MODAL_CLOSE_TRANSITION = { type: 'spring', duration: 0.095, bounce: 0.03 } as const;

// Pure-CSS confirmation modal. Mirrors the Dialog component: we keep the
// DOM mounted after the first open so subsequent opens are compositor-only
// (instant), and we use CSS transitions instead of framer-motion to avoid
// any JS cold-start cost.
export default function ConfirmationModal({
  open,
  title,
  description,
  confirmLabel,
  confirmButtonClassName,
  onConfirm,
  onClose,
}: ConfirmationModalProps) {
  const [phase, setPhase] = useState<ConfirmationModalPhase>('closed');

  useLayoutEffect(() => {
    let exitTimeout = 0;
    let raf1 = 0;
    let raf2 = 0;

    if (open) {
      // Two-step open so the backdrop fades 0 -> 1 alongside the panel
      // animation instead of popping in instantly.
      setPhase((current) => (current === 'open' ? current : 'enter'));
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setPhase('open'));
      });
    } else {
      setPhase((current) => (current === 'closed' ? current : 'exit'));
      exitTimeout = window.setTimeout(() => {
        setPhase('closed');
      }, CONFIRMATION_MODAL_EXIT_DURATION_MS);
    }

    return () => {
      window.clearTimeout(exitTimeout);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const isVisible = open || phase !== 'closed';
  const isInteractive = phase === 'open';

  if (!isVisible) return null;

  const backdropOpacity = phase === 'open' ? 1 : 0;

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center ${
        isInteractive ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
      aria-hidden={!isVisible}
      onClick={onClose}
    >
      <div
        className="absolute inset-0 bg-black/15"
        style={{ opacity: backdropOpacity, transition: 'opacity 160ms ease-out' }}
      />
      <motion.div
        className="relative w-full max-w-sm rounded-2xl border border-border bg-background p-6 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.25)] transform-gpu"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={phase === 'exit' ? { opacity: 0, scale: 0.98, y: 4 } : { opacity: 1, scale: 1, y: 0 }}
        transition={phase === 'exit' ? MODAL_CLOSE_TRANSITION : MODAL_OPEN_TRANSITION}
        style={{ willChange: 'opacity, transform' }}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <h3 className="text-[15px] font-semibold text-foreground">{title}</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            className={`inline-flex h-9 items-center justify-center rounded-md px-4 text-[13px] font-medium transition-[transform,opacity] duration-100 active:scale-[0.98] ${
              confirmButtonClassName ?? 'bg-[#cf6f63] text-white hover:bg-[#c76357]'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
