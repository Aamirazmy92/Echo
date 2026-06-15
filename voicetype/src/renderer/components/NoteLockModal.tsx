import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { LockKeyhole } from 'lucide-react';
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

type NoteLockModalMode = 'setup' | 'unlock' | 'remove';

type NoteLockModalProps = {
  open: boolean;
  mode: NoteLockModalMode;
  noteTitle: string;
  error?: string | null;
  onSubmit: (code: string) => Promise<void> | void;
  onClose: () => void;
};

const CODE_PATTERN = /^\d{4,6}$/;

export default function NoteLockModal({
  open,
  mode,
  noteTitle,
  error,
  onSubmit,
  onClose,
}: NoteLockModalProps) {
  const [code, setCode] = useState('');
  const [confirmCode, setConfirmCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setCode('');
    setConfirmCode('');
    setSubmitting(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, mode]);

  const title = useMemo(() => {
    if (mode === 'setup') return 'Set lock code';
    if (mode === 'remove') return 'Remove lock';
    return 'Unlock note';
  }, [mode]);

  const hint = useMemo(() => {
    if (mode === 'setup') return 'Enter a 4-6 digit code for this note.';
    if (mode === 'remove') return 'Confirm the code before removing this note lock.';
    return 'Enter the code for this locked note.';
  }, [mode]);

  const localError = !CODE_PATTERN.test(code)
    ? 'Use 4-6 digits.'
    : mode === 'setup' && code !== confirmCode
      ? 'Codes do not match.'
      : null;

  const canSubmit = !submitting && !localError;

  return createPortal(
    <AnimatePresence initial={false} onExitComplete={refreshPointerTargetUnderCursor}>
      {open ? (
        <ModalOverlayRoot
          key="note-lock-modal"
          className="note-lock-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={MODAL_OVERLAY_FADE}
          onClick={onClose}
        >
      <motion.form
        className="note-lock-modal transform-gpu"
        initial={MODAL_PANEL_INITIAL}
        animate={MODAL_PANEL_OPEN}
        exit={{ ...MODAL_PANEL_EXIT, transition: MODAL_SPRING_EXIT }}
        transition={MODAL_SPRING}
        style={{ willChange: 'opacity, transform' }}
        onClick={(event) => event.stopPropagation()}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canSubmit) return;
          setSubmitting(true);
          try {
            await onSubmit(code);
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <div className="note-lock-icon">
          <LockKeyhole size={17} />
        </div>
        <h2>{title}</h2>
        <p className="note-lock-note">{noteTitle || 'Untitled'}</p>
        <p className="note-lock-hint">{hint}</p>

        <label className="note-lock-field">
          <span>Code</span>
          <input
            ref={inputRef}
            value={code}
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="off"
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          />
        </label>

        {mode === 'setup' && (
          <label className="note-lock-field">
            <span>Confirm code</span>
            <input
              value={confirmCode}
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="off"
              onChange={(event) => setConfirmCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </label>
        )}

        {(error || localError) && <p className="note-lock-error">{error || localError}</p>}

        <div className="note-lock-actions">
          <button type="button" className="note-lock-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="note-lock-confirm" disabled={!canSubmit}>
            {submitting
              ? 'Saving...'
              : mode === 'setup'
                ? 'Lock'
                : mode === 'remove'
                  ? 'Remove'
                  : 'Unlock'}
          </button>
        </div>
      </motion.form>
        </ModalOverlayRoot>
      ) : null}
    </AnimatePresence>,
    document.body
  );
}
