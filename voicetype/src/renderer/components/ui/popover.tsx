import * as React from 'react';
import { AnimatePresence, motion, type Transition } from 'framer-motion';
import { cn } from '../../lib/utils';

// Controlled Popover. Manages click-outside, escape-to-close, and a
// snappy spring entrance so every menu in the app opens the same way.
// Mirrors the house style of `Dialog`: hand-rolled wrapper around
// framer-motion rather than a Radix headless primitive, since the
// codebase already commits to that style for modal-y surfaces.

type PopoverAlign = 'start' | 'end';

interface PopoverContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  align: PopoverAlign;
  sideOffset: number;
}

const PopoverContext = React.createContext<PopoverContextValue | null>(null);

function usePopoverContext(component: string): PopoverContextValue {
  const ctx = React.useContext(PopoverContext);
  if (!ctx) {
    throw new Error(`${component} must be rendered inside <Popover>.`);
  }
  return ctx;
}

interface PopoverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  align?: PopoverAlign;
  /** Pixel gap between the anchor and the popover panel. Defaults to 6. */
  sideOffset?: number;
  className?: string;
  children: React.ReactNode;
}

export function Popover({
  open,
  onOpenChange,
  align = 'end',
  sideOffset = 6,
  className,
  children,
}: PopoverProps) {
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && wrapperRef.current?.contains(target)) return;
      onOpenChange(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onOpenChange(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onOpenChange]);

  const ctx = React.useMemo<PopoverContextValue>(
    () => ({ open, onOpenChange, align, sideOffset }),
    [open, onOpenChange, align, sideOffset]
  );

  return (
    <PopoverContext.Provider value={ctx}>
      <div ref={wrapperRef} className={cn('relative', className)}>
        {children}
      </div>
    </PopoverContext.Provider>
  );
}

// Tuned to be visibly snappier than Dialog — popovers are smaller surfaces
// near the cursor, so a faster spring feels more direct.
const POPOVER_OPEN_TRANSITION: Transition = {
  type: 'spring',
  duration: 0.22,
  bounce: 0.18,
};

const POPOVER_CLOSE_TRANSITION: Transition = {
  duration: 0.12,
  ease: [0.4, 0, 1, 1],
};

// The native `onDrag*` and `onAnimation*` handler types collide with
// framer-motion's pan/animation callbacks, so strip them out. Consumers
// don't pass them in practice.
type PopoverContentForwardProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  | 'children'
  | 'onDrag'
  | 'onDragStart'
  | 'onDragEnd'
  | 'onDragEnter'
  | 'onDragExit'
  | 'onDragLeave'
  | 'onDragOver'
  | 'onDrop'
  | 'onAnimationStart'
  | 'onAnimationEnd'
  | 'onAnimationIteration'
  | 'style'
>;

interface PopoverContentProps extends PopoverContentForwardProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function PopoverContent({
  className,
  children,
  style,
  ...rest
}: PopoverContentProps) {
  const { open, align, sideOffset } = usePopoverContext('PopoverContent');

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="popover-content"
          role="dialog"
          initial={{ opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -2, transition: POPOVER_CLOSE_TRANSITION }}
          transition={POPOVER_OPEN_TRANSITION}
          style={{
            transformOrigin: align === 'end' ? 'top right' : 'top left',
            marginTop: sideOffset,
            willChange: 'opacity, transform',
            ...style,
          }}
          className={cn(
            'absolute top-full z-30 overflow-hidden rounded-xl border border-border bg-card shadow-[0_18px_44px_-26px_rgba(31,27,22,0.22)]',
            align === 'end' ? 'right-0' : 'left-0',
            className
          )}
          {...rest}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
