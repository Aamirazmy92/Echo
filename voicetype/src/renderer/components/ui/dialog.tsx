import * as React from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion } from "framer-motion"
import { X } from "lucide-react"
import { cn } from "../../lib/utils"
import { refreshPointerTargetUnderCursor } from "../../lib/pointerSync"
import ModalOverlayRoot from "../ModalOverlayRoot"
import {
  MODAL_OVERLAY_FADE,
  MODAL_PANEL_INITIAL,
  MODAL_PANEL_OPEN,
  MODAL_PANEL_EXIT,
  MODAL_SPRING,
  MODAL_SPRING_EXIT,
} from "../../lib/modalMotion"

// Spring-animated Dialog. `<MotionWarmup>` at app boot primes framer-motion
// so the first open does not stutter. Overlay fades in sync with the panel;
// both use coordinated exit animations so the shell never snaps shut.

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

type DialogAnimation = "default" | "pop"

const DialogOpenContext = React.createContext<{
  animation: DialogAnimation
}>({
  animation: "default",
})

function Dialog({ open, onOpenChange, children }: DialogProps) {
  React.useEffect(() => {
    if (!open) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, onOpenChange])

  const content = (
    <AnimatePresence initial={false} onExitComplete={refreshPointerTargetUnderCursor}>
      {open ? (
        <DialogOpenContext.Provider value={{ animation: "default" }}>
          <ModalOverlayRoot
            key="dialog-root"
            className="fixed inset-0 z-[180] flex items-center justify-center bg-[hsl(25_18%_12%/0.30)] p-4"
            aria-hidden={false}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={MODAL_OVERLAY_FADE}
            onClick={() => onOpenChange(false)}
          >
            {children}
          </ModalOverlayRoot>
        </DialogOpenContext.Provider>
      ) : null}
    </AnimatePresence>
  )

  return createPortal(content, document.body)
}

function DialogContent({
  className,
  children,
  onClose,
  animation = "default",
}: {
  className?: string
  children: React.ReactNode
  onClose?: () => void
  animation?: DialogAnimation
}) {
  React.useContext(DialogOpenContext)
  const initial = animation === "pop" ? { opacity: 0, scale: 0.94, y: 6 } : MODAL_PANEL_INITIAL

  return (
    <motion.div
      className={cn(
        "relative w-full echo-standard-modal border border-border bg-popover shadow-[0_24px_60px_-20px_rgba(31,27,22,0.20)] transform-gpu",
        className
      )}
      initial={initial}
      animate={MODAL_PANEL_OPEN}
      exit={{ ...MODAL_PANEL_EXIT, transition: MODAL_SPRING_EXIT }}
      transition={MODAL_SPRING}
      style={{ willChange: "opacity, transform" }}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
    >
      {children}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X size={16} />
        </button>
      )}
    </motion.div>
  )
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-4", className)} {...props} />
}

function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("echo-modal-title", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("echo-modal-description", className)} {...props} />
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("echo-modal-footer", className)} {...props} />
}

export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter }
