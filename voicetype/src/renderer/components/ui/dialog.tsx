import * as React from "react"
import { createPortal } from "react-dom"
import { AnimatePresence, motion } from "framer-motion"
import { X } from "lucide-react"
import { cn } from "../../lib/utils"
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
} from "../../lib/modalMotion"

// Spring-animated Dialog. Framer-motion's spring solver has a one-shot
// JIT/setup cost the first time it animates a new node — visible as a
// stutter on the very first modal open. We work around this by mounting
// `<MotionWarmup>` at app boot (see `MotionWarmup.tsx`) which runs an
// off-screen spring animation through one full cycle. By the time the
// user clicks "Add new" the motion runtime is hot and the open is
// indistinguishable from any subsequent open.
//
// The backdrop is still driven by a pure CSS transition (cheaper than
// running a second framer animation) and the panel uses a spring for
// the satisfying overshoot the user explicitly asked for.
//
// We deliberately mount the panel on-demand for shared dialogs and keep
// the panel opacity constant. Open and close are both spring transforms,
// and the shell unmounts only after Framer reports the exit complete.

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
    <AnimatePresence initial={false}>
      {open ? (
        <DialogOpenContext.Provider value={{ animation: "default" }}>
          <motion.div
            key="dialog-root"
            className="fixed inset-0 z-[180]"
            aria-hidden={false}
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 1 }}
          >
            <motion.div
              className="fixed inset-0 bg-black/15"
              initial={MODAL_BACKDROP_INITIAL}
              animate={MODAL_BACKDROP_OPEN}
              exit={MODAL_BACKDROP_EXIT}
              transition={MODAL_BACKDROP_TRANSITION}
              onClick={() => onOpenChange(false)}
            />
            <div
              className="fixed inset-0 flex items-center justify-center p-4"
              onClick={() => onOpenChange(false)}
            >
              {children}
            </div>
          </motion.div>
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
        "relative w-full max-w-lg rounded-2xl border border-border bg-background p-6 shadow-lg transform-gpu",
        className
      )}
      initial={initial}
      animate={MODAL_PANEL_OPEN}
      exit={{ ...MODAL_PANEL_EXIT, transition: MODAL_CLOSE_TRANSITION }}
      transition={MODAL_OPEN_TRANSITION}
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
  return <h2 className={cn("text-lg font-semibold text-foreground", className)} {...props} />
}

function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-1 text-sm text-muted-foreground", className)} {...props} />
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-6 flex justify-end gap-2", className)} {...props} />
}

export { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter }
