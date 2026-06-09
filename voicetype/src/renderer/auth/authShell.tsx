import type { ReactNode } from 'react';
import { Minus, Square, X } from 'lucide-react';

/*
 * Shared chrome for every auth screen — centred card on a soft
 * gradient backdrop with the Echo wordmark + a subtitle.
 *
 * This file deliberately uses inline tailwind classes (no shadcn
 * components) because the auth screens render BEFORE the lazy-loaded
 * dashboard. Pulling in dialog/Button/etc. here would defeat that
 * lazy split and slow first paint after sign-in.
 *
 * Frameless-window plumbing:
 *   The Echo BrowserWindow is `frame: false`, so without an in-app
 *   titlebar the user can't move, minimise, maximise, or close the
 *   window from the sign-in screen. We render the same drag region
 *   + min/max/close trio as App.tsx, scoped to AuthShell, so the
 *   auth screens behave like a normal Windows app.
 *
 *   The `titlebar` and `no-drag` classes are defined in `index.css`
 *   and toggle Electron's `-webkit-app-region` between `drag` and
 *   `no-drag` — there is no JS plumbing required for the drag region
 *   itself.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative flex h-screen w-screen items-center justify-center bg-[hsl(var(--app-bg))] px-6">
      <TitleBar />
      <div className="w-full max-w-[400px]">
        <div className="mb-6 text-center">
          <div className="mb-1 text-3xl font-bold text-foreground">
            Echo
          </div>
          <div className="text-sm text-muted-foreground">{subtitle}</div>
        </div>

        <div
          className="rounded-[24px] border border-border bg-popover p-7 shadow-[0_18px_60px_-44px_rgba(15,23,42,0.42)]"
        >
          <h1 className="mb-5 text-base font-semibold text-foreground">{title}</h1>
          {children}
        </div>

        {footer ? (
          <div className="mt-5 text-center text-xs text-muted-foreground">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

export const inputClasses =
  'w-full rounded-xl border border-border bg-popover px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground disabled:opacity-60';

export const primaryButtonClasses =
  'flex h-10 w-full items-center justify-center rounded-xl bg-foreground px-4 text-sm font-bold text-background shadow-sm transition hover:bg-foreground/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60';

export const secondaryButtonClasses =
  'flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-border bg-popover px-4 text-sm font-semibold text-foreground transition hover:bg-muted active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60';

export const linkButtonClasses =
  'text-foreground underline-offset-4 hover:underline focus:outline-none focus:underline';

/**
 * Frameless-window titlebar for the auth screens.
 *
 * Spans the full top of the window so anywhere outside the buttons is
 * draggable (the `titlebar` class enables `-webkit-app-region: drag`).
 * Buttons opt out via `no-drag` so clicks register normally.
 */
function TitleBar() {
  return (
    <div className="titlebar absolute top-0 left-0 right-0 z-50 flex h-10 items-center justify-end pr-2">
      <div className="no-drag flex items-center">
        <button
          type="button"
          onClick={() => window.api.windowMinimize()}
          aria-label="Minimize window"
          className="flex h-10 w-11 items-center justify-center rounded-lg text-foreground/58 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Minus size={17} />
        </button>
        <button
          type="button"
          onClick={() => window.api.windowToggleMaximize()}
          aria-label="Maximize window"
          className="flex h-10 w-11 items-center justify-center rounded-lg text-foreground/58 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          <Square size={15} />
        </button>
        <button
          type="button"
          onClick={() => window.api.windowClose()}
          aria-label="Close window"
          className="flex h-10 w-11 items-center justify-center rounded-lg text-foreground/58 transition-colors hover:bg-red-500/10 hover:text-red-600"
        >
          <X size={17} />
        </button>
      </div>
    </div>
  );
}
