import * as React from "react"
import { motion } from "framer-motion"
import { X } from "lucide-react"
import { cn } from "../../lib/utils"

// Pure-CSS Dialog. We intentionally avoid framer-motion here because its
// first-mount cost (internal ref/measurement setup + first GPU compositing)
// produced a very visible stutter the first time the user opened the modal
// inside a lazy-loaded tab. CSS transitions run on the compositor with no
// per-frame JS work, so the open feels instant even on cold chunks.
//
// The dialog DOM is kept mounted after the first open and only its
// `opacity`/`visibility`/`pointer-events` toggle, so follow-up opens are
// similarly instant (no remount, no layout recompute).

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}

type DialogAnimation = "default" | "pop"
type DialogPhase = "closed" | "enter" | "open" | "exit"

// Share `open` between Dialog and DialogContent so the panel can drive its
// own CSS transition without touching the DOM imperatively.
const DialogOpenContext = React.createContext<DialogPhase>("closed")
const DIALOG_EXIT_DURATION_MS = 95
const MODAL_OPEN_TRANSITION = { type: "spring", duration: 0.18, bounce: 0.24 } as const
const MODAL_CLOSE_TRANSITION = { type: "spring", duration: 0.095, bounce: 0.03 } as const

function Dialog({ open, onOpenChange, children }: DialogProps) {
  const [phase, setPhase] = React.useState<DialogPhase>("closed")

  React.useLayoutEffect(() => {
    let exitTimeout = 0
    let raf1 = 0
    let raf2 = 0

    if (open) {
      // Two-step open so the backdrop can transition opacity from 0 -> 1
      // alongside the panel animation. Without the `enter` paint, the
      // wrapper would render at opacity 1 immediately and the backdrop
      // would pop in with no fade.
      setPhase((current) => (current === "open" ? current : "enter"))
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setPhase("open"))
      })
    } else {
      setPhase((current) => (current === "closed" ? current : "exit"))
      exitTimeout = window.setTimeout(() => {
        setPhase("closed")
      }, DIALOG_EXIT_DURATION_MS)
    }

    return () => {
      window.clearTimeout(exitTimeout)
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [open])

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

  const isVisible = open || phase !== "closed"
  const isInteractive = phase === "open"
  // Backdrop is only fully opaque while the panel is in its `open` resting
  // phase. During `enter` and `exit` it transitions to/from 0 so the dim
  // overlay fades in and out alongside the panel.
  const backdropOpacity = phase === "open" ? 1 : 0

  if (!isVisible) return null

  return (
    <DialogOpenContext.Provider value={phase}>
      <div
        className={cn(
          "fixed inset-0 z-[180]",
          isInteractive ? "pointer-events-auto" : "pointer-events-none"
        )}
        aria-hidden={!isVisible}
      >
        <div
          className="fixed inset-0 bg-black/15"
          style={{
            opacity: backdropOpacity,
            transition: "opacity 160ms ease-out",
          }}
          onClick={() => onOpenChange(false)}
        />
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          onClick={() => onOpenChange(false)}
        >
          {children}
        </div>
      </div>
    </DialogOpenContext.Provider>
  )
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
  const phase = React.useContext(DialogOpenContext)
  const isPop = animation === "pop"
  return (
    <motion.div
      className={cn(
        "relative w-full max-w-lg rounded-2xl border border-border bg-background p-6 shadow-lg transform-gpu",
        className
      )}
      initial={isPop ? { opacity: 0, scale: 0.94, y: 14 } : { opacity: 0, scale: 0.96, y: 8 }}
      animate={phase === "exit" ? { opacity: 0, scale: isPop ? 0.97 : 0.98, y: isPop ? 6 : 4 } : { opacity: 1, scale: 1, y: 0 }}
      transition={phase === "exit" ? MODAL_CLOSE_TRANSITION : MODAL_OPEN_TRANSITION}
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
